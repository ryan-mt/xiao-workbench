import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { SelectMenu } from "../../../components/SelectMenu";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  AgentMcpElicitationField,
  AgentMcpElicitationRequest,
  AgentMcpElicitationResponse,
} from "../../../core/models/agent";

export type McpElicitationDraftValue = string | boolean | string[] | null;
export type McpElicitationDraft = Record<string, McpElicitationDraftValue>;

type McpElicitationDockProps = {
  request: AgentMcpElicitationRequest;
  onResolve: (
    pendingInputId: string,
    response: AgentMcpElicitationResponse,
  ) => Promise<boolean>;
};

export const initialMcpElicitationDraft = (
  fields: AgentMcpElicitationField[],
): McpElicitationDraft => Object.fromEntries(fields.map((field) => {
  switch (field.kind) {
    case "text":
    case "select":
      return [field.name, field.defaultValue ?? ""];
    case "number":
      return [field.name, field.defaultValue == null ? "" : String(field.defaultValue)];
    case "boolean":
      return [field.name, field.defaultValue ?? (field.required ? false : null)];
    case "multi-select":
      return [field.name, [...field.defaultValue]];
    case "unsupported":
      return [field.name, ""];
  }
}));

export const validateMcpElicitationDraft = (
  fields: AgentMcpElicitationField[],
  draft: McpElicitationDraft,
) => Object.fromEntries(fields.flatMap((field) => {
  const value = draft[field.name];
  if (field.kind === "unsupported") {
    return [[field.name, `Xiao does not support MCP field type “${field.schemaType}”.`]];
  }
  if (field.kind === "boolean") {
    return field.required && typeof value !== "boolean"
      ? [[field.name, "Choose whether this option is enabled."]]
      : [];
  }
  if (field.kind === "multi-select") {
    const selected = Array.isArray(value) ? value : [];
    if (!field.required && !selected.length) return [];
    const minimum = field.minItems ?? 0;
    if (selected.length < minimum) {
      return [[field.name, minimum === 1 ? "Choose at least one option." : `Choose at least ${minimum} options.`]];
    }
    if (field.maxItems != null && selected.length > field.maxItems) {
      return [[field.name, `Choose no more than ${field.maxItems} options.`]];
    }
    return [];
  }

  const text = typeof value === "string" ? value : "";
  if (field.required && !text.trim()) {
    return [[field.name, "This field is required."]];
  }
  if (field.kind === "number" && text.trim()) {
    const number = Number(text);
    if (!Number.isFinite(number)) return [[field.name, "Enter a valid number."]];
    if (field.integer && !Number.isInteger(number)) return [[field.name, "Enter a whole number."]];
    if (field.minimum != null && number < field.minimum) {
      return [[field.name, `Enter ${field.minimum} or greater.`]];
    }
    if (field.maximum != null && number > field.maximum) {
      return [[field.name, `Enter ${field.maximum} or less.`]];
    }
    return [];
  }
  if (field.kind === "text") {
    if (!field.required && !text) return [];
    if (field.minLength != null && text.length < field.minLength) {
      return [[field.name, `Enter at least ${field.minLength} characters.`]];
    }
    if (field.maxLength != null && text.length > field.maxLength) {
      return [[field.name, `Enter no more than ${field.maxLength} characters.`]];
    }
  }
  return [];
}));

export const mcpElicitationContent = (
  fields: AgentMcpElicitationField[],
  draft: McpElicitationDraft,
) => {
  const entries: Array<[string, unknown]> = [];
  for (const field of fields) {
    if (field.kind === "unsupported") continue;
    const value = draft[field.name];
    if (field.kind === "boolean") {
      if (typeof value === "boolean") entries.push([field.name, value]);
      continue;
    }
    if (field.kind === "multi-select") {
      if (Array.isArray(value) && (value.length || field.required)) {
        entries.push([field.name, value]);
      }
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (!field.required && (field.kind === "number" ? !text.trim() : !text)) continue;
    entries.push([field.name, field.kind === "number" ? Number(text) : text]);
  }
  return Object.fromEntries(entries);
};

const inputType = (field: Extract<AgentMcpElicitationField, { kind: "text" }>) => {
  if (field.format === "email") return "email";
  if (field.format === "uri") return "url";
  if (field.format === "date") return "date";
  return "text";
};

export function McpElicitationDock({ request, onResolve }: McpElicitationDockProps) {
  const [draft, setDraft] = useState<McpElicitationDraft>(() =>
    initialMcpElicitationDraft(request.fields)
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  const unsupported = useMemo(
    () => request.fields.some((field) => field.kind === "unsupported"),
    [request.fields],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstField.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [request.pendingInputId]);

  const update = (name: string, value: McpElicitationDraftValue) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
    setError(null);
  };

  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const nextErrors = validateMcpElicitationDraft(request.fields, draft);
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setError("Review the highlighted MCP fields before sending.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const sent = await onResolve(request.pendingInputId, {
      action: "accept",
      content: mcpElicitationContent(request.fields, draft),
      _meta: null,
    });
    if (!sent) {
      setSubmitting(false);
      setError("Xiao could not send this MCP response. Try again.");
    }
  };

  const decline = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const sent = await onResolve(request.pendingInputId, {
      action: "decline",
      content: null,
      _meta: null,
    });
    if (!sent) {
      setSubmitting(false);
      setError("Xiao could not decline this MCP request. Try again.");
    }
  };

  return (
    <div
      className="question-dock mcp-elicitation-dock"
      role="dialog"
      aria-modal={false}
      aria-labelledby="mcp-elicitation-title"
    >
      <header className="question-dock__header">
        <span className="question-dock__signal"><XiaoIcon name="capability" size={15} /></span>
        <div>
          <small>{request.serverName} · MCP</small>
          <strong id="mcp-elicitation-title">An MCP server needs information</strong>
        </div>
        <span className="question-dock__count">
          {request.fields.length}<i>{request.fields.length === 1 ? " field" : " fields"}</i>
        </span>
      </header>

      <form onSubmit={(event) => void accept(event)}>
        <div className="question-dock__body">
          <h2>{request.message}</h2>
          <div className="mcp-elicitation-fields">
            {request.fields.map((field, index) => {
              const fieldError = fieldErrors[field.name];
              const descriptionId = `mcp-field-${index}-description`;
              const errorId = `mcp-field-${index}-error`;
              if (field.kind === "boolean") {
                return (
                  <label className="mcp-elicitation-field is-boolean" key={field.name}>
                    <input
                      type="checkbox"
                      ref={index === 0 ? (node) => { firstField.current = node; } : undefined}
                      checked={draft[field.name] === true}
                      disabled={submitting}
                      onChange={(event) => update(field.name, event.target.checked)}
                    />
                    <span><strong>{field.label}{field.required ? " *" : ""}</strong>{field.description ? <small>{field.description}</small> : null}</span>
                  </label>
                );
              }
              if (field.kind === "multi-select") {
                const selected = Array.isArray(draft[field.name]) ? draft[field.name] as string[] : [];
                return (
                  <fieldset className="mcp-elicitation-field" key={field.name} aria-describedby={fieldError ? errorId : field.description ? descriptionId : undefined}>
                    <legend>{field.label}{field.required ? " *" : ""}</legend>
                    {field.description ? <small id={descriptionId}>{field.description}</small> : null}
                    <div className="mcp-elicitation-options">
                      {field.options.map((option, optionIndex) => (
                        <label key={option.value}>
                          <input
                            type="checkbox"
                            ref={index === 0 && optionIndex === 0
                              ? (node) => { firstField.current = node; }
                              : undefined}
                            checked={selected.includes(option.value)}
                            disabled={submitting}
                            onChange={(event) => update(
                              field.name,
                              event.target.checked
                                ? [...selected, option.value]
                                : selected.filter((value) => value !== option.value),
                            )}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                    {fieldError ? <em id={errorId}>{fieldError}</em> : null}
                  </fieldset>
                );
              }
              if (field.kind === "unsupported") {
                return (
                  <div className="mcp-elicitation-field is-unsupported" key={field.name}>
                    <strong>{field.label}</strong>
                    <small>{field.description}</small>
                    <em>Xiao cannot render this field. Decline the request to continue safely.</em>
                  </div>
                );
              }

              if (field.kind === "select") {
                return (
                  <div className="mcp-elicitation-field" key={field.name}>
                    <span><strong>{field.label}{field.required ? " *" : ""}</strong>{field.description ? <small id={descriptionId}>{field.description}</small> : null}</span>
                    <SelectMenu
                      ref={index === 0 ? (node) => { firstField.current = node; } : undefined}
                      ariaLabel={field.label}
                      value={typeof draft[field.name] === "string" ? draft[field.name] as string : ""}
                      disabled={submitting}
                      ariaInvalid={Boolean(fieldError)}
                      ariaDescribedBy={fieldError ? errorId : field.description ? descriptionId : undefined}
                      options={[
                        { value: "", label: "Choose an option" },
                        ...field.options,
                      ]}
                      onValueChange={(value) => update(field.name, value)}
                    />
                    {fieldError ? <em id={errorId}>{fieldError}</em> : null}
                  </div>
                );
              }

              return (
                <label className="mcp-elicitation-field" key={field.name}>
                  <span><strong>{field.label}{field.required ? " *" : ""}</strong>{field.description ? <small id={descriptionId}>{field.description}</small> : null}</span>
                  <input
                    ref={index === 0 ? (node) => { firstField.current = node; } : undefined}
                    type={field.kind === "number" ? "number" : inputType(field)}
                    step={field.kind === "number" && field.integer ? 1 : field.kind === "number" ? "any" : undefined}
                    min={field.kind === "number" ? field.minimum ?? undefined : undefined}
                    max={field.kind === "number" ? field.maximum ?? undefined : undefined}
                    minLength={field.kind === "text" ? field.minLength ?? undefined : undefined}
                    maxLength={field.kind === "text" ? field.maxLength ?? undefined : undefined}
                    required={field.required}
                    disabled={submitting}
                    value={typeof draft[field.name] === "string" ? draft[field.name] as string : ""}
                    placeholder={field.kind === "text" && field.format === "date-time" ? "YYYY-MM-DDTHH:mm:ssZ" : undefined}
                    aria-invalid={Boolean(fieldError)}
                    aria-describedby={fieldError ? errorId : field.description ? descriptionId : undefined}
                    onChange={(event) => update(field.name, event.target.value)}
                  />
                  {fieldError ? <em id={errorId}>{fieldError}</em> : null}
                </label>
              );
            })}
          </div>
          {unsupported ? <p className="question-dock__error" role="alert">This MCP form contains a field Xiao cannot safely render.</p> : null}
          {error ? <p className="question-dock__error" role="alert">{error}</p> : null}
        </div>

        <footer className="question-dock__footer">
          <div>
            <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void decline()}>
              Decline
            </button>
            <small>Responses go directly to {request.serverName}.</small>
          </div>
          <button className="button button--primary" type="submit" disabled={submitting || unsupported}>
            {submitting ? "Sending..." : "Send response"}
          </button>
        </footer>
      </form>
    </div>
  );
}
