/**
 * #739. The deliverable is not "a script that runs the checks" — it is that the local gate set and
 * the CI gate set *cannot* come apart. Running the runner does not test that, so these tests
 * introduce each way the two could diverge and require the parity check to refuse it.
 *
 * Every divergence is applied to a copy of this repository's real `package.json` and real
 * `.github/workflows/`, not to a hand-written fixture. A fixture would be a third description of
 * the gate set, free to stop resembling the two it is meant to hold together.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Temporary directories, kept local on purpose.
 *
 * The shared fixture helper reaches the whole core harness — SQLite, the migration ledger, the
 * session registry — none of which this file touches: it spawns two scripts and reads their
 * output. Importing it made a process test fail to collect because an unrelated edit in `src/db`
 * was mid-flight, and a suite that cannot collect proves nothing about the guard it names.
 */
const temporaryDirectories: string[] = [];
const tempDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

const REPO_ROOT = process.cwd();
const PARITY = join(REPO_ROOT, "scripts", "verify-ci-runs-the-gate-runner.mjs");
const RUNNER = join(REPO_ROOT, "scripts", "run-prepush-gates.mjs");
const WORKFLOW = join(".github", "workflows", "ci.yml");

const parity = (repoRoot: string) =>
  spawnSync(process.execPath, [PARITY, `--repo-root=${repoRoot}`], { cwd: REPO_ROOT, encoding: "utf8" });

/** A copy of the real package.json and workflows, which the divergences below then damage. */
const copyOfThisRepository = (): string => {
  const repoRoot = join(tempDir("acp-gate-parity-"), "repo");
  mkdirSync(join(repoRoot, ".github"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(repoRoot, "package.json"));
  cpSync(join(REPO_ROOT, ".github", "workflows"), join(repoRoot, ".github", "workflows"), {
    recursive: true,
  });
  return repoRoot;
};

const editWorkflow = (repoRoot: string, edit: (text: string) => string): void => {
  const path = join(repoRoot, WORKFLOW);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
};

const editPackage = (repoRoot: string, edit: (json: Record<string, string>) => void): void => {
  const path = join(repoRoot, "package.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> };
  edit(parsed.scripts);
  writeFileSync(path, JSON.stringify(parsed, null, 2));
};

const GATE_STEP = "      - run: pnpm gates\n";

describe("the CI gate set and the pre-push gate set", () => {
  it("are the same set in this repository right now", () => {
    const result = parity(REPO_ROOT);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("verify-matrix runs `pnpm gates` and nothing else that verifies");
    // The claim is bounded on purpose: this says the two sides hold the same gates, not that a
    // step is reached or that any gate is correct.
    expect(result.stdout).toContain("only that neither side can hold a gate the other does not");
  });

  it("refuses a gate CI runs as its own step — the #736 shape, in the direction CI grows", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}      - run: pnpm release:version\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify-matrix runs "pnpm release:version" as its own step');
  });

  it("refuses a command in the gate job it cannot name at all", () => {
    const repoRoot = copyOfThisRepository();
    // Not every gate is spelled `pnpm <script>`. `npx eslint .` is the same verification arriving
    // by a route the pnpm classification does not see, so the gate job refuses anything it cannot
    // name rather than waving through what it failed to recognise.
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}      - run: npx eslint .\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify-matrix runs "npx eslint ."');
    expect(result.stderr).toContain("neither the gate runner nor a declared setup command");
  });

  it("refuses a CI job that lists its own gates instead of invoking the runner", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) =>
      text.replace(GATE_STEP, "      - run: pnpm lint\n      - run: pnpm typecheck\n"),
    );

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verify-matrix never runs `pnpm gates`");
    expect(result.stderr).toContain("second source of truth");
  });

  it("refuses a runner invocation carrying arguments, which is how a subset gets in", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, "      - run: pnpm gates --only lint\n"));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the gate runner is invoked with "--only lint"');
  });

  it("refuses a gates script that no longer invokes the runner", () => {
    const repoRoot = copyOfThisRepository();
    editPackage(repoRoot, (scripts) => {
      scripts.gates = "echo ok";
    });

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the "gates" script is "echo ok", which is not exactly');
  });

  it("refuses a manifest gate whose package script a merge deleted", () => {
    const repoRoot = copyOfThisRepository();
    editPackage(repoRoot, (scripts) => {
      // This is not hypothetical: a `--theirs` merge removed exactly this script while `ci.yml`
      // kept calling it, and the loss surfaced as `Command not found` in CI, not locally.
      delete scripts["coordinates:stale"];
    });

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the gate manifest names "coordinates:stale", which is not a package script');
  });

  it("refuses verification in another job that no declaration explains", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(
      repoRoot,
      (text) => `${text}\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm symbols\n`,
    );

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('job "extra" runs "pnpm symbols"');
    expect(result.stderr).toContain("VERIFICATION_OUTSIDE_THE_RUNNER");
  });

  it("refuses continue-on-error on the gate job, which would let every gate fail green", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}        continue-on-error: true\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('carries "continue-on-error"');
  });

  it("refuses a declaration that no longer names anything a workflow runs", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace("- run: pnpm guards:falsifiable", "- run: echo nothing"));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('declares "guard-falsifiability:pnpm guards:falsifiable", which no workflow runs');
  });

  it("refuses a run: form it cannot attribute, rather than reporting a coverage it does not have", () => {
    const repoRoot = copyOfThisRepository();
    // A flow-mapping step is valid YAML that this parser does not read. The rejected design —
    // extracting commands from `ci.yml` at run time — would silently drop it from the local set.
    // Here the same blind spot is a red build.
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}      - {run: pnpm symbols}\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a command-shaped line outside every parsed run block");
  });
});

/**
 * Everything above reads commands. An independent review defeated the first version of this check
 * four times without touching one: `if: false` on the runner step, a `working-directory:` pointing
 * somewhere else, a `uses:` action doing the verification, and a package script that kept the
 * runner's path in a string while running `echo`. All four left CI executing something other than
 * the manifest while the check reported that both sides held the same gates.
 *
 * The lesson is not "add four cases". It is that a check which classifies some shapes and is
 * silent about the rest reports a coverage it does not have — the same defect it exists to catch,
 * occurring inside it. So the gate job is enumerated: every job key, every step, every step key,
 * every action input. These tests are the four, the ones found by asking what else decides whether,
 * where, or how a command runs, and the general net that has to catch the ones nobody has thought
 * of yet.
 */
const RUNS_ON = "    runs-on: macos-15\n";
const CHECKOUT_INPUT = "          fetch-depth: 0\n";
const MATRIX_LEGS = '        node-version: ["22.18.0", "22"]\n';

describe("the gate job's shape, not only its commands", () => {
  it("refuses a gates script that mentions the runner's path while running something else", () => {
    const repoRoot = copyOfThisRepository();
    // The exact mutation an independent review used. `"echo ok"` — the shape the first round of
    // testing chose — removes the substring, so a substring check catches it. Keeping the substring
    // is what someone routing around the guard reaches for first.
    editPackage(repoRoot, (scripts) => {
      scripts.gates = "echo scripts/run-prepush-gates.mjs";
    });

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("which is not exactly `node scripts/run-prepush-gates.mjs`");
  });

  it("refuses a gates script that runs the runner and then something else", () => {
    const repoRoot = copyOfThisRepository();
    editPackage(repoRoot, (scripts) => {
      scripts.gates = "node scripts/run-prepush-gates.mjs || true";
    });

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("It must be that one command and nothing else");
  });

  it("refuses an if: on the runner step, which would skip every gate", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}        if: false\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the `pnpm gates` step carries "if"');
  });

  it("refuses a working-directory on the runner step, which would verify another tree", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}        working-directory: elsewhere\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the `pnpm gates` step carries "working-directory"');
  });

  it("refuses a shell: on the runner step, which decides how its exit status is read", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}        shell: sh -e {0}\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the `pnpm gates` step carries "shell"');
  });

  it("refuses environment on the runner step other than the commit range", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) =>
      text.replace("          ACP_TRAILERS_RANGE:", '          NODE_OPTIONS: "--max-old-space-size=64"\n          ACP_TRAILERS_RANGE:'),
    );

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the gate step sets "NODE_OPTIONS"');
  });

  it("refuses an action in the gate job that no declaration names", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `      - uses: some/verifier-action@v1\n${GATE_STEP}`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An action can verify anything a gate can");
  });

  it("refuses a declared action that is not pinned to a commit SHA", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) =>
      text.replace(/uses: actions\/checkout@[0-9a-f]{40}/, "uses: actions/checkout@main"),
    );

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not pinned to a 40-character commit SHA");
  });

  it("refuses an action input that moves the tree CI checks out", () => {
    const repoRoot = copyOfThisRepository();
    // `working-directory` arriving through an action's inputs. `repository`, `ref` and `path` each
    // make the job verify something that is not this commit, and none of them is a command.
    editWorkflow(repoRoot, (text) => text.replace(CHECKOUT_INPUT, `${CHECKOUT_INPUT}          repository: someone/else\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An input that moves or replaces the tree makes CI verify something else");
  });

  it("refuses a key on a setup step, so no setup step can skip or move what follows", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) =>
      text.replace("      - run: pnpm install --frozen-lockfile\n", "      - run: pnpm install --frozen-lockfile\n        continue-on-error: true\n"),
    );

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a setup step in verify-matrix carries");
  });

  it("refuses a job-level key that would move or skip the whole gate job", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(RUNS_ON, `${RUNS_ON}    defaults:\n      run:\n        working-directory: elsewhere\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify-matrix sets "defaults"');
    expect(result.stderr).toContain("would move every step's working directory off the tree under test");
  });

  it("refuses job-level environment, which changes what every gate in the job means", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(RUNS_ON, `${RUNS_ON}    env:\n      SKIP_SLOW: "1"\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify-matrix sets "env"');
  });

  it("refuses a top-level defaults, which reaches into the gate job from above it", () => {
    const repoRoot = copyOfThisRepository();
    // Nothing inside the job changes, so a job-scoped check sees a clean gate job and passes.
    editWorkflow(repoRoot, (text) => text.replace("jobs:\n", "defaults:\n  run:\n    working-directory: elsewhere\njobs:\n"));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sets a top-level \"defaults\"");
  });

  it("refuses a matrix dimension that changes which legs exist", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(MATRIX_LEGS, `${MATRIX_LEGS}        include:\n          - node-version: "22"\n`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matrix declares "include"');
  });

  it("refuses a step shape it cannot place, even when the step runs no command", () => {
    const repoRoot = copyOfThisRepository();
    // The general net, and the only one of these that catches what nobody has thought of. A
    // flow-style `uses:` step is not command-shaped, so the command-level passes are blind to it.
    editWorkflow(repoRoot, (text) =>
      text.replace(GATE_STEP, `${GATE_STEP}      - {uses: some/verifier-action@${"0".repeat(40)}}\n`),
    );

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a line inside verify-matrix this check could not place");
  });

  it("refuses a second step running the runner", () => {
    const repoRoot = copyOfThisRepository();
    editWorkflow(repoRoot, (text) => text.replace(GATE_STEP, `${GATE_STEP}${GATE_STEP}`));

    const result = parity(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("step(s) running `pnpm gates`; it must have exactly one");
  });
});

/**
 * The runner's own contract: every gate's exit code is printed, a failure stops the sequence, and
 * nothing folds an intermediate failure into success.
 *
 * `pnpm` is stubbed on PATH so the whole manifest runs in milliseconds and a chosen gate can fail
 * on demand. The stub records what it was asked to run, which is what makes "nothing after it ran"
 * an observation instead of an inference.
 */
const stubbedPnpm = (options: { fail?: string; kill?: string }): { path: string; log: string } => {
  const directory = tempDir("acp-gates-stub-");
  const log = join(directory, "invocations.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    options.kill ? `if [ "$1" = "${options.kill}" ]; then kill -TERM $$; fi` : "",
    options.fail ? `if [ "$1" = "${options.fail}" ]; then echo "stub: $1 is unhappy" >&2; exit 7; fi` : "",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(directory, "pnpm"), script);
  chmodSync(join(directory, "pnpm"), 0o755);
  return { path: directory, log };
};

// One environment, shared by every spawn in this file. `--list` renders a gate's command
// including any argument it takes from the environment (`trailers` takes `ACP_TRAILERS_RANGE`),
// so a `--list` that reads a different environment than the run describes a different gate set
// and the comparison below fails for a reason that has nothing to do with drift. That is not
// hypothetical: this file passed locally, where the variable is unset and both spawns agreed by
// accident, and failed on both CI legs, where the workflow sets it for the `pnpm gates` step.
const runnerEnv = (stub?: { path: string }): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(stub ? { PATH: `${stub.path}:${process.env.PATH ?? ""}` } : {}),
  ACP_TRAILERS_RANGE: "",
});

const runRunner = (stub: { path: string }, args: string[] = []) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: runnerEnv(stub),
  });

const invocations = (log: string): string[] =>
  readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.trim());

describe("the pre-push gate runner", () => {
  it("runs the whole manifest in order and reports each gate's exit code", () => {
    const stub = stubbedPnpm({});

    const result = runRunner(stub);

    expect(result.status, result.stdout).toBe(0);
    const ran = invocations(stub.log);
    const listed = spawnSync(process.execPath, [RUNNER, "--list"], { cwd: REPO_ROOT, encoding: "utf8", env: runnerEnv() })
      .stdout.split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\S+\s+pnpm\s+/, ""));
    expect(ran).toEqual(listed);
    expect(result.stdout).toContain("PASS  pnpm lint  exit 0");
    expect(result.stdout).toContain(`gates: PASSED — ${listed.length} of ${listed.length} gate(s)`);
  });

  it("stops at the first failing gate and exits with that gate's status", () => {
    const stub = stubbedPnpm({ fail: "typecheck" });

    const result = runRunner(stub);

    // 7, not 1: a runner that normalises the exit code has thrown away which gate said what.
    expect(result.status).toBe(7);
    expect(result.stdout).toContain("FAIL  pnpm typecheck  exit 7");
    expect(result.stdout).toContain("gates: FAILED at pnpm typecheck (exit 7)");
    expect(result.stdout).toContain("SKIP  not run");

    const ran = invocations(stub.log);
    expect(ran.at(-1)).toBe("typecheck");
    expect(ran).not.toContain("test");
  });

  it("does not swallow a failing gate's own output", () => {
    const stub = stubbedPnpm({ fail: "lint" });

    const result = runRunner(stub);

    expect(result.stderr).toContain("stub: lint is unhappy");
  });

  it("counts a gate killed by a signal as a failure, not as an exit code of zero", () => {
    const stub = stubbedPnpm({ kill: "terminology" });

    const result = runRunner(stub);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("killed by SIGTERM");
    expect(invocations(stub.log)).not.toContain("test");
  });

  it("refuses an argument, because a subset of the gates is the thing that failed #736", () => {
    const stub = stubbedPnpm({});

    const result = runRunner(stub, ["--only", "lint"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("there is deliberately no way to run part of it");
    expect(() => invocations(stub.log)).toThrow();
  });
});
