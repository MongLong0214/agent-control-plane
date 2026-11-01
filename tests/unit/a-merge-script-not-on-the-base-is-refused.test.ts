import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A checkout still at an older `main` ran its own `scripts/merge-pr.mjs` after the change to merge
 * commits (#1269) had landed, and four pull requests went in by squash: the copy that ran was the
 * pre-change script, and nothing said so. These run the real script from a checkout whose `origin`
 * is the pull request's base repository, reached over a stand-in ssh, with `gh` and `commitlore`
 * stubbed on PATH. They pin that a copy differing from the current base -- the script, a module it
 * imports, a script it runs with node, a module the base no longer has -- refuses before any merge
 * request, in --dry-run too, as does a base that cannot be fetched or an origin that is another
 * repository; an older local ref never stands in for the fetched base.
 */
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
/** As GitHub spells it; origin below spells it in lower case, which is the same repository. */
const REPOSITORY = "Example/Project";
const SOURCES = ["scripts/merge-pr.mjs", "scripts/verify-merge-preserved-records.mjs", "scripts/verify-trailers-are-parsable.mjs", "scripts/lib"];

interface World {
  readonly dir: string;
  readonly work: string;
  readonly remotes: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: string;
}

const git = (w: Pick<World, "env">, cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, env: w.env, encoding: "utf8", timeout: 30_000 }).trim();

/** A checkout at origin's `main`, which holds this repository's merge script, and a `gh` that answers green. */
const world = (): World => {
  const dir = tempDir("acp-merge-script-base-");
  const remotes = join(dir, "remotes");
  const work = join(dir, "work");
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  mkdirSync(join(remotes, "example"), { recursive: true });
  mkdirSync(bin);
  // `git@github.com:<owner>/<name>.git` lands here: the remote command runs in `remotes`, so the
  // origin URL is the GitHub form merge-pr.mjs reads and no network is touched.
  writeFileSync(join(bin, "fake-ssh"), `#!/bin/sh\nfor last; do :; done\ncd '${remotes}' || exit 128\nexec /bin/sh -c "git \${last#git-}"\n`);
  const pr = JSON.stringify({
    state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: HEAD, baseRefOid: BASE,
    baseRefName: "main", title: "a change", statusCheckRollup: [], url: `https://github.com/${REPOSITORY}/pull/7`,
  });
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1:$2" in',
    `  pr:view) printf '%s' '${pr}' ;;`,
    `  run:list) printf '%s' '[{"databaseId":1,"attempt":1,"status":"completed","headSha":"${HEAD}"}]' ;;`,
    `  run:view) printf '%s' '{"jobs":[{"name":"verify","status":"completed","conclusion":"success"}]}' ;;`,
    `  api:*) printf '%s' '{"status":"ahead"}' ;;`,
    '  *) echo "gh stub refuses: $*" >&2; exit 1 ;;',
    "esac",
    "",
  ].join("\n"));
  writeFileSync(join(bin, "commitlore"), "#!/bin/sh\nexit 0\n");
  for (const stub of ["fake-ssh", "gh", "commitlore"]) chmodSync(join(bin, stub), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH_COMMAND: `'${join(bin, "fake-ssh")}'`,
    GIT_SSH_VARIANT: "simple",
  };
  const w = { dir, work, remotes, log, env };
  git(w, dir, "init", "--quiet", "--bare", "-b", "main", join(remotes, "example", "project.git"));
  git(w, dir, "init", "--quiet", "-b", "main", work);
  for (const path of SOURCES) cpSync(join(process.cwd(), path), join(work, path), { recursive: true });
  git(w, work, "add", "--all");
  git(w, work, "commit", "--quiet", "--no-verify", "-m", "base");
  git(w, work, "remote", "add", "origin", "git@github.com:example/project.git");
  git(w, work, "push", "--quiet", "--no-verify", "origin", "main");
  return w;
};

/** origin's `main` moves on by one commit to `path`; this checkout stays where it was, as the stale one did. */
const originMovesOn = (w: World, path: string, change: "one-byte" | "deleted"): void => {
  if (change === "deleted") git(w, w.work, "rm", "--quiet", path);
  else writeFileSync(join(w.work, path), `${readFileSync(join(w.work, path), "utf8")}\n`);
  git(w, w.work, "commit", "--quiet", "--no-verify", "--all", "-m", `origin moves ${path} on`);
  git(w, w.work, "push", "--quiet", "--no-verify", "origin", "main");
  git(w, w.work, "reset", "--quiet", "--hard", "HEAD~1");
};

/** The local remote-tracking ref names this checkout's own commit: it matches the running script. */
const staleLocalRefMatches = (w: World): void => {
  git(w, w.work, "update-ref", "refs/remotes/origin/main", "HEAD");
};

interface Result { readonly status: number; readonly out: string }

const mergePr = (w: World, ...extra: readonly string[]): Result => {
  const body = join(w.dir, "body");
  writeFileSync(body, "why the change.\n");
  const args = [join(w.work, "scripts", "merge-pr.mjs"), "7", "--subject", "a change (#7)", "--body-file", body, ...extra];
  try {
    const out = execFileSync(process.execPath, args, { cwd: w.work, env: w.env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

const ghCalls = (w: World): string[] =>
  existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter(Boolean) : [];

/** Refused before any merge request: the PR was read and nothing else asked of GitHub, in one line. */
const expectRefused = (w: World, result: Result, ...naming: readonly string[]): void => {
  expect(ghCalls(w), result.out).toEqual([expect.stringMatching(/^pr view 7 --json \S*baseRefName\S*,url$/u)]);
  expect(result.status, result.out).toBe(1);
  const lines = result.out.trim().split("\n");
  expect(lines, result.out).toHaveLength(1);
  expect(lines[0]).toMatch(/^RESULT: FAIL — /u);
  for (const text of [...naming, "Run merge-pr.mjs from a checkout of current main."]) expect(lines[0]).toContain(text);
};

describe("merge-pr.mjs refuses a copy that differs from the current base", () => {
  it("proceeds past the comparison when every byte matches the base, to the checks and to the merge request", () => {
    const w = world();
    const dry = mergePr(w, "--dry-run");
    expect(dry.out).toContain("RESULT: PASS — checks only, nothing merged (--dry-run).");
    expect(dry.status, dry.out).toBe(0);
    expect(ghCalls(w).some((call) => call.startsWith("pr merge"))).toBe(false);

    // Without --dry-run the stub is asked for the merge itself, so its absence below is a refusal, not a stub that cannot see one.
    mergePr(w);
    expect(ghCalls(w)).toContainEqual(expect.stringMatching(new RegExp(`^pr merge 7 --merge --match-head-commit ${HEAD} `, "u")));
  });

  it("refuses a merge-pr.mjs that differs from the base, as a checkout at an older base runs it", () => {
    const w = world();
    originMovesOn(w, "scripts/merge-pr.mjs", "one-byte");
    expectRefused(w, mergePr(w), "differing: scripts/merge-pr.mjs.");
  });

  it("refuses the same in --dry-run", () => {
    const w = world();
    originMovesOn(w, "scripts/merge-pr.mjs", "one-byte");
    expectRefused(w, mergePr(w, "--dry-run"), "differing: scripts/merge-pr.mjs.");
  });

  it("refuses when a module merge-pr.mjs imports differs from the base", () => {
    const w = world();
    originMovesOn(w, "scripts/lib/record-trailer-keys.mjs", "one-byte");
    expectRefused(w, mergePr(w), "differing: scripts/lib/record-trailer-keys.mjs.");
  });

  it("refuses when a module merge-pr.mjs imports is missing at the base", () => {
    const w = world();
    originMovesOn(w, "scripts/verify-merge-preserved-records.mjs", "deleted");
    expectRefused(w, mergePr(w), "scripts/verify-merge-preserved-records.mjs (missing or unreadable at main)");
  });

  it("refuses when a script merge-pr.mjs runs with node differs from the base", () => {
    const w = world();
    originMovesOn(w, "scripts/verify-trailers-are-parsable.mjs", "one-byte");
    expectRefused(w, mergePr(w), "differing: scripts/verify-trailers-are-parsable.mjs.");
  });

  it("compares with the base the fetch returned, not with a local origin/main that matches the script", () => {
    const w = world();
    originMovesOn(w, "scripts/merge-pr.mjs", "one-byte");
    staleLocalRefMatches(w);
    expectRefused(w, mergePr(w), "differing: scripts/merge-pr.mjs.");
  });

  it("refuses when the base cannot be fetched, though a local origin/main matches: a comparison that cannot be made is not a pass", () => {
    const w = world();
    staleLocalRefMatches(w);
    renameSync(join(w.remotes, "example", "project.git"), join(w.dir, "gone.git"));
    expectRefused(w, mergePr(w), "could not fetch main from origin");
  });

  it.each([
    ["a fork holding the same bytes", "git@github.com:someone/project.git"],
    ["another owner over https", "https://github.com/someone/project.git"],
    ["a path that names no GitHub repository", "<local>"],
  ])("refuses an origin that is not the pull request's base repository: %s", (_, url) => {
    const w = world();
    const origin = join(w.remotes, "example", "project.git");
    mkdirSync(join(w.remotes, "someone"));
    git(w, w.dir, "clone", "--quiet", "--bare", origin, join(w.remotes, "someone", "project.git"));
    git(w, w.work, "remote", "set-url", "origin", url === "<local>" ? origin : url);
    expectRefused(w, mergePr(w), `is not ${REPOSITORY}, the pull request's base repository`);
  });
});
