import assert from "node:assert/strict";
import test from "node:test";

import { handler } from "./handler.js";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
process.env.OPENAI_API_KEY = "test-key";

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
  assert.equal(
    result.headers["Access-Control-Allow-Origin"],
    "https://example.com",
  );
  assert.deepEqual(JSON.parse(result.body), {
    error: "Missing request body",
  });
});

test("returns 400 when request body is invalid JSON", async () => {
  const result = await handler(buildEvent("{invalid json}"));

  assert.equal(result.statusCode, 400);
  assert.equal(
    result.headers["Access-Control-Allow-Origin"],
    "https://example.com",
  );
  assert.deepEqual(JSON.parse(result.body), {
    error: "Invalid JSON payload",
  });
});

test("returns 400 when threadId is missing", async () => {
  const result = await handler(
    buildEvent(
      JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    ),
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "Missing threadId",
  });
});

test("returns 400 when messages is not an array", async () => {
  const result = await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: "not-an-array",
      }),
    ),
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "messages must be an array",
  });
});

test("returns 400 when messages is empty", async () => {
  const result = await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [],
      }),
    ),
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "messages array cannot be empty",
  });
});

test("returns 200 when OpenAI responds successfully", async () => {
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { role: "assistant", content: "Hello from mock" },
          },
        ],
      }),
    };
  };

  const result = await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    assistant: { role: "assistant", content: "Hello from mock" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.3,
  });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.signal.aborted, false);
});

test("returns 500 when OpenAI call fails", async () => {
  globalThis.fetch = async () => {
    throw new Error("mock OpenAI failure");
  };

  const result = await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
  );

  assert.equal(result.statusCode, 500);
  assert.deepEqual(JSON.parse(result.body), {
    error: "Error calling OpenAI API",
  });
});

test("returns 500 when OpenAI responds with a non-success status", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
  });

  const result = await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
  );

  assert.equal(result.statusCode, 500);
  assert.deepEqual(JSON.parse(result.body), {
    error: "Error calling OpenAI API",
  });
});
