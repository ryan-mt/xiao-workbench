import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentMcpElicitationField,
  AgentMcpElicitationRequest,
} from "../../../core/models/agent";
import {
  initialMcpElicitationDraft,
  McpElicitationDock,
  mcpElicitationContent,
  validateMcpElicitationDraft,
} from "./McpElicitationDock";

const fields: AgentMcpElicitationField[] = [
  {
    kind: "text",
    name: "title",
    label: "Event title",
    description: "Shown to attendees",
    required: true,
    format: "text",
    minLength: 3,
    maxLength: 80,
    defaultValue: "Planning",
  },
  {
    kind: "select",
    name: "calendar",
    label: "Calendar",
    description: "",
    required: true,
    options: [
      { value: "work", label: "Work" },
      { value: "personal", label: "Personal" },
    ],
    defaultValue: "work",
  },
  {
    kind: "number",
    name: "duration",
    label: "Duration",
    description: "Minutes",
    required: true,
    integer: true,
    minimum: 15,
    maximum: 240,
    defaultValue: 30,
  },
  {
    kind: "boolean",
    name: "private",
    label: "Private event",
    description: "Hide details",
    required: false,
    defaultValue: false,
  },
  {
    kind: "multi-select",
    name: "reminders",
    label: "Reminders",
    description: "",
    required: true,
    options: [
      { value: "email", label: "Email" },
      { value: "popup", label: "Popup" },
    ],
    minItems: 1,
    maxItems: 2,
    defaultValue: ["popup"],
  },
];

const request: AgentMcpElicitationRequest = {
  requestId: 27,
  pendingInputId: "pending-a",
  runId: "run-a",
  taskId: "task-a",
  threadId: "thread-a",
  turnId: "turn-a",
  serverName: "calendar",
  message: "Choose how the event should be created.",
  fields,
  receivedAt: 1,
};

describe("MCP elicitation form", () => {
  it("starts from schema defaults and serializes typed MCP content", () => {
    const draft = initialMcpElicitationDraft(fields);

    expect(draft).toEqual({
      title: "Planning",
      calendar: "work",
      duration: "30",
      private: false,
      reminders: ["popup"],
    });
    expect(validateMcpElicitationDraft(fields, draft)).toEqual({});
    expect(mcpElicitationContent(fields, draft)).toEqual({
      title: "Planning",
      calendar: "work",
      duration: 30,
      private: false,
      reminders: ["popup"],
    });
  });

  it("blocks missing, out-of-range, and over-selected values", () => {
    const invalid = {
      ...initialMcpElicitationDraft(fields),
      title: "x",
      duration: "7.5",
      reminders: ["email", "popup", "sms"],
    };

    expect(validateMcpElicitationDraft(fields, invalid)).toEqual({
      title: "Enter at least 3 characters.",
      duration: "Enter a whole number.",
      reminders: "Choose no more than 2 options.",
    });
  });

  it("omits untouched optional fields even when their schema has minimum constraints", () => {
    const optionalFields: AgentMcpElicitationField[] = [
      {
        kind: "text",
        name: "note",
        label: "Note",
        description: "",
        required: false,
        format: "text",
        minLength: 3,
        maxLength: null,
        defaultValue: null,
      },
      {
        kind: "boolean",
        name: "notify",
        label: "Notify",
        description: "",
        required: false,
        defaultValue: null,
      },
      {
        kind: "multi-select",
        name: "channels",
        label: "Channels",
        description: "",
        required: false,
        options: [{ value: "email", label: "Email" }],
        minItems: 1,
        maxItems: null,
        defaultValue: [],
      },
    ];
    const draft = initialMcpElicitationDraft(optionalFields);

    expect(draft).toEqual({ note: "", notify: null, channels: [] });
    expect(validateMcpElicitationDraft(optionalFields, draft)).toEqual({});
    expect(mcpElicitationContent(optionalFields, draft)).toEqual({});
  });

  it("serializes schema property names without invoking object prototype setters", () => {
    const reservedNameField: AgentMcpElicitationField = {
      kind: "text",
      name: "__proto__",
      label: "Reserved name",
      description: "",
      required: true,
      format: "text",
      minLength: null,
      maxLength: null,
      defaultValue: "safe",
    };
    const content = mcpElicitationContent(
      [reservedNameField],
      initialMcpElicitationDraft([reservedNameField]),
    );

    expect(Object.hasOwn(content, "__proto__")).toBe(true);
    expect(JSON.stringify(content)).toBe('{"__proto__":"safe"}');
  });

  it("allows a required multi-select to be empty when the schema has no minItems", () => {
    const emptyAllowedField: AgentMcpElicitationField = {
      kind: "multi-select",
      name: "tags",
      label: "Tags",
      description: "",
      required: true,
      options: [{ value: "one", label: "One" }],
      minItems: null,
      maxItems: null,
      defaultValue: [],
    };
    const draft = initialMcpElicitationDraft([emptyAllowedField]);

    expect(validateMcpElicitationDraft([emptyAllowedField], draft)).toEqual({});
    expect(mcpElicitationContent([emptyAllowedField], draft)).toEqual({ tags: [] });
  });

  it("renders the requesting server, fields, and explicit accept/decline actions", () => {
    const markup = renderToStaticMarkup(
      <McpElicitationDock request={request} onResolve={vi.fn()} />,
    );

    expect(markup).toContain("calendar · MCP");
    expect(markup).toContain("Choose how the event should be created.");
    expect(markup).toContain("Event title");
    expect(markup).toContain("Reminders");
    expect(markup).toContain(">Decline<");
    expect(markup).toContain(">Send response<");
  });
});
