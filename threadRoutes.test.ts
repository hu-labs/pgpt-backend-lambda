import { beforeEach, expect, test, vi } from "vitest";
import * as repo from "./conversations.js";
import { dispatchThreadRoute, type RequestEvent } from "./threadRoutes.js";

vi.mock("./conversations.js", async (original) => ({
  ...(await original<typeof import("./conversations.js")>()),
  createThread: vi.fn(),
  listThreads: vi.fn(),
  requireThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

const id = "550e8400-e29b-41d4-a716-446655440000";
const mid = `1792846800000-${id}`;

const thread = {
  threadId: id,
  title: "Test",
  createdAt: "now",
  updatedAt: "now",
};

const message = {
  threadId: id,
  messageId: mid,
  role: "user" as const,
  content: "Hello",
  createdAt: "now",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.createThread).mockResolvedValue(thread);
  vi.mocked(repo.listThreads).mockResolvedValue([thread]);
  vi.mocked(repo.requireThread).mockResolvedValue(thread);
  vi.mocked(repo.renameThread).mockResolvedValue(thread);
  vi.mocked(repo.listMessages).mockResolvedValue({
    messages: [message],
    nextCursor: null,
  });

  vi.mocked(repo.addMessage).mockResolvedValue(message);
  vi.mocked(repo.editMessage).mockResolvedValue(message);
});

const route = (
  httpMethod: string,
  path: string,
  body?: unknown,
  extra?: Partial<RequestEvent>,
) =>
  dispatchThreadRoute(
    {
      httpMethod,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...extra,
    },
    "trusted-sub",
  );

test("dispatches all thread operations with trusted identity", async () => {
  expect(await route("POST", "/threads", {})).toEqual({
    statusCode: 201,
    body: thread,
  });

  expect(repo.createThread).toHaveBeenCalledWith("trusted-sub", undefined);
  expect(await route("GET", "/threads")).toEqual({
    statusCode: 200,
    body: { threads: [thread] },
  });

  expect(await route("GET", `/threads/${id}`)).toEqual({
    statusCode: 200,
    body: thread,
  });

  expect(
    await route("PATCH", `/threads/${id}`, { title: " Renamed " }),
  ).toEqual({ statusCode: 200, body: thread });

  expect(repo.renameThread).toHaveBeenCalledWith("trusted-sub", id, "Renamed");
  expect(await route("DELETE", `/threads/${id}`)).toEqual({ statusCode: 204 });
  expect(repo.deleteThread).toHaveBeenCalledWith("trusted-sub", id);
});

test("dispatches message operations and forwards pagination", async () => {
  expect(
    (await route("POST", `/threads/${id}/messages`, { content: " Hello " }))
      .statusCode,
  ).toBe(201);

  expect(repo.addMessage).toHaveBeenCalledWith(
    "trusted-sub",
    id,
    "user",
    "Hello",
  );

  expect(
    (
      await route("GET", `/threads/${id}/messages`, undefined, {
        queryStringParameters: { cursor: "cursor" },
      })
    ).body,
  ).toEqual({ messages: [message], nextCursor: null });

  expect(repo.listMessages).toHaveBeenCalledWith("trusted-sub", id, "cursor");
  expect(
    (
      await route("PATCH", `/threads/${id}/messages/${mid}`, {
        content: " Edited ",
      })
    ).statusCode,
  ).toBe(200);

  expect(repo.editMessage).toHaveBeenCalledWith(
    "trusted-sub",
    id,
    mid,
    "Edited",
  );

  expect(await route("DELETE", `/threads/${id}/messages/${mid}`)).toEqual({
    statusCode: 204,
  });
});

for (const [method, path, body] of [
  ["GET", "/threads/bad", undefined],
  ["POST", "/threads", { title: " " }],
  ["POST", "/threads", { title: "x".repeat(101) }],
  ["POST", "/threads", { sub: "attacker" }],
  ["PATCH", `/threads/${id}`, {}],
  ["POST", `/threads/${id}/messages`, { content: "" }],
  ["POST", `/threads/${id}/messages`, { content: "x".repeat(5001) }],
  ["PATCH", `/threads/${id}/messages/bad`, { content: "text" }],
  [
    "PATCH",
    `/threads/${id}/messages/${mid}`,
    { role: "assistant", content: "text" },
  ],
] as const)
  test(`rejects invalid ${method} ${path} ${(JSON.stringify(body) ?? "undefined").slice(0, 60)}`, async () => {
    expect((await route(method, path, body)).statusCode).toBe(400);
  });

test("rejects absent and invalid JSON bodies", async () => {
  expect((await route("POST", "/threads")).statusCode).toBe(400);
  expect(
    (await route("POST", "/threads", undefined, { body: "{" })).statusCode,
  ).toBe(400);
});

test("returns 404 for absent or other-user resources and 500 for database errors", async () => {
  vi.mocked(repo.requireThread).mockRejectedValueOnce(new repo.NotFoundError());
  expect((await route("GET", `/threads/${id}`)).statusCode).toBe(404);
  vi.mocked(repo.editMessage).mockRejectedValueOnce(new repo.NotFoundError());
  expect(
    (await route("PATCH", `/threads/${id}/messages/${mid}`, { content: "Hi" }))
      .statusCode,
  ).toBe(404);

  vi.mocked(repo.listThreads).mockRejectedValueOnce(new Error("Database down"));
  expect((await route("GET", "/threads")).statusCode).toBe(500);
});

test("distinguishes unknown paths and unsupported methods", async () => {
  expect((await route("GET", "/other")).statusCode).toBe(404);
  for (const path of [
    "/threads",
    `/threads/${id}`,
    `/threads/${id}/messages`,
    `/threads/${id}/messages/${mid}`,
  ])
    expect((await route("PUT", path)).statusCode).toBe(405);
});
