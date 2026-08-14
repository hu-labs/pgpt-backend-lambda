import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TIMEOUT_MS = 19_500;
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

// Main
export const handler = async (event) => {
  const allowedOrigin = event.stageVariables?.allowedOrigin;
  if (!allowedOrigin) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Missing stage variable: allowedOrigin" }),
    };
  }

  const headers = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
    //"Access-Control-Allow-Credentials": true,
  };
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing request body" }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseErr) {
      console.error("Unable to parse request body", {
        error: parseErr.message,
      });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid JSON payload" }),
      };
    }

    const {
      threadId,
      messages,
      model = "gpt-4o-mini",
      temperature = 0.3,
    } = body;
    if (!threadId) {
      console.warn("Request validation failed: missing threadId");
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing threadId" }),
      };
    }
    if (!Array.isArray(messages)) {
      console.warn("Request validation failed: messages must be an array", {
        threadId,
      });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "messages must be an array" }),
      };
    }
    if (messages.length === 0) {
      console.warn("Request validation failed: messages cannot be empty", {
        threadId,
      });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "messages array cannot be empty" }),
      };
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

    let data;
    try {
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
        }),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API responded with status ${response.status}`);
      }

      data = await response.json();
      console.info("OpenAI response received", {
        threadId,
        statusCode: response.status,
      });
    } catch (err) {
      console.error("OpenAI request failed", { threadId, error: err.message });
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Error calling OpenAI API" }),
      };
    }

    const assistant = data.choices?.[0]?.message || {
      role: "assistant",
      content: "No response",
    };
    console.info("Successful response issued", { threadId, statusCode: 200 });
    return { statusCode: 200, headers, body: JSON.stringify({ assistant }) };
  } catch (err) {
    console.error("Unexpected server error", { error: err.message });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server error" }),
    };
  }
};
