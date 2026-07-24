// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionPairingForm } from "./CompanionPairingForm";

const pairingCode = JSON.stringify({
  endpoint: "https://xiao-host.local:4318/",
  serverName: "xiao-host.local",
  certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
  certificateFingerprint: `sha256:${"ab".repeat(32)}`,
  pairingId: "pairing-1",
  ownerCredential: "XIAO-PAIR-123",
  expiresAt: 1_900_000_000_000,
});

afterEach(cleanup);

describe("CompanionPairingForm", () => {
  it("collects and normalizes the primary-host pairing details", () => {
    const onPair = vi.fn();
    render(<CompanionPairingForm busy={false} error={null} onPair={onPair} />);

    fireEvent.change(screen.getByLabelText("Primary host pairing bundle"), {
      target: { value: ` ${pairingCode} ` },
    });
    fireEvent.change(screen.getByLabelText("Device name"), {
      target: { value: " Operator phone " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    expect(onPair).toHaveBeenCalledWith({
      pairingCode,
      deviceName: "Operator phone",
    });
  });

  it("returns focus and reports pairing failure as an uncertain host-side effect", () => {
    render(<CompanionPairingForm busy={false} error={null} onPair={vi.fn()} />);

    const bundle = screen.getByLabelText("Primary host pairing bundle");
    fireEvent.change(bundle, { target: { value: "not-a-bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    expect(screen.getByRole("alert").textContent).toContain("may have created a host session");
    expect(screen.getByRole("alert").textContent).toContain("Inspect and revoke");
    expect(screen.getByRole("alert").textContent).toContain("malformed");
    expect(document.activeElement).toBe(bundle);
  });
});
