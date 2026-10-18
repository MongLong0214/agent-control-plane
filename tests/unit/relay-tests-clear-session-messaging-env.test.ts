import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R1154-01 — a test run from inside a Claude Code session inherits that session's
 * CLAUDE_CODE_MESSAGING_* variables, and a relay that sees them opens its wake proxy beside the live
 * session's socket. This asks one question of the tests that run the relay: is that inheritance
 * blocked? It is limited to the relay's own entry points and the files that call them, and it is
 * not a general analyzer.
 *
 * - A file that calls an entry point in process must hold a hoisted prefix clear: a `vi.hoisted`
 *   that deletes every name starting with the prefix, which runs before the file's imports evaluate.
 * - A file that spawns the CLI with `attach` must hand every child an env that does not inherit the
 *   prefix: it never passes this process's env on as it is (no spread, no `env: process.env`, no
 *   `= process.env`), and either every spawn names an env or the file holds the hoisted clear, so a
 *   child that inherits implicitly inherits a cleared env. An env passed through
 *   `withoutSessionMessagingEnv(...)` is not inheriting.
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TESTS_ROOT = join(REPO_ROOT, "tests");
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));

const ENTRY_POINTS = ["runAttachRelay", "runAttachRelayCommand", "runAdoptedCeoAttachRelay"];
const IN_PROCESS_CALL = new RegExp(`\\b(?:${ENTRY_POINTS.join("|")})\\(`);
const CLI_ATTACH = /"attach",\s*"(?:canonical-cto|adopted-ceo)"/;
const HOISTED_PREFIX_CLEAR =
  /vi\.hoisted\(\(\) => \{\s*for \(const name of Object\.keys\(process\.env\)\) \{\s*if \(name\.startsWith\("CLAUDE_CODE_MESSAGING_"\)\) delete process\.env\[name\];\s*\}\s*\}\);/;
/** This process's env handed on as it is: a spread, `env: process.env`, or `= process.env`. */
const RAW_INHERIT = /\.\.\.process\.env\b|(?:\benv\s*:|=)\s*process\.env\b(?!\s*\[)/;
const SPAWN_CALL = /\b(?:spawn|spawnSync|boundedSpawnSync|execFile|execFileSync|fork)\(/g;
const ENV_KEY = /\benv\s*:/g;

const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") ? [relative(REPO_ROOT, path)] : [];
  });

const scan = () => {
  const inProcess: string[] = [];
  const cliAttach: string[] = [];
  const refusals: string[] = [];
  for (const file of testFiles(TESTS_ROOT).sort()) {
    if (file === SELF) continue;
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    const hoisted = HOISTED_PREFIX_CLEAR.test(text);
    if (IN_PROCESS_CALL.test(text)) {
      inProcess.push(file);
      if (!hoisted) refusals.push(`${file}: calls a relay entry point in process without a hoisted CLAUDE_CODE_MESSAGING_* clear`);
    }
    if (CLI_ATTACH.test(text)) {
      cliAttach.push(file);
      if (RAW_INHERIT.test(text)) refusals.push(`${file}: spawns the CLI with attach and hands a child this process's env as it is`);
      const spawns = (text.match(SPAWN_CALL) ?? []).length;
      const envs = (text.match(ENV_KEY) ?? []).length;
      if (!hoisted && envs < spawns) {
        refusals.push(`${file}: spawns the CLI with attach, ${spawns - envs} spawn(s) name no env, and no hoisted clear covers them`);
      }
    }
  }
  return { inProcess, cliAttach, refusals };
};

describe("R1154-01: every test that runs the relay blocks CLAUDE_CODE_MESSAGING_* inheritance", () => {
  it("finds the relay-running tests and refuses none", () => {
    const { inProcess, cliAttach, refusals } = scan();
    // The matched files ride on every assertion's message, so a failure says what the sweep looked at.
    const matched = JSON.stringify({ inProcess, cliAttach });
    // The patterns still find both kinds of site; a sweep that matched nothing would pass vacuously.
    expect(inProcess, matched).toContain("tests/unit/attach-relay.test.ts");
    expect(cliAttach, matched).toContain("tests/process/a-cli-through-the-current-symlink-is-not-silent.test.ts");
    expect(refusals, matched).toEqual([]);
  });
});
