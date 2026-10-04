import assert from "node:assert/strict";
import * as ai from "ai";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Context } from "aws-lambda";
import { afterAll, afterEach, test, vi } from "vitest";

// Expose configurable exports so individual tests can spy on the SDK boundary.
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
}));

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

const validBody = {
  threadId: "thread-123",
  messages: [{ role: "user", content: "Hi" }],
};

for (const [name, body, paths] of [
  ["missing threadId", { messages: validBody.messages }, [["threadId"]]],
  ["empty threadId", { ...validBody, threadId: "" }, [["threadId"]]],
  ["numeric threadId", { ...validBody, threadId: 42 }, [["threadId"]]],
  ["missing messages", { threadId: "thread-123" }, [["messages"]]],
  ["non-array messages", { ...validBody, messages: "invalid" }, [["messages"]]],
  ["empty messages", { ...validBody, messages: [] }, [["messages"]]],
  [
    "unsupported role",
    { ...validBody, messages: [{ role: "tool", content: "Hi" }] },
    [["messages", 0, "role"]],
  ],
  [
    "non-text content",
    { ...validBody, messages: [{ role: "user", content: 42 }] },
    [["messages", 0, "content"]],
  ],
  ["null message", { ...validBody, messages: [null] }, [["messages", 0]]],
  ["empty model", { ...validBody, model: "" }, [["model"]]],
  ["numeric model", { ...validBody, model: 42 }, [["model"]]],
  ["null model", { ...validBody, model: null }, [["model"]]],
  [
    "string temperature",
    { ...validBody, temperature: "0.7" },
    [["temperature"]],
  ],
  ["null temperature", { ...validBody, temperature: null }, [["temperature"]]],
  ["null payload", null, [[]]],
  ["array payload", [], [[]]],
  ["string payload", "invalid", [[]]],
  ["numeric payload", 42, [[]]],
  ["boolean payload", true, [[]]],
  [
    "multiple invalid fields",
    { ...validBody, threadId: "", messages: [] },
    [["threadId"], ["messages"]],
  ],
] as const) {
  test(`returns validation issues for ${name} without calling external services`, async () => {
    const logMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretMock = vi.spyOn(SecretsManagerClient.prototype, "send");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stream = createMockStream();
    await invokeHandler(buildEvent(JSON.stringify(body)), stream);

    assert.equal(stream.metadata?.statusCode, 400);
    assert.equal(stream.metadata?.headers["Content-Type"], "application/json");
    assert.equal(
      stream.metadata?.headers["Access-Control-Allow-Origin"],
      "https://example.com",
    );
    assert.equal(stream.ended, true);
    const response = JSON.parse(stream.chunks.join(""));
    assert.equal(response.error, "Invalid request body");
    assert.deepEqual(
      response.issues.map((issue: { path: unknown[] }) => issue.path),
      paths,
    );
    for (const issue of response.issues) {
      assert.deepEqual(Object.keys(issue).sort(), ["message", "path"]);
      assert.equal(typeof issue.message, "string");
      assert.ok(issue.message.length > 0);
    }
    assert.deepEqual(logMock.mock.calls, [
      ["Request validation failed", { issues: response.issues }],
    ]);
    assert.equal(secretMock.mock.calls.length, 0);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
}

test("returns a validation issue for non-finite temperature", async () => {
  const stream = createMockStream();
  await invokeHandler(
    buildEvent(
      '{"threadId":"thread-123","messages":[{"role":"user","content":"Hi"}],"temperature":1e400}',
    ),
    stream,
  );
  assert.equal(stream.metadata?.statusCode, 400);
  const response = JSON.parse(stream.chunks.join(""));
  assert.equal(response.error, "Invalid request body");
  assert.deepEqual(
    response.issues.map((issue: { path: unknown[] }) => issue.path),
    [["temperature"]],
  );
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
          'event: response.created\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Hel"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"lo"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
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
    input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
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
            'event: response.failed\ndata: {"type":"response.failed","sequence_number":1,"response":{"error":{"message":"mock stream failure"}}}\n\n',
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
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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
  await vi.waitFor(() => assert.ok(resolveFetch));

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

  assert.equal(vi.getTimerCount(), 0);
  const pingCount = stream.chunks.filter((c) => c === ": ping\n\n").length;
  assert.ok(
    pingCount >= 2,
    `expected at least 2 heartbeat pings, got ${pingCount}`,
  );
});

const validRequest = (overrides: Record<string, unknown> = {}) =>
  buildEvent(
    JSON.stringify({
      threadId: "thread-123",
      messages: [{ role: "user", content: "Hi" }],
      ...overrides,
    }),
  );

for (const terminal of [
  "",
  'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
]) {
  test(`rejects ${terminal ? "incomplete" : "prematurely ended"} streams without done`, async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            fakeSseBody([
              'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}\n\n',
              'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Partial"}\n\n',
              terminal,
            ]),
          ),
      ),
    );
    const stream = createMockStream();
    await invokeHandler(validRequest(), stream);
    assert.deepEqual(
      parseSseEvents(stream.chunks.join("")).map((e) => e.event),
      ["delta", "error"],
    );
    assert.equal(stream.ended, true);
    assert.equal(vi.getTimerCount(), 0);
  });
}

test("uses the existing AWS secret key and honors model and temperature overrides", async () => {
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_SECRET_ID", "existing-secret");
  const secretMock = vi
    .spyOn(SecretsManagerClient.prototype, "send")
    .mockImplementation(async (command) => {
      assert.deepEqual(command.input, { SecretId: "existing-secret" });
      return {
        SecretString: JSON.stringify({ OPENAI_API_KEY: "existing-secret-key" }),
      };
    });
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer existing-secret-key",
      );
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, "gpt-4o");
      assert.equal(body.temperature, 0.2);
      assert.equal(body.store, false);
      return new Response(
        fakeSseBody(['data: {"type":"response.completed","response":{}}\n\n']),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const stream = createMockStream();
  await invokeHandler(
    validRequest({ model: "gpt-4o", temperature: 0.2 }),
    stream,
  );
  assert.equal(secretMock.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(parseSseEvents(stream.chunks.join("")).at(-1)?.event, "done");
});

test("does not retry upstream rate limits", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", fetchMock);
  await invokeHandler(validRequest(), createMockStream());
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("aborting an active request emits a timeout error and clears heartbeats", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(controller.signal);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
        controller.abort(new DOMException("Budget exceeded", "TimeoutError"));
      });
    }),
  );
  const stream = createMockStream();
  await invokeHandler(validRequest(), stream);
  assert.equal(timeout.mock.calls[0][0], 290_000);
  assert.deepEqual(parseSseEvents(stream.chunks.join("")), [
    {
      event: "error",
      data: { message: "Backend timed out while waiting for the AI response." },
    },
  ]);
  assert.equal(stream.ended, true);
  assert.equal(vi.getTimerCount(), 0);
});

test("preserves supported roles and maps developer to system at the SDK boundary", async () => {
  const messages = [
    { role: "system", content: "System" },
    { role: "developer", content: "Developer" },
    { role: "user", content: "" },
    { role: "assistant", content: "Reply" },
  ];
  const streamTextMock = vi.spyOn(ai, "streamText").mockReturnValue({
    fullStream: (async function* () {
      yield { type: "finish", finishReason: "stop" };
    })(),
  } as unknown as ReturnType<typeof ai.streamText>);
  const stream = createMockStream();
  await invokeHandler(validRequest({ messages }), stream);
  assert.equal(streamTextMock.mock.calls.length, 1);
  assert.deepEqual(
    streamTextMock.mock.calls[0][0].messages,
    messages.map(({ role, content }) => ({
      role: role === "developer" ? "system" : role,
      content,
    })),
  );
  assert.equal(parseSseEvents(stream.chunks.join("")).at(-1)?.event, "done");
});

test("preserves whitespace and accepts unknown fields and unbounded finite temperature", async () => {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, " custom-model ");
      assert.equal(body.temperature, 3);
      assert.equal(body.extra, undefined);
      return new Response(
        fakeSseBody(['data: {"type":"response.completed","response":{}}\n\n']),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const stream = createMockStream();
  await invokeHandler(
    validRequest({
      threadId: " ",
      model: " custom-model ",
      temperature: 3,
      extra: true,
    }),
    stream,
  );
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(parseSseEvents(stream.chunks.join("")).at(-1)?.event, "done");
});

for (const secret of [
  {},
  { SecretString: "null" },
  { SecretString: "{}" },
  { SecretString: '{"OPENAI_API_KEY":42}' },
  { SecretString: "{invalid}" },
]) {
  test(`returns a server error for invalid secret ${JSON.stringify(secret)}`, async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(
      async () => secret,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const logMock = vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = createMockStream();
    await invokeHandler(validRequest(), stream);
    assert.equal(stream.metadata?.statusCode, 500);
    assert.deepEqual(JSON.parse(stream.chunks.join("")), {
      error: "Server error",
    });
    assert.equal(stream.ended, true);
    assert.equal(fetchMock.mock.calls.length, 0);
    if (!secret.SecretString) {
      assert.equal(
        logMock.mock.calls[0]?.[1].error,
        "Invalid secret format: SecretString not found",
      );
    } else if (secret.SecretString !== "{invalid}") {
      assert.equal(
        logMock.mock.calls[0]?.[1].error,
        "Invalid secret format: OPENAI_API_KEY not found",
      );
    }
  });
}
