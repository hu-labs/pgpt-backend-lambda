import assert from "node:assert/strict";
import type { Context } from "aws-lambda";
import { afterAll, afterEach, test, vi } from "vitest";

interface ResponseMetadata {
  statusCode: number;
  headers: Record<string, string>;
}

interface MockStream {
  chunks: string[];
  ended: boolean;
  metadata?: ResponseMetadata;
  write: (chunk: string) => void;
  end: (chunk?: string) => void;
}

interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

const originalApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
process.env.OPENAI_API_KEY = "test-key";

// Minimal shim for the Lambda-runtime-injected `awslambda` global (response streaming).
// Must be set before handler.ts is imported, since it calls awslambda.streamifyResponse
// at module load time — hence the dynamic import below instead of a static one.
Object.assign(globalThis, {
  awslambda: {
    streamifyResponse: <T>(fn: T): T => fn,
    HttpResponseStream: {
      from: (stream: unknown, metadata: ResponseMetadata): MockStream => {
        const mockStream = stream as MockStream;
        mockStream.metadata = metadata;
        return mockStream;
      },
    },
  },
});

const { handler } = await import("./handler.js");

// Must match handler.ts's HEARTBEAT_INTERVAL_MS.
const HEARTBEAT_INTERVAL_MS = 20_000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
    return;
  }

  process.env.OPENAI_API_KEY = originalApiKey;
});

const buildEvent = (body: string) => ({
  stageVariables: { allowedOrigin: "https://example.com" },
  body,
});

const defaultContext = {
  getRemainingTimeInMillis: () => 300_000,
} as Context;

function createMockStream(): MockStream {
  return {
    chunks: [],
    ended: false,
    metadata: undefined,
    write(chunk: string) {
      this.chunks.push(chunk);
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.chunks.push(chunk);
      this.ended = true;
    },
  };
}

// Builds a fake OpenAI SSE response body; each array entry is delivered as its own read() chunk.
function fakeSseBody(rawChunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= rawChunks.length) {
        controller.close();
        return;
      }

      controller.enqueue(encoder.encode(rawChunks[index]));
      index += 1;
    },
  });
}

// Parses the SSE text the handler wrote into a list of {event, data} records.
function parseSseEvents(text: string): ParsedSseEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()) as Record<
          string,
          unknown
        >,
      };
    });
}

const invokeHandler = (
  event: Parameters<typeof handler>[0],
  stream: MockStream,
): ReturnType<typeof handler> =>
  handler(
    event,
    stream as unknown as awslambda.HttpResponseStream,
    defaultContext,
  );

test("returns 500 when allowedOrigin stage variable is missing", async () => {
  const stream = createMockStream();

  await invokeHandler({}, stream);

  assert.equal(stream.metadata?.statusCode, 500);
  assert.deepEqual(stream.metadata?.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Missing stage variable: allowedOrigin",
  });
});

test("returns 400 when request body is missing", async () => {
  const stream = createMockStream();

  await invokeHandler(
    { stageVariables: { allowedOrigin: "https://example.com" } },
    stream,
  );

  assert.equal(stream.metadata?.statusCode, 400);
  assert.equal(
    stream.metadata?.headers["Access-Control-Allow-Origin"],
    "https://example.com",
  );
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Missing request body",
  });
});

test("returns 400 when request body is invalid JSON", async () => {
  const stream = createMockStream();

  await invokeHandler(buildEvent("{invalid json}"), stream);

  assert.equal(stream.metadata?.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Invalid JSON payload",
  });
});

test("returns 400 when threadId is missing", async () => {
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    ),
    stream,
  );

  assert.equal(stream.metadata?.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "Missing threadId",
  });
});

test("returns 400 when messages is not an array", async () => {
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: "not-an-array",
      }),
    ),
    stream,
  );

  assert.equal(stream.metadata?.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "messages must be an array",
  });
});

test("returns 400 when messages is empty", async () => {
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [],
      }),
    ),
    stream,
  );

  assert.equal(stream.metadata?.statusCode, 400);
  assert.deepEqual(JSON.parse(stream.chunks.join("")), {
    error: "messages array cannot be empty",
  });
});

test("streams delta/done events assembling the full reply across multiple reads", async () => {
  const calls: Array<{
    input: RequestInfo | URL;
    init?: RequestInit;
  }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(
        fakeSseBody([
          'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ]),
        { status: 200 },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
  );

  assert.equal(stream.metadata?.statusCode, 200);
  assert.equal(stream.metadata?.headers["Content-Type"], "text/event-stream");
  assert.equal(stream.ended, true);

  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(
    events.filter((e) => e.event === "delta").map((e) => e.data.content),
    ["Hel", "lo"],
  );
  assert.deepEqual(events.at(-1), { event: "done", data: {} });

  assert.equal(calls.length, 1);
  const [{ input, init }] = calls;
  assert.equal(input, "https://api.openai.com/v1/responses");
  if (typeof init?.body !== "string") {
    assert.fail("expected fetch body to be a string");
  }
  assert.deepEqual(JSON.parse(init.body) as unknown, {
    model: "gpt-4o-mini",
    input: [{ role: "user", content: "Hi" }],
    temperature: 0.7,
    store: false,
    stream: true,
  });
  assert.ok(init.signal instanceof AbortSignal);
});

test("emits an error event when OpenAI responds with a non-success status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 429 })),
  );
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
  );

  // Status is already committed to 200 by the time the OpenAI call fails.
  assert.equal(stream.metadata?.statusCode, 200);
  assert.equal(stream.ended, true);
  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(events, [
    { event: "error", data: { message: "Error calling OpenAI API." } },
  ]);
});

test("emits an error event when the OpenAI request throws", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("mock OpenAI failure");
    }),
  );
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
  );

  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(events, [
    { event: "error", data: { message: "Error calling OpenAI API." } },
  ]);
});

test("emits an error event when OpenAI streams a failed response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          fakeSseBody([
            'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"mock stream failure"}}}\n\n',
          ]),
          { status: 200 },
        ),
    ),
  );
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
  );

  const events = parseSseEvents(stream.chunks.join(""));
  assert.deepEqual(events, [
    { event: "error", data: { message: "Error calling OpenAI API." } },
  ]);
});

test("emits a timeout-specific error event when the request budget is exceeded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const timeoutErr = new Error("The operation was aborted due to timeout");
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    }),
  );
  const stream = createMockStream();

  await invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
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

test("writes heartbeat pings while waiting on a slow OpenAI response", async () => {
  vi.useFakeTimers({ toFake: ["setInterval"] });
  let resolveFetch: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );
  const stream = createMockStream();

  const handlerPromise = invokeHandler(
    buildEvent(
      JSON.stringify({
        threadId: "thread-123",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ),
    stream,
  );

  // Let the handler run up to the pending fetch() call before advancing fake timers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

  assert.ok(resolveFetch);
  resolveFetch(
    new Response(
      fakeSseBody([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ]),
      { status: 200 },
    ),
  );
  await handlerPromise;

  const pingCount = stream.chunks.filter((c) => c === ": ping\n\n").length;
  assert.ok(
    pingCount >= 2,
    `expected at least 2 heartbeat pings, got ${pingCount}`,
  );
});
