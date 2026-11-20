import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * Every CTO refresh and recovery runs inside agentcpd, one at a time on the host, through this queue. There is no other door:
 * the operator's `agentctl cto refresh --apply` is a request to the daemon (`ctoRefresh.run`), the daemon's own sweep enqueues
 * the same way, and the child that carries a job out refuses to run unless the daemon vouches for it with the token this queue
 * minted for that one run (`ctoRefresh.verify`). Mutual exclusion is the queue and nothing on disk, so there is no lock to
 * go stale and nothing to take over.
 */

export const CTO_REFRESH_RUN_METHOD = "ctoRefresh.run";
export const CTO_REFRESH_VERIFY_METHOD = "ctoRefresh.verify";
export const CTO_REFRESH_TOKEN_ENV = "ACP_CTO_REFRESH_RUN_TOKEN";
/** A whole refresh (rotate, stop, launch, claim, and a rollback) is bounded; the child is killed past it. */
export const CTO_REFRESH_CHILD_TIMEOUT_MS = 15 * 60_000;

export type RefreshMode = "refresh" | "recover";
export interface RefreshJobResult { ok: boolean; reason: string; lines: Array<Record<string, unknown>> }
export interface RefreshJob { projectId: string; mode: RefreshMode; token: string }

export interface RefreshQueue {
  /** Runs the job after every job queued before it, and answers its result. A job already queued or running for the same project and mode is the same job. */
  enqueue(projectId: string, mode: RefreshMode): Promise<RefreshJobResult>;
  /** Whether a job is queued or running. */
  busy(): boolean;
  /** Whether `token` is the token of the job that is running now for this project and mode. */
  verify(token: string, projectId: string, mode: RefreshMode): boolean;
}

export const createRefreshQueue = (execute: (job: RefreshJob) => Promise<RefreshJobResult>): RefreshQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  const waiting = new Map<string, Promise<RefreshJobResult>>();
  const running = new Map<string, { projectId: string; mode: RefreshMode }>();
  return {
    enqueue: (projectId, mode) => {
      const key = `${mode}:${projectId}`;
      const same = waiting.get(key);
      if (same) return same;
      const job = tail.then(async (): Promise<RefreshJobResult> => {
        const token = randomUUID();
        running.set(token, { projectId, mode });
        try { return await execute({ projectId, mode, token }); } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error), lines: [] };
        } finally { running.delete(token); waiting.delete(key); }
      });
      waiting.set(key, job);
      tail = job;
      return job;
    },
    busy: () => waiting.size > 0,
    verify: (token, projectId, mode) => {
      const job = running.get(token);
      return job !== undefined && job.projectId === projectId && job.mode === mode;
    },
  };
};

/**
 * Runs `agentctl cto refresh <project> [--recover] --apply` from the installed runtime as a child, with the daemon's own operator
 * credential and the job's token in its environment (never printed; the child's JSON lines are what comes back). A child, not a call
 * into this process: the refresh runs `tmux` and `claude mcp` synchronously and waits on a launch, and the daemon must not stand
 * still for that.
 */
export const runRefreshChild = (stateDir: string, env: NodeJS.ProcessEnv, job: RefreshJob, timeoutMs = CTO_REFRESH_CHILD_TIMEOUT_MS): Promise<RefreshJobResult> => {
  const node = join(stateDir, "current", "dist", "bin", "node");
  const cli = join(stateDir, "current", "dist", "cli", "agentctl.js");
  if (!existsSync(node) || !existsSync(cli)) return Promise.resolve({ ok: false, reason: `the agentctl runtime is not installed under ${join(stateDir, "current")}`, lines: [] });
  const args = ["cto", "refresh", job.projectId, ...(job.mode === "recover" ? ["--recover"] : []), "--apply"];
  return new Promise((resolve) => {
    const child = spawn(node, [cli, ...args], { env: { ...env, [CTO_REFRESH_TOKEN_ENV]: job.token }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString("utf8")).slice(-65_536); });
    child.stderr.on("data", () => undefined);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    const finish = (code: number | null, error?: Error): void => {
      clearTimeout(timer);
      const lines = out.trim().split("\n").flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
      const failed = lines.find((line) => line["result"] === "failed");
      const refusal = lines.find((line) => typeof line["refused"] === "string");
      const reason = error ? error.message : timedOut ? `the refresh did not end within ${timeoutMs / 1000}s` :
        typeof failed?.["reason"] === "string" ? `${String(failed["step"])}: ${failed["reason"]}` : typeof refusal?.["refused"] === "string" ? refusal["refused"] : `exit ${code}`;
      resolve({ ok: !error && !timedOut && code === 0, reason, lines });
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
};

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** The operator's two requests: `run` (queue a job, answer its result) and `verify` (is this token the running job's). Owner only; composed by `startDaemonOperatorSocket`. */
export type CtoRefreshOperator = (method: "run" | "verify", params: Record<string, unknown>) => Promise<Decision<unknown>>;

export const ctoRefreshOperator = (queue: RefreshQueue): CtoRefreshOperator => async (method, params) => {
  const { projectId, recover, token } = params;
  const keys = Object.keys(params).filter((name) => name !== "recover").sort().join(",");
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId) || (recover !== undefined && typeof recover !== "boolean") ||
      keys !== (method === "run" ? "projectId" : "projectId,token") || (method === "verify" && typeof token !== "string")) {
    return deny(ReasonCode.INVALID_ARGUMENT, "ctoRefresh takes projectId, an optional boolean recover and, to verify, the run's token", {});
  }
  const mode: RefreshMode = recover === true ? "recover" : "refresh";
  if (method === "verify") {
    return queue.verify(token as string, projectId, mode) ? allow(ReasonCode.OK, {}) : deny(ReasonCode.CONFLICT, "this is not the token of the refresh the daemon is running for this project", {});
  }
  return allow(ReasonCode.OK, await queue.enqueue(projectId, mode));
};
