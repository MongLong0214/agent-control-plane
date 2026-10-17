import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #1107 — a commit message that links an external work session is refused, by the `commit-msg` hook
 * and by the shared checker the hook, CI's range check (`pnpm trailers` under `pnpm gates`) and the
 * merge path all call.
 *
 * Commits already on `main` keep the links they carry: history is not rewritten, and the range check
 * reads only the range it is given. Every link below is synthetic — an all-zero id that names no
 * session — and none of the refusals may print it back.
 */
const ROOT = process.cwd();
const CHECK = join(ROOT, "scripts/verify-trailers-are-parsable.mjs");
const HOOK = join(ROOT, ".githooks/commit-msg");
const SYNTHETIC_ID = "session_0000000000000000000000";
const LINK = `https://claude.ai/code/${SYNTHETIC_ID}`;

/** The hook runs `command -v node`; put the interpreter running this suite first on its PATH. */
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };

const messageFile = (message: string): string => {
  const file = join(tempDir("acp-session-link-msg-"), "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return file;
};

type Run = { status: number; out: string };

const viaChecker = (message: string): Run => {
  const done = boundedSpawnSync(process.execPath, [CHECK, "--message-file", messageFile(message)], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
};

const viaHook = (message: string): Run => {
  const done = boundedSpawnSync(HOOK, [messageFile(message)], { cwd: ROOT, encoding: "utf8", env });
  return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
};

const LINKED: ReadonlyArray<readonly [string, string]> = [
  ["bare, alone at the end of a squash body", `subject\n\nwhat changed.\n\n${LINK}\n`],
  ["labelled, as a Claude-Session trailer", `subject\n\nwhat changed.\n\nClaude-Session: ${LINK}\n`],
  ["labelled, beside a record trailer", `subject\n\nwhat changed.\n\nLimit: one line\nClaude-Session: ${LINK}\n`],
  ["embedded in prose", `subject\n\nThe work is at ${LINK} if anyone needs it.\n`],
  ["embedded as a markdown link", `subject\n\nSee [the session](${LINK}) for the steps.\n`],
  ["embedded without a scheme", `subject\n\nRan in claude.ai/code/${SYNTHETIC_ID} first.\n`],
  ["a session key carrying no link at all", `subject\n\nwhat changed.\n\nX-Claude-Session: ${SYNTHETIC_ID}\n`],
];

const CLEAN = [
  "subject\n\nA session_id column and a claude.ai mention are prose, not a link.\n\nLimit: one line\n",
  "subject\n\njust a body, nothing to record\n",
];

/** What `git commit -v` hands the hook: the diff sits below git's scissors line and is discarded. */
const VERBOSE_TAIL =
  "# ------------------------ >8 ------------------------\n" +
  "# Do not modify or remove the line above.\n" +
  "# Everything below it will be ignored.\n" +
  "diff --git a/t.ts b/t.ts\n" +
  `+const SESSION_URL = "${LINK}";\n`;

describe("a message that links an external work session is refused (#1107)", () => {
  for (const [form, message] of LINKED) {
    it(`refuses it ${form}, through the checker and through the hook`, () => {
      const checked = viaChecker(message);
      expect(checked.status, checked.out).toBe(1);
      expect(checked.out).toContain("external work session");
      const hooked = viaHook(message);
      expect(hooked.status, hooked.out).toBe(1);
      expect(hooked.out).toContain("external work session");
      // The refusal names the line, never the link: a CI log is as public as the commit would be.
      expect(checked.out + hooked.out).not.toContain(SYNTHETIC_ID);
    });
  }

  it("does not blame the trailers for a link, and names both when both are wrong", () => {
    expect(viaHook(LINKED[0]![1]).out).not.toContain("writes a record git will not store");
    const both = viaHook(`subject\n\nbody\n\nLimit: this wraps across\ntwo lines.\n${LINK}\n`);
    expect(both.status).toBe(1);
    expect(both.out).toContain("external work session");
    expect(both.out).toContain("writes a record git will not store");
  });

  it("passes a clean message, through the checker and through the hook", () => {
    for (const message of CLEAN) {
      const checked = viaChecker(message);
      expect(checked.status, checked.out).toBe(0);
      const hooked = viaHook(message);
      expect(hooked.status, hooked.out).toBe(0);
    }
  });

  it("reads a verbose commit's message, not the diff git appends below the scissors line", () => {
    const clean = `subject\n\nwhat changed.\n\n${VERBOSE_TAIL}`;
    expect(viaHook(clean).status, viaHook(clean).out).toBe(0);
    const linked = `subject\n\n${LINK}\n\n${VERBOSE_TAIL}`;
    expect(viaHook(linked).status).toBe(1);
  });
});

describe("the range check CI runs refuses a commit that links an external work session (#1107)", () => {
  const fixture = (): { git: (...args: string[]) => string; dir: string } => {
    const dir = tempDir("acp-session-link-range-");
    const git = (...args: string[]): string => {
      const done = boundedSpawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "absent-gitconfig") },
      });
      expect(done.status, `git ${args.join(" ")}: ${done.stderr ?? ""}`).toBe(0);
      return (done.stdout ?? "").trim();
    };
    git("init", "-q", "-b", "main", ".");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    return { git, dir };
  };

  const commit = (git: (...args: string[]) => string, message: string): string => {
    git("commit", "-q", "--allow-empty", "--no-verify", "-F", messageFile(message));
    return git("rev-parse", "HEAD");
  };

  /** The real script, reading the fixture repository rather than this one. */
  const verifyRange = (dir: string, range: string): Run => {
    const done = boundedSpawnSync(process.execPath, [CHECK, range], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...env, GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir },
    });
    return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
  };

  it("refuses the range that carries a synthetic link, and passes the one that does not", () => {
    const { git, dir } = fixture();
    const clean = commit(git, "clean subject\n\nnothing linked here.\n");
    const linked = commit(git, `linked subject\n\nwhat changed.\n\nClaude-Session: ${LINK}\n`);

    const refused = verifyRange(dir, `${clean}..${linked}`);
    expect(refused.status, refused.out).toBe(1);
    expect(refused.out).toContain(linked.slice(0, 7));
    expect(refused.out).toContain("external work session");
    expect(refused.out).not.toContain(SYNTHETIC_ID);

    const passed = verifyRange(dir, clean);
    expect(passed.status, passed.out).toBe(0);
  });
});
