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

describe("workflow prompt templates", () => {
  it("provides editable templates for fixing, building, explaining, and refactoring", () => {
    const templates = Object.fromEntries(
      SLASH_COMMANDS
        .filter((command) => ["fix", "build", "explain", "refactor"].includes(command.id))
        .map((command) => [command.id, command.prompt]),
    );

    expect(Object.keys(templates)).toEqual(["fix", "build", "explain", "refactor"]);
    expect(templates.fix).toContain("Observed behavior:");
    expect(templates.fix).toContain("add or update a regression test");
    expect(templates.build).toContain("Acceptance checks:");
    expect(templates.explain).toContain("separate verified behavior from inference");
    expect(templates.explain).toContain("Do not change code.");
    expect(templates.refactor).toContain("without changing behavior");
    expect(["fix", "build", "refactor"].every((id) =>
      templates[id]?.includes("Do not commit or push unless I ask.")
    )).toBe(true);
  });

  it("finds each template by its slash trigger", () => {
    for (const id of ["fix", "build", "explain", "refactor"] as const) {
      expect(filterSlashCommands(SLASH_COMMANDS, id).map((command) => command.id))
        .toEqual([id]);
    }
  });
});
