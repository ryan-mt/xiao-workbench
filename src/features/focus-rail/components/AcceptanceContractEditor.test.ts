import { describe, expect, it } from "vitest";

import {
  createBufferedFieldState,
  isBufferedFieldReady,
  parseExitCodesField,
  parseMultilineField,
  reconcileBufferedFieldState,
  transitionBufferedFieldState,
} from "./AcceptanceContractEditor";

const fingerprint = (value: readonly (number | string)[]) => JSON.stringify(value);

describe("AcceptanceContractEditor buffered fields", () => {
  it("preserves an unfinished newline and commits a second argv line", () => {
    const initialArgv = ["run"];
    let field = createBufferedFieldState("run", fingerprint(initialArgv), "task-a");

    field = transitionBufferedFieldState(field, { type: "edit", text: "run\n", valid: true });
    field = reconcileBufferedFieldState(
      field,
      initialArgv.join("\n"),
      fingerprint(initialArgv),
      "task-a",
    );
    expect(field.text).toBe("run\n");
    expect(isBufferedFieldReady(field)).toBe(false);

    field = transitionBufferedFieldState(field, {
      type: "edit",
      text: "run\ncheck",
      valid: true,
    });
    const committed = parseMultilineField(field.text);
    expect(committed).toEqual(["run", "check"]);

    field = transitionBufferedFieldState(field, {
      type: "commit",
      sourceFingerprint: fingerprint(committed),
    });
    field = reconcileBufferedFieldState(
      field,
      committed.join("\n"),
      fingerprint(committed),
      "task-a",
    );
    expect(field.text).toBe("run\ncheck");
    expect(isBufferedFieldReady(field)).toBe(true);
  });

  it("keeps a trailing exit-code comma as raw unfinished text", () => {
    const exitCodes = [0];
    let field = createBufferedFieldState("0", fingerprint(exitCodes), "task-a");

    field = transitionBufferedFieldState(field, { type: "edit", text: "0,", valid: false });
    field = reconcileBufferedFieldState(
      field,
      exitCodes.join(", "),
      fingerprint(exitCodes),
      "task-a",
    );

    expect(field.text).toBe("0,");
    expect(parseExitCodesField(field.text)).toBeNull();
    expect(parseExitCodesField(field.text)).not.toEqual([0, 0]);
    expect(isBufferedFieldReady(field)).toBe(false);
  });

  it("treats clearing as no exit codes and re-enables after commit", () => {
    const cleared = parseExitCodesField("");
    expect(cleared).toEqual([]);
    expect(parseExitCodesField("   ")).toEqual([]);
    expect(parseExitCodesField("0, 2, -1")).toEqual([0, 2, -1]);
    expect(parseExitCodesField("0, nope")).toBeNull();

    let field = createBufferedFieldState("0", fingerprint([0]), "task-a");
    field = transitionBufferedFieldState(field, {
      type: "edit",
      text: "",
      valid: cleared !== null,
    });
    expect(isBufferedFieldReady(field)).toBe(false);
    field = transitionBufferedFieldState(field, {
      type: "commit",
      sourceFingerprint: fingerprint(cleared ?? []),
    });
    expect(isBufferedFieldReady(field)).toBe(true);
  });

  it("resets raw text for an external value replacement or task switch", () => {
    let field = createBufferedFieldState("src/**", fingerprint(["src/**"]), "task-a");
    field = transitionBufferedFieldState(field, {
      type: "edit",
      text: "src/**\ntests/**\n",
      valid: true,
    });

    const replacement = ["packages/**", "tests/**"];
    field = reconcileBufferedFieldState(
      field,
      replacement.join("\n"),
      fingerprint(replacement),
      "task-a",
    );
    expect(field.text).toBe("packages/**\ntests/**");

    field = transitionBufferedFieldState(field, {
      type: "edit",
      text: "packages/**\ntests/**\n",
      valid: true,
    });
    field = reconcileBufferedFieldState(
      field,
      replacement.join("\n"),
      fingerprint(replacement),
      "task-b",
    );
    expect(field.text).toBe("packages/**\ntests/**");
  });

  it("uses an explicit reset revision to discard semantically equal raw text", () => {
    const exitCodes = [0];
    let field = createBufferedFieldState("0", fingerprint(exitCodes), "task-a\u00000");
    field = transitionBufferedFieldState(field, { type: "edit", text: "0,", valid: false });
    expect(field.text).toBe("0,");
    expect(isBufferedFieldReady(field)).toBe(false);

    field = reconcileBufferedFieldState(
      field,
      exitCodes.join(", "),
      fingerprint(exitCodes),
      "task-a\u00001",
    );
    expect(field.text).toBe("0");
    expect(isBufferedFieldReady(field)).toBe(true);
  });
});
