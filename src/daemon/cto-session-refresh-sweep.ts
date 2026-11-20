import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { pendingRotationOf, liveRunIdsOwnedBySession } from "../registry/canonical-cto-rotation.ts";
import { CanonicalSessionRegistry } from "../registry/canonical-session-registry.ts";
import type { ControlPlane } from "../app/control-plane.ts";
import { SessionLifecycle } from "../domain/types.ts";
import {
  CTO_HANDOFF_WAIT_MS, CTO_REFRESH_QUIET_SECONDS, buildFallbackHandoff, clearHandoffRequest, clearRefreshFailure, createConversationMeter, ctoTranscriptPath,
  gatherFallbackFacts, hostStoreFiles, longReasons, readHandoff, readHandoffRequest, readRefreshFailure, recordRefreshFailure, refreshLimitsFromEnv,
  retryNotBefore, writeHandoff, writeHandoffRequest, DEFAULT_REFRESH_LIMITS,
  type ConversationFiles, type ConversationMeasure, type FallbackFacts, type LongReason, type RefreshLimits, type StoreFiles,
} from "../cto/cto-session-refresh.ts";

/**
 * The daemon's half of a CTO conversation refresh (`src/cto/cto-session-refresh.ts`): on a timer it measures every live
 * CTO's conversation, and for one that is long and idle it asks for a handoff, waits a bounded time for it, and then runs
 * `agentctl cto refresh <project> --apply`, the one place that stops a CTO and starts its successor. It decides when;
 * it never signals a process itself.
 *
 *   - one refresh at a time on the host (a second candidate waits for the next tick), and none while a refresh is running;
 *   - a project whose refresh failed is not tried again until its backoff has passed (it doubles with every failure);
 *   - "idle" is all of: the transcript unchanged for a minute, no live run the session owns, no running work of the
 *     project, and no switchover already pending;
 *   - the handoff is waited for at most `CTO_HANDOFF_WAIT_MS`; then ACP writes one itself. Nothing waits forever.
 */

export interface RefreshCandidate {
  projectId: string;
  roleKey: string;
  generation: number;
  /** The conversation the role's binding is held by: the transcript's name. */
  conversation: string;
  sessionId: string;
  cwd: string | null;
}

export type RefreshVerdict =
  | { projectId: string; action: "unmeasured" }
  | { projectId: string; action: "not-long" }
  | { projectId: string; action: "backoff"; retryAt: number }
  | { projectId: string; action: "waiting-idle"; reasons: LongReason[]; because: string }
  | { projectId: string; action: "asked"; requestId: string }
  | { projectId: string; action: "waiting-handoff"; since: string }
  | { projectId: string; action: "busy" }
  | { projectId: string; action: "refreshed"; source: "cto" | "acp" }
  | { projectId: string; action: "failed"; reason: string };

export interface RefreshSweepDeps {
  stateDir: string;
  files?: StoreFiles;
  now(): number;
  limits?: RefreshLimits;
  handoffWaitMs?: number;
  candidates(): RefreshCandidate[];
  /** The candidate's transcript path, or null when its folder is unknown. */
  transcriptOf(candidate: RefreshCandidate): string | null;
  measure(path: string): ConversationMeasure | null;
  /** Between turns, owning no live run, nothing running for the project, no switchover pending. */
  idle(candidate: RefreshCandidate, measure: ConversationMeasure): { idle: true } | { idle: false; because: string };
  facts(candidate: RefreshCandidate): FallbackFacts | null;
  /** Runs one refresh to its end; resolves when it has succeeded or failed. */
  refresh(projectId: string): Promise<{ ok: boolean; reason: string }>;
  newId(): string;
}

export interface CtoRefreshSweep {
  tick(): Promise<RefreshVerdict[]>;
  /** A refresh is running now; the sweep starts no second one. */
  running(): boolean;
}

export const createCtoRefreshSweep = (deps: RefreshSweepDeps): CtoRefreshSweep => {
  const files = deps.files ?? hostStoreFiles;
  const limits = deps.limits ?? DEFAULT_REFRESH_LIMITS;
  const waitMs = deps.handoffWaitMs ?? CTO_HANDOFF_WAIT_MS;
  let busy = false;
  const iso = (): string => new Date(deps.now()).toISOString();

  const start = async (candidate: RefreshCandidate, source: "cto" | "acp"): Promise<RefreshVerdict> => {
    busy = true;
    try {
      const outcome = await deps.refresh(candidate.projectId);
      if (outcome.ok) {
        clearHandoffRequest(files, deps.stateDir, candidate.projectId);
        clearRefreshFailure(files, deps.stateDir, candidate.projectId);
        return { projectId: candidate.projectId, action: "refreshed", source };
      }
      recordRefreshFailure(files, deps.stateDir, candidate.projectId, outcome.reason, iso());
      return { projectId: candidate.projectId, action: "failed", reason: outcome.reason };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordRefreshFailure(files, deps.stateDir, candidate.projectId, reason, iso());
      return { projectId: candidate.projectId, action: "failed", reason };
    } finally {
      busy = false;
    }
  };

  const tick = async (): Promise<RefreshVerdict[]> => {
    const verdicts: RefreshVerdict[] = [];
    for (const candidate of deps.candidates()) {
      const projectId = candidate.projectId;
      const path = deps.transcriptOf(candidate);
      const measure = path === null ? null : deps.measure(path);
      if (measure === null) { verdicts.push({ projectId, action: "unmeasured" }); continue; }
      const reasons = longReasons(measure, limits);
      if (reasons.length === 0) {
        // No longer long (its conversation was replaced, or compacted away): nothing stays asked.
        if (readHandoffRequest(files, deps.stateDir, projectId) !== null) clearHandoffRequest(files, deps.stateDir, projectId);
        verdicts.push({ projectId, action: "not-long" });
        continue;
      }
      const retryAt = retryNotBefore(readRefreshFailure(files, deps.stateDir, projectId));
      if (deps.now() < retryAt) { verdicts.push({ projectId, action: "backoff", retryAt }); continue; }
      const idle = deps.idle(candidate, measure);
      if (!idle.idle) { verdicts.push({ projectId, action: "waiting-idle", reasons, because: idle.because }); continue; }
      // Asking and writing the fallback are cheap and may happen for several projects; only the refresh itself is one at a time.
      const stored = readHandoff(files, deps.stateDir, projectId, candidate.generation);
      if (stored?.source === "cto") {
        if (busy) { verdicts.push({ projectId, action: "busy" }); continue; }
        verdicts.push(await start(candidate, "cto"));
        continue;
      }
      const request = readHandoffRequest(files, deps.stateDir, projectId);
      if (request === null || request.conversation !== candidate.conversation || request.generation !== candidate.generation) {
        const asked = writeHandoffRequest(files, deps.stateDir, {
          requestId: deps.newId(), projectId, generation: candidate.generation, conversation: candidate.conversation, requestedAt: iso(),
        });
        verdicts.push({ projectId, action: "asked", requestId: asked.requestId });
        continue;
      }
      const waited = deps.now() - Date.parse(request.requestedAt);
      if (!(waited >= waitMs)) { verdicts.push({ projectId, action: "waiting-handoff", since: request.requestedAt }); continue; }
      // No handoff within the bound: ACP's own, from its records. The refresh takes whatever is stored for the generation.
      if (stored === null) {
        const facts = deps.facts(candidate);
        if (facts === null) { verdicts.push({ projectId, action: "waiting-idle", reasons, because: "ACP's records name no active binding to write a handoff from" }); continue; }
        const written = writeHandoff(files, deps.stateDir, {
          projectId, generation: candidate.generation, conversation: candidate.conversation, source: "acp", text: buildFallbackHandoff(facts), now: iso(),
        });
        if (!written.ok) { verdicts.push({ projectId, action: "failed", reason: written.reason }); continue; }
      }
      if (busy) { verdicts.push({ projectId, action: "busy" }); continue; }
      verdicts.push(await start(candidate, "acp"));
    }
    return verdicts;
  };

  return { tick: async () => (busy ? [] : tick()), running: () => busy };
};

// ---- the daemon's wiring ----------------------------------------------------------------------------------------------------

/** How often the daemon looks. A conversation takes hours to grow; a minute is quicker than anything it decides. */
export const CTO_REFRESH_SWEEP_INTERVAL_MS = 60_000;
/** A whole refresh (rotate, stop, launch, claim, and a rollback) is bounded; the child is killed past it. */
export const CTO_REFRESH_CHILD_TIMEOUT_MS = 15 * 60_000;

export interface RefreshChildResult { ok: boolean; reason: string }

/**
 * Runs `agentctl cto refresh <project> --apply` from the installed runtime as a child, with the daemon's own operator
 * credential in its environment (never printed; the child's output is read for its last JSON line only). A child, not a call
 * into this process: the refresh runs `tmux` and `claude mcp` synchronously and waits on a launch, and the daemon must not
 * stand still for that.
 */
export const runRefreshChild = (stateDir: string, env: NodeJS.ProcessEnv, projectId: string, timeoutMs = CTO_REFRESH_CHILD_TIMEOUT_MS): Promise<RefreshChildResult> => {
  const node = join(stateDir, "current", "dist", "bin", "node");
  const cli = join(stateDir, "current", "dist", "cli", "agentctl.js");
  if (!existsSync(node) || !existsSync(cli)) return Promise.resolve({ ok: false, reason: `the agentctl runtime is not installed under ${join(stateDir, "current")}` });
  return new Promise((resolve) => {
    const child = spawn(node, [cli, "cto", "refresh", projectId, "--apply"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString("utf8")).slice(-16_384); });
    child.stderr.on("data", () => undefined);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    const finish = (code: number | null, error?: Error): void => {
      clearTimeout(timer);
      const lines = out.trim().split("\n").reverse().flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
      const failed = lines.find((line) => line["result"] === "failed");
      const reason = error ? error.message : timedOut ? `the refresh did not end within ${timeoutMs / 1000}s` :
        typeof failed?.["reason"] === "string" ? `${String(failed["step"])}: ${failed["reason"]}`
          : typeof lines.find((line) => typeof line["refused"] === "string")?.["refused"] === "string" ? String(lines.find((line) => typeof line["refused"] === "string")!["refused"]) : `exit ${code}`;
      resolve({ ok: !error && !timedOut && code === 0, reason });
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
};

/** The sweep over a live control plane: its candidates and its idleness are read from the database and the transcript, nothing is signalled. */
export const createDaemonRefreshSweep = (
  cp: Pick<ControlPlane, "db" | "bindings" | "sessions" | "projects" | "clock">,
  options: { stateDir: string; env: NodeJS.ProcessEnv; home?: string; conversationFiles?: ConversationFiles; refresh?: (projectId: string) => Promise<RefreshChildResult>; now?: () => number; newId?: () => string },
): CtoRefreshSweep => {
  const home = options.home ?? options.env["HOME"] ?? homedir();
  const meter = createConversationMeter(options.conversationFiles);
  const now = options.now ?? Date.now;
  const registry = new CanonicalSessionRegistry(cp.db);
  return createCtoRefreshSweep({
    stateDir: options.stateDir,
    now,
    limits: refreshLimitsFromEnv(options.env),
    candidates: () => cp.bindings.activePrimaryCtos().flatMap((binding): RefreshCandidate[] => {
      const projectId = binding.projectId;
      if (projectId === null) return [];
      const project = cp.projects.get(projectId);
      const session = cp.sessions.get(binding.sessionId);
      if (!project || project.retiredAt !== null || project.suspended || session?.lifecycle !== SessionLifecycle.READY) return [];
      const conversation = conversationOf(cp.db, binding.roleKey, binding.bindingGeneration);
      return conversation === null ? [] : [{ projectId, roleKey: binding.roleKey, generation: binding.bindingGeneration, conversation, sessionId: binding.sessionId, cwd: session.workdir }];
    }),
    transcriptOf: (candidate) => (candidate.cwd ? ctoTranscriptPath(home, candidate.cwd, candidate.conversation) : null),
    measure: (path) => meter.measure(path),
    idle: (candidate, measure) => {
      const quiet = Math.floor((now() - measure.mtimeMs) / 1000);
      if (quiet < CTO_REFRESH_QUIET_SECONDS) return { idle: false, because: `its transcript changed ${quiet}s ago, so a turn may be running` };
      const runs = liveRunIdsOwnedBySession(cp.db, candidate.sessionId);
      if (runs.length > 0) return { idle: false, because: `it owns live runs (${runs.slice(0, 5).join(", ")})` };
      const working = registry.runningWork(candidate.projectId, new Date(now()).toISOString());
      if (working) return { idle: false, because: `the project has ${working.what} (${working.run_id})` };
      if (pendingRotationOf(cp.db, candidate.projectId) !== null) return { idle: false, because: "a canonical switchover of the project is already pending" };
      return { idle: true };
    },
    facts: (candidate) => gatherFallbackFacts(cp.db, candidate.projectId, candidate.conversation),
    refresh: options.refresh ?? ((projectId) => runRefreshChild(options.stateDir, options.env, projectId)),
    newId: options.newId ?? (() => randomUUID()),
  });
};

/** The conversation the role's actor targets (the transcript's name), or null when the actor has none. */
const conversationOf = (db: Pick<ControlPlane["db"], "get">, roleKey: string, generation: number): string | null =>
  db.get<{ target_locator: string }>(
    `SELECT tb.target_locator FROM actor_target_bindings tb JOIN assignments a ON a.actor_id = tb.target_actor_id
      WHERE a.role_key = ? AND a.status = 'ACTIVE' AND a.binding_generation = ?`, [roleKey, generation])?.target_locator ?? null;

/** Starts the timer; the returned handle is cleared at shutdown. A tick that throws is reported and dropped, never raised into the daemon. */
export const startCtoRefreshSweep = (
  sweep: CtoRefreshSweep, report: (line: Record<string, unknown>) => void, intervalMs = CTO_REFRESH_SWEEP_INTERVAL_MS,
): NodeJS.Timeout => {
  const timer = setInterval(() => {
    void sweep.tick().then(
      // What a person reading the log needs: a request made, a refresh done or failed. Waiting is the usual state and says nothing.
      (verdicts) => { const news = verdicts.filter((v) => v.action === "asked" || v.action === "refreshed" || v.action === "failed"); if (news.length > 0) report({ ctoRefresh: news }); },
      (error: unknown) => report({ ctoRefreshSweepFailed: error instanceof Error ? error.message : String(error) }),
    );
  }, intervalMs);
  timer.unref();
  return timer;
};
