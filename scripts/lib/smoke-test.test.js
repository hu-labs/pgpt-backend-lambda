import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { runSmoke, readChatStream, smokeConfig } from "./smoke-test.mjs";

const env = {
  SMOKE_ENVIRONMENT: "preview",
  SMOKE_TARGET: "test",
  TEST_API_URL: "https://example.com/test/chat",
  TEST_API_KEY: "api-secret",
  PUBLIC_API_URL: "https://public.example.com/api/v1/chat",
  COGNITO_USER_POOL_ID: "eu-west-2_example",
  COGNITO_CLIENT_ID: "client",
  COGNITO_USERNAME: "a",
  COGNITO_PASSWORD: "password-a",
  COGNITO_SECOND_USERNAME: "b",
  COGNITO_SECOND_PASSWORD: "password-b",
};

const login = vi.fn(async ({ username }) => ({
  idToken: `token-${username}`,
  sub: username,
}));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const streamResponse = (text) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 3)
          controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

function fixture({
  failRename = false,
  streamError = false,
  lostPersistence = false,
  cleanupError = false,
  leak = false,
  wrongIsolationStatus = false,
} = {}) {
  const threads = new Map();
  const calls = [];
  const fetchImpl = vi.fn(async (url, options) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/test|^\/api\/v1/, "");
    const token = options.headers.Authorization?.replace("Bearer ", "");
    const method = options.method;
    calls.push({ path, method, token, headers: options.headers });
    if (!token) return json({ message: "Unauthorized" }, 401);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const match = /^\/threads\/([^/]+)(?:\/messages(?:\/([^/]+))?)?$/.exec(
      path,
    );

    if (path === "/threads") {
      if (method === "POST") {
        const thread = {
          threadId: randomUUID(),
          title: body.title,
          owner: token,
          messages: [],
        };

        threads.set(thread.threadId, thread);

        return json(thread, 201);
      }

      return json({
        threads: [...threads.values()].filter((t) => leak || t.owner === token),
      });
    }
    if (path === "/chat") {
      const t = threads.get(body.threadId);
      if (!t || t.owner !== token)
        return json(
          { error: "Resource not found" },
          wrongIsolationStatus ? 403 : 404,
        );
      if (streamError)
        return streamResponse(
          'event: delta\ndata: {"content":"Partial"}\n\nevent: error\ndata: {"message":"Failed"}\n\n',
        );
      const user = {
        messageId: `1792846800000-${randomUUID()}`,
        role: "user",
        content: body.content,
      };

      const assistant = {
        messageId: `1792846800001-${randomUUID()}`,
        role: "assistant",
        content: "Héllo",
      };

      if (!lostPersistence) t.messages.push(user, assistant);

      return streamResponse(
        `: ping\r\n\r\nevent: delta\r\ndata: {"content":"Héllo"}\r\n\r\nevent: done\r\ndata: ${JSON.stringify({ userMessageId: user.messageId, assistantMessageId: assistant.messageId })}\r\n\r\n`,
      );
    }
    const thread = threads.get(match?.[1]);
    if (!thread || thread.owner !== token)
      return json({ error: "Not found" }, 404);
    if (!path.includes("/messages")) {
      if (method === "PATCH") {
        if (failRename) return json({ error: "Server error" }, 500);
        thread.title = body.title;
      }
      if (method === "DELETE") {
        if (cleanupError) return json({ error: "Server error" }, 500);
        threads.delete(thread.threadId);

        return new Response(null, { status: 204 });
      }

      return json(thread);
    }
    if (match[2]) {
      const message = thread.messages.find((m) => m.messageId === match[2]);
      if (method === "PATCH") {
        message.content = body.content;

        return json(message);
      }
      thread.messages = thread.messages.filter((m) => m.messageId !== match[2]);

      return new Response(null, { status: 204 });
    }
    if (method === "POST") {
      const message = {
        messageId: `1792846800000-${randomUUID()}`,
        role: "user",
        content: body.content,
      };

      thread.messages.push(message);

      return json(message, 201);
    }
    const offset = Number(u.searchParams.get("cursor") ?? 0);

    return json({
      messages: thread.messages.slice(offset, offset + 1),
      nextCursor:
        offset + 1 < thread.messages.length ? String(offset + 1) : null,
    });
  });

  return { fetchImpl, threads, calls };
}

test("CI mode checks both unauthenticated routes without invoking login", async () => {
  const f = fixture(),
    auth = vi.fn();

  await runSmoke({
    env: { ...env, COGNITO_PASSWORD: undefined },
    fetchImpl: f.fetchImpl,
    login: auth,
    log: () => {},
  });

  expect(auth).not.toHaveBeenCalled();
  expect(f.calls.map((c) => c.path)).toEqual(["/chat", "/threads"]);
  expect(f.calls.every((c) => c.headers["X-Api-Key"] === "api-secret")).toBe(
    true,
  );
});

test("authenticated mode verifies CRUD, paginated persisted SSE, both users and cleanup", async () => {
  const f = fixture(),
    logs = [];

  await runSmoke({
    env,
    args: ["--authenticated"],
    fetchImpl: f.fetchImpl,
    login,
    log: (line) => logs.push(line),
  });

  expect(f.threads.size).toBe(0);
  expect(f.calls.some((c) => c.path === "/chat" && c.token === "token-b")).toBe(
    true,
  );

  expect(
    f.calls.some((c) => c.method === "PATCH" && c.token === "token-b"),
  ).toBe(true);

  expect(logs.some((line) => line.includes("Cross-user list"))).toBe(true);
  expect(logs.join("\n")).not.toMatch(/api-secret|password-a|token-a|token-b/);
});

test("same runner supports production CloudFront without forwarding the direct API key", async () => {
  const f = fixture();
  await runSmoke({
    env: { ...env, SMOKE_ENVIRONMENT: "production", SMOKE_TARGET: "public" },
    args: ["--authenticated"],
    fetchImpl: f.fetchImpl,
    login,
    log: () => {},
  });

  expect(f.calls.every((c) => !c.headers["X-Api-Key"])).toBe(true);
  expect(f.fetchImpl.mock.calls[0][0]).toBe(
    "https://public.example.com/api/v1/chat",
  );
});

for (const options of [
  { failRename: true },
  { streamError: true },
  { lostPersistence: true },
  { leak: true },
  { wrongIsolationStatus: true },
]) {
  test(`failures trigger cleanup: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await expect(
      runSmoke({
        env,
        args: ["--authenticated"],
        fetchImpl: f.fetchImpl,
        login,
        log: () => {},
      }),
    ).rejects.toThrow();

    expect(f.threads.size).toBe(0);
  });
}

test("cleanup failure reports thread IDs and cannot yield a passing result", async () => {
  const f = fixture({ cleanupError: true }),
    logs = [];

  await expect(
    runSmoke({
      env,
      args: ["--authenticated"],
      fetchImpl: f.fetchImpl,
      login,
      log: (line) => logs.push(line),
    }),
  ).rejects.toThrow("cleanup failed");

  expect(logs.some((line) => line.includes("remove it manually"))).toBe(true);
});

test("second account is optional, but half credentials fail before requests", async () => {
  const f = fixture(),
    one = { ...env, COGNITO_SECOND_USERNAME: "", COGNITO_SECOND_PASSWORD: "" };

  await runSmoke({
    env: one,
    args: ["--authenticated"],
    fetchImpl: f.fetchImpl,
    login,
    log: () => {},
  });

  expect(f.threads.size).toBe(0);
  const fetchImpl = vi.fn();
  await expect(
    runSmoke({
      env: { ...one, COGNITO_SECOND_USERNAME: "b" },
      args: ["--authenticated"],
      fetchImpl,
    }),
  ).rejects.toThrow("COGNITO_SECOND_PASSWORD");

  expect(fetchImpl).not.toHaveBeenCalled();
});

test("aliases of the same Cognito user cannot pass cross-user checks", async () => {
  const f = fixture();
  await expect(
    runSmoke({
      env,
      args: ["--authenticated"],
      fetchImpl: f.fetchImpl,
      login: async () => ({ idToken: "token", sub: "same" }),
      log: () => {},
    }),
  ).rejects.toThrow("two different Cognito users");

  expect(f.threads.size).toBe(0);
});

test("login failure creates no threads", async () => {
  const f = fixture();
  await expect(
    runSmoke({
      env,
      args: ["--authenticated"],
      fetchImpl: f.fetchImpl,
      login: async () => {
        throw new Error("Login failed");
      },
      log: () => {},
    }),
  ).rejects.toThrow("Login failed");

  expect(f.calls).toHaveLength(2);
});

test("rejects wrong boundary statuses and HTML error substitutions", async () => {
  for (const response of [
    json({ error: "Wrong" }, 200),
    new Response("html", { status: 401 }),
  ]) {
    await expect(
      runSmoke({ env, fetchImpl: async () => response, log: () => {} }),
    ).rejects.toThrow();
  }
});

test("validates arguments, URLs, API keys and authenticated configuration", () => {
  expect(() => smokeConfig(env, ["--typo"])).toThrow("Usage");
  expect(() => smokeConfig({ ...env, TEST_API_KEY: "" })).toThrow(
    "TEST_API_KEY",
  );

  expect(() =>
    smokeConfig({ ...env, TEST_API_URL: "http://example.com/chat" }),
  ).toThrow("HTTPS");

  expect(() =>
    smokeConfig({ ...env, COGNITO_PASSWORD: "" }, ["--authenticated"]),
  ).toThrow("COGNITO_PASSWORD");
});

for (const text of [
  'event: delta\ndata: {"content":"Partial"}\n\n',
  'event: error\ndata: {"message":"Failure"}\n\n',
  "event: done\ndata: {}\n\n",
  'event: delta\ndata: {"content":"Hi"}\n\nevent: done\ndata: {"userMessageId":"u","assistantMessageId":"a"}\n\nevent: delta\ndata: {"content":"Late"}\n\n',
  'event: delta\ndata: {"content":"Hi"}',
])
  test(`rejects malformed or incomplete SSE ${text.slice(0, 50)}`, async () => {
    await expect(readChatStream(streamResponse(text))).rejects.toThrow();
  });
