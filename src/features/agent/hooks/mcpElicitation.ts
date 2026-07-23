import type {
  AgentMcpElicitationField,
  AgentMcpElicitationOption,
  AgentMcpElicitationRequest,
  AgentMessage,
} from "../../../core/models/agent";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonNegativeInteger = (value: unknown) => {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
};

const stringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const optionsFromSchema = (schema: Record<string, unknown>): AgentMcpElicitationOption[] => {
  if (Array.isArray(schema.oneOf)) {
    const options = schema.oneOf.flatMap((rawOption) => {
      if (!isRecord(rawOption)) return [];
      return typeof rawOption.const === "string" && typeof rawOption.title === "string"
        ? [{ value: rawOption.const, label: rawOption.title }]
        : [];
    });
    if (options.length === schema.oneOf.length) return options;
  }

  const values = stringArray(schema.enum);
  if (!values.length) return [];
  const labels = stringArray(schema.enumNames);
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
};

const multiSelectOptions = (schema: Record<string, unknown>) => {
  if (!isRecord(schema.items)) return [];
  if (Array.isArray(schema.items.anyOf)) {
    const options = schema.items.anyOf.flatMap((rawOption) => {
      if (!isRecord(rawOption)) return [];
      return typeof rawOption.const === "string" && typeof rawOption.title === "string"
        ? [{ value: rawOption.const, label: rawOption.title }]
        : [];
    });
    if (options.length === schema.items.anyOf.length) return options;
  }
  return optionsFromSchema(schema.items);
};

const normalizeField = (
  name: string,
  rawSchema: unknown,
  required: boolean,
): AgentMcpElicitationField => {
  if (!isRecord(rawSchema)) {
    return {
      kind: "unsupported",
      name,
      label: name,
      description: "This field uses an invalid MCP schema.",
      required,
      schemaType: "invalid",
    };
  }
  const label = typeof rawSchema.title === "string" && rawSchema.title.trim()
    ? rawSchema.title
    : name;
  const description = typeof rawSchema.description === "string"
    ? rawSchema.description
    : "";
  const type = typeof rawSchema.type === "string" ? rawSchema.type : "unknown";
  const base = { name, label, description, required };

  if (type === "string") {
    const options = optionsFromSchema(rawSchema);
    if (options.length) {
      const defaultValue = typeof rawSchema.default === "string" &&
        options.some((option) => option.value === rawSchema.default)
        ? rawSchema.default
        : null;
      return { ...base, kind: "select", options, defaultValue };
    }
    const format = ["email", "uri", "date", "date-time"].includes(String(rawSchema.format))
      ? rawSchema.format as "email" | "uri" | "date" | "date-time"
      : "text";
    return {
      ...base,
      kind: "text",
      format,
      minLength: nonNegativeInteger(rawSchema.minLength),
      maxLength: nonNegativeInteger(rawSchema.maxLength),
      defaultValue: typeof rawSchema.default === "string" ? rawSchema.default : null,
    };
  }

  if (type === "number" || type === "integer") {
    return {
      ...base,
      kind: "number",
      integer: type === "integer",
      minimum: finiteNumber(rawSchema.minimum),
      maximum: finiteNumber(rawSchema.maximum),
      defaultValue: finiteNumber(rawSchema.default),
    };
  }

  if (type === "boolean") {
    return {
      ...base,
      kind: "boolean",
      defaultValue: typeof rawSchema.default === "boolean" ? rawSchema.default : null,
    };
  }

  if (type === "array") {
    const options = multiSelectOptions(rawSchema);
    if (options.length) {
      const allowed = new Set(options.map((option) => option.value));
      return {
        ...base,
        kind: "multi-select",
        options,
        minItems: nonNegativeInteger(rawSchema.minItems),
        maxItems: nonNegativeInteger(rawSchema.maxItems),
        defaultValue: stringArray(rawSchema.default).filter((value) => allowed.has(value)),
      };
    }
  }

  return {
    ...base,
    kind: "unsupported",
    schemaType: type,
  };
};

export const readMcpElicitationRequest = (
  message: AgentMessage,
  taskId: string,
  pendingInputId: string,
  runId: string,
): AgentMcpElicitationRequest | null => {
  if (message.id == null || !isRecord(message.params)) return null;
  if (
    message.params.mode !== "form" ||
    typeof message.params.serverName !== "string" ||
    typeof message.params.message !== "string" ||
    !isRecord(message.params.requestedSchema) ||
    message.params.requestedSchema.type !== "object" ||
    !isRecord(message.params.requestedSchema.properties)
  ) {
    return null;
  }

  const required = new Set(stringArray(message.params.requestedSchema.required));
  const fields = Object.entries(message.params.requestedSchema.properties).map(
    ([name, schema]) => normalizeField(name, schema, required.has(name)),
  );
  return {
    requestId: message.id,
    pendingInputId,
    runId,
    taskId,
    threadId: typeof message.params.threadId === "string" ? message.params.threadId : "",
    turnId: typeof message.params.turnId === "string" ? message.params.turnId : "",
    serverName: message.params.serverName,
    message: message.params.message,
    fields,
    receivedAt: Date.now(),
  };
};

export const agentMcpElicitationRequestMatches = (
  current: AgentMcpElicitationRequest | null,
  candidate: Pick<
    AgentMcpElicitationRequest,
    "requestId" | "pendingInputId" | "runId" | "taskId"
  >,
) => Boolean(
  current &&
  current.pendingInputId === candidate.pendingInputId &&
  current.runId === candidate.runId &&
  current.taskId === candidate.taskId &&
  String(current.requestId) === String(candidate.requestId)
);

export const enqueueAgentMcpElicitationRequest = (
  current: AgentMcpElicitationRequest[],
  request: AgentMcpElicitationRequest,
) => current.some((candidate) => agentMcpElicitationRequestMatches(candidate, request))
  ? current
  : [...current, request];

export const removeAgentMcpElicitationRequest = (
  current: AgentMcpElicitationRequest[],
  request: Pick<
    AgentMcpElicitationRequest,
    "requestId" | "pendingInputId" | "runId" | "taskId"
  >,
) => {
  const next = current.filter((candidate) =>
    !agentMcpElicitationRequestMatches(candidate, request)
  );
  return next.length === current.length ? current : next;
};
