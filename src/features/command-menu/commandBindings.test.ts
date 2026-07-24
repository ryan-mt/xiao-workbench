import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMAND_BINDINGS,
  commandForKeyboardEvent,
  keyboardEventMatchesBinding,
  normalizeCommandBindings,
} from "./commandBindings";

describe("command bindings", () => {
  it("keeps stable command identifiers and applies valid overrides", () => {
    expect(normalizeCommandBindings({
      "task.create": "Ctrl+N",
      unknown: "Ctrl+Y",
    })).toEqual({
      ...DEFAULT_COMMAND_BINDINGS,
      "task.create": "Ctrl+N",
    });
  });

  it("reports conflicting contextual shortcuts instead of choosing silently", () => {
    const bindings = normalizeCommandBindings({
      "task.create": "Ctrl+K",
    });
    expect(bindings["task.create"]).toBe("Ctrl+T");
  });

  it("resolves keyboard input to a stable command identifier", () => {
    expect(commandForKeyboardEvent({
      key: "k",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, DEFAULT_COMMAND_BINDINGS)).toBe("command-menu.open");
  });

  it("matches a configured binding and its shifted cycling variant", () => {
    const event = {
      key: "j",
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: true,
    };

    expect(keyboardEventMatchesBinding(event, "Alt+J")).toBe(false);
    expect(keyboardEventMatchesBinding(event, "Alt+J", true)).toBe(true);
  });
});
