//
// Called by smoke-test.sh
//
// Depends on:  cognito-login.mjs
// Accompanying scripts available to load environment variables:
// - setenv-preview.sh
// - setenv-production.sh

import { pathToFileURL } from "node:url";
import { loginCognito } from "./cognito-login.mjs";

export function smokeConfig(env, args = []) {
  if (args.length > 1 || (args.length && args[0] !== "--authenticated"))
    throw new Error("Usage: scripts/smoke-test.sh [--authenticated]");
  const target = env.SMOKE_TARGET;
  if (!["test", "public"].includes(target))
    throw new Error("SMOKE_TARGET must be test or public.");
  const value = target === "test" ? env.TEST_API_URL : env.PUBLIC_API_URL;
  if (!value)
    throw new Error(
      `${target === "test" ? "TEST_API_URL" : "PUBLIC_API_URL"} is missing.`,
    );
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTPS API URL without credentials, query or fragment.",
    );
  const base = url.href.replace(/\/$/, "").replace(/\/chat$/, "");
  if (target === "test" && !env.TEST_API_KEY)
    throw new Error("TEST_API_KEY is missing.");
  const authenticated = args[0] === "--authenticated";
  const secondary = Boolean(
    env.COGNITO_SECOND_USERNAME || env.COGNITO_SECOND_PASSWORD,
  );

  if (authenticated) {
    for (const key of [
      "COGNITO_USER_POOL_ID",
      "COGNITO_CLIENT_ID",
      "COGNITO_USERNAME",
      "COGNITO_PASSWORD",
      ...(secondary
        ? ["COGNITO_SECOND_USERNAME", "COGNITO_SECOND_PASSWORD"]
        : []),
    ]) {
      if (!env[key])
        throw new Error(`${key} is required for authenticated tests.`);
    }
  }

  return {
    base,
    target,
    authenticated,
    secondary,
    environment: env.SMOKE_ENVIRONMENT ?? "unknown",
    apiKey: target === "test" ? env.TEST_API_KEY : undefined,
  };
}

export async function readChatStream(response) {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error("Chat did not return text/event-stream.");
  let buffer = "",
    content = "",
    done;
  const decoder = new TextDecoder();
  const consume = (block) => {
    const lines = block.split(/\r?\n/);
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();

    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!event) return;
    if (done) throw new Error("Chat emitted an event after done.");
    const payload = JSON.parse(data);
    if (event === "error") throw new Error("Chat emitted an SSE error event.");
    if (event === "delta") {
      if (typeof payload.content !== "string")
        throw new Error("Invalid chat delta.");
      content += payload.content;
    } else if (event === "done") {
      if (
        typeof payload.userMessageId !== "string" ||
        typeof payload.assistantMessageId !== "string" ||
        !payload.userMessageId ||
        !payload.assistantMessageId
      )
        throw new Error("Chat done event is missing stored message IDs.");
      done = payload;
    } else throw new Error(`Unexpected chat event: ${event}`);
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      consume(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.decode();
  if (!done || !content.trim() || buffer.trim())
    throw new Error(
      "Chat ended without a complete, nonempty reply and done event.",
    );

  return { content, ...done };
}

export async function runSmoke({
  env = process.env,
  args = [],
  fetchImpl = fetch,
  login = loginCognito,
  log = console.log,
  signal,
} = {}) {
  const config = smokeConfig(env, args);
  const headers = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { "X-Api-Key": config.apiKey } : {}),
  };

  const request = async (
    method,
    path,
    expected,
    token,
    body,
    { streaming = false, cleanup = false } = {},
  ) => {
    const timeout = AbortSignal.timeout(streaming ? 330_000 : 30_000);
    const response = await fetchImpl(config.base + path, {
      method,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(streaming ? { Accept: "text/event-stream" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal && !cleanup ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });

    if (response.status !== expected) {
      await response.body?.cancel();
      throw new Error(
        `${method} ${path}: expected ${expected}, got ${response.status}.`,
      );
    }
    if (streaming) return response;
    if (expected === 204) {
      if ((await response.text()).length)
        throw new Error(`${method} ${path}: expected an empty 204 body.`);

      return undefined;
    }
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error(`${method} ${path}: expected JSON.`);

    return response.json();
  };

  for (const path of ["/chat", "/threads"]) {
    const body = await request("POST", path, 401, undefined, {});
    if (typeof (body.message ?? body.error) !== "string")
      throw new Error("Invalid authentication error response.");
  }
  log(
    `Authentication boundary passed (${config.environment}/${config.target}).`,
  );

  if (!config.authenticated) return;

  const credentials = (second = false) => ({
    poolId: env.COGNITO_USER_POOL_ID,
    clientId: env.COGNITO_CLIENT_ID,
    username: env[second ? "COGNITO_SECOND_USERNAME" : "COGNITO_USERNAME"],
    password: env[second ? "COGNITO_SECOND_PASSWORD" : "COGNITO_PASSWORD"],
    label: second ? "Second account" : "Primary account",
  });

  const primary = await login(credentials());
  const secondary = config.secondary
    ? await login(credentials(true))
    : undefined;

  if (secondary && secondary.sub === primary.sub)
    throw new Error("Cross-user tests require two different Cognito users.");
  const resources = [];
  const create = async (token) => {
    const thread = await request("POST", "/threads", 201, token, {
      title: "Local smoke test",
    });

    if (!/^[0-9a-f-]{36}$/i.test(thread.threadId ?? ""))
      throw new Error("Create thread returned no valid ID.");
    resources.push({ id: thread.threadId, token });

    return thread;
  };

  const messages = async (id, token) => {
    const result = [];
    let cursor;
    const seen = new Set();
    do {
      const page = await request(
        "GET",
        `/threads/${id}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        200,
        token,
      );

      if (
        !Array.isArray(page.messages) ||
        !(page.nextCursor === null || typeof page.nextCursor === "string")
      )
        throw new Error("Invalid messages page.");
      result.push(...page.messages);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Message pagination repeated a cursor.");
      seen.add(cursor);
    } while (cursor);

    return result;
  };

  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  let failure;
  try {
    const token = primary.idToken;
    const thread = await create(token);
    const path = `/threads/${thread.threadId}`;
    check(
      (await request("GET", "/threads", 200, token)).threads.some(
        (t) => t.threadId === thread.threadId,
      ),
      "Created thread is missing from the thread list.",
    );

    check(
      (await request("GET", path, 200, token)).threadId === thread.threadId,
      "Fetched thread ID differs.",
    );

    check(
      (
        await request("PATCH", path, 200, token, {
          title: "Renamed smoke test",
        })
      ).title === "Renamed smoke test",
      "Thread rename failed.",
    );

    const added = await request("POST", `${path}/messages`, 201, token, {
      content: "Temporary user message",
    });

    check(
      typeof added.messageId === "string" && added.role === "user",
      "Add message failed.",
    );

    check(
      (
        await request(
          "PATCH",
          `${path}/messages/${added.messageId}`,
          200,
          token,
          { content: "Edited temporary message" },
        )
      ).content === "Edited temporary message",
      "Message edit failed.",
    );

    check(
      (await messages(thread.threadId, token)).some(
        (m) =>
          m.messageId === added.messageId &&
          m.content === "Edited temporary message",
      ),
      "Edited message was not persisted.",
    );

    await request("DELETE", `${path}/messages/${added.messageId}`, 204, token);
    check(
      !(await messages(thread.threadId, token)).some(
        (m) => m.messageId === added.messageId,
      ),
      "Message deletion was not persisted.",
    );

    log("Thread and message CRUD passed.");

    const prompt = "Reply with a short greeting.";
    const streamed = await readChatStream(
      await request(
        "POST",
        "/chat",
        200,
        token,
        { threadId: thread.threadId, content: prompt },
        { streaming: true },
      ),
    );

    const stored = await messages(thread.threadId, token);
    check(
      stored.some(
        (m) =>
          m.messageId === streamed.userMessageId &&
          m.role === "user" &&
          m.content === prompt,
      ),
      "Chat user message was not persisted.",
    );

    check(
      stored.some(
        (m) =>
          m.messageId === streamed.assistantMessageId &&
          m.role === "assistant" &&
          m.content === streamed.content,
      ),
      "Stored assistant reply differs from streamed text.",
    );

    log("Streaming completion and message persistence passed.");

    if (secondary) {
      const other = secondary.idToken;
      const secondThread = await create(other);
      check(
        !(await request("GET", "/threads", 200, other)).threads.some(
          (t) => t.threadId === thread.threadId,
        ),
        "Second account can list the primary thread.",
      );

      check(
        !(await request("GET", "/threads", 200, token)).threads.some(
          (t) => t.threadId === secondThread.threadId,
        ),
        "Primary account can list the second thread.",
      );

      for (const [method, route, body] of [
        ["GET", path],
        ["PATCH", path, { title: "Forbidden" }],
        ["DELETE", path],
        ["GET", `${path}/messages`],
        ["POST", `${path}/messages`, { content: "Forbidden" }],
        [
          "PATCH",
          `${path}/messages/${streamed.userMessageId}`,
          { content: "Forbidden" },
        ],
        ["DELETE", `${path}/messages/${streamed.userMessageId}`],
        ["POST", "/chat", { threadId: thread.threadId, content: "Forbidden" }],
      ])
        await request(method, route, 404, other, body);
      await request("GET", `/threads/${secondThread.threadId}`, 404, token);
      await request("DELETE", `/threads/${secondThread.threadId}`, 404, token);
      check(
        (await request("GET", path, 200, token)).title === "Renamed smoke test",
        "Cross-user access changed the primary thread.",
      );

      check(
        JSON.stringify(await messages(thread.threadId, token)) ===
          JSON.stringify(stored),
        "Cross-user access changed the primary messages.",
      );

      log("Cross-user list, read, write and chat isolation passed.");
    } else log("Cross-user checks skipped: no second account configured.");
  } catch (error) {
    failure = error;
  } finally {
    for (const resource of resources) {
      try {
        await request(
          "DELETE",
          `/threads/${resource.id}`,
          204,
          resource.token,
          undefined,
          { cleanup: true },
        );

        await request(
          "GET",
          `/threads/${resource.id}`,
          404,
          resource.token,
          undefined,
          { cleanup: true },
        );
      } catch {
        log(
          `Cleanup failed for temporary thread ${resource.id}; remove it manually.`,
        );

        failure ??= new Error("Temporary thread cleanup failed.");
      }
    }
  }
  if (failure) throw failure;
  log(
    `Authenticated smoke test passed (${config.environment}/${config.target}); temporary threads deleted.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await runSmoke({ args: process.argv.slice(2), signal: controller.signal });
  } catch (error) {
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
