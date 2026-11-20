import { afterAll, describe, expect, it, vi } from "vitest";

import { createOperatorClient } from "../../src/cli/agentctl.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoRefreshHolds } from "../../src/daemon/cto-refresh-hold.ts";
import { startOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const TOKEN = "operator-test-credential-0123456789";

const started = async (options: { owner?: boolean; withHold?: boolean } = {}) => {
  const holds = createCtoRefreshHolds();
  const listener = await startOperatorSocket(
    { lock: { held: () => true }, handleOperatorRequest: async () => allow(ReasonCode.OK, {}) } as never,
    tempDir("acp-hold-"),
    { token: TOKEN, peerId: "cli:owner", actor: "owner" },
    {
      mcpToken: "mcp-test-credential-9876543210",
      ...(options.withHold === false ? {} : {
        ctoRefreshHold: (projectId, socket, pid) => (options.owner === false
          ? deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED, "owner only", {}) : holds.acquire(projectId, socket, pid)),
      }),
    },
  );
  return { listener, client: createOperatorClient({ socketPath: listener.socketPath, token: TOKEN }) };
};

describe("ctoRefresh.hold: one swap per project, held by a connection", () => {
  it("refuses a second hold on the same project with the holder's pid, and a closed connection releases the hold", async () => {
    const { listener, client } = await started();
    try {
      const first = await client.hold!("ctoRefresh.hold", { projectId: "p", holderPid: 4242 });
      expect(first.decision).toMatchObject({ allowed: true });
      expect(first.open()).toBe(true);
      const second = await client.hold!("ctoRefresh.hold", { projectId: "p", holderPid: 99 });
      expect(second.decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.CTO_REFRESH_IN_PROGRESS, evidence: { holderPid: 4242 } });
      expect(JSON.stringify(second.decision)).toContain("pid 4242");
      expect(second.open()).toBe(false);
      // Another project is its own.
      const other = await client.hold!("ctoRefresh.hold", { projectId: "q" });
      expect(other.decision).toMatchObject({ allowed: true });
      other.release();
      // The holder's connection closes: the daemon sees it, and the project can be held again.
      first.release();
      expect(first.open()).toBe(false);
      await vi.waitFor(async () => {
        const again = await client.hold!("ctoRefresh.hold", { projectId: "p" });
        expect(again.decision).toMatchObject({ allowed: true });
        again.release();
      });
    } finally { await listener.close(); }
  });

  it("is owner only, and absent where the daemon does not enable it", async () => {
    const notOwner = await started({ owner: false });
    try {
      const refused = await notOwner.client.hold!("ctoRefresh.hold", { projectId: "p" });
      expect(refused.decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED });
    } finally { await notOwner.listener.close(); }
    const absent = await started({ withHold: false });
    try {
      const refused = await absent.client.hold!("ctoRefresh.hold", { projectId: "p" });
      expect(refused.decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.OPERATOR_METHOD_NOT_ALLOWED });
    } finally { await absent.listener.close(); }
  });

  it("is released when the daemon's listener closes, so a restarted daemon holds nothing", async () => {
    const { listener, client } = await started();
    const held = await client.hold!("ctoRefresh.hold", { projectId: "p" });
    expect(held.open()).toBe(true);
    await listener.close();
    await vi.waitFor(() => expect(held.open()).toBe(false));
  });
});
