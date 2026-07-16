import { describe, expect, it } from "vitest";

import {
  filterSlashCommands,
  SLASH_COMMANDS,
  slashCommandDisabledReason,
} from "./slashCommands";

describe("compact slash command", () => {
  it("is a native task command with the summarize alias", () => {
    const command = SLASH_COMMANDS.find((item) => item.id === "compact");

    expect(command).toMatchObject({
      id: "compact",
      trigger: "compact",
      aliases: ["summarize"],
      group: "Task",
    });
    expect(command?.prompt).toBeUndefined();
  });

  it("matches both /compact and /summarize without leaking description matches", () => {
    expect(filterSlashCommands(SLASH_COMMANDS, "compact").map((command) => command.id))
      .toEqual(["compact"]);
    expect(filterSlashCommands(SLASH_COMMANDS, "summarize").map((command) => command.id))
      .toEqual(["compact"]);
    expect(filterSlashCommands(SLASH_COMMANDS, "comp").map((command) => command.id))
      .toEqual(["compact"]);
  });

  it("stays visible with a useful reason before the first conversation", () => {
    const command = SLASH_COMMANDS.find((item) => item.id === "compact")!;

    expect(slashCommandDisabledReason(command, {
      canCompact: false,
      compacting: false,
      hasThread: false,
    })).toBe("Start a conversation first");
    expect(slashCommandDisabledReason(command, {
      canCompact: true,
      compacting: false,
      hasThread: true,
    })).toBeNull();
  });
});
