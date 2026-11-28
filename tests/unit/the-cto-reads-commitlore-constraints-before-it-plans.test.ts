import { accessSync, constants, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BEFORE_CHANGE_CONCURRENCY, beforeChangeCoverage, beforeChangeProposal, beforeChangeSection } from "../../src/bootstrap/commitlore-commit.ts";
import {
  COMMITLORE_LIMITS,
  type CommitLoreBeforeChangeRequest,
  type CommitLorePathLookup,
  type CommitLorePort,
  commitloreRunner,
  createCommitLoreCliPort,
} from "../../src/bootstrap/commitlore-observation.ts";
import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { ArtifactKind, ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { callCtoToolAsOwner } from "../helpers/bootstrap-plan.ts";
import { settlingCommitLore } from "../helpers/commitlore-attempt.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { type Harness, bindCeo, dispatchBootstrapRun, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * #1456 — the CTO reads what CommitLore holds for the paths it is about to plan for, at the run's base, before it
 * cuts the work: `contract_get` with `paths` answers the same lookup and the same section a worker turn gets before
 * it edits. CommitLore needs a checkout at that base, and neither the registered checkout nor the worker clone may
 * be moved for it, so the lookup runs in a private clone that is gone when the call returns. Advisory only: no
 * path is refused at plan time, and the worker-time lookup stays the enforcement.
 */

afterAll(cleanupTempDirs);

const CONTRACT = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};
const SECOND = "github:acme/second";
const RULED_OUT = "a global lock around app() | it deadlocks the daemon on restart";

interface BeforeChangeCall {
  checkout: string;
  head: string;
  request: CommitLoreBeforeChangeRequest;
}

/** A CommitLore double whose every path holds one Ruled-out record, except where `path` says otherwise. */
const doublePort = (script: { path?: (path: string) => Partial<CommitLorePathLookup> } = {}) => {
  const calls: BeforeChangeCall[] = [];
  const port: CommitLorePort = {
    ...settlingCommitLore(),
    beforeChange: async (checkout, _git, request) => {
      calls.push({ checkout, head: gitSync(checkout, ["rev-parse", "HEAD"]), request });
      return {
        paths: request.paths.map((path) => ({
          path,
          outcome: "answered" as const,
          text: `commitlore: active records for ${path}\n\nRuled-out\n  [claim]  r-0123456789ab  daef3548  ${RULED_OUT}\n`,
          cacheKey: `cache-${path}`,
          withheld: 0,
          items: null,
          detail: null,
          ...script.path?.(path),
        })),
        guard: { status: "clean" as const, matches: [], detail: null },
        cliIdentity: { version: "test-double", digest: `sha256:${"0".repeat(64)}` },
      };
    },
  };
  return { port, calls };
};

/** A dispatched STANDARD_WORK run of a fixture project; `prepare` runs on the registered checkout before the run exists. */
const standardRun = async (commitlore: CommitLorePort, options: { second?: boolean; prepare?: (repo: string) => void } = {}) => {
  const harness = makeHarness({ commitlore });
  options.prepare?.(harness.repoPath);
  const { projectId, repositoryId } = await registerFixtureProject(harness, "cto-constraints", options.second
    ? { repositories: [{ role: "primary", remote: "github:acme/fixture", manifestRoot: "." }, { role: "secondary", remote: SECOND, manifestRoot: "." }] }
    : {});
  const repositories = [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }];
  let secondPath: string | null = null;
  if (options.second === true) {
    secondPath = makeRepo({ "README.md": "# second\n" });
    const second = await harness.cp.repositories.register({ checkoutPath: secondPath, projectId, repositoryRole: "secondary", identity: SECOND });
    if (!second.allowed) throw new Error(second.message);
    repositories.push({ repositoryId: second.value.repositoryId, repositoryRole: "secondary", baseBranch: "dev" });
  }
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT, repositories });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { harness, runId, secondPath };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const contractGet = (run: StandardRun, args: Record<string, unknown> = {}) =>
  callCtoToolAsOwner(run.harness, run.runId, "contract_get", { runId: run.runId, ...args });
const constraintsOf = (answer: { body: Record<string, unknown> }) =>
  (answer.body["value"] as Record<string, unknown>)["constraints"] as Record<string, unknown>;
const proposalOf = (harness: Harness, runId: string): string =>
  beforeChangeProposal(CONTRACT.goal, harness.cp.artifacts.latest(runId, ArtifactKind.TASK_CONTRACT)?.content ?? null);

/** Everything of a checkout a lookup could add to: its refs, its objects, its HEAD, its files and its git dir's entries. */
const checkoutState = (repo: string) => ({
  refs: gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
  objects: gitSync(repo, ["count-objects", "-v"]),
  head: gitSync(repo, ["rev-parse", "HEAD"]),
  status: gitSync(repo, ["status", "--porcelain", "--untracked-files=all", "--ignored"]),
  gitDir: readdirSync(join(repo, ".git")).sort(),
});
const leftoverScratch = (): string[] =>
  existsSync(ACP_SCRATCH_ROOT) ? readdirSync(ACP_SCRATCH_ROOT).filter((name) => name.startsWith("acp-cto-constraints-")) : [];

describe("#1456: contract_get answers CommitLore's constraints for the paths the CTO names", () => {
  it("a governed run: CommitLore is asked in a private clone at the run's base for those paths, the section carries the Ruled-out value, and the clone is gone after", async () => {
    const { port, calls } = doublePort();
    const run = await standardRun(port);
    const base = gitSync(run.harness.repoPath, ["rev-parse", "dev"]);
    const before = checkoutState(run.harness.repoPath);

    const answer = await contractGet(run, { paths: ["src/app.js", "README.md"] });

    expect(answer.isError, answer.text).toBe(false);
    expect(calls).toHaveLength(1);
    const [call] = calls as [BeforeChangeCall];
    expect(call.request).toMatchObject({ paths: ["src/app.js", "README.md"], baseHead: base, concurrency: BEFORE_CHANGE_CONCURRENCY, proposal: proposalOf(run.harness, run.runId) });
    expect(call.checkout).not.toBe(run.harness.repoPath);
    expect(call.head).toBe(base);
    const constraints = constraintsOf(answer);
    expect(constraints).toMatchObject({
      status: "CONSULTED",
      baseHead: base,
      omitted: 0,
      guard: { status: "clean", matches: [] },
      paths: [
        { path: "src/app.js", outcome: "answered", items: null, withheld: 0 },
        { path: "README.md", outcome: "answered", items: null, withheld: 0 },
      ],
    });
    expect(constraints["section"]).toContain(`CommitLore before-change context (ACP): what this repository's CommitLore records hold for the paths you may change, looked up at ${base}`);
    expect(constraints["section"]).toContain("Path src/app.js (commitlore inject):");
    expect(constraints["section"]).toContain(RULED_OUT);
    // The contract itself is answered as before, beside the constraints.
    expect(answer.body["value"]).toMatchObject({ run: { runId: run.runId }, contract: expect.objectContaining({ goal: CONTRACT.goal }) });

    expect(existsSync(call.checkout)).toBe(false);
    expect(existsSync(call.request.scratch)).toBe(false);
    expect(leftoverScratch()).toEqual([]);
    expect(checkoutState(run.harness.repoPath)).toEqual(before);
  });

  it("without paths, contract_get answers exactly what it answered before, and CommitLore is not asked", async () => {
    const { port, calls } = doublePort();
    const run = await standardRun(port);

    const answer = await contractGet(run);

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.body).toEqual({ ok: true, value: JSON.parse(JSON.stringify(createCtoMcpPort(run.harness.cp).contractForRun(run.runId))) });
    expect(answer.body["value"]).not.toHaveProperty("constraints");
    expect(calls).toHaveLength(0);
  });

  it("a run CommitLore does not govern (a project-less bootstrap pins no manifest) is answered NOT_CONSULTED, and CommitLore is not asked", async () => {
    const { port, calls } = doublePort();
    const harness = makeHarness({ commitlore: port });
    bindCeo(harness);
    const created = harness.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract: { ...CONTRACT, scope: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(harness.cp, harness.clock, runId);
    expect(harness.cp.runs.require(runId).pinnedManifestDigest).toBeNull();

    const answer = await callCtoToolAsOwner(harness, runId, "contract_get", { runId, paths: ["src/app.js"] });

    expect(answer.isError, answer.text).toBe(false);
    expect(constraintsOf(answer)).toEqual({ status: "NOT_CONSULTED", reason: expect.any(String) });
    expect(calls).toHaveLength(0);
  });

  it("a run with more than one repository names the one to read, or is refused INVALID_ARGUMENT; a path not in normal form is refused the same way", async () => {
    const { port, calls } = doublePort();
    const run = await standardRun(port, { second: true });

    const unnamed = await contractGet(run, { paths: ["README.md"] });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.body).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
    const outside = await contractGet(run, { paths: ["README.md"], repositoryIdentity: "github:acme/elsewhere" });
    expect(outside.body).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
    const escaping = await contractGet(run, { paths: ["../README.md"], repositoryIdentity: SECOND });
    expect(escaping.body).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);

    const named = await contractGet(run, { paths: ["README.md"], repositoryIdentity: SECOND });
    expect(named.isError, named.text).toBe(false);
    const secondBase = gitSync(run.secondPath!, ["rev-parse", "dev"]);
    expect(calls.map((call) => [call.request.baseHead, call.head])).toEqual([[secondBase, secondBase]]);
    expect(constraintsOf(named)).toMatchObject({ status: "CONSULTED", baseHead: secondBase });
  });

  it("a path CommitLore failed on is reported failed, and the contract and the other paths are still answered", async () => {
    const { port } = doublePort({
      path: (path) => (path === "README.md" ? { outcome: "failed", text: "", cacheKey: null, detail: "commitlore context did not answer: fixture" } : {}),
    });
    const run = await standardRun(port);

    const answer = await contractGet(run, { paths: ["src/app.js", "README.md"] });

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.body["value"]).toMatchObject({ run: { runId: run.runId }, contract: expect.objectContaining({ goal: CONTRACT.goal }) });
    const constraints = constraintsOf(answer);
    expect(constraints).toMatchObject({
      status: "CONSULTED",
      omitted: 1,
      paths: [
        { path: "src/app.js", outcome: "answered" },
        { path: "README.md", outcome: "failed", detail: "commitlore context did not answer: fixture" },
      ],
    });
    expect(constraints["section"]).toContain(RULED_OUT);
    expect(constraints["section"]).toContain("Path README.md: not covered by ACP's lookup.");
    expect(leftoverScratch()).toEqual([]);
  });
});

const realCommitLore = (): string | null => {
  const explicit = process.env["ACP_TEST_REAL_COMMITLORE"];
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const directory of (process.env["PATH"] ?? "").split(":").filter((entry) => entry.startsWith("/"))) {
    try {
      accessSync(join(directory, "commitlore"), constants.X_OK);
      return join(directory, "commitlore");
    } catch {
      // not here
    }
  }
  return null;
};
const REAL = realCommitLore();
const realPort = (): CommitLorePort => createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, REAL as string));

describe.skipIf(REAL === null)("#1456: contract_get answers CommitLore's constraints (real CLI)", { timeout: 180_000 }, () => {
  /** A commit on src/app.js carrying a Ruled-out record, made on the registered checkout's base branch. */
  const ruledOutOnApp = (repo: string): void => {
    writeFileSync(join(repo, "src", "app.js"), "module.exports = () => 1; // kept simple\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "--no-verify", "-m", `Keep app() simple\n\nRuled-out: ${RULED_OUT}\nProvenance: authored\nRecord-Id: r-0123456789ab`]);
  };
  /** What a worker turn's own lookup renders in the registered checkout, which stands at the run's base. */
  const workerSection = async (run: StandardRun, paths: string[], base: string): Promise<string> => {
    const repo = run.harness.repoPath;
    const answer = await realPort().beforeChange!(repo, { gitDir: join(repo, ".git"), workTree: repo }, {
      paths,
      baseHead: base,
      proposal: proposalOf(run.harness, run.runId),
      scratch: tempDir("acp-1456-worker-lookup-"),
      deadline: Date.now() + 90_000,
      concurrency: BEFORE_CHANGE_CONCURRENCY,
    });
    return beforeChangeSection({ baseHead: base, coverage: beforeChangeCoverage(paths, answer!.paths), guard: answer!.guard });
  };

  it("a Ruled-out record on P at run B's base reaches run B's contract_get for P, in the section a worker turn at that base renders", async () => {
    const run = await standardRun(realPort(), {
      prepare: (repo) => {
        ruledOutOnApp(repo);
        // CommitLore's trust setting is the checkout's own configuration: the private clone answers with it.
        gitSync(repo, ["config", "--local", "commitlore.trustedAuthor", "test@example.invalid"]);
      },
    });
    const repo = run.harness.repoPath;
    const base = gitSync(repo, ["rev-parse", "dev"]);
    const before = checkoutState(repo);
    const paths = ["src/app.js", "README.md"];

    const answer = await contractGet(run, { paths });

    expect(answer.isError, answer.text).toBe(false);
    const constraints = constraintsOf(answer);
    expect(constraints).toMatchObject({ status: "CONSULTED", baseHead: base, omitted: 0, paths: [{ path: "src/app.js", outcome: "answered" }, { path: "README.md", outcome: "answered" }] });
    expect(constraints["section"]).toContain("Path src/app.js (commitlore inject):");
    expect(constraints["section"]).toContain(RULED_OUT);
    expect(constraints["section"]).toMatch(/^ {4}\| +\[directive\] +r-0123456789ab /m);
    expect(checkoutState(repo)).toEqual(before);
    expect(leftoverScratch()).toEqual([]);
    expect(constraints["section"]).toBe(await workerSection(run, paths, base));
  });

  it("a checkout whose origin's notes mirror was never fetched is answered incomplete, as a worker turn there is", async () => {
    const run = await standardRun(realPort(), { prepare: ruledOutOnApp });
    // The registered checkout's own remote, as its identity names it; nothing here contacts it.
    gitSync(run.harness.repoPath, ["remote", "add", "origin", "https://github.com/acme/fixture.git"]);
    const base = gitSync(run.harness.repoPath, ["rev-parse", "dev"]);

    const answer = await contractGet(run, { paths: ["src/app.js"] });

    expect(answer.isError, answer.text).toBe(false);
    const constraints = constraintsOf(answer);
    expect(constraints).toMatchObject({ status: "CONSULTED", omitted: 1, paths: [{ path: "src/app.js", outcome: "incomplete" }] });
    expect(constraints["section"]).toBe(await workerSection(run, ["src/app.js"], base));
  });
});
