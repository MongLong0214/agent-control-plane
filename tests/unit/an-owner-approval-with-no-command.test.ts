import { afterAll, describe, expect, it } from "vitest";

import { dispatch, type OperatorClient } from "../../src/cli/agentctl.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The approval that rebinds a revoked canonical `PRIMARY_CTO` had no command.
 *
 * `owner.approveClaimCanonicalCto` has been implemented, bearer-authenticated and reachable over
 * the operator socket since the canonical self-claim landed. `agentctl` never spelled it, and
 * `agentctl` is how the owner reaches the daemon — so the one action permitted to exactly one
 * person, and to nobody else by design, was the one action they had no way to perform.
 *
 * Measured on the live deployment: the binding was revoked at generation 6 on 2026-09-16 with
 * `coverage plan cannot staff the bound role`, and the role stayed unbound with every downstream
 * path ready. `binding recover-dead` — the sibling door for the same role, the same owner and the
 * same socket — was already spelled, which is what made the gap visible.
 *
 * These rows are about the translation from argv to one operator request, because that is the
 * whole of this command: the daemon's own refusals (a non-owner connection, a wrong generation, a
 * spent nonce) are its to make and are covered where it makes them.
 */
const recordingClient = (): {
  client: OperatorClient;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (method, params = {}) => {
        calls.push({ method, params });
        return allow(ReasonCode.OK, { approved: true });
      },
    },
  };
};

describe("the owner approval that had no command", () => {
  it("sends one owner.approveClaimCanonicalCto carrying exactly what the daemon requires", async () => {
    const { client, calls } = recordingClient();

    const code = await dispatch(
      client,
      "owner",
      [
        "approve-canonical-cto",
        "prj_ce75bb8671a64a348507d85a",
        "41439a5d-47af-4325-b63b-36643fdd384f",
        "7",
        "owner-minted-nonce",
      ],
      true,
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("owner.approveClaimCanonicalCto");
    // Every field the daemon's own validation requires, and the integer as an integer: it reads
    // `expectedBindingGeneration` with a minimum of 1 and refuses a string, so a CLI that passed
    // the argv token through would be refused for a reason the owner cannot see from here.
    expect(calls[0]?.params).toEqual({
      projectId: "prj_ce75bb8671a64a348507d85a",
      claimedSessionUuid: "41439a5d-47af-4325-b63b-36643fdd384f",
      expectedBindingGeneration: 7,
      nonce: "owner-minted-nonce",
      approved: true,
    });
  });

  it("does not offer a role argument, because the daemon fixes the role itself", async () => {
    const { client, calls } = recordingClient();

    await dispatch(
      client,
      "owner",
      ["approve-canonical-cto", "prj_x", "session-uuid", "2", "nonce-2"],
      true,
    );

    // A `role` the caller could set would be a second statement of a fact the daemon already
    // owns, and the only value it accepts is the one it would have used. `binding recover-dead`
    // made the same choice for the same door.
    expect(calls[0]?.params).not.toHaveProperty("role");
  });

  it("refuses a malformed request by throwing, before anything is sent", async () => {
    // `required` and `requiredInteger` throw, and the entry point turns a throw into exit 1 with
    // the message on stderr — so this is the established contract for a malformed argument, not a
    // return code. The half that matters either way is the second assertion: nothing was sent. A
    // malformed approval that reaches the daemon spends a nonce round trip and reads in the audit
    // as an owner who tried to approve something they never typed.
    for (const { args, because } of [
      { args: ["approve-canonical-cto", "prj_x", "session-uuid"], because: "no generation, no nonce" },
      { args: ["approve-canonical-cto", "prj_x", "session-uuid", "not-a-number", "nonce"], because: "generation is not a number" },
      { args: ["approve-canonical-cto", "prj_x", "session-uuid", "0", "nonce"], because: "generation is below the minimum of 1" },
      { args: ["approve-canonical-cto", "prj_x", "session-uuid", "7", ""], because: "nonce is empty" },
      { args: ["approve-canonical-cto", "", "session-uuid", "7", "nonce"], because: "projectId is empty" },
    ]) {
      const { client, calls } = recordingClient();
      await expect(dispatch(client, "owner", args, true), because).rejects.toThrow();
      expect(calls, `sent something despite: ${because}`).toHaveLength(0);
    }
  });

  it("still routes the other owner subcommand, and refuses an unknown one", async () => {
    const approve = recordingClient();
    expect(await dispatch(approve.client, "owner", ["approve", "run-1", "item-1", "looks", "fine"], true)).toBe(0);
    expect(approve.calls[0]?.method).toBe("owner.approve");

    const unknown = recordingClient();
    expect(await dispatch(unknown.client, "owner", ["approve-canonical"], true)).not.toBe(0);
    expect(unknown.calls).toHaveLength(0);
  });
});
