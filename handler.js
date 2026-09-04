import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
// Leaves time to flush a clean "error" event before AWS hard-kills the Lambda.
const TIMEOUT_SAFETY_MARGIN_MS = 10_000;
const MIN_OPENAI_TIMEOUT_MS = 5_000;
// Must stay under CloudFront's 60s inter-chunk idle timeout (see terraform repo cloudfront.tf).
const HEARTBEAT_INTERVAL_MS = 20_000;
const secretsManager = new SecretsManagerClient();

// OpenAI API Key retrieval from Secrets Manager
const getApiKey = async () => {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  const secret = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.OPENAI_SECRET_ID }),
  );
  const secretsObj = JSON.parse(secret.SecretString);
  if (typeof secretsObj === "object" && secretsObj.OPENAI_API_KEY) {
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
const sseEvent = (event, data) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Parses OpenAI's own SSE stream, yielding delta text chunks; returns on [DONE].
async function* readOpenAiDeltas(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // ignore malformed/partial lines
        }
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
    }
  }
}

// Main
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
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

    // Only safe to call before the streaming success response has been committed below.
    const fail = (statusCode, errorBody) => {
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

      let body;
      try {
        body = JSON.parse(event.body);
      } catch (parseErr) {
        console.error("Unable to parse request body", {
          error: parseErr.message,
        });
        fail(400, { error: "Invalid JSON payload" });
        return;
      }

      const {
        threadId,
        messages,
        model = "gpt-4o-mini",
        temperature = 0.3,
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
      console.info("Valid request received", {
        threadId,
        model,
        messageCount: messages.length,
      });

      const apiKey = await getApiKey().catch((err) => {
        console.error("Unable to retrieve OpenAI API key", {
          threadId,
          error: err.message,
        });
        throw err;
      });

      const chatMessages = messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));

      // Committed from here on: status/headers can no longer change, failures become SSE "error" events.
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          ...headers,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });

      let heartbeat;
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

        const response = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: chatMessages,
            temperature,
            stream: true,
          }),
          signal: AbortSignal.timeout(budgetMs),
        });

        if (!response.ok) {
          throw new Error(
            `OpenAI API responded with status ${response.status}`,
          );
        }

        for await (const delta of readOpenAiDeltas(response.body)) {
          responseStream.write(sseEvent("delta", { content: delta }));
        }

        console.info("Streamed response completed", { threadId });
        responseStream.write(sseEvent("done", {}));
      } catch (err) {
        const timedOut =
          err.name === "TimeoutError" || err.name === "AbortError";
        console.error("OpenAI streaming failed", {
          threadId,
          error: err.message,
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
      console.error("Unexpected server error", { error: err.message });
      fail(500, { error: "Server error" });
    }
  },
);
