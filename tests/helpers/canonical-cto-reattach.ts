import { expect } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  createCanonicalCtoReattach,
  type CanonicalCtoReattach,
  type CanonicalCtoReattachOptions,
} from "../../src/registry/canonical-cto-reattach.ts";
import {
  hostSessionRegistryAbsent,
  SELF_CLAIM_EXECUTOR_KIND,
  SELF_CLAIM_PROTOCOL,
  type ProcessAncestryInspector,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import type { ProcessLineageReader } from "../../src/session/runtime-lineage.ts";
import { fixtureManifest, makeHarness, type Harness } from "./harness.ts";

/**
 * A canonical CTO bound the way the canonical claim binds one: a runtime row for the `claude`
 * process with its native start, and an actor whose `claude-cli` target is that process's
 * conversation. The process tree is stated by the test and read by both the claim's own identity
 * derivation and the lineage check, so the two cannot disagree about a fixture.
 */

export const CLAUDE = 525_252;
export const OTHER_CLAUDE = 535_353;
export const RELAY = 545_454;
export const CLAUDE_TOKEN = "darwin-tv:1790000100.000001";
export const RESTARTED_TOKEN = "darwin-tv:1790000900.000009";
export const CONVERSATION = "11111111-1111-4111-8111-111111111111";
export const OTHER_CONVERSATION = "22222222-2222-4222-8222-222222222222";
export const PROJECT = "reattach-project";
export const CTO = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });

export interface StatedProcess {
  ppid: number;
  startedAt: string | null;
  argv: readonly string[];
}

export interface CanonicalCtoFixture {
  h: Harness;
  processes: Map<number, StatedProcess>;
  sessionId: string;
  reattach(overrides?: Partial<CanonicalCtoReattachOptions>): CanonicalCtoReattach;
  bindTo(osPid: number, startedAt: string): string;
}

export const claudeProcess = (conversation: string, startedAt: string): StatedProcess => ({
  ppid: 1,
  startedAt,
  argv: ["/Users/fixture/.local/bin/claude", "--resume", conversation],
});

export const canonicalCtoFixture = (): CanonicalCtoFixture => {
  const h = makeHarness();
  const manifest = fixtureManifest(PROJECT);
  expect(
    h.cp.projects.register({
      projectId: manifest.projectId,
      name: "fixture",
      manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest),
    }).allowed,
  ).toBe(true);
  const processes = new Map<number, StatedProcess>([
    [CLAUDE, claudeProcess(CONVERSATION, CLAUDE_TOKEN)],
    [RELAY, { ppid: CLAUDE, startedAt: "darwin-tv:1790000200.000002", argv: ["node", "agentctl", "attach"] }],
  ]);
  const inspector: ProcessAncestryInspector = {
    readStartToken: (pid) => processes.get(pid)?.startedAt ?? null,
    snapshot: (pid): ProcessSnapshot | null => {
      const stated = processes.get(pid);
      if (!stated) return null;
      return {
        pid,
        ppid: stated.ppid,
        command: stated.argv.join(" "),
        cwd: "/Users/fixture/work",
        cwdProbeFailure: null,
        startedAt: stated.startedAt,
        argv: stated.argv,
      };
    },
  };
  const lineage: ProcessLineageReader = {
    parentOf: (pid) => processes.get(pid)?.ppid ?? null,
    startToken: (pid) => processes.get(pid)?.startedAt ?? null,
    startedAt: () => null,
  };
  const bindTo = (osPid: number, startedAt: string): string => {
    const session = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid, osStartedAt: startedAt });
    expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    const claimed = {
      executorKind: SELF_CLAIM_EXECUTOR_KIND,
      targetLocator: CONVERSATION,
      targetLocatorDigest: sha256(CONVERSATION),
    };
    expect(
      h.cp.bindings.bind({
        role: Role.PRIMARY_CTO,
        projectId: PROJECT,
        sessionId: session.sessionId,
        authenticatedTarget: {
          claimed,
          protocolVersion: SELF_CLAIM_PROTOCOL,
          attestationDigest: digestOf({ fixture: "canonical-cto", sessionId: session.sessionId }),
          verify: () => claimed,
        },
      }).allowed,
    ).toBe(true);
    return session.sessionId;
  };
  const sessionId = bindTo(CLAUDE, CLAUDE_TOKEN);
  return {
    h,
    processes,
    sessionId,
    bindTo,
    reattach: (overrides = {}) =>
      createCanonicalCtoReattach(h.cp, {
        processes: lineage,
        inspector,
        registryReader: { read: () => hostSessionRegistryAbsent("absent") },
        ...overrides,
      }),
  };
};
