import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../../../core/models/agent";
import {
  agentMcpElicitationRequestMatches,
  enqueueAgentMcpElicitationRequest,
  readMcpElicitationRequest,
  removeAgentMcpElicitationRequest,
} from "./mcpElicitation";

const formMessage = (params: Record<string, unknown> = {}): AgentMessage => ({
  id: 27,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-a",
    turnId: "turn-a",
    serverName: "calendar",
    mode: "form",
    message: "Choose how the event should be created.",
    requestedSchema: {
      type: "object",
      required: ["title", "calendar", "reminders"],
      properties: {
        title: {
          type: "string",
          title: "Event title",
          minLength: 3,
          maxLength: 80,
          default: "Planning",
        },
        calendar: {
          type: "string",
          oneOf: [
            { const: "work", title: "Work" },
            { const: "personal", title: "Personal" },
          ],
          default: "work",
        },
        duration: {
          type: "integer",
          minimum: 15,
          maximum: 240,
          default: 30,
        },
        private: { type: "boolean", default: true },
        reminders: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "string", enum: ["email", "popup"] },
          default: ["popup"],
        },
      },
    },
    ...params,
  },
});

describe("MCP elicitation parsing", () => {
  it("normalizes every standard form field into renderer-safe controls", () => {
    const request = readMcpElicitationRequest(
      formMessage(),
      "task-a",
      "pending-a",
      "run-a",
    );

    expect(request).toMatchObject({
      requestId: 27,
      pendingInputId: "pending-a",
      runId: "run-a",
      taskId: "task-a",
      serverName: "calendar",
      message: "Choose how the event should be created.",
    });
    expect(request?.fields).toEqual([
      expect.objectContaining({
        kind: "text",
        name: "title",
        label: "Event title",
        required: true,
        minLength: 3,
        maxLength: 80,
        defaultValue: "Planning",
      }),
      expect.objectContaining({
        kind: "select",
        name: "calendar",
        required: true,
        defaultValue: "work",
        options: [
          { value: "work", label: "Work" },
          { value: "personal", label: "Personal" },
        ],
      }),
      expect.objectContaining({
        kind: "number",
        name: "duration",
        integer: true,
        minimum: 15,
        maximum: 240,
        defaultValue: 30,
      }),
      expect.objectContaining({
        kind: "boolean",
        name: "private",
        defaultValue: true,
      }),
      expect.objectContaining({
        kind: "multi-select",
        name: "reminders",
        required: true,
        minItems: 1,
        maxItems: 2,
        defaultValue: ["popup"],
      }),
    ]);
  });

  it("preserves an omitted optional boolean instead of coercing it to false", () => {
    const request = readMcpElicitationRequest(
      formMessage({
        requestedSchema: {
          type: "object",
          properties: { notify: { type: "boolean" } },
        },
      }),
      "task-a",
      "pending-a",
      "run-a",
    );

    expect(request?.fields).toEqual([
      expect.objectContaining({
        kind: "boolean",
        name: "notify",
        defaultValue: null,
      }),
    ]);
  });

  it("rejects non-form modes and keeps unknown field types visible as unsupported", () => {
    expect(readMcpElicitationRequest(
      formMessage({ mode: "url" }),
      "task-a",
      "pending-a",
      "run-a",
    )).toBeNull();

    const request = readMcpElicitationRequest(
      formMessage({
        requestedSchema: {
          type: "object",
          properties: { nested: { type: "object", title: "Nested" } },
        },
      }),
      "task-a",
      "pending-a",
      "run-a",
    );
    expect(request?.fields).toEqual([
      expect.objectContaining({
        kind: "unsupported",
        name: "nested",
        schemaType: "object",
      }),
    ]);
  });

  it("matches resolution events by durable pending-input identity", () => {
    const request = readMcpElicitationRequest(
      formMessage(),
      "task-a",
      "pending-a",
      "run-a",
    );
    expect(request).not.toBeNull();
    expect(agentMcpElicitationRequestMatches(request, {
      requestId: "27",
      pendingInputId: "pending-a",
      runId: "run-a",
      taskId: "task-a",
    })).toBe(true);
    expect(agentMcpElicitationRequestMatches(request, {
      requestId: 27,
      pendingInputId: "pending-b",
      runId: "run-a",
      taskId: "task-a",
    })).toBe(false);
  });

  it("queues concurrent requests and advances after the first one resolves", () => {
    const first = readMcpElicitationRequest(
      formMessage(),
      "task-a",
      "pending-a",
      "run-a",
    );
    const second = readMcpElicitationRequest(
      { ...formMessage(), id: 28 },
      "task-a",
      "pending-b",
      "run-a",
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const queued = enqueueAgentMcpElicitationRequest(
      enqueueAgentMcpElicitationRequest([], first!),
      second!,
    );
    expect(enqueueAgentMcpElicitationRequest(queued, first!)).toBe(queued);
    expect(queued.map((request) => request.pendingInputId)).toEqual([
      "pending-a",
      "pending-b",
    ]);

    const remaining = removeAgentMcpElicitationRequest(queued, first!);
    expect(remaining.map((request) => request.pendingInputId)).toEqual(["pending-b"]);
  });
});
