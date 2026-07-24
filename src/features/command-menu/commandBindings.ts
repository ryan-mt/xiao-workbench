export const DEFAULT_COMMAND_BINDINGS = {
  "command-menu.open": "Ctrl+K",
  "task-switcher.open": "Ctrl+Tab",
  "task.create": "Ctrl+T",
  "task.close": "Ctrl+W",
  "runtime.open": "Ctrl+`",
} as const;

export type CommandId = keyof typeof DEFAULT_COMMAND_BINDINGS;
export type CommandBindings = Record<CommandId, string>;

const commandIds = Object.keys(DEFAULT_COMMAND_BINDINGS) as CommandId[];
const normalizeKey = (binding: string) => binding.trim().toLowerCase();

export const normalizeCommandBindings = (value: unknown): CommandBindings => {
  const bindings: CommandBindings = { ...DEFAULT_COMMAND_BINDINGS };
  if (!value || typeof value !== "object") return bindings;
  const overrides = value as Record<string, unknown>;
  for (const commandId of commandIds) {
    const candidate = overrides[commandId];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const normalized = normalizeKey(candidate);
    const conflict = commandIds.some(
      (otherId) => otherId !== commandId && normalizeKey(bindings[otherId]) === normalized,
    );
    if (!conflict) bindings[commandId] = candidate.trim();
  }
  return bindings;
};

type KeyboardCommandEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

const bindingForKeyboardEvent = (event: KeyboardCommandEvent) => {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
};

export const keyboardEventMatchesBinding = (
  event: KeyboardCommandEvent,
  binding: string,
  allowShiftVariant = false,
) => {
  const pressed = bindingForKeyboardEvent(event);
  const expected = normalizeKey(binding);
  if (pressed === expected) return true;
  return allowShiftVariant && event.shiftKey && pressed.replace("shift+", "") === expected;
};

export const commandForKeyboardEvent = (
  event: KeyboardCommandEvent,
  bindings: CommandBindings,
): CommandId | null => {
  return commandIds.find((id) => keyboardEventMatchesBinding(event, bindings[id])) ?? null;
};
