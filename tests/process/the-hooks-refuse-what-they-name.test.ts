import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The hooks are a local install, and CI is a clone that never ran it. This covers their logic
 * anyway, because the alternative is a guard whose only proof lives on one machine.
 *
 * Each case below is a mistake that was made more than once inside 48 hours, and each was already
 * *detected* by something at the time — a CommitLore warning that exited 0, a harness sentinel
 * nothing consulted, a mutation row that CI reported forty minutes in. Detection was never the
 * missing part. Refusal was.
 */
const ROOT = process.cwd();
const hook = (name: string): string => join(ROOT, ".githooks", name);

const runCommitMsg = (message: string): number => {
  const dir = tempDir("acp-hook-msg-");
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return spawnSync(hook("commit-msg"), [file], { cwd: ROOT, encoding: "utf8" }).status ?? -1;
};

/**
 * The hook under an environment git actually hands it, rather than the one this suite happens to
 * run in. Git does not give a hook a login shell's PATH, so a commit made from a GUI client, a
 * launchd job, or an editor reaches this hook with a PATH that has no `node` on it — which is what
 * CommitLore's own `doctor` reports on this machine today.
 *
 * `env` is replaced rather than extended: `NODE` and `npm_node_execpath` are the fallbacks the hook
 * consults after PATH, so leaving this process's copies in place would let a run that resolved
 * nothing look identical to one that resolved everything.
 */
const runCommitMsgWithEnv = (
  message: string,
  env: NodeJS.ProcessEnv,
): { status: number; stderr: string } => {
  const dir = tempDir("acp-hook-env-");
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  const done = spawnSync(hook("commit-msg"), [file], { cwd: ROOT, encoding: "utf8", env });
  return { status: done.status ?? -1, stderr: done.stderr ?? "" };
};

/**
 * A PATH carrying only what the hook shells out to. `git` is the one external command it runs;
 * `sh` is here so the check below can actually run under this PATH. Without it the probe fails to
 * start, and "no node here" becomes indistinguishable from "no shell to ask with" — the assertion
 * would pass on a PATH that resolves node perfectly well.
 */
const pathWithoutNode = (): string => {
  const bin = join(tempDir("acp-hook-bin-"), "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["git", "sh"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    expect(found, `no ${name} to build a PATH from`).not.toBe("");
    symlinkSync(found, join(bin, name));
  }
  const probe = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8", env: { PATH: bin } });
  expect(probe.error, "the probe never ran, so its answer says nothing").toBeUndefined();
  expect(
    probe.status,
    "this PATH still resolves node, so nothing below measures what it claims",
  ).not.toBe(0);
  return bin;
};

/**
 * An executable that exits 0 and answers nothing else. This is exactly what `[ -x "$NODE" ]` sees
 * when it looks at a real interpreter, which is why the hook may not stop at `-x`.
 */
const exitsZeroButIsNotNode = (): string => {
  const path = join(tempDir("acp-hook-impostor-"), "node-shaped");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
};

/** The real interpreter, named the way `pnpm run` names it in a hook's environment. */
const realNode = process.execPath;

/**
 * The same PATH with a real interpreter on it. Built from `pathWithoutNode`, so the base is the one
 * already proven to resolve nothing, and then asserted in the other direction: a case about what
 * the hook does *with* an interpreter says nothing if the PATH never had one.
 */
const pathWithNode = (): string => {
  const bin = pathWithoutNode();
  symlinkSync(realNode, join(bin, "node"));
  const probe = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8", env: { PATH: bin } });
  expect(probe.status, "this PATH resolves no node, so nothing below measures it").toBe(0);
  return bin;
};

/** A preload module that writes a line of its own before the interpreter evaluates anything. */
const modulePrintingOnStdout = (): string => {
  const path = join(tempDir("acp-hook-preload-"), "boot.cjs");
  writeFileSync(path, "console.log('boot');\n");
  return path;
};

/** Answers the version question correctly, and then holds the pipe open. */
const printsAVersionThenNeverExits = (): string => {
  const path = join(tempDir("acp-hook-slow-"), "node-shaped");
  writeFileSync(path, "#!/bin/sh\necho 1.2.3\nexec /bin/sleep 20\n");
  chmodSync(path, 0o755);
  return path;
};

/** Answers the version question, exits, and checks nothing. Two lines of sh. */
const printsAVersionAndChecksNothing = (): string => {
  const path = join(tempDir("acp-hook-printer-"), "node-shaped");
  writeFileSync(path, "#!/bin/sh\necho 1.2.3\n");
  chmodSync(path, 0o755);
  return path;
};

/**
 * A run that cannot outlive its own bound. A case about a hook that hangs must not hang the suite
 * the way the hook hangs a commit, so the wait is capped here rather than left to the file's
 * timeout — and the elapsed time comes back, because "it finished" and "it finished promptly" are
 * the two different facts under test.
 */
const runCommitMsgBounded = (
  message: string,
  env: NodeJS.ProcessEnv,
  capMs: number,
): { status: number; stderr: string; elapsedMs: number } => {
  const dir = tempDir("acp-hook-bounded-");
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  const started = Date.now();
  const done = spawnSync(hook("commit-msg"), [file], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: capMs,
    killSignal: "SIGKILL",
  });
  return { status: done.status ?? -1, stderr: done.stderr ?? "", elapsedMs: Date.now() - started };
};

const WELL_FORMED = "subject\n\nbody\n\nLimit: one line\n";
const WRAPPED = "subject\n\nbody\n\nLimit: this wraps across\ntwo lines.\n";
/** The hook's own sentence about the message. It must not be said about the interpreter. */
const TRAILER_REFUSAL = "writes a record git will not store";

describe("commit-msg refuses a trailer git will not parse", () => {
  it("refuses a Limit that wraps onto a second line", () => {
    // The exact shape that reached six commits on 2026-08-22. `git interpret-trailers` reads the
    // last paragraph one trailer per line, so the continuation ends the block and every record in
    // it — including this one — is stored by nobody.
    expect(runCommitMsg("subject\n\nbody\n\nLimit: this wraps across\ntwo lines.\n")).toBe(1);
  });

  it("refuses an ordinary sentence that follows a trailer", () => {
    expect(runCommitMsg("subject\n\nLimit: fine\nRuled-out: a | b\nnot a trailer at all\n")).toBe(1);
  });

  it("accepts a long trailer on one line, because length was never the problem", () => {
    const long = `Limit: ${"a sentence that keeps going ".repeat(12)}and ends.`;
    expect(runCommitMsg(`subject\n\nbody\n\n${long}\n`)).toBe(0);
  });

  it("accepts a message with no trailers at all", () => {
    expect(runCommitMsg("subject\n\njust a body, nothing to record\n")).toBe(0);
  });

  it("accepts trailers separated from the body by a blank line, which is the normal case", () => {
    expect(
      runCommitMsg("subject\n\nbody\n\nLimit: one line\nRuled-out: alternative | why not\n"),
    ).toBe(0);
  });
});

describe("commit-msg tells a refusal apart from a check it could not run", () => {
  it("does not report a trailer problem when it could not find an interpreter", () => {
    // The defect: `node` was invoked by bare name, so a PATH without it made the check exit 127,
    // which `if !` reads as "the check refused". The hook then blamed a well-formed message for a
    // fault in the environment — the opposite failure, wearing the same words and the same exit.
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.stderr).not.toContain(TRAILER_REFUSAL);
  });

  it("says the check could not run, and names where it looked", () => {
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.stderr).toContain("could not run");
    expect(done.stderr).toContain("PATH");
  });

  it("names the two variables it deliberately does not consult", () => {
    // This case used to read "and names what it looked for", and covered $NODE and
    // npm_node_execpath as candidates. They are no longer candidates, and the same two strings have
    // to earn their place here for the opposite reason: the operator with $NODE set, on a git PATH
    // without node, is exactly who this refusal lands on, and a refusal that leaves them looking at
    // a variable the hook silently ignores has not told them what to do.
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.stderr).toContain("NODE");
    expect(done.stderr).toContain("npm_node_execpath");
    expect(done.stderr).toContain("NOT consulted");
  });

  it("refuses the commit when it cannot run the check, which is the choice the hook argues", () => {
    // Asserted directly rather than left implied by the message above. The alternative — exit 0 —
    // would let every commit on a machine with no `node` on git's PATH be stored unchecked, with
    // nothing saying so. See the comment in `.githooks/commit-msg` for the argument.
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.status).toBe(1);
  });

  it("does not resolve an interpreter from $NODE or npm_node_execpath at all", () => {
    // Two cases stood here — "runs the check on the interpreter NODE names when PATH has none" and
    // "accepts npm_node_execpath as the same answer under its other name". They asserted a fallback
    // that no longer exists, so they are replaced rather than dropped quietly: what they measured
    // is now false on purpose, and this is the case that says so.
    //
    // Why the fallback went. It was written for `pnpm merge`, where `scripts/merge-pr.mjs` spawns
    // git from inside a package script that sets both variables. Measured, it never fired there:
    // under `pnpm run`, `command -v node` already resolves and is consulted first, and the case
    // where it would be reached — a package script on a PATH with no node — cannot arise while npm
    // and pnpm are themselves `#!/usr/bin/env node` scripts and do not start. Against that it was
    // the sole cause of a fail-open, a hang, an unbounded read, and a refusal of a well-formed
    // message on a machine with node on PATH. The argument is in `.githooks/commit-msg`.
    //
    // The cost is real, and is asserted here rather than left implied: this operator now gets a
    // refusal. It is a loud one that names the variable and says what to do about it.
    const env = { PATH: pathWithoutNode(), HOME: process.env.HOME, NODE: realNode };
    const done = runCommitMsgWithEnv(WELL_FORMED, env);
    expect(done.status, "a fallback resolved an interpreter that was not on git's PATH").toBe(1);
    expect(done.stderr).toContain("could not run");
    expect(done.stderr).not.toContain(TRAILER_REFUSAL);

    const byOtherName = { PATH: pathWithoutNode(), HOME: process.env.HOME, npm_node_execpath: realNode };
    expect(runCommitMsgWithEnv(WELL_FORMED, byOtherName).status).toBe(1);
  });
});

describe("commit-msg never lets a named executable's exit status become its verdict", () => {
  // Round 2 of this change read the cases below as proof that a candidate was *established* as an
  // interpreter before its exit status was trusted. Two of them still pass and one no longer can,
  // and it is worth saying why, because a case that passes for a reason other than the one in its
  // name is a check reporting coverage it does not have.
  //
  // `[ -x "$NODE" ]` proves a file is executable, not that it is node, and the hook's verdict on
  // the message was nothing but that file's exit status — so `/usr/bin/true` in $NODE accepted the
  // wrapped `Limit:` this hook exists to refuse. The two cases here still hold, but NOT because a
  // probe rejected the impostor: neither variable is consulted now, so there is no candidate and no
  // exit status to misread. That is a wider reason than the probe gave — it also covers the
  // impostor the probe accepted, `#!/bin/sh` + `echo 1.2.3` — and these stay as the regression test
  // that the fail-open does not come back by either name.
  //
  // A third case stood here: "falls through to a candidate that is an interpreter rather than
  // stopping at the first -x". It measured the order of a candidate list that no longer exists —
  // it asserted that npm_node_execpath gets the slot a stale $NODE would otherwise consume, and
  // with a single candidate there is no slot to consume. Its replacement is "does not resolve an
  // interpreter from $NODE or npm_node_execpath at all", above, which asserts the removal head-on.

  it("refuses a wrapped trailer when $NODE names an executable that only exits 0", () => {
    const done = runCommitMsgWithEnv(WRAPPED, {
      PATH: pathWithoutNode(),
      HOME: process.env.HOME,
      NODE: exitsZeroButIsNotNode(),
    });
    expect(
      done.status,
      "an exit-0 executable was read as a verdict about the message, so the check never ran",
    ).toBe(1);
    expect(done.stderr).toContain("could not run");
  });

  it("refuses a wrapped trailer when npm_node_execpath names one", () => {
    const done = runCommitMsgWithEnv(WRAPPED, {
      PATH: pathWithoutNode(),
      HOME: process.env.HOME,
      npm_node_execpath: exitsZeroButIsNotNode(),
    });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain("could not run");
  });
});

describe("commit-msg resolves an interpreter without reading anything a program tells it", () => {
  it("checks the message when node prints something of its own before answering", () => {
    // `NODE_OPTIONS=--require <module>` is an ordinary, supported thing to have set: coverage
    // tooling, tracers and shims all use it. A module that writes one line at startup makes a real
    // node print `boot` ahead of every answer it gives, so a resolution that reads the first line
    // of a candidate's stdout as the candidate's identity rejects the interpreter it is standing
    // on, and refuses a well-formed message with "no Node interpreter found" while node sits on
    // PATH. Measured on 8b92ee8; the commit before it, 8e0fd01, accepted the same message.
    //
    // Stdout belongs to the program, not to whoever is asking it a question.
    const env = {
      PATH: pathWithNode(),
      HOME: process.env.HOME,
      NODE_OPTIONS: `--require ${modulePrintingOnStdout()}`,
    };

    const accepted = runCommitMsgWithEnv(WELL_FORMED, env);
    expect(accepted.stderr).not.toContain("could not run");
    expect(accepted.status, "a well-formed message was refused over a fact about stdout").toBe(0);

    // And the check still runs, rather than merely not refusing.
    expect(runCommitMsgWithEnv(WRAPPED, env).stderr).toContain(TRAILER_REFUSAL);
  });

  it(
    "cannot be made to wait by a candidate that answers and then holds the pipe open",
    () => {
      // A hook that can hang is worse than a hook that refuses: a refusal is loud and
      // self-clearing, a hang is neither. `echo 1.2.3; exec sleep 20` answers the version question
      // correctly and then never exits, so anything that pipes a candidate's output waits on the
      // writer even after it has its answer — and the real interpreter behind it in the list is
      // never reached. Measured on 8b92ee8, with a 30s sleep: 60s, and the wrapped `Limit:`
      // accepted by the impostor at the end of it.
      const done = runCommitMsgBounded(
        WRAPPED,
        {
          PATH: pathWithoutNode(),
          HOME: process.env.HOME,
          NODE: printsAVersionThenNeverExits(),
          npm_node_execpath: realNode,
        },
        8_000,
      );
      expect(done.elapsedMs, "the hook waited on a program it chose to consult").toBeLessThan(5_000);
      expect(done.status).toBe(1);
      expect(done.stderr).toContain("could not run");
    },
    30_000,
  );

  it("does not let a two-line shell script become its verdict on the message", () => {
    // `#!/bin/sh` + `echo 1.2.3` satisfies any question whose answer is read from stdout, and then
    // exits 0 on the check — so the wrapped `Limit:` this hook exists to refuse is stored. This is
    // the round-2 fail-open in its second shape: asking a candidate to print a version raises the
    // cost of impersonating an interpreter from `exit 0` to two lines of sh, which is not a bound.
    const done = runCommitMsgWithEnv(WRAPPED, {
      PATH: pathWithoutNode(),
      HOME: process.env.HOME,
      NODE: printsAVersionAndChecksNothing(),
    });
    expect(
      done.status,
      "a program that prints a version string was trusted to check the message",
    ).toBe(1);
    expect(done.stderr).toContain("could not run");
  });
});

describe("pre-commit refuses while the falsifiability harness holds a mutation", () => {
  it("refuses when the sentinel exists", () => {
    // The sentinel is present for exactly the window where committing takes a mutation with it:
    // during a live sweep and after a killed one. Asking "is the tree dirty" answers no in both —
    // the harness restores what it is not currently holding, and a killed run leaves a clean
    // index. That is how a removed guard reached a commit twice.
    const fake = join(tempDir("acp-hook-sentinel-"), "repo");
    mkdirSync(fake, { recursive: true });
    chmodSync(fake, 0o700);
    expect(spawnSync("git", ["init", "-q"], { cwd: fake }).status).toBe(0);

    const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: fake, encoding: "utf8" })
      .stdout.trim();
    const sentinel = join(fake, gitDir, "verify-guards-in-flight.json");
    writeFileSync(sentinel, "{}");
    try {
      const refused = spawnSync(hook("pre-commit"), [], { cwd: fake, encoding: "utf8" });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("mutation applied");
    } finally {
      rmSync(sentinel, { force: true });
    }
  });

  it("runs the anchors pass whatever is staged, because the filter had a hole shaped like the defect", () => {
    // The first version ran it only when `src/` or the harness was staged. That excluded deleting
    // a test file a row names in `killedBy` — the case the newest half of that check exists for.
    // A filter written to save a second had a hole shaped exactly like the defect.
    //
    // Proven in a repository of its own, with a stub standing in for the harness: running against
    // this one would answer differently depending on whether a real sweep happens to be in
    // progress, and a test whose result depends on that is not measuring the hook.
    const fake = join(tempDir("acp-hook-unfiltered-"), "repo");
    mkdirSync(join(fake, "scripts"), { recursive: true });
    chmodSync(fake, 0o700);
    expect(spawnSync("git", ["init", "-q"], { cwd: fake }).status).toBe(0);

    const marker = join(fake, "ran");
    writeFileSync(
      join(fake, "scripts", "verify-guards-are-falsifiable.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "yes");\n`,
    );
    // This case isolates the later anchors call. The real preflight and both of its counterexamples
    // run through scripts/verify-ci-preflight.mjs in ci-preflight.test.ts.
    writeFileSync(
      join(fake, "package.json"),
      JSON.stringify({ scripts: { "ci:preflight": "true" } }),
    );

    // Nothing staged at all — the case the old filter skipped.
    const done = spawnSync(hook("pre-commit"), [], { cwd: fake, encoding: "utf8" });
    expect(done.status).toBe(0);
    expect(existsSync(marker), "the hook did not run the anchors pass").toBe(true);
  });
});
