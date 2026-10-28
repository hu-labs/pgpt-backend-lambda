import { z } from "zod";
import * as conversations from "./conversations.js";

export interface RequestEvent {
  body?: string | null;
  path?: string;
  httpMethod?: string;
  stageVariables?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { claims?: { sub?: string } } };
}
export interface RouteResponse {
  statusCode: number;
  body?: unknown;
}
export const contentSchema = z.string().trim().min(1).max(5000);
const titleSchema = z.string().trim().min(1).max(100);
const presetTextSchema = z.string().trim().min(1).max(5000);
const messageIdSchema = z
  .string()
  .regex(
    /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

export function requestBody(event: RequestEvent): unknown {
  if (!event.body) throw new SyntaxError("Missing request body");

  return JSON.parse(event.body);
}

export function routeError(error: unknown): RouteResponse {
  if (error instanceof conversations.NotFoundError)
    return { statusCode: 404, body: { error: "Resource not found" } };
  if (
    error instanceof SyntaxError ||
    error instanceof z.ZodError ||
    error instanceof conversations.InvalidCursorError
  )
    return { statusCode: 400, body: { error: "Invalid request" } };
  console.error("Request failed", error);

  return { statusCode: 500, body: { error: "Server error" } };
}

export async function dispatchThreadRoute(
  event: RequestEvent,
  sub: string,
): Promise<RouteResponse> {
  const path = event.path ?? "";
  const method = event.httpMethod;
  const presetMatch = /^\/presets(?:\/([^/]+))?$/.exec(path);
  const match = /^\/threads(?:\/([^/]+)(?:\/(messages)(?:\/([^/]+))?)?)?$/.exec(
    path,
  );

  try {
    if (presetMatch) {
      const [, rawPresetId] = presetMatch;
      if (!rawPresetId) {
        if (method === "GET") {
          return {
            statusCode: 200,
            body: { presets: await conversations.listPresets(sub) },
          };
        }
        if (method === "POST") {
          const body = z
            .object({ title: titleSchema, text: presetTextSchema })
            .strict()
            .parse(requestBody(event));

          return {
            statusCode: 201,
            body: await conversations.createPreset(sub, body.title, body.text),
          };
        }
      } else {
        const presetId = z.uuid().parse(rawPresetId);
        if (method === "PATCH") {
          const body = z
            .object({
              title: titleSchema.optional(),
              text: presetTextSchema.optional(),
            })
            .strict()
            .refine(
              (value) => value.title !== undefined || value.text !== undefined,
            )
            .parse(requestBody(event));

          return {
            statusCode: 200,
            body: await conversations.updatePreset(sub, presetId, body),
          };
        }
        if (method === "DELETE") {
          await conversations.deletePreset(sub, presetId);

          return { statusCode: 204 };
        }
      }

      return { statusCode: 405, body: { error: "Method not allowed" } };
    }

    if (!match) return { statusCode: 404, body: { error: "Route not found" } };
    const [, rawThreadId, messages, rawMessageId] = match;
    if (!rawThreadId) {
      if (method === "GET")
        return {
          statusCode: 200,
          body: { threads: await conversations.listThreads(sub) },
        };
      if (method === "POST") {
        const body = z
          .object({ title: titleSchema.optional() })
          .strict()
          .parse(requestBody(event));

        return {
          statusCode: 201,
          body: await conversations.createThread(sub, body.title),
        };
      }
    } else {
      const threadId = z.uuid().parse(rawThreadId);
      if (!messages) {
        if (method === "GET")
          return {
            statusCode: 200,
            body: await conversations.requireThread(sub, threadId),
          };
        if (method === "PATCH") {
          const body = z
            .object({ title: titleSchema })
            .strict()
            .parse(requestBody(event));

          return {
            statusCode: 200,
            body: await conversations.renameThread(sub, threadId, body.title),
          };
        }
        if (method === "DELETE") {
          await conversations.deleteThread(sub, threadId);

          return { statusCode: 204 };
        }
      } else if (!rawMessageId) {
        if (method === "GET")
          return {
            statusCode: 200,
            body: await conversations.listMessages(
              sub,
              threadId,
              event.queryStringParameters?.cursor,
            ),
          };
        if (method === "POST") {
          const body = z
            .object({ content: contentSchema })
            .strict()
            .parse(requestBody(event));

          return {
            statusCode: 201,
            body: await conversations.addMessage(
              sub,
              threadId,
              "user",
              body.content,
            ),
          };
        }
      } else {
        const messageId = messageIdSchema.parse(rawMessageId);
        if (method === "PATCH") {
          const body = z
            .object({ content: contentSchema })
            .strict()
            .parse(requestBody(event));

          return {
            statusCode: 200,
            body: await conversations.editMessage(
              sub,
              threadId,
              messageId,
              body.content,
            ),
          };
        }
        if (method === "DELETE") {
          await conversations.deleteMessage(sub, threadId, messageId);

          return { statusCode: 204 };
        }
      }
    }

    return { statusCode: 405, body: { error: "Method not allowed" } };
  } catch (error) {
    return routeError(error);
  }
}
