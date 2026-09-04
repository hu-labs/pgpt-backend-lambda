import assert from "node:assert/strict";
import test from "node:test";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
process.env.OPENAI_API_KEY = "test-key";

// Minimal shim for the Lambda-runtime-injected `awslambda` global (response streaming).
// Must be set before handler.js is imported, since it calls awslambda.streamifyResponse
// at module load time — hence the dynamic import below instead of a static one.
globalThis.awslambda = {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: {
    from: (stream, metadata) => {
      stream.metadata = metadata;
      return stream;
    },
  },
};

const { handler } = await import("./handler.js");

// Must match handler.js's HEARTBEAT_INTERVAL_MS.
const HEARTBEAT_INTERVAL_MS = 20_000;

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

const defaultContext = { getRemainingTimeInMillis: () => 300_000 };

function createMockStream() {
  return {
    chunks: [],
    ended: false,
    metadata: undefined,
    write(chunk) {
      this.chunks.push(chunk);
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk);
      this.ended = true;
    },
  };
}

// Builds a fake OpenAI SSE response body; each array entry is delivered as its own read() chunk.
function fakeSseBody(rawChunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= rawChunks.length)
            return { done: true, value: undefined };
          const value = encoder.encode(rawChunks[index]);
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

// Parses the SSE text the handler wrote into a list of {event, data} records.
function parseSseEvents(text) {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()),
      };
    });
}

test("returns 500 when allowedOrigin stage variable is missing", async () => {
  const stream = createMockStream();

  await handler({}, stream, defaultContext);

  assert.equal(stream.metadata.statusCode, 500);
  assert.deepEqual(stream.metadata.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Missing stage variable: allowedOrigin",
  });
});

test("returns 400 when request body is missing", async () => {
  const stream = createMockStream();

  await handler(
    { stageVariables: { allowedOrigin: "https://example.com" } },
    stream,
    defaultContext,
  );

  assert.equal(stream.metadata.statusCode, 400);
  assert.equal(
    stream.metadata.headers["Access-Control-Allow-Origin"],
    "https://example.com",
  );
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Missing request body",
  });
});

test("returns 400 when request body is invalid JSON", async () => {
  const stream = createMockStream();

  await handler(buildEvent("{invalid json}"), stream, defaultContext);

  assert.equal(stream.metadata.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Invalid JSON payload",
  });
});

test("returns 400 when threadId is missing", async () => {
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    ),
    stream,
    defaultContext,
  );

  assert.equal(stream.metadata.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Missing threadId",
  });
});

test("returns 400 when messages is not an array", async () => {
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: "not-an-array",
      }),
    ),
    stream,
    defaultContext,
  );

  assert.equal(stream.metadata.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "messages must be an array",
  });
});

test("returns 400 when messages is empty", async () => {
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [],
      }),
    ),
    stream,
    defaultContext,
  );

  assert.equal(stream.metadata.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "messages array cannot be empty",
  });
});

test("streams delta/done events assembling the full reply across multiple reads", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      body: fakeSseBody([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
      ]),
    };
  };
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
    defaultContext,
  );

  assert.equal(stream.metadata.statusCode, 200);
  assert.equal(stream.metadata.headers["Content-Type"], "text/event-stream");
  assert.equal(stream.ended, true);

  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(
    events.filter((e) => e.event === "delta").map((e) => e.data.content),
    ["Hel", "lo"],
  );
  assert.deepEqual(events.at(-1), { event: "done", data: {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.3,
    stream: true,
  });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("emits an error event when OpenAI responds with a non-success status", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
    defaultContext,
  );

  // Status is already committed to 200 by the time the OpenAI call fails.
  assert.equal(stream.metadata.statusCode, 200);
  assert.equal(stream.ended, true);
  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(events, [
    { event: "error", data: { message: "Error calling OpenAI API." } },
  ]);
});

test("emits an error event when the OpenAI request throws", async () => {
  globalThis.fetch = async () => {
    throw new Error("mock OpenAI failure");
  };
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
    defaultContext,
  );

  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(events, [
    { event: "error", data: { message: "Error calling OpenAI API." } },
  ]);
});

test("emits a timeout-specific error event when the request budget is exceeded", async () => {
  globalThis.fetch = async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    throw timeoutErr;
  };
  const stream = createMockStream();

  await handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
    defaultContext,
  );

  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(events, [
    {
      event: "error",
      data: {
        message: "Backend timed out while waiting for the AI response.",
      },
    },
  ]);
});

test("writes heartbeat pings while waiting on a slow OpenAI response", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let resolveFetch;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });
  const stream = createMockStream();

  const handlerPromise = handler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
    defaultContext,
  );

  // Let the handler run up to the pending fetch() call before advancing fake timers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);

  resolveFetch({
    ok: true,
    status: 200,
    body: fakeSseBody(["data: [DONE]\n\n"]),
  });
  await handlerPromise;

  const pingCount = stream.chunks.filter((c) => c === ": ping\n\n").length;
  assert.ok(
    pingCount >= 2,
    `expected at least 2 heartbeat pings, got ${pingCount}`,
  );
});
