import * as git from "../../src/git/git.ts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { type HandoffAcknowledgement, type HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  bindCeo,
  finalizeNoRepositoryRun,
  fixtureManifest,
  makeHarness,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "review regression",
  why: "prove the registry and CTO boundary",
  scope: [],
  nonGoals: [],
  acceptance: ["test passes"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const HANDOFF: HandoffPackage = {
  projectStatus: "ACTIVE/HEALTHY",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "continue",
};

const createActiveRun = async (harness: Harness, projectId: string, repositoryId: string) => {
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return dispatched.value;
};

const authenticateHandoffsForTest = (harness: Harness): void => {
  harness.cp.cto.attach({
    handoffAuthentication: {
      verifyHandoffAcknowledgement: (ack) =>
        ack.sessionSecret === "test-session-secret"
          ? allow(ReasonCode.OK, undefined)
          : deny(ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED, "test credential rejected"),
    },
  });
};

const deliveredAck = (
  harness: Harness,
  handoffId: string,
  incomingSessionId: string,
): HandoffAcknowledgement => {
  const message = harness.cp.outbox.byIdempotencyKey(`handoff:${handoffId}`);
  if (!message) throw new Error("handoff message was not persisted");
  harness.cp.db.run(`UPDATE outbox SET status = 'SENT' WHERE message_id = ?`, [message.messageId]);
  return {
    sessionId: incomingSessionId,
    sessionIncarnation: harness.cp.sessions.require(incomingSessionId).incarnation,
    bindingGeneration: message.bindingGeneration,
    messageId: message.messageId,
    payloadDigest: message.payloadDigest,
    sessionSecret: "test-session-secret",
  };
};

describe("round-2 CTO lifecycle regressions", () => {
  it("handoff P1-06 provisions the CTO in the managed runtime root and persists it", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "managed runtime test");
    if (!bound.allowed) throw new Error(bound.message);

    const session = harness.cp.sessions.require(bound.value.sessionId);
    expect(session.workdir).toBe(join(harness.root, "runtime", "provider-returned-workdir"));
    expect(session.workdir).not.toBe(process.cwd());
  });

  it("ACP1045-R2-01 pins the launched CTO's native start beside the lstart it records", async () => {
    // The row keeps `ps` lstart for the readers that compare it; the exact token is pinned beside
    // it so the unread-capacity keep can tell this process from one that later takes its pid.
    const harness = makeHarness();
    const original = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => ({ ...(await original(spec)), pid: process.pid });

    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "launch pins its token");
    if (!bound.allowed) throw new Error(bound.message);

    const session = harness.cp.sessions.require(bound.value.sessionId);
    expect(session.osPid).toBe(process.pid);
    expect(session.osProcessStartedAt).not.toMatch(/^darwin-tv:/);
    expect(readProcessStartToken(process.pid)).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    expect(harness.cp.sessions.pinnedNativeStart(session.sessionId)).toBe(readProcessStartToken(process.pid));
  });

  it("P1-06 refuses to persist a workdir the adapter reports outside the managed root", async () => {
    // The test above proves the *returned* value is persisted rather than the request echo,
    // but its adapter returns a path under the managed root, so it says nothing about a
    // provider that reports somewhere else. `sessions_workdir_immutable` is BEFORE UPDATE:
    // whatever lands here can never be corrected, so an adapter echoing its own cwd would pin
    // the session to it permanently.
    const harness = makeHarness();
    const escaped = process.cwd();
    const original = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => ({ ...(await original(spec)), workdir: escaped });

    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "escaping adapter workdir");
    if (!bound.allowed) throw new Error(bound.message);

    const session = harness.cp.sessions.require(bound.value.sessionId);
    expect(session.workdir).not.toBe(escaped);
    expect(session.workdir).toBe(join(harness.root, "runtime"));
  });

  it("#147 refuses an incomplete handoff without leaving the healthy CTO draining", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!bound.allowed) throw new Error(bound.message);

    const refused = await harness.cp.cto.prepareSwitchover(projectId, {
      ...HANDOFF,
      recommendedNextAction: "",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE);
    expect(harness.cp.sessions.require(bound.value.sessionId).lifecycle).toBe(SessionLifecycle.READY);
  });

  it("#148 refuses a handoff ACK that knows only the incoming session id", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      prepared.value.incomingSessionId,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED);
  });

  it("#149 refuses emergency takeover while the original CTO is merely draining", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    expect(harness.cp.cto.requestReplacement(projectId, "normal replacement").allowed).toBe(true);

    const refused = await harness.cp.cto.recoveryTakeover(projectId, "attempt bypass of normal handoff");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER);
  });

  it("#150 checkpoints active runs before revoking the suspended CTO binding", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);

    const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(suspended.allowed).toBe(true);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.cto.latestHandoff(projectId)?.status).toBe("PENDING");
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
  });

  it("#151 reports provider stop failure and keeps the binding instead of claiming a clean suspension", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    await createActiveRun(harness, projectId, repositoryId);
    harness.scripted.stopSession = async () => {
      throw new Error("runtime still alive");
    };

    const refused = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SESSION_STOP_FAILED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).not.toBeNull();
    expect(harness.cp.sessions.require(harness.cp.bindings.activePrimaryCto(projectId)!.sessionId).lifecycle).toBe(
      SessionLifecycle.ERROR,
    );
  });

  it("#226 leaves a durable blocked run instead of an ACTIVE run owned by a revoked CTO", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);

    await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.runs.require(run.runId).ownerBindingGeneration).toBe(1);
  });

  it("reblocks an escalation resolved while suspension stops its owner", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);
    const cto = harness.cp.bindings.activePrimaryCto(projectId);
    if (!cto) throw new Error("run dispatch did not bind a primary CTO");
    const ceoSessionId = bindCeo(harness);

    // `suspendProject` does not yield between the STOPPED write and revocation. Schedule the
    // real CEO path from immediately after the real lifecycle transition instead of fabricating
    // revoke's denial or changing the run row ourselves.
    const originalTransition = harness.cp.sessions.transition.bind(harness.cp.sessions);
    let resolveAttempted = false;
    let resolveAllowed = false;
    harness.cp.sessions.transition = (sessionId, to, transitionReason) => {
      const transitioned = originalTransition(sessionId, to, transitionReason);
      if (sessionId === cto.sessionId && to === SessionLifecycle.STOPPED) {
        resolveAttempted = true;
        resolveAllowed = harness.cp.ceo.resolveEscalation(
          run.runId,
          "continue after review",
          ceoSessionId,
        ).allowed;
      }
      return transitioned;
    };

    let suspended: Awaited<ReturnType<typeof harness.cp.cto.suspendProject>>;
    try {
      suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    } finally {
      harness.cp.sessions.transition = originalTransition;
    }

    expect(resolveAttempted).toBe(true);
    expect(resolveAllowed).toBe(true);
    expect(harness.cp.sessions.require(cto.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(suspended).toMatchObject({ allowed: true });
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
  });

  it("accepts a delivered, session-authenticated handoff envelope", async () => {
    const harness = makeHarness();
    authenticateHandoffsForTest(harness);
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    if (!prepared.allowed) throw new Error(prepared.message);

    const acked = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      deliveredAck(harness, prepared.value.handoffId, prepared.value.incomingSessionId),
    );
    expect(acked.allowed).toBe(true);
  });
});

describe("round-2 registry regressions", () => {
  it("#152 activates only the manifest its own PLAN carried, once: the completed run's grant cannot activate another", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const manifestA = { ...fixtureManifest(projectId), postMergeCommands: ["verify"] };
    const finalized = await finalizeNoRepositoryRun(harness, projectId, CONTRACT, { manifest: manifestA });
    // #246 B2-b — the CEO CONFIRM issued the grant and the finalizer consumed it with COMPLETED.
    expect(harness.cp.projects.require(projectId).activeManifestDigest).toBe(manifestDigest(manifestA));
    const grant = harness.cp.manifestGrants.get(finalized.runId)!;
    expect(grant.manifestDigest).toBe(manifestDigest(manifestA));
    expect(grant.consumedAt).not.toBeNull();

    // No caller can name a manifest to activate: activation loads it from the grant's PLAN, and the
    // grant is consumed, so asking again moves nothing.
    const again = harness.cp.projects.activateManifest(finalized.runId, {
      completion: harness.cp.daemonFinalizationAuthorities().completion,
      attemptId: grant.consumedAttemptId!,
      workflows: [],
      consumer: null,
    });
    expect(again.allowed).toBe(false);
    expect(again.reasonCode).toBe(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED);
    expect(harness.cp.projects.require(projectId).activeManifestDigest).toBe(manifestDigest(manifestA));
  });

  it("#153 marks every project repository drifted with the activated manifest digest", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const revised = { ...fixtureManifest(projectId), postMergeCommands: ["verify"] };
    await finalizeNoRepositoryRun(harness, projectId, CONTRACT, { manifest: revised });

    const repository = harness.cp.repositories.byId(repositoryId)!;
    expect(repository.activeManifestDigest).toBe(manifestDigest(revised));
    expect(repository.driftState).toBe("DRIFTED");
  });

  it("#154 refuses a second identity for the same canonical checkout", async () => {
    const harness = makeHarness();
    const repository = makeRepo();
    const first = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local-alias-a",
    });
    if (!first.allowed) throw new Error(first.message);

    const refused = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local-alias-b",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REPOSITORY_CHECKOUT_ALREADY_REGISTERED);
  });

  it("#155 preserves trust and project bindings when an existing repository is re-registered", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const repository = makeRepo();
    const first = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local-untrusted",
      projectId,
      repositoryRole: "secondary",
      activeManifestDigest: harness.cp.projects.require(projectId).activeManifestDigest,
      trustClass: "UNTRUSTED",
    });
    if (!first.allowed) throw new Error(first.message);

    const retried = await harness.cp.repositories.register({ checkoutPath: repository, identity: "local-untrusted" });
    expect(retried.allowed).toBe(true);
    if (!retried.allowed) return;
    expect(retried.value.trustClass).toBe("UNTRUSTED");
    expect(retried.value.projectId).toBe(projectId);
    expect(retried.value.activeManifestDigest).toBe(first.value.activeManifestDigest);
  });

  it("accepts a clean default-branch descendant and clears sticky drift during observation", async () => {
    const harness = makeHarness();
    const { repositoryId, identity } = await registerFixtureProject(harness);
    const accepted = harness.cp.repositories.byId(repositoryId)!.lastObservedHead;
    writeFiles(harness.repoPath, { "README.md": "# changed outside ACP\n" });
    commitAll(harness.repoPath, "out-of-band move");

    const diagnostic = harness.cp.repositories.observed(identity);
    expect(diagnostic).toMatchObject({
      baselineHead: accepted,
      drift: "DRIFTED",
    });
    expect(diagnostic.currentHead).not.toBe(accepted);
    expect(harness.cp.repositories.byId(repositoryId)!.lastObservedHead).toBe(accepted);

    harness.cp.db.run(`UPDATE repositories SET drift_state = 'DRIFTED' WHERE repository_id = ?`, [repositoryId]);
    const first = await harness.cp.repositories.observe(repositoryId);
    const second = await harness.cp.repositories.observe(repositoryId);
    expect(first?.driftState).toBe("IN_SYNC");
    expect(second?.driftState).toBe("IN_SYNC");
    expect(second?.lastObservedHead).toBe(diagnostic.currentHead);
  });

  it.each(["dirty", "divergent", "detached", "wrong branch", "unreadable"])(
    "does not acknowledge a %s checkout", async (state) => {
      const harness = makeHarness();
      const { repositoryId } = await registerFixtureProject(harness);
      const baseline = harness.cp.repositories.byId(repositoryId)!.lastObservedHead;
      writeFiles(harness.repoPath, { "README.md": "# descendant\n" });
      const descendant = commitAll(harness.repoPath, "descendant");
      if (state === "dirty") writeFiles(harness.repoPath, { "untracked.txt": "owner edits" });
      if (state === "divergent") {
        gitSync(harness.repoPath, ["checkout", "--orphan", "unrelated"]);
        commitAll(harness.repoPath, "unrelated root");
        gitSync(harness.repoPath, ["branch", "-M", "dev"]);
      }
      if (state === "detached") gitSync(harness.repoPath, ["checkout", "--detach", descendant]);
      if (state === "wrong branch") gitSync(harness.repoPath, ["checkout", "-b", "owner-feature"]);
      if (state === "unreadable") harness.cp.db.run(`UPDATE repositories SET checkout_path = ? WHERE repository_id = ?`,
        [join(harness.root, "missing-checkout"), repositoryId]);
      const before = state === "unreadable" ? null : gitSync(harness.repoPath, ["status", "--porcelain=v1", "--branch"]);
      const observed = await harness.cp.repositories.observe(repositoryId);
      expect(observed?.lastObservedHead).toBe(baseline);
      expect(observed?.driftState).not.toBe("IN_SYNC");
      const report = await harness.cp.doctor.run("system");
      expect(report.findings.some((f) => ["REPOSITORY_DRIFT", "REPOSITORY_PROBE_FAILED", "REPOSITORY_UNREADABLE"].includes(f.code))).toBe(true);
      if (state !== "unreadable") expect(gitSync(harness.repoPath, ["status", "--porcelain=v1", "--branch"])).toBe(before);
    },
  );

  it("does not interpret a detached HEAD as an attached branch named by the manifest", async () => {
    const harness = makeHarness();
    const { repositoryId } = await registerFixtureProject(harness, "fixture-project", {
      branchProfile: { ...fixtureManifest("fixture-project").branchProfile, longLived: ["HEAD"], defaultBranch: "HEAD" },
    });
    const baseline = harness.cp.repositories.byId(repositoryId)!.lastObservedHead;
    writeFiles(harness.repoPath, { "README.md": "# descendant\n" });
    const head = commitAll(harness.repoPath, "descendant");
    gitSync(harness.repoPath, ["checkout", "--detach", head]);
    expect(await harness.cp.repositories.observe(repositoryId)).toMatchObject({ lastObservedHead: baseline, driftState: "DRIFTED" });
  });

  it("ACP1187-R1-02: rejects HEAD and branch readings from an interleaved checkout", async () => {
    const harness = makeHarness();
    const { repositoryId } = await registerFixtureProject(harness);
    const baseline = harness.cp.repositories.byId(repositoryId)!.lastObservedHead;
    gitSync(harness.repoPath, ["checkout", "-b", "owner-feature"]);
    writeFiles(harness.repoPath, { "README.md": "# feature descendant\n" });
    const descendant = commitAll(harness.repoPath, "owner feature");
    const readHead = git.tryRevParse;
    const readBranch = git.currentBranch;
    const readClean = git.isClean;
    let headReads = 0;
    let branchReads = 0;
    let switchedBack = false;
    const invoke = git.git;
    const snapshots = vi.spyOn(git, "git").mockImplementation(async (cwd, args, options) => {
      const result = await invoke(cwd, args, options);
      if (args.includes("status")) {
        expect(args.slice(-5)).toEqual(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"]);
        expect(result.stdout).toContain(`# branch.oid ${descendant}\n`);
        expect(result.stdout).toContain("# branch.head owner-feature\n");
        // The checkout changes after Git answers, without changing any returned evidence.
        gitSync(cwd, ["checkout", "dev"]);
      }
      return result;
    });
    const headProbe = vi.spyOn(git, "tryRevParse").mockImplementation(async (cwd, ref) => {
      const head = await readHead(cwd, ref);
      // Inspection sees B, while every branch probe up to acceptance sees dev at A.
      if (++headReads === 1) gitSync(cwd, ["checkout", "dev"]);
      return head;
    });
    const branchProbe = vi.spyOn(git, "currentBranch").mockImplementation(async (cwd) => {
      branchReads++;
      return readBranch(cwd);
    });
    const cleanProbe = vi.spyOn(git, "isClean").mockImplementation(async (cwd) => {
      // After the original final branch probe, cleanliness and HEAD see owner-feature at B.
      if (branchReads >= 2 && !switchedBack) {
        gitSync(cwd, ["checkout", "owner-feature"]);
        switchedBack = true;
      }
      return readClean(cwd);
    });
    try {
      const observed = await harness.cp.repositories.observe(repositoryId);
      if (headReads > 0) expect(switchedBack).toBe(true);
      else expect(snapshots.mock.calls.filter(([, args]) => args.includes("status"))).toHaveLength(1);
      expect(gitSync(harness.repoPath, ["rev-parse", "dev"])).toBe(baseline);
      expect(gitSync(harness.repoPath, ["rev-parse", "HEAD"])).toBe(headReads > 0 ? descendant : baseline);
      expect(await readBranch(harness.repoPath)).toBe(headReads > 0 ? "owner-feature" : "dev");
      expect(observed).toMatchObject({ lastObservedHead: baseline, driftState: "DRIFTED" });
    } finally { headProbe.mockRestore(); branchProbe.mockRestore(); cleanProbe.mockRestore(); snapshots.mockRestore(); }
  });

  it.each(["head", "branch", "cleanliness", "manifest", "baseline"])("rechecks %s before acknowledging a descendant", async (change) => {
    const harness = makeHarness();
    const { repositoryId } = await registerFixtureProject(harness);
    const baseline = harness.cp.repositories.byId(repositoryId)!.lastObservedHead;
    writeFiles(harness.repoPath, { "README.md": "# descendant\n" });
    commitAll(harness.repoPath, "descendant");
    const readMergeBase = git.mergeBase;
    const readProject = harness.cp.projects.get.bind(harness.cp.projects);
    let manifestChanged = false;
    const projectProbe = vi.spyOn(harness.cp.projects, "get").mockImplementation((id) => {
      const project = readProject(id);
      return manifestChanged && project ? { ...project, activeManifestDigest: "changed-manifest" } : project;
    });
    let reads = 0;
    const probe = vi.spyOn(git, "mergeBase").mockImplementation(async (cwd, ...args) => {
      const ancestor = await readMergeBase(cwd, ...args);
      if (++reads === 1) {
        if (change === "manifest") manifestChanged = true;
        else if (change === "baseline") harness.cp.repositories.acknowledgeHead(repositoryId, "b".repeat(40));
        else if (change === "branch") gitSync(cwd, ["checkout", "-b", "owner-moved"]);
        else {
          writeFiles(cwd, { "owner.txt": "arrived during observation" });
          if (change === "head") commitAll(cwd, "owner moved head");
        }
      }
      return ancestor;
    });
    try {
      expect((await harness.cp.repositories.observe(repositoryId))?.lastObservedHead)
        .toBe(change === "baseline" ? "b".repeat(40) : baseline);
      expect(reads).toBe(1);
    } finally { probe.mockRestore(); projectProbe.mockRestore(); }
  });

  it("#228 refuses to reuse a temporary repository binding created for another run", async () => {
    const harness = makeHarness();
    const repository = makeRepo();
    const first = await harness.cp.repositories.registerTemporary(repository, "run-A");
    if (!first.allowed) throw new Error(first.message);

    const refused = await harness.cp.repositories.registerTemporary(repository, "run-B");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.TEMPORARY_REPOSITORY_SCOPE_VIOLATION);
    const attachment = harness.cp.repositories.assertRunScope(first.value.repositoryId, "run-B");
    expect(attachment.allowed).toBe(false);
    expect(attachment.reasonCode).toBe(ReasonCode.TEMPORARY_REPOSITORY_SCOPE_VIOLATION);
  });
});
