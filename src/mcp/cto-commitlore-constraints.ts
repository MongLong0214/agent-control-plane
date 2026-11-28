import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BEFORE_CHANGE_CONCURRENCY,
  BEFORE_CHANGE_LOOKUP_MS,
  beforeChangeCoverage,
  beforeChangeProposal,
  beforeChangeSection,
} from "../bootstrap/commitlore-commit.ts";
import {
  type CommitLoreBeforeChange,
  type CommitLoreGuardLookup,
  type CommitLoreLookupEvent,
  type CommitLorePathLookup,
  type CommitLorePort,
  commitloreGoverned,
  repositoryObjectFormat,
} from "../bootstrap/commitlore-observation.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import { git, withoutRepositoryPrograms } from "../git/git.ts";
import type { RunEngine } from "../run/run-engine.ts";
import { type TaskWriteTargets, isNormalRelativePath } from "../run/task-write-target.ts";

/**
 * #1456 — what CommitLore holds for the paths a run's CTO names, at the run's base, answered by `contract_get` before
 * the CTO cuts the work: the lookup a worker turn makes before it edits (`CommitLorePort.beforeChange`) and the section
 * it renders (`beforeChangeSection`). Advisory: nothing here refuses a path. A failed, partial or late lookup is told per
 * path by its outcome, and the worker-time lookup stays the enforcement.
 */

const NOTES_REF = "refs/notes/commitlore";
/**
 * The checkout's configuration CommitLore reads (whether its notes are whole, its trust and inject settings), copied into
 * the clone rather than dropping the clone's origin alone: with no remote, CommitLore answers notes "absent" and grades
 * records [claim] where the checkout answers "unfetched" or [directive].
 */
const COMMITLORE_READS = "^(remote\\..+\\.(url|fetch)|commitlore\\..+)$";

export interface CommitLoreConstraintsSource {
  readonly db: Db;
  readonly runs: Pick<RunEngine, "require" | "repositoriesOf">;
  readonly artifacts: Pick<ArtifactStore, "latest">;
  readonly commitlore: CommitLorePort | null;
}

export type CommitLoreConstraints =
  | { readonly status: "NOT_CONSULTED"; readonly reason: string }
  | {
      readonly status: "CONSULTED";
      readonly baseHead: string;
      readonly section: string;
      readonly paths: ReadonlyArray<Pick<CommitLorePathLookup, "path" | "outcome" | "items" | "withheld" | "detail">>;
      readonly guard: CommitLoreGuardLookup;
      /** How many of the paths the section does not cover. */
      readonly omitted: number;
    };

const notConsulted = (reason: string): Decision<CommitLoreConstraints> => allow(ReasonCode.OK, { status: "NOT_CONSULTED", reason });

/**
 * A clone of `checkout` at `into`, detached at `baseSha`, for CommitLore to answer in as it answers in the checkout, which
 * cannot be moved to the base for it: a local clone, so its objects are hardlinked and its history is whole; the checkout's
 * CommitLore notes and the configuration CommitLore reads (`COMMITLORE_READS`) in place of the clone's own origin; the base
 * fetched from `residentClone` when the checkout does not hold it yet. The checkout and the resident clone are only read.
 */
const cloneAtBase = async (checkout: string, residentClone: string | null, baseSha: string, into: string): Promise<void> => {
  await git(dirname(into), ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-checkout", "--template=", "--", checkout, into]);
  const from = await withoutRepositoryPrograms(checkout);
  const own = await withoutRepositoryPrograms(into);
  const fetch = (source: string, refspec: string) =>
    git(into, [...own, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", source, refspec], { allowFailure: true });
  await git(into, [...own, "remote", "remove", "origin"]);
  const read = await git(checkout, [...from, "config", "--local", "-z", "--get-regexp", COMMITLORE_READS], { allowFailure: true });
  for (const entry of read.stdout.split("\0").filter((line) => line.length > 0)) {
    const at = entry.indexOf("\n");
    await git(into, [...own, "config", "--local", "--add", at < 0 ? entry : entry.slice(0, at), at < 0 ? "true" : entry.slice(at + 1)]);
  }
  if ((await git(checkout, [...from, "rev-parse", "--verify", "-q", NOTES_REF], { allowFailure: true })).exitCode === 0) {
    const notes = await fetch(checkout, `+${NOTES_REF}:${NOTES_REF}`);
    if (notes.exitCode !== 0) throw new Error(`the checkout's CommitLore notes could not be read: git fetch exited ${notes.exitCode}`);
  }
  const present = async (): Promise<boolean> => (await git(into, [...own, "cat-file", "-e", `${baseSha}^{commit}`], { allowFailure: true })).exitCode === 0;
  if (!(await present()) && residentClone !== null) await fetch(residentClone, baseSha);
  if (!(await present())) throw new Error(`the run's base ${baseSha} is in neither the registered checkout nor the resident's clone`);
  await git(into, [...own, "update-ref", "--no-deref", "-m", "agent-control-plane: CommitLore reads the run's base", "HEAD", baseSha]);
  await git(into, [...own, "read-tree", "-u", "--reset", "HEAD"]);
};

/**
 * #1456 — `paths` (repository-relative, normal form) of the run's repository `repositoryIdentity`, which may be left out
 * only when the run has one. A run CommitLore does not govern, a deployment with no CommitLore and a base that cannot
 * be read are answered NOT_CONSULTED; only input that names no path or repository of the run is refused.
 */
export const commitloreConstraintsForRun = async (
  source: CommitLoreConstraintsSource,
  writeTargets: Pick<TaskWriteTargets, "baseOf">,
  runId: string,
  input: { readonly paths: readonly string[]; readonly repositoryIdentity?: string | undefined },
): Promise<Decision<CommitLoreConstraints>> => {
  const paths = [...new Set(input.paths)];
  const malformed = paths.filter((path) => !isNormalRelativePath(path));
  if (malformed.length > 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "contract_get paths must be repository-relative paths in normal form", { paths: malformed.slice(0, 5) });
  }
  const repositories = source.runs.repositoriesOf(runId);
  const named = input.repositoryIdentity;
  const repository = named === undefined ? (repositories.length === 1 ? repositories[0]! : null) : (repositories.find((candidate) => candidate.identity === named) ?? null);
  if (repository === null && (named !== undefined || repositories.length > 1)) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      named === undefined
        ? "contract_get paths name no repositoryIdentity and the run has more than one repository; the control plane does not pick one"
        : "contract_get names a repositoryIdentity this run does not include",
      { runId, repositories: repositories.map((candidate) => candidate.identity) },
    );
  }
  if (!commitloreGoverned(source.db, runId)) return notConsulted("the run pins no manifest, so CommitLore does not govern it");
  const port = source.commitlore;
  if (port === null || port.beforeChange === undefined) return notConsulted("this deployment has no CommitLore to read records with");
  if (repository === null) return notConsulted("the run has no repository");
  const base = await writeTargets.baseOf(runId, repository);
  if (!base.allowed) return notConsulted(`the run's base could not be read: ${base.message}`);
  const baseHead = base.value.baseSha;
  const run = source.runs.require(runId);
  const contract = source.artifacts.latest(runId, ArtifactKind.TASK_CONTRACT)?.content ?? null;

  const root = acpScratchDir("acp-cto-constraints-");
  try {
    const checkout = join(root, "checkout");
    const scratch = join(root, "lookup");
    mkdirSync(scratch, { mode: 0o700 });
    let gitTarget: { gitDir: string; workTree: string; objectFormat: "sha1" | "sha256" };
    try {
      await cloneAtBase(repository.checkoutPath, base.value.residentClone, baseHead, checkout);
      gitTarget = { gitDir: join(checkout, ".git"), workTree: checkout, objectFormat: await repositoryObjectFormat(join(checkout, ".git")) };
    } catch (error) {
      return notConsulted(`no checkout at the run's base could be made for CommitLore: ${(error as Error).message.slice(0, 300)}`);
    }

    // As a worker turn takes it: each part told by the deadline is kept, and only what was not told by then failed.
    const deadline = Date.now() + BEFORE_CHANGE_LOOKUP_MS;
    const told: { paths: Map<string, CommitLorePathLookup>; guard: CommitLoreGuardLookup | null } = { paths: new Map(), guard: null };
    const report = (event: CommitLoreLookupEvent): void => {
      if (Date.now() > deadline) return;
      if (event.kind === "path") told.paths.set(event.lookup.path, event.lookup);
      else if (event.kind === "guard") told.guard = event.lookup;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let whole: CommitLoreBeforeChange | null = null;
    let why = "CommitLore gave no answer for it";
    try {
      const asked = port.beforeChange(checkout, gitTarget, {
        paths,
        baseHead,
        proposal: beforeChangeProposal(run.goal, contract),
        scratch,
        deadline,
        concurrency: BEFORE_CHANGE_CONCURRENCY,
        report,
      });
      asked.catch(() => {});
      const settled = await Promise.race([
        asked.then((value) => ({ value })),
        new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), BEFORE_CHANGE_LOOKUP_MS);
        }),
      ]);
      if (settled === "late" || Date.now() > deadline) why = `the CommitLore lookup did not answer within ${BEFORE_CHANGE_LOOKUP_MS} ms`;
      else if (settled.value === null) return notConsulted("this deployment has no CommitLore to read records with");
      else whole = settled.value;
    } catch (error) {
      why = `the CommitLore lookup failed: ${(error as Error).message.slice(0, 300)}`;
    } finally {
      clearTimeout(timer);
    }
    const lookups = paths.map(
      (path): CommitLorePathLookup =>
        told.paths.get(path) ?? whole?.paths.find((entry) => entry.path === path) ?? { path, outcome: "failed", text: "", cacheKey: null, withheld: 0, items: null, detail: why },
    );
    const guard: CommitLoreGuardLookup = told.guard ?? whole?.guard ?? { status: "not_consulted", matches: [], detail: `guard not consulted: ${why}` };
    const coverage = beforeChangeCoverage(paths, lookups);
    return allow(ReasonCode.OK, {
      status: "CONSULTED",
      baseHead,
      section: beforeChangeSection({ baseHead, coverage, guard }),
      paths: lookups.map(({ path, outcome, items, withheld, detail }) => ({ path, outcome, items, withheld, detail })),
      guard,
      omitted: new Set(coverage.uncovered.map((gap) => gap.path)).size,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
