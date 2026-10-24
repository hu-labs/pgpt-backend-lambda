import { beforeEach, expect, test, vi } from "vitest";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import * as repo from "./conversations.js";
const id = "550e8400-e29b-41d4-a716-446655440000";
const mid = `1792846800000-${id}`;
const thread = {
  PK: "USER#a",
  SK: `THREAD#${id}`,
  threadId: id,
  title: "Test",
  createdAt: "2026-10-24T16:00:00.000Z",
  updatedAt: "2026-10-24T16:00:00.000Z",
};
const message = {
  PK: "USER#a",
  SK: `MSG#${id}#${mid}`,
  messageId: mid,
  threadId: id,
  role: "user",
  content: "Hi",
  createdAt: "now",
};

const conditional = () =>
  Object.assign(new Error("Missing"), {
    name: "ConditionalCheckFailedException",
  });
const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send");
beforeEach(() => {
  send.mockReset();
  process.env.DYNAMODB_TABLE_NAME = "test-conversations";
});

test("creates backend UUID thread metadata without exposing storage keys", async () => {
  send.mockResolvedValueOnce({} as never);
  const result = await repo.createThread("a");
  expect(result.threadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.title).toBe("New conversation");
  expect(result.createdAt).toBe(result.updatedAt);
  expect(result).not.toHaveProperty("PK");
  const command = send.mock.calls[0][0] as PutCommand;
  expect(command.input).toMatchObject({
    TableName: "test-conversations",
    ConditionExpression: "attribute_not_exists(PK)",
    Item: { PK: "USER#a", SK: `THREAD#${result.threadId}` },
  });
});

test("queries every thread page and sorts by updated time", async () => {
  const cursor = { PK: "USER#a", SK: "THREAD#page" };
  send
    .mockResolvedValueOnce({
      Items: [thread],
      LastEvaluatedKey: cursor,
    } as never)
    .mockResolvedValueOnce({
      Items: [{ ...thread, threadId: "new", updatedAt: "2026-10-25" }],
    } as never);
  const result = await repo.listThreads("a");
  expect(result.map((t) => t.threadId)).toEqual(["new", id]);
  const first = send.mock.calls[0][0] as QueryCommand;
  const second = send.mock.calls[1][0] as QueryCommand;
  expect(first.input.ExpressionAttributeValues).toEqual({
    ":pk": "USER#a",
    ":prefix": "THREAD#",
  });
  expect(first.input.ConsistentRead).toBe(true);
  expect(second.input.ExclusiveStartKey).toEqual(cursor);
  expect(result[0]).not.toHaveProperty("SK");
});

test("all ownership lookups use the caller partition and return null for absent rows", async () => {
  send.mockResolvedValueOnce({} as never);
  expect(await repo.getThread("b", id)).toBeNull();
  expect((send.mock.calls[0][0] as GetCommand).input).toMatchObject({
    Key: { PK: "USER#b", SK: `THREAD#${id}` },
    ConsistentRead: true,
  });
});

test("missing parents block every message read or mutation", async () => {
  send.mockResolvedValue({} as never);
  for (const action of [
    () => repo.addMessage("b", id, "user", "Hi"),
    () => repo.listMessages("b", id),
    () => repo.getRecentMessages("b", id),
    () => repo.editMessage("b", id, mid, "New"),
    () => repo.deleteMessage("b", id, mid),
    () => repo.deleteThread("b", id),
  ])
    await expect(action()).rejects.toBeInstanceOf(repo.NotFoundError);
  expect(
    send.mock.calls.every(([command]) => command instanceof GetCommand),
  ).toBe(true);
});

test("renames only existing metadata and returns a public object", async () => {
  send.mockResolvedValueOnce({
    Attributes: { ...thread, title: "New" },
  } as never);
  expect((await repo.renameThread("a", id, "New")).title).toBe("New");
  expect((send.mock.calls[0][0] as UpdateCommand).input).toMatchObject({
    ConditionExpression: "attribute_exists(PK)",
    Key: { PK: "USER#a", SK: `THREAD#${id}` },
    ReturnValues: "ALL_NEW",
  });
  send.mockRejectedValueOnce(conditional());
  await expect(repo.renameThread("b", id, "New")).rejects.toBeInstanceOf(
    repo.NotFoundError,
  );
});

test("paginates 50 messages, validates cursor scope and omits DynamoDB keys", async () => {
  const key = { PK: message.PK, SK: message.SK };
  send.mockResolvedValueOnce({ Item: thread } as never).mockResolvedValueOnce({
    Items: [message],
    LastEvaluatedKey: key,
  } as never);
  const page = await repo.listMessages("a", id);
  expect(page.messages[0]).not.toHaveProperty("PK");
  expect(page.nextCursor).not.toBeNull();
  expect((send.mock.calls[1][0] as QueryCommand).input).toMatchObject({
    Limit: 50,
    ScanIndexForward: true,
    ConsistentRead: true,
  });
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({ Items: [] } as never);
  expect(
    (await repo.listMessages("a", id, page.nextCursor!)).nextCursor,
  ).toBeNull();
  expect(
    (send.mock.calls[3][0] as QueryCommand).input.ExclusiveStartKey,
  ).toEqual(key);
  for (const cursor of [
    "bad",
    Buffer.from(JSON.stringify({ ...key, PK: "USER#b" })).toString("base64url"),
    Buffer.from(JSON.stringify({ ...key, SK: "MSG#other#" + mid })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ ...key, extra: true })).toString("base64url"),
  ]) {
    send.mockResolvedValueOnce({ Item: thread } as never);
    await expect(repo.listMessages("a", id, cursor)).rejects.toBeInstanceOf(
      repo.InvalidCursorError,
    );
  }
});

test("retrieves the latest 30 across the DynamoDB size boundary then restores chronology", async () => {
  const newest = Array.from({ length: 20 }, (_, i) => ({
    ...message,
    content: String(29 - i),
  }));
  const oldest = Array.from({ length: 10 }, (_, i) => ({
    ...message,
    content: String(9 - i),
  }));
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({
      Items: newest,
      LastEvaluatedKey: { PK: "USER#a", SK: "cursor" },
    } as never)
    .mockResolvedValueOnce({ Items: oldest } as never);
  const result = await repo.getRecentMessages("a", id);
  expect(result.map((m) => Number(m.content))).toEqual(
    Array.from({ length: 30 }, (_, i) => i),
  );
  expect((send.mock.calls[1][0] as QueryCommand).input).toMatchObject({
    Limit: 30,
    ScanIndexForward: false,
  });
  expect((send.mock.calls[2][0] as QueryCommand).input.Limit).toBe(10);
});

test("inserts messages and updates their parent atomically", async () => {
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({} as never);
  const result = await repo.addMessage("a", id, "user", "Hello");
  expect(result.messageId).toMatch(/^\d{13}-[0-9a-f-]{36}$/);
  const command = send.mock.calls[1][0] as TransactWriteCommand;
  expect(command).toBeInstanceOf(TransactWriteCommand);
  expect(command.input.TransactItems).toMatchObject([
    {
      Put: {
        Item: {
          PK: "USER#a",
          SK: `MSG#${id}#${result.messageId}`,
          content: "Hello",
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        Key: { PK: "USER#a", SK: `THREAD#${id}` },
        ConditionExpression: "attribute_exists(PK)",
      },
    },
  ]);
});

test("a parent deleted before the transaction produces not-found, while outages propagate", async () => {
  send.mockResolvedValueOnce({ Item: thread } as never).mockRejectedValueOnce(
    Object.assign(new Error("Cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "None" },
        { Code: "ConditionalCheckFailed" },
      ],
    }),
  );
  await expect(repo.addMessage("a", id, "user", "Hi")).rejects.toBeInstanceOf(
    repo.NotFoundError,
  );
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockRejectedValueOnce(new Error("Database down"));
  await expect(repo.addMessage("a", id, "user", "Hi")).rejects.toThrow(
    "Database down",
  );
});

test("edits only content and conditionally rejects missing messages", async () => {
  send.mockResolvedValueOnce({ Item: thread } as never).mockResolvedValueOnce({
    Attributes: { ...message, content: "Edited" },
  } as never);
  expect((await repo.editMessage("a", id, mid, "Edited")).content).toBe(
    "Edited",
  );
  expect((send.mock.calls[1][0] as UpdateCommand).input).toMatchObject({
    UpdateExpression: "SET content = :content",
    ConditionExpression: "attribute_exists(PK)",
  });
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockRejectedValueOnce(conditional());
  await expect(repo.deleteMessage("a", id, mid)).rejects.toBeInstanceOf(
    repo.NotFoundError,
  );
});

test("deletes every message page before deleting metadata", async () => {
  const second = { ...message, messageId: `1792846800001-${id}` };
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({
      Items: [message],
      LastEvaluatedKey: { PK: message.PK, SK: message.SK },
    } as never)
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({ Items: [second] } as never)
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce({} as never);
  await repo.deleteThread("a", id);
  const deletes = send.mock.calls
    .map(([c]) => c)
    .filter((c) => c instanceof DeleteCommand);
  expect(deletes.map((c) => c.input.Key?.SK)).toEqual([
    message.SK,
    `MSG#${id}#${second.messageId}`,
    thread.SK,
  ]);
});

test("failed message deletion keeps metadata for a retry", async () => {
  send
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({ Item: thread } as never)
    .mockResolvedValueOnce({ Items: [message] } as never)
    .mockRejectedValueOnce(new Error("Write failed"));
  await expect(repo.deleteThread("a", id)).rejects.toThrow("Write failed");
  expect(
    send.mock.calls.some(
      ([c]) => c instanceof DeleteCommand && c.input.Key?.SK === thread.SK,
    ),
  ).toBe(false);
});

test("missing configuration and unexpected errors fail rather than returning success", async () => {
  delete process.env.DYNAMODB_TABLE_NAME;
  await expect(repo.getThread("a", id)).rejects.toThrow(
    "DYNAMODB_TABLE_NAME is missing",
  );
  process.env.DYNAMODB_TABLE_NAME = "test-conversations";
  send.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(repo.renameThread("a", id, "New")).rejects.toThrow(
    "Unavailable",
  );
});
