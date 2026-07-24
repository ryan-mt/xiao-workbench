import { describe, expect, it } from "vitest";

import type { CompanionSession } from "../../core/models/companion";
import { groupCompanionDevices } from "./CompanionHostPage";

const session = (
  sessionId: string,
  generation: number,
  revokedAt: number | null,
): CompanionSession => ({
  sessionId,
  deviceId: "device-1",
  deviceName: "Operator phone",
  grants: ["read_projects", "read_tasks"],
  generation,
  createdAt: 100,
  lastSeenAt: 200 + generation,
  rotatedAt: generation > 1 ? 150 : null,
  revokedAt,
});

describe("Companion primary-host projection", () => {
  it("groups sessions under one inspectable device without exposing credentials", () => {
    const [device] = groupCompanionDevices([
      session("session-a", 1, 300),
      session("session-b", 2, null),
    ]);

    expect(device).toMatchObject({
      id: "device-1",
      name: "Operator phone",
      version: 2,
      grants: ["Read Projects", "Read Tasks"],
      revokedAt: null,
    });
    expect(device.sessions.map(({ id, version, revokedAt }) => ({ id, version, revokedAt })))
      .toEqual([
        { id: "session-a", version: 1, revokedAt: 300_000 },
        { id: "session-b", version: 2, revokedAt: null },
      ]);
    expect(JSON.stringify(device)).not.toContain("secret");
  });
});
