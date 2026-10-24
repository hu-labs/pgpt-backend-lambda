import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

export interface Thread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  messageId: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export class NotFoundError extends Error {}
export class InvalidCursorError extends Error {}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const tableName = () => {
  const name = process.env.DYNAMODB_TABLE_NAME;
  if (!name) throw new Error("DYNAMODB_TABLE_NAME is missing");
  return name;
};

const userPK = (sub: string) => `USER#${sub}`;

const threadKey = (sub: string, threadId: string) => ({
  PK: userPK(sub),
  SK: `THREAD#${threadId}`,
});

const messageKey = (sub: string, threadId: string, messageId: string) => ({
  PK: userPK(sub),
  SK: `MSG#${threadId}#${messageId}`,
});

const toThread = (item: Record<string, unknown>): Thread => ({
  threadId: item.threadId as string,
  title: item.title as string,
  createdAt: item.createdAt as string,
  updatedAt: item.updatedAt as string,
});

const toMessage = (item: Record<string, unknown>): Message => ({
  messageId: item.messageId as string,
  threadId: item.threadId as string,
  role: item.role as Message["role"],
  content: item.content as string,
  createdAt: item.createdAt as string,
});

async function existingUpdate(command: UpdateCommand | DeleteCommand) {
  try {
    return await db.send(command);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      throw new NotFoundError("Resource not found");
    throw error;
  }
}

export async function createThread(
  sub: string,
  title = "New conversation",
): Promise<Thread> {
  const now = new Date().toISOString();
  const thread = {
    threadId: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
  };
  await db.send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...threadKey(sub, thread.threadId), ...thread },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return thread;
}

export async function listThreads(sub: string): Promise<Thread[]> {
  const threads: Thread[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result: QueryCommandOutput = await db.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": userPK(sub), ":prefix": "THREAD#" },
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }),
    );
    threads.push(...(result.Items ?? []).map(toThread));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return threads.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.threadId.localeCompare(b.threadId),
  );
}

export async function getThread(
  sub: string,
  threadId: string,
): Promise<Thread | null> {
  const result = await db.send(
    new GetCommand({
      TableName: tableName(),
      Key: threadKey(sub, threadId),
      ConsistentRead: true,
    }),
  );
  return result.Item ? toThread(result.Item) : null;
}

export async function requireThread(
  sub: string,
  threadId: string,
): Promise<Thread> {
  const thread = await getThread(sub, threadId);
  if (!thread) throw new NotFoundError("Thread not found");
  return thread;
}

export async function renameThread(
  sub: string,
  threadId: string,
  title: string,
): Promise<Thread> {
  const result = await existingUpdate(
    new UpdateCommand({
      TableName: tableName(),
      Key: threadKey(sub, threadId),
      UpdateExpression: "SET title = :title, updatedAt = :now",
      ExpressionAttributeValues: {
        ":title": title,
        ":now": new Date().toISOString(),
      },
      ConditionExpression: "attribute_exists(PK)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return toThread(result.Attributes!);
}
const cursorSchema = z.object({ PK: z.string(), SK: z.string() }).strict();

function decodeCursor(
  cursor: string | undefined,
  sub: string,
  threadId: string,
) {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const key = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    const prefix = `MSG#${threadId}#`;
    if (
      key.PK !== userPK(sub) ||
      !key.SK.startsWith(prefix) ||
      !/^\d{13}-[0-9a-f-]{36}$/i.test(key.SK.slice(prefix.length))
    )
      throw new Error();
    return key;
  } catch {
    throw new InvalidCursorError("Invalid cursor");
  }
}

export async function listMessages(
  sub: string,
  threadId: string,
  cursor?: string,
) {
  await requireThread(sub, threadId);
  const result = await db.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": userPK(sub),
        ":prefix": `MSG#${threadId}#`,
      },
      ScanIndexForward: true,
      ConsistentRead: true,
      Limit: 50,
      ExclusiveStartKey: decodeCursor(cursor, sub, threadId),
    }),
  );
  return {
    messages: (result.Items ?? []).map(toMessage),
    nextCursor: result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString(
          "base64url",
        )
      : null,
  };
}

export async function getRecentMessages(
  sub: string,
  threadId: string,
): Promise<Message[]> {
  await requireThread(sub, threadId);
  const messages: Message[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result: QueryCommandOutput = await db.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": userPK(sub),
          ":prefix": `MSG#${threadId}#`,
        },
        ScanIndexForward: false,
        ConsistentRead: true,
        Limit: 30 - messages.length,
        ExclusiveStartKey: cursor,
      }),
    );
    messages.push(...(result.Items ?? []).map(toMessage));
    cursor = result.LastEvaluatedKey;
  } while (cursor && messages.length < 30);
  return messages.reverse();
}

export async function addMessage(
  sub: string,
  threadId: string,
  role: Message["role"],
  content: string,
): Promise<Message> {
  await requireThread(sub, threadId);
  const now = Date.now();
  const message: Message = {
    messageId: `${now.toString().padStart(13, "0")}-${randomUUID()}`,
    threadId,
    role,
    content,
    createdAt: new Date(now).toISOString(),
  };
  // Commit the message and parent timestamp together; a missing parent cannot create an orphan.
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(),
              Item: {
                ...messageKey(sub, threadId, message.messageId),
                ...message,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: threadKey(sub, threadId),
              UpdateExpression: "SET updatedAt = :now",
              ExpressionAttributeValues: { ":now": message.createdAt },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException" &&
      "CancellationReasons" in error &&
      (error.CancellationReasons as { Code?: string }[] | undefined)?.[1]
        ?.Code === "ConditionalCheckFailed"
    )
      throw new NotFoundError("Thread not found");
    throw error;
  }
  return message;
}

export async function editMessage(
  sub: string,
  threadId: string,
  messageId: string,
  content: string,
): Promise<Message> {
  await requireThread(sub, threadId);
  const result = await existingUpdate(
    new UpdateCommand({
      TableName: tableName(),
      Key: messageKey(sub, threadId, messageId),
      UpdateExpression: "SET content = :content",
      ExpressionAttributeValues: { ":content": content },
      ConditionExpression: "attribute_exists(PK)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return toMessage(result.Attributes!);
}

export async function deleteMessage(
  sub: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  await requireThread(sub, threadId);
  await existingUpdate(
    new DeleteCommand({
      TableName: tableName(),
      Key: messageKey(sub, threadId, messageId),
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

export async function deleteThread(
  sub: string,
  threadId: string,
): Promise<void> {
  await requireThread(sub, threadId);
  let cursor: string | undefined;
  do {
    const page = await listMessages(sub, threadId, cursor);
    for (const message of page.messages)
      await db.send(
        new DeleteCommand({
          TableName: tableName(),
          Key: messageKey(sub, threadId, message.messageId),
        }),
      );
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  await existingUpdate(
    new DeleteCommand({
      TableName: tableName(),
      Key: threadKey(sub, threadId),
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}
