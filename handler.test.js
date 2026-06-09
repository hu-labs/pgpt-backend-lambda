const test = require("node:test");
const assert = require("node:assert/strict");
const { default: axios } = require("axios");

const { handler } = require("./handler");

const originalApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "test-key";

test.after(() => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
    return;
  }

  process.env.OPENAI_API_KEY = originalApiKey;
});

const buildEvent = (body) => ({
  stageVariables: { allowedOrigin: "https://example.com" },
  body,
});

test("returns 500 when allowedOrigin stage variable is missing", async () => {
  const result = await handler({});

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(result.body), {
    error: "Missing stage variable: allowedOrigin",
  });
});

test("returns 400 when request body is missing", async () => {
  const result = await handler({
    stageVariables: { allowedOrigin: "https://example.com" },
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.headers["Access-Control-Allow-Origin"], "https://example.com");
  assert.deepEqual(JSON.parse(result.body), {
    error: "Missing request body",
  });
});

test("returns 400 when request body is invalid JSON", async () => {
  const result = await handler(buildEvent("{invalid json}"));

  assert.equal(result.statusCode, 400);
  assert.equal(result.headers["Access-Control-Allow-Origin"], "https://example.com");
  assert.deepEqual(JSON.parse(result.body), {
    error: "Invalid JSON payload",
  });
});

test("returns 400 when threadId is missing", async () => {
  const result = await handler(
    buildEvent(JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    })),
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "Missing threadId",
  });
});

test("returns 400 when messages is not an array", async () => {
  const result = await handler(
    buildEvent(JSON.stringify({
      threadId: "thread-123",
      messages: "not-an-array",
    })),
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "messages must be an array",
  });
});

test("returns 400 when messages is empty", async () => {
  const result = await handler(
    buildEvent(JSON.stringify({
      threadId: "thread-123",
      messages: [],
    })),
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "messages array cannot be empty",
  });
});

test("returns 200 when OpenAI responds successfully", async () => {
  const originalPost = axios.post;
  const calls = [];

  axios.post = async (url, payload, config) => {
    calls.push({ url, payload, config });
    return {
      data: {
        choices: [
          {
            message: { role: "assistant", content: "Hello from mock" },
          },
        ],
      },
    };
  };

  try {
    const result = await handler(
      buildEvent(JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      })),
    );

    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      assistant: { role: "assistant", content: "Hello from mock" },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0].config.headers.Authorization, "Bearer test-key");
  } finally {
    axios.post = originalPost;
  }
});

test("returns 500 when OpenAI call fails", async () => {
  const originalPost = axios.post;

  axios.post = async () => {
    throw new Error("mock OpenAI failure");
  };

  try {
    const result = await handler(
      buildEvent(JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      })),
    );

    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), {
      error: "Error calling OpenAI API",
    });
  } finally {
    axios.post = originalPost;
  }
});
