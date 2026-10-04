import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Context } from "aws-lambda";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";

interface RequestEvent {
  body?: string | null;
  stageVariables?: Record<string, string | undefined> | null;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface RequestBody {
  threadId?: string;
  messages?: ChatMessage[];
  model?: string;
  temperature?: number;
}

type SseData = Record<string, unknown>;

const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_TEMPERATURE = 0.7;
// Reserved for `reasoning.effort` when the default model supports reasoning.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const OPENAI_EFFORT = "low";
// Leaves time to flush a clean "error" event before AWS hard-kills the Lambda.
const TIMEOUT_SAFETY_MARGIN_MS = 10_000;
const MIN_OPENAI_TIMEOUT_MS = 5_000;
// Must stay under CloudFront's 60s inter-chunk idle timeout (see terraform repo cloudfront.tf).
const HEARTBEAT_INTERVAL_MS = 20_000;
const secretsManager = new SecretsManagerClient();

// OpenAI API Key retrieval from Secrets Manager
const getApiKey = async (): Promise<string> => {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  const secret = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.OPENAI_SECRET_ID }),
  );
  if (!secret.SecretString) {
    throw new Error("Invalid secret format: SecretString not found");
  }

  const secretsObj: unknown = JSON.parse(secret.SecretString);
  if (
    typeof secretsObj === "object" &&
    secretsObj !== null &&
    "OPENAI_API_KEY" in secretsObj &&
    typeof secretsObj.OPENAI_API_KEY === "string"
  ) {
    return secretsObj.OPENAI_API_KEY;
  }
  throw new Error("Invalid secret format: OPENAI_API_KEY not found");
};

/*
  SSE contract emitted to the browser (see frontend ChatPane.tsx send()):
    event: delta  data: {"content": "..."}   - incremental assistant text
    event: done   data: {}                   - clean completion
    event: error  data: {"message": "..."}   - fatal failure, stream still ends after this
    ": ping" comment lines                   - heartbeat only, ignored by the client parser
  If the stream ends without a "done" or "error" event, the client treats that itself as a
  timeout/dropped-connection signal.
*/
const sseEvent = (event: string, data: SseData): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Main
export const handler = awslambda.streamifyResponse(
  async (event: RequestEvent, responseStream, context: Context) => {
    const allowedOrigin = event.stageVariables?.allowedOrigin;
    if (!allowedOrigin) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
      });
      responseStream.end(
        JSON.stringify({ error: "Missing stage variable: allowedOrigin" }),
      );
      return;
    }

    const headers = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
      //"Access-Control-Allow-Credentials": true,
    };

    // fail function that is used to send error responses before streaming starts.
    // Only safe to call before the streaming success response has been committed below.
    const fail = (statusCode: number, errorBody: SseData): void => {
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode,
        headers: { ...headers, "Content-Type": "application/json" },
      });
      responseStream.end(JSON.stringify(errorBody));
    };

    try {
      if (!event.body) {
        fail(400, { error: "Missing request body" });
        return;
      }

      let body: RequestBody;
      try {
        body = JSON.parse(event.body) as RequestBody;
      } catch (parseErr) {
        console.error("Unable to parse request body", {
          error:
            parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        fail(400, { error: "Invalid JSON payload" });
        return;
      }

      const {
        threadId,
        messages,
        model = OPENAI_MODEL,
        temperature = OPENAI_TEMPERATURE,
      } = body;
      if (!threadId) {
        console.warn("Request validation failed: missing threadId");
        fail(400, { error: "Missing threadId" });
        return;
      }
      if (!Array.isArray(messages)) {
        console.warn("Request validation failed: messages must be an array", {
          threadId,
        });
        fail(400, { error: "messages must be an array" });
        return;
      }
      if (messages.length === 0) {
        console.warn("Request validation failed: messages cannot be empty", {
          threadId,
        });
        fail(400, { error: "messages array cannot be empty" });
        return;
      }
      if (
        messages.some(
          (message) =>
            !message ||
            !["system", "developer", "user", "assistant"].includes(
              message.role,
            ) ||
            typeof message.content !== "string",
        )
      ) {
        fail(400, { error: "Invalid chat message" });
        return;
      }
      console.info("Valid request received", {
        threadId,
        model,
        messageCount: messages.length,
      });

      const apiKey = await getApiKey().catch((err) => {
        console.error("Unable to retrieve OpenAI API key", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });

      const chatMessages: ModelMessage[] = messages.map((message) => {
        return {
          role:
            message.role === "developer"
              ? "system"
              : (message.role as "system" | "user" | "assistant"),
          content: message.content,
        };
      });

      // Acquire the OpenAI client with the retrieved API key
      const openai = createOpenAI({ apiKey });

      // Committed from here on: status/headers can no longer change, failures become SSE "error" events.
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          ...headers,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });

      let heartbeat: NodeJS.Timeout | undefined;
      try {
        responseStream.write(": ping\n\n"); // flush headers to the client immediately
        heartbeat = setInterval(
          () => responseStream.write(": ping\n\n"),
          HEARTBEAT_INTERVAL_MS,
        );

        const budgetMs = Math.max(
          context.getRemainingTimeInMillis() - TIMEOUT_SAFETY_MARGIN_MS,
          MIN_OPENAI_TIMEOUT_MS,
        );

        // Use streamText from AI SDK
        const result = streamText({
          model: openai.responses(model),
          messages: chatMessages,
          temperature,
          providerOptions: { openai: { store: false } },
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(budgetMs),
        });

        let completed = false;
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              responseStream.write(sseEvent("delta", { content: part.text }));
              break;
            case "error":
              throw part.error;
            case "abort":
              throw new DOMException("AI request aborted", "AbortError");
            case "finish":
              // A dropped stream has reason "other"; length/filter limits are incomplete.
              completed = part.finishReason === "stop";
              break;
          }
        }
        if (!completed) {
          throw new Error("AI response did not complete successfully");
        }

        console.info("Streamed response completed", { threadId });
        responseStream.write(sseEvent("done", {}));
      } catch (err) {
        const timedOut =
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError");
        console.error("OpenAI streaming failed", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        responseStream.write(
          sseEvent("error", {
            message: timedOut
              ? "Backend timed out while waiting for the AI response."
              : "Error calling OpenAI API.",
          }),
        );
      } finally {
        clearInterval(heartbeat);
        responseStream.end();
      }
    } catch (err) {
      console.error("Unexpected server error", {
        error: err instanceof Error ? err.message : String(err),
      });
      fail(500, { error: "Server error" });
    }
  },
);
