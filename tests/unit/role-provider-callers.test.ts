import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { CtoLifecycle } from "../../src/cto/cto-lifecycle.ts";
import { ProviderRegistry } from "../../src/runtime/provider.ts";
import { join } from "node:path";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

const makeCto = (harness: ReturnType<typeof makeHarness>, providers: ProviderRegistry) => {
  const { cp, root } = harness;
  return new CtoLifecycle(cp.db, cp.clock, cp.audit, cp.projects, cp.sessions, cp.bindings,
    providers, cp.outbox, cp.runs, { provider: "scripted", model: "scripted-cto", effort: null },
    join(root, "caller-runtime"));
};

describe("CTO role caller", () => {
  it.each(["unscoped", "scoped", "mixed"])("spawns and probes through the %s CTO adapter", async (mode) => {
    const harness = makeHarness();
    const { cp, clock } = harness;
    try {
      const providers = new ProviderRegistry();
      const selected = new TestProductionAdapter(clock);
      const wrong = new TestProductionAdapter(clock);
      if (mode === "unscoped") providers.register(selected);
      else {
        providers.registerForRole(selected, Role.PRIMARY_CTO);
        providers.registerForRole(wrong, Role.BLIND_REVIEWER);
        if (mode === "mixed") providers.register(wrong);
      }
      const start = vi.spyOn(selected, "startSession");
      const probe = vi.spyOn(selected, "probeSession");
      const wrongStart = vi.spyOn(wrong, "startSession");
      const cto = makeCto(harness, providers);
      const result = await cto["spawn"]("project-test", "caller test");
      expect(result.allowed).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledOnce();
      expect(wrongStart).not.toHaveBeenCalled();
    } finally { cp.close(); }
  });

  it("probes an existing binding through the CTO identity", async () => {
    const harness = makeHarness();
    const { cp, clock } = harness;
    try {
      const providers = new ProviderRegistry();
      const selected = new TestProductionAdapter(clock);
      const wrong = new TestProductionAdapter(clock);
      providers.registerForRole(selected, Role.PRIMARY_CTO);
      providers.registerForRole(wrong, Role.BLIND_REVIEWER);
      const handle = await selected.startSession({ model: "cto", workdir: harness.root, purpose: "test" });
      const session = cp.sessions.create({ provider: "scripted", model: "cto", incarnation: `${handle.externalSessionId}#test` });
      const probe = vi.spyOn(selected, "probeSession");
      const wrongProbe = vi.spyOn(wrong, "probeSession");
      const result = await makeCto(harness, providers)["probeBoundSession"](session);
      expect(result.allowed).toBe(true);
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ externalSessionId: handle.externalSessionId }));
      expect(wrongProbe).not.toHaveBeenCalled();
    } finally { cp.close(); }
  });

  it("stops an unused session with the CTO adapter, not the reviewer", async () => {
    const harness = makeHarness();
    const { cp, clock } = harness;
    try {
      const providers = new ProviderRegistry();
      const selected = new TestProductionAdapter(clock);
      const wrong = new TestProductionAdapter(clock);
      providers.registerForRole(selected, Role.PRIMARY_CTO);
      providers.registerForRole(wrong, Role.BLIND_REVIEWER);
      const session = cp.sessions.create({ provider: "scripted", model: "cto", incarnation: "unused#test" });
      cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
      const stop = vi.spyOn(selected, "stopSession");
      const wrongStop = vi.spyOn(wrong, "stopSession");
      await makeCto(harness, providers)["stopUnusedSession"](session.sessionId, "test cleanup");
      expect(stop).toHaveBeenCalledOnce();
      expect(wrongStop).not.toHaveBeenCalled();
      expect(cp.sessions.require(session.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    } finally { cp.close(); }
  });

  it("suspends a bound CTO through its scoped stop adapter", async () => {
    const harness = makeHarness();
    const { cp, clock, scripted } = harness;
    try {
      const { projectId } = await registerFixtureProject(harness);
      const bound = await cp.cto.ensurePrimaryCto(projectId, "test");
      expect(bound.allowed).toBe(true);
      const selected = new TestProductionAdapter(clock);
      const wrong = new TestProductionAdapter(clock);
      cp.providers.registerForRole(selected, Role.PRIMARY_CTO);
      cp.providers.registerForRole(wrong, Role.BLIND_REVIEWER);
      const stop = vi.spyOn(selected, "stopSession");
      const wrongStop = vi.spyOn(wrong, "stopSession");
      const sharedStop = vi.spyOn(scripted, "stopSession");
      expect(await cp.cto.suspendProject(projectId, true, "test", TEST_OWNER)).toMatchObject({ allowed: true });
      expect(stop).toHaveBeenCalledOnce();
      expect(wrongStop).not.toHaveBeenCalled();
      expect(sharedStop).not.toHaveBeenCalled();
    } finally { cp.close(); }
  });

  it("preserves missing-adapter decisions and refuses a reviewer-only target", async () => {
    const harness = makeHarness();
    const { cp, clock } = harness;
    try {
      const providers = new ProviderRegistry();
      const cto = makeCto(harness, providers);
      const session = cp.sessions.create({ provider: "scripted", model: "cto", incarnation: "absent#test" });
      expect(await cto["spawn"]("project-test", "absent")).toMatchObject({ allowed: false, reasonCode: ReasonCode.NOT_FOUND });
      expect(await cto["probeBoundSession"](session)).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      const wrong = new TestProductionAdapter(clock);
      providers.registerForRole(wrong, Role.BLIND_REVIEWER);
      const start = vi.spyOn(wrong, "startSession");
      const probe = vi.spyOn(wrong, "probeSession");
      await expect(cto["spawn"]("project-test", "wrong role")).rejects.toThrow("no adapter registered");
      await expect(cto["probeBoundSession"](session)).rejects.toThrow("no adapter registered");
      expect(start).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    } finally { cp.close(); }
  });
});

// Exercise the real provisioning boundary without starting a live runtime or dispatching a run.
describe("continuity role caller", () => {
  it.each([Role.CEO, Role.PRIMARY_CTO, Role.BOOTSTRAP_CTO, Role.WORKER, Role.BLIND_REVIEWER])(
    "provisions and probes only the requested %s identity",
    async (role) => {
      const { cp, clock, scripted } = makeHarness();
      try {
        cp.continuity.attach({ readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) } });
        const selected = new TestProductionAdapter(clock);
        const wrong = new TestProductionAdapter(clock);
        cp.providers.registerForRole(selected, role);
        cp.providers.registerForRole(wrong, role === Role.BLIND_REVIEWER ? Role.PRIMARY_CTO : Role.BLIND_REVIEWER);
        const start = vi.spyOn(selected, "startSession");
        const probe = vi.spyOn(selected, "probeSession");
        const wrongStart = vi.spyOn(wrong, "startSession");
        const sharedStart = vi.spyOn(scripted, "startSession");
        const result = await cp.continuity["provisionRoutableSession"](role, "scripted", "role test");
        expect(result.allowed).toBe(true);
        expect(start).toHaveBeenCalledOnce();
        expect(probe).toHaveBeenCalledOnce();
        expect(wrongStart).not.toHaveBeenCalled();
        expect(sharedStart).not.toHaveBeenCalled();
      } finally { cp.close(); }
    },
  );

  it("keeps unscoped provisioning compatible and rejects a different-role-only provider", async () => {
    const { cp, clock, scripted } = makeHarness();
    try {
      cp.continuity.attach({ readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) } });
      const start = vi.spyOn(scripted, "startSession");
      expect((await cp.continuity["provisionRoutableSession"](Role.CEO, "scripted", "shared test")).allowed).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      const wrong = new TestProductionAdapter(clock, "role-only");
      cp.providers.registerForRole(wrong, Role.BLIND_REVIEWER);
      const wrongStart = vi.spyOn(wrong, "startSession");
      await expect(cp.continuity["provisionRoutableSession"](Role.CEO, "role-only", "wrong role"))
        .rejects.toThrow("no adapter registered");
      expect(wrongStart).not.toHaveBeenCalled();
      await expect(cp.continuity["provisionRoutableSession"](Role.CEO, "absent", "absent"))
        .rejects.toThrow("no adapter registered");
    } finally { cp.close(); }
  });
});
