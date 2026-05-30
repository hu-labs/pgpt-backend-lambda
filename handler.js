const { default: axios } = require("axios");
const AWS = require("aws-sdk");

// OpenAI API Key retrieval from Secrets Manager
const getApiKey = async () => {
  if (process.env.OPENAI_API_KEY)
    return process.env.OPENAI_API_KEY;  // Local key for local debug with SAM

  const sm = new AWS.SecretsManager();
  const secret = await sm.getSecretValue({ SecretId: process.env.OPENAI_SECRET_ID }).promise();
  const secretsObj = JSON.parse(secret.SecretString);
  if (typeof secretsObj === 'object' && secretsObj.OPENAI_API_KEY) {
    return secretsObj.OPENAI_API_KEY;
  }
  throw new Error("Invalid secret format: OPENAI_API_KEY not found");
};

// Main
exports.handler = async (event) => {
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
  console.log("allowedOrigin:", allowedOrigin);

  try {
    console.log("Raw event received:", JSON.stringify(event, null, 2));

    if (!event.body) {
      return {
        statusCode: 400, headers, body: JSON.stringify({ error: "Missing request body" })
      };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseErr) {
      console.error("Error parsing event body:", parseErr.message, parseErr.stack);
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON payload" }) };
    }

    //console.log("Parsed body:", body);

    const { threadId, messages, model = "gpt-4o-mini", temperature = 0.3 } = body;
    if (!threadId) {
      console.error("Validation error: Missing threadId in request body");
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing threadId" }) };
    }
    if (!Array.isArray(messages)) {
      console.error("Validation error: 'messages' must be an array");
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages must be an array" }) };
    }
    if (messages.length === 0) {
      console.error("Validation error: 'messages' array cannot be empty");
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages array cannot be empty" }) };
    }
    console.log("No errors on the parse + format.");

    // Retrieve API Key
    const apiKey = await getApiKey().catch((err) => {
      console.error("Error retrieving API key from Secrets Manager:", err.message, err.stack);
      throw err;
    });

    const chatMessages = messages.map(m => ({ role: m.role, content: m.content }));

    // Query OpenAI API
    let resp;
    try {
      resp = await axios.post("https://api.openai.com/v1/chat/completions", {
        model, messages: chatMessages, temperature,
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 19500,
      });
    } catch (err) {
      console.error("Error during OpenAI API call:", err.message, err.stack);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Error calling OpenAI API" }) };
    }

    const data = resp.data;
    // Log the backend response
    console.log("OpenAI API Response:", JSON.stringify(data, null, 2));

    const assistant = data.choices?.[0]?.message || { role: "assistant", content: "No response" };
    return { statusCode: 200, headers, body: JSON.stringify({ assistant }) };
  } catch (err) {
    console.error("Unexpected server error:", err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server error" }) };
  }
};
