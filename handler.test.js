const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./handler");

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
  const result = await handler({
    stageVariables: { allowedOrigin: "https://example.com" },
    body: "{invalid json}",
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.headers["Access-Control-Allow-Origin"], "https://example.com");
  assert.deepEqual(JSON.parse(result.body), {
    error: "Invalid JSON payload",
  });
});
