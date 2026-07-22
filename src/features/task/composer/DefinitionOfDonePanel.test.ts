import { describe, expect, it } from "vitest";

import type { AcceptanceContractDraft } from "../../../core/models/verification";
import {
  definitionOfDoneIsComplete,
  definitionOfDoneSummary,
} from "./DefinitionOfDonePanel";

const commandContract = (executable: string): AcceptanceContractDraft => ({
  name: "Project checks",
  gates: [{
    type: "command",
    executable,
    argv: ["run", "check"],
    timeoutMs: 120_000,
    expectedExitCodes: [0],
  }],
});

describe("DefinitionOfDonePanel", () => {
  it("allows no contract but rejects incomplete configured contracts", () => {
    expect(definitionOfDoneIsComplete(null)).toBe(true);
    expect(definitionOfDoneIsComplete({ name: "Project checks", gates: [] })).toBe(false);
    expect(definitionOfDoneIsComplete(commandContract(""))).toBe(false);
    expect(definitionOfDoneIsComplete(commandContract("npm"))).toBe(true);
  });

  it("explains whether completion will be checked", () => {
    expect(definitionOfDoneSummary(null)).toBe("No checks — this run will finish as Done");
    expect(definitionOfDoneSummary(commandContract("npm"))).toBe(
      "1 check — completion will be verified",
    );
  });
});
