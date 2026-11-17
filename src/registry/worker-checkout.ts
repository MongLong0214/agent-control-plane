import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { git, withoutRepositoryPrograms } from "../git/git.ts";
import {
  type ManagedWriteGuard,
  type RepairWorktreeAuthority,
  WorktreeAction,
  WriteOperation,
} from "../guard/managed-write-guard.ts";
import { canonical } from "../guard/workspace-probe.ts";
import { type ResidentRepository, residentRepositories } from "./resident-repositories.ts";
import { branchCreations } from "../run/task-write-target.ts";

/**
 * #1227 — a resident CTO runs in its project's clone, and every worker turn ran in that same checkout:
 * whatever the resident's tooling wrote there (Claude Code's `.claude/scheduled_tasks.lock`, notes, an
 * edit in progress) was in front of the worker scan, and could reach a candidate. A resident project's
 * worker turns therefore get their own checkout at `residentWorkerCheckoutPath`: a separate local clone of
 * the resident's clone, with its own git dir (refs, config, HEAD, index, logs; no hooks), made by the
 * control plane and registered in the clone's place, so every machine that reads the registered checkout
 * — claims, the write target, the worker turn, freeze, candidate verification, GitHub publication —
 * uses it unchanged. The clone stays the resident's, and nothing in it is ever written.
 *
 * Not a linked worktree: that shares the clone's git dir, so a resident's commit or fetch (its refs,
 * reflogs, COMMIT_EDITMSG, FETCH_HEAD) changed the git dir a worker turn is held to and refused the turn
 * (#1227 review, PR #1256). Objects come over by git's local clone, which hardlinks the clone's object
 * files rather than borrowing them through `objects/info/alternates`: git never rewrites an object file
 * in place, so the resident's gc, repack or prune can only unlink its own names, never take an object
 * from the worker clone. Later objects (a base the resident committed after the move) are fetched from
 * the clone by name when a run pins its base (`task-write-target.ts`), and only objects are written then.
 */
export const REPOSITORY_CHECKOUT_MOVED = "REPOSITORY_CHECKOUT_MOVED";
/** A move that could not happen on this pass; recorded once per distinct refusal, tried again on the next. */
export const REPOSITORY_CHECKOUT_MOVE_REFUSED = "REPOSITORY_CHECKOUT_MOVE_REFUSED";

/** The worker clone's own configuration naming the resident clone it was made from: how a move recognises its own. */
const MADE_FROM = "acp.residentClone";

/** CommitLore's notes ref, and how long, at most, one question to the remote about it may take. */
const NOTES_REF = "refs/notes/commitlore";
/** The config key CommitLore reads an origin's recorded absence of notes from: `r` and the hex of the remote's name. */
const ORIGIN_ABSENCE_KEY = `commitlore.notesabsence.r${Buffer.from("origin", "utf8").toString("hex")}`;
/** CommitLore's own test (`coversNotes`): a fetch refspec whose destination is its notes ref, or a glob that includes it. */
const coversCommitLoreNotes = (refspec: string): boolean => {
  const destination = refspec.replace(/^\+/, "").split(":")[1] ?? "";
  return destination === NOTES_REF || (destination.endsWith("/*") && NOTES_REF.startsWith(destination.slice(0, -1)));
};
const ORIGIN_QUESTION_MS = 20_000;
/** A remote that could not be asked is not asked again for this long, so a pass is not spent waiting on it. */
const ORIGIN_RETRY_MS = 5 * 60_000;

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Moves each live resident's repository from the resident's clone to its dedicated worker clone.
 *
 * Run by the daemon at start and on every watchdog pass (`Daemon.resumeResidentProjects`), so a new
 * project is moved on the pass after its activation and an existing one on the first start of a build
 * that has this. Idempotent: a repository already at its worker clone, or registered anywhere but its
 * resident's clone, is left alone. Until it is moved, worker turns refuse to run in the clone
 * (`WorkerTurnRunner`), so no turn is ever in flight there while it moves.
 *
 * One move, under one Managed Write Guard grant (GIT_WORKTREE ADD, outside any run, by the composition
 * root's repair authority, for the registered checkout it reads), with nothing of the resident clone
 * written:
 * 1. the clone is cloned beside the final path (`git clone --no-checkout`, no template, no hook): its
 *    objects hardlinked; every local branch and ACP private ref (`refs/acp/*`) copied as the clone has
 *    them; none of its remote-tracking refs; `origin` set to the clone's own `origin` URL, the
 *    repository's real remote; gc and maintenance off;
 * 2. it stands where the clone stands: on a branch the control plane made for one of the repository's
 *    tasks (S-TB) when the clone is on one, so that task re-enters it; otherwise detached at the clone's
 *    HEAD commit, so the base branch stays a ref the control plane can move to a run's pin;
 * 3. it is checked out with no hook, fsmonitor or filter program run, must stand clean, and is renamed
 *    into place; a path there that is not a worker clone made from this clone is refused and left as it is;
 * 4. in one transaction the registry names the worker clone, the repository's HELD worktree claims
 *    follow it, and `REPOSITORY_CHECKOUT_MOVED` records from where to where.
 *
 * #1268 — CommitLore's notes mirror goes with it: a managed turn is refused when its checkout has a remote and no
 * mirror ("notes unfetched"), so the notes refs, the fetch refspec for them and the record that the remote's mirror
 * was looked for (`commitlore.notesabsence.*`, what `commitlore doctor --fix` writes) are carried over when the
 * worker clone is made, and again on a later pass for a worker clone made before this, while no turn runs in it.
 */
export class WorkerCheckouts {
  readonly #lastRefusal = new Map<string, string>();
  readonly #askedAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly guard: ManagedWriteGuard,
    private readonly authority: RepairWorktreeAuthority,
    /** #1268 — holds a worktree against worker turn admissions for a write between turns; null when a turn holds it (`WorkerTurnRunner.holdForMaintenance`). */
    private readonly hold?: (worktree: string) => (() => void) | null,
  ) {}

  /** Every resident repository still registered at its clone, moved; one already at its worker clone has its notes mirror refreshed. Never throws. */
  async ensureAll(): Promise<Array<{ repositoryId: string; outcome: Decision<string> }>> {
    const outcomes: Array<{ repositoryId: string; outcome: Decision<string> }> = [];
    for (const resident of residentRepositories(this.db)) {
      const moved = canonical(resident.checkoutPath) === resident.workerCheckoutPath;
      if (canonical(resident.checkoutPath) !== resident.clonePath && !moved) continue;
      let outcome: Decision<string>;
      try {
        outcome = moved ? await this.refreshNotes(resident) : await this.move(resident);
      } catch (error) {
        outcome = deny(ReasonCode.INTERNAL_ERROR, "the worker checkout could not be made", {
          identity: resident.identity,
          error: errorText(error).slice(0, 300),
        });
      }
      if (outcome.allowed) this.#lastRefusal.delete(resident.repositoryId);
      else this.recordRefusal(resident, outcome);
      outcomes.push({ repositoryId: resident.repositoryId, outcome });
    }
    return outcomes;
  }

  /** A turn of this repository that has not ended: its git dir is held to a baseline, so it is not written meanwhile. */
  private runningTurn(resident: ResidentRepository): { execution_id: string } | undefined {
    return this.db.get<{ execution_id: string }>(
      `SELECT e.execution_id FROM task_executions e
         JOIN tasks t ON t.task_id = e.task_id
         JOIN run_repositories rr ON rr.run_id = t.run_id
        WHERE rr.repository_id = ?
          AND (e.status = 'RUNNING' OR (e.worker_process_id IS NOT NULL AND e.worker_process_released_at IS NULL))
        ORDER BY e.execution_id LIMIT 1`,
      [resident.repositoryId],
    );
  }

  /**
   * #1268 — the worker clone a repository is already registered at, with the resident clone's CommitLore notes mirror
   * carried into it and its origin's notes (or their absence) settled, unless a turn of the repository has not ended. Only a
   * clone this control plane made from that resident clone is written; the resident's clone is only read.
   *
   * Everything is read first, the question to origin included, and nothing is authorised or written on a pass that finds
   * nothing to do. A write holds the worker clone against turn admissions for its whole length (`hold`) and looks for a
   * turn again once it holds it: a turn is held to the git dir it found, so a write landing after one began would fail it.
   */
  private async refreshNotes(resident: ResidentRepository): Promise<Decision<string>> {
    const { clonePath: clone, workerCheckoutPath: worker } = resident;
    if (this.runningTurn(resident) !== undefined) return allow(ReasonCode.OK, worker);
    const made = lstatOrNull(join(worker, ".git"))?.isDirectory() === true
      ? await git(worker, ["config", "--local", "--get", MADE_FROM], { allowFailure: true })
      : null;
    if (made?.exitCode !== 0 || made.stdout.trim() !== clone) return allow(ReasonCode.OK, worker);
    const missing = await this.notesMissing(clone, worker);
    const answer = await this.askOrigin(resident.repositoryId, worker);
    const settling = answer !== null && (await this.originNeedsWrite(worker, answer));
    if (!missing && !settling) return allow(ReasonCode.OK, worker);
    const held = this.hold?.(worker) ?? null;
    if (this.hold !== undefined && held === null) return allow(ReasonCode.OK, worker);
    try {
      const authorised = await this.guard.authorize(
        {
          operation: WriteOperation.GIT_WORKTREE,
          worktreeAction: WorktreeAction.ADD,
          targetPath: worker,
          targetWorktreeId: worker,
          repositoryIdentity: resident.identity,
          repairWorktreeAuthority: this.authority,
          actor: "worker-checkout",
        },
        async () => {
          if (this.runningTurn(resident) !== undefined) return;
          if (missing) await this.carryNotes(clone, worker);
          if (answer !== null) await this.settleOrigin(worker, answer);
        },
      );
      return authorised.allowed ? allow(ReasonCode.OK, worker) : (authorised as Decision<never>);
    } finally {
      held?.();
    }
  }

  /**
   * #1268 — CommitLore answers a lookup "unfetched", which `required` refuses, unless the clone has a local notes ref, or
   * records (`commitlore.notesabsence.*`, which `commitlore doctor --fix` writes after an empty `git ls-remote`) that its
   * remote was asked and advertises none; a repository whose remote has no notes at all (a new project) has neither. So a
   * clone with no notes ref asks its origin, with the daemon's own git (CommitLore's child has no credential), and asks again
   * on every later pass past `ORIGIN_RETRY_MS`: an absence is only as good as the last time it was verified.
   *
   * Read only. `none`: origin answered and advertises no CommitLore notes; `some`: it advertises them; `unanswered`: it did not
   * answer (no network, no permission, a timeout), which says nothing about notes. null: not asked now (a notes ref is held,
   * there is no origin, or it was asked lately).
   */
  private async askOrigin(repositoryId: string, worker: string): Promise<{ url: string; advertised: "none" | "some" | "unanswered" } | null> {
    const asked = this.#askedAt.get(repositoryId);
    if (asked !== undefined && Date.parse(this.clock.nowIso()) - asked < ORIGIN_RETRY_MS) return null;
    const into = await withoutRepositoryPrograms(worker);
    if ((await git(worker, [...into, "rev-parse", "--verify", "-q", NOTES_REF], { allowFailure: true })).exitCode === 0) return null;
    const url = (await git(worker, [...into, "config", "--local", "--get", "remote.origin.url"], { allowFailure: true })).stdout.trim();
    if (url === "") return null;
    this.#askedAt.set(repositoryId, Date.parse(this.clock.nowIso()));
    const advertised = await git(worker, [...into, "ls-remote", "origin", NOTES_REF], { allowFailure: true, timeoutMs: ORIGIN_QUESTION_MS });
    if (advertised.exitCode !== 0) return { url, advertised: "unanswered" };
    return { url, advertised: advertised.stdout.trim() === "" ? "none" : "some" };
  }

  /** Whether acting on `answer` would change `worker`. */
  private async originNeedsWrite(worker: string, answer: { url: string; advertised: "none" | "some" | "unanswered" }): Promise<boolean> {
    if (answer.advertised === "some") return true;
    const into = await withoutRepositoryPrograms(worker);
    const recorded = (await git(worker, [...into, "config", "--local", "--get", ORIGIN_ABSENCE_KEY], { allowFailure: true })).stdout.trim();
    if (answer.advertised === "unanswered") return recorded !== "";
    return recorded !== answer.url || !(await this.notesConfigOf(worker)).specs.some(coversCommitLoreNotes);
  }

  /**
   * #1268 — what origin answered, as `commitlore doctor --fix` acts on it: notes it advertises are fetched as the mirror and
   * no absence stands; none is recorded as CommitLore records it (a fetch refspec that covers CommitLore's notes, and
   * `commitlore.notesabsence.*` naming the url asked); an origin that did not answer leaves no absence record standing, so a
   * lookup that cannot be answered is refused. Nothing is pushed to the remote.
   */
  private async settleOrigin(worker: string, answer: { url: string; advertised: "none" | "some" | "unanswered" }): Promise<void> {
    const into = await withoutRepositoryPrograms(worker);
    if (answer.advertised !== "none") {
      await git(worker, [...into, "config", "--local", "--unset-all", ORIGIN_ABSENCE_KEY], { allowFailure: true });
      if (answer.advertised === "some") {
        await git(worker, [
          ...into, "-c", "gc.auto=0", "-c", "maintenance.auto=false",
          "fetch", "--quiet", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "origin", `${NOTES_REF}:${NOTES_REF}`,
        ], { allowFailure: true, timeoutMs: ORIGIN_QUESTION_MS });
      }
      return;
    }
    if (!(await this.notesConfigOf(worker)).specs.some(coversCommitLoreNotes)) {
      await git(worker, [...into, "config", "--local", "--add", "remote.origin.fetch", "refs/notes/*:refs/notes/*"]);
    }
    await git(worker, [...into, "config", "--local", ORIGIN_ABSENCE_KEY, answer.url]);
  }

  /** A repository's CommitLore notes refs, each with the object it names. */
  private async notesRefsOf(repo: string): Promise<Array<{ ref: string; oid: string }>> {
    const programs = await withoutRepositoryPrograms(repo);
    const listed = await git(repo, [...programs, "for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/"], { allowFailure: true });
    return listed.stdout.split("\n").filter((line) => line.length > 0).map((line) => ({ ref: line.slice(0, line.indexOf(" ")), oid: line.slice(line.indexOf(" ") + 1) }));
  }

  /** The fetch refspecs on origin that cover notes, that `repo` has. */
  private async notesConfigOf(repo: string): Promise<{ specs: string[] }> {
    const programs = await withoutRepositoryPrograms(repo);
    const configured = await git(repo, [...programs, "config", "--local", "--get-all", "remote.origin.fetch"], { allowFailure: true });
    return { specs: configured.stdout.split("\n").filter((line) => line.length > 0 && /^\+?refs\/notes\//.test(line)) };
  }

  /** Whether `worker` lacks any of what `clone` has of the notes mirror. A notes ref the worker is ahead of or has merged is not lacking. */
  private async notesMissing(clone: string, worker: string): Promise<boolean> {
    const into = await withoutRepositoryPrograms(worker);
    for (const { ref, oid } of await this.notesRefsOf(clone)) {
      const held = (await git(worker, [...into, "rev-parse", "--verify", "-q", ref], { allowFailure: true })).stdout.trim();
      if (held === oid) continue;
      if (held === "") return true;
      const contains = await git(worker, [...into, "merge-base", "--is-ancestor", oid, held], { allowFailure: true });
      if (contains.exitCode !== 0) return true;
    }
    const wanted = await this.notesConfigOf(clone);
    const have = await this.notesConfigOf(worker);
    return wanted.specs.some((spec) => !have.specs.includes(spec));
  }

  /**
   * CommitLore's notes mirror, as `clone` has it, in `worker`: the notes refs and the fetch refspecs for them on origin. The
   * record that origin's mirror was looked for is not carried: it is only as good as the last time it was verified, and the
   * worker clone's own question to origin (`askOrigin`) is what records it. Idempotent, and it never takes a note from the
   * worker: a notes ref the worker lacks is fetched, one it is ahead of is left, one behind is moved forward, and one both
   * have added to is merged (`git notes merge -s union`), so what a worker turn captured in its own clone is kept. `clone`
   * is only read.
   */
  private async carryNotes(clone: string, worker: string): Promise<void> {
    const into = await withoutRepositoryPrograms(worker);
    const quiet = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];
    for (const { ref, oid } of await this.notesRefsOf(clone)) {
      const held = (await git(worker, [...into, "rev-parse", "--verify", "-q", ref], { allowFailure: true })).stdout.trim();
      if (held === oid) continue;
      const fetch = (refspec: string) =>
        git(worker, [...into, ...quiet, "fetch", "--quiet", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", clone, refspec]);
      if (held === "") {
        await fetch(`${ref}:${ref}`);
        continue;
      }
      const carrying = `refs/acp/notes-carry/${ref.slice("refs/notes/".length).replace(/[^A-Za-z0-9._-]/g, "_")}`;
      await fetch(`+${ref}:${carrying}`);
      try {
        const behind = await git(worker, [...into, "merge-base", "--is-ancestor", oid, held], { allowFailure: true });
        if (behind.exitCode === 0) continue;
        const ahead = await git(worker, [...into, "merge-base", "--is-ancestor", held, oid], { allowFailure: true });
        if (ahead.exitCode === 0) await git(worker, [...into, "update-ref", "-m", "agent-control-plane: the worker checkout follows the resident's notes", ref, oid, held]);
        else await git(worker, [...into, "-c", "user.name=agent-control-plane", "-c", "user.email=acp@localhost", "notes", `--ref=${ref}`, "merge", "-s", "union", carrying]);
      } finally {
        await git(worker, [...into, "update-ref", "-d", carrying], { allowFailure: true });
      }
    }
    const have = await this.notesConfigOf(worker);
    for (const spec of (await this.notesConfigOf(clone)).specs) {
      if (!have.specs.includes(spec)) await git(worker, [...into, "config", "--local", "--add", "remote.origin.fetch", spec]);
    }
  }

  private async move(resident: ResidentRepository): Promise<Decision<string>> {
    const { clonePath: clone, workerCheckoutPath: worker } = resident;
    const running = this.runningTurn(resident);
    if (running) {
      return deny(ReasonCode.CONFLICT, "a worker turn has not ended in the resident's checkout; the move waits for it", {
        identity: resident.identity,
        executionId: running.execution_id,
      });
    }
    if (lstatOrNull(worker) !== null) {
      // Made by an earlier pass that stopped before the registry moved: it is renamed into place only
      // complete, and names the clone it was made from in its own configuration.
      const made = lstatOrNull(join(worker, ".git"))?.isDirectory() === true
        ? await git(worker, ["config", "--local", "--get", MADE_FROM], { allowFailure: true })
        : null;
      if (made?.exitCode !== 0 || made.stdout.trim() !== clone) {
        return deny(ReasonCode.CONFLICT, "the worker checkout's path holds something the control plane did not make there; it is left as it is", {
          identity: resident.identity,
          worktreePath: worker,
        });
      }
    } else {
      ensurePrivateDirectory(dirname(worker));
    }

    const made: { outcome: Decision<{ head: string; branch: string | null }> } = {
      outcome: deny(ReasonCode.INTERNAL_ERROR, "the worker checkout effect did not run", { identity: resident.identity }),
    };
    const authorised = await this.guard.authorize(
      {
        operation: WriteOperation.GIT_WORKTREE,
        worktreeAction: WorktreeAction.ADD,
        targetPath: worker,
        targetWorktreeId: clone,
        repositoryIdentity: resident.identity,
        repairWorktreeAuthority: this.authority,
        actor: "worker-checkout",
      },
      async () => {
        made.outcome = await this.materialize(resident);
      },
    );
    if (!authorised.allowed) return authorised as Decision<never>;
    if (!made.outcome.allowed) return made.outcome as Decision<never>;
    const { head, branch } = made.outcome.value;

    return this.db.txDecision((): Decision<string> => {
      const moved = this.db.run(
        `UPDATE repositories SET checkout_path = ? WHERE repository_id = ? AND checkout_path = ? AND retired_at IS NULL`,
        [worker, resident.repositoryId, resident.checkoutPath],
      );
      if (moved.changes !== 1) {
        return deny(ReasonCode.CONFLICT, "the repository's registration changed while its worker checkout was made; nothing was moved", {
          identity: resident.identity,
        });
      }
      const claims = this.db.run(
        `UPDATE resource_claims SET worktree_id = ? WHERE repository_identity = ? AND worktree_id = ? AND status = 'HELD'`,
        [worker, resident.identity, resident.checkoutPath],
      );
      const recorded = this.audit.record({
        kind: REPOSITORY_CHECKOUT_MOVED,
        projectId: resident.projectId,
        evidence: {
          identity: resident.identity,
          repositoryId: resident.repositoryId,
          from: clone,
          to: worker,
          head,
          branch,
          claimsMoved: claims.changes,
          at: this.clock.nowIso(),
        },
      });
      if (!recorded.allowed) return recorded as Decision<never>;
      return allow(ReasonCode.OK, worker);
    });
  }

  /** The guarded effect: the worker clone made (or found, made by an earlier pass) and standing clean. */
  private async materialize(resident: ResidentRepository): Promise<Decision<{ head: string; branch: string | null }>> {
    const worker = resident.workerCheckoutPath;
    if (lstatOrNull(worker) === null) {
      const staging = join(dirname(worker), `.${basename(worker)}.${randomUUID()}.tmp`);
      try {
        const made = await this.cloneInto(resident, staging);
        if (!made.allowed) return made;
        renameSync(staging, worker);
      } finally {
        if (lstatOrNull(staging) !== null) rmSync(staging, { recursive: true, force: true });
      }
    }
    const own = await withoutRepositoryPrograms(worker);
    const status = await git(worker, [...own, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"]);
    const dirty = status.stdout.split("\n").filter((line) => line.length > 0);
    if (dirty.length > 0) {
      return deny(ReasonCode.CONFLICT, "the worker checkout is not clean; it is not registered", {
        identity: resident.identity,
        worktreePath: worker,
        paths: dirty.slice(0, 20),
      });
    }
    const head = (await git(worker, [...own, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const symbolic = await git(worker, [...own, "symbolic-ref", "-q", "HEAD"], { allowFailure: true });
    const ref = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
    return allow(ReasonCode.OK, { head, branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null });
  }

  /** The worker clone, made at `staging` from the resident clone, which is only read. */
  private async cloneInto(resident: ResidentRepository, staging: string): Promise<Decision<void>> {
    const clone = resident.clonePath;
    const programs = await withoutRepositoryPrograms(clone);
    // What the clone stands on, read before the copy so the copy holds it.
    const head = (await git(clone, [...programs, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const symbolic = await git(clone, [...programs, "symbolic-ref", "-q", "HEAD"], { allowFailure: true });
    if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1) {
      return deny(ReasonCode.PROBE_FAILED, "the resident checkout's HEAD could not be read", { identity: resident.identity });
    }
    const ref = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
    const onTask = ref !== null && ref.startsWith("refs/heads/") &&
      branchCreations(this.db, resident.identity, ref.slice("refs/heads/".length)).length > 0;
    const origin = await git(clone, ["remote", "get-url", "origin"], { allowFailure: true });

    // A local clone hardlinks the object files; no template, so no hooks; nothing checked out yet.
    await git(dirname(staging), ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-checkout", "--template=", "--origin", "origin", "--", clone, staging]);
    await git(staging, [
      ...programs, "-c", "gc.auto=0", "-c", "maintenance.auto=false",
      "fetch", "--quiet", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "--update-head-ok", clone,
      "+refs/heads/*:refs/heads/*", "+refs/acp/*:refs/acp/*",
    ]);
    // The clone's branches, read as remote-tracking refs, are not the real remote's: dropped, and origin
    // names the repository's own remote, the URL the resident clone has.
    await git(staging, ["remote", "remove", "origin"]);
    if (origin.exitCode === 0 && origin.stdout.trim().length > 0) await git(staging, ["remote", "add", "origin", origin.stdout.trim()]);
    await this.carryNotes(clone, staging);
    const answer = await this.askOrigin(resident.repositoryId, staging);
    if (answer !== null) await this.settleOrigin(staging, answer);
    for (const [key, value] of [["gc.auto", "0"], ["maintenance.auto", "false"], [MADE_FROM, clone]] as const) {
      await git(staging, ["config", "--local", key, value]);
    }
    if (onTask) await git(staging, ["symbolic-ref", "-m", "agent-control-plane: the worker checkout stands on the task branch", "HEAD", ref]);
    else await git(staging, ["update-ref", "--no-deref", "-m", "agent-control-plane: the worker checkout rests detached", "HEAD", head]);
    await git(staging, [...(await withoutRepositoryPrograms(staging)), "read-tree", "-u", "--reset", "HEAD"]);
    return allow(ReasonCode.OK, undefined);
  }

  private recordRefusal(resident: ResidentRepository, refusal: Decision<string>): void {
    if (refusal.allowed) return;
    const key = `${refusal.reasonCode}:${refusal.message}`;
    if (this.#lastRefusal.get(resident.repositoryId) === key) return;
    this.#lastRefusal.set(resident.repositoryId, key);
    try {
      this.audit.record({
        kind: REPOSITORY_CHECKOUT_MOVE_REFUSED,
        projectId: resident.projectId,
        reasonCode: refusal.reasonCode,
        evidence: { identity: resident.identity, repositoryId: resident.repositoryId, reason: refusal.message, deferred: true },
      });
    } catch {
      /* a report: the next pass tries the move again either way */
    }
  }
}
