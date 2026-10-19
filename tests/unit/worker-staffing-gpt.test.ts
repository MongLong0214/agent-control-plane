import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { fixedRuntimes } from "../../src/domain/fixed-role-runtime.ts";
import { Role } from "../../src/domain/types.ts";
import { resolveWorkerModel, WORKER_MODEL_BY_PROVIDER } from "../../src/run/worker-staffing.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

describe("a worker may be staffed on gpt", () => {
  it("accepts provider gpt with model gpt-6.1-sol and still accepts claude opus", () => {
    expect(resolveWorkerModel("gpt", undefined)).toEqual({
      allowed: true,
      reasonCode: ReasonCode.OK,
      evidence: {},
      value: "gpt-6.1-sol",
    });
    expect(resolveWorkerModel("gpt", "gpt-6.1-sol")).toMatchObject({ allowed: true, value: "gpt-6.1-sol" });
    expect(resolveWorkerModel("claude", undefined)).toMatchObject({ allowed: true, value: "opus" });
  });

  it("refuses an unknown provider as not staffed", () => {
    const decided = resolveWorkerModel("grok", undefined);
    expect(decided).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.INVALID_ARGUMENT,
      message: expect.stringContaining("not staffed"),
    });
  });

  it("refuses a gpt worker with a different model", () => {
    expect(resolveWorkerModel("gpt", "gpt-5.6-luna-max")).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.INVALID_ARGUMENT,
    });
  });

  it("continuity constitutes a worker from the same table", async () => {
    expect(Object.fromEntries(fixedRuntimes(Role.WORKER).map((runtime) => [runtime.provider, runtime.model])))
      .toEqual(WORKER_MODEL_BY_PROVIDER);
    expect(WORKER_MODEL_BY_PROVIDER).toEqual({ claude: "opus", gpt: "gpt-6.1-sol" });

    const harness = makeHarness();
    try {
      harness.cp.continuity.attach({ readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) } });
      const gpt = new TestProductionAdapter(harness.clock, "gpt");
      const claude = new TestProductionAdapter(harness.clock, "claude");
      harness.cp.providers.registerForRole(gpt, Role.WORKER);
      harness.cp.providers.registerForRole(claude, Role.WORKER);
      const gptStart = vi.spyOn(gpt, "startSession");
      const claudeStart = vi.spyOn(claude, "startSession");

      const substituted = await harness.cp.continuity["provisionRoutableSession"](Role.WORKER, "grok", "gpt worker");
      expect(substituted).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED,
        evidence: {
          allowed: fixedRuntimes(Role.WORKER).map((runtime) => ({ provider: runtime.provider, model: runtime.model })),
        },
      });
      expect(gptStart).not.toHaveBeenCalled();

      const accepted = await harness.cp.continuity["provisionRoutableSession"](Role.WORKER, "gpt", "gpt worker");
      expect(accepted.allowed).toBe(true);
      expect(gptStart).toHaveBeenCalledOnce();
      expect(gptStart.mock.calls[0]![0]).toMatchObject({ model: "gpt-6.1-sol" });

      const claudeAccepted = await harness.cp.continuity["provisionRoutableSession"](Role.WORKER, "claude", "claude worker");
      expect(claudeAccepted.allowed).toBe(true);
      expect(claudeStart).toHaveBeenCalledOnce();
      expect(claudeStart.mock.calls[0]![0]).toMatchObject({ model: "opus" });
    } finally {
      harness.cp.close();
    }
  });
});
