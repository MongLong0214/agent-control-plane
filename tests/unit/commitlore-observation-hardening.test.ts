import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  COMMITLORE_LIMITS,
  OBSERVATION_HARDENING_EXCEPTION,
  commitloreRunner,
  createCommitLoreCliPort,
  probeCommitLore,
  requiredCommitLoreObservation,
} from "../../src/bootstrap/commitlore-observation.ts";
import { GIT_HARDENING, gitHardeningEnvironment } from "../../src/run/worker-git.ts";
import { EMPTY_TREE, gitIgnoresAttrSource } from "../../src/bootstrap/commitlore-snapshot.ts";
import { installedCopyOf, writeCommitLoreInstall } from "../helpers/commitlore-install.ts";
import { latestRelease, stableReleaseAnswer } from "../helpers/commitlore-release.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";

/**
 * #1268 — the bootstrap observation (`commitlore init`, then `commitlore doctor --json`) runs its git under
 * the worker's git hardening with exactly one setting left out, `core.hooksPath`: `init` installs CommitLore's
 * hooks, and under `core.hooksPath=/dev/null` it answers `init: 1/7 step(s) could not run — hooks install`.
 * Every other setting holds in that checkout too, so a program its config names is not run.
 */

afterAll(cleanupTempDirs);

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
const realPort = () => {
  const version = execFileSync(REAL as string, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
  return createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, REAL as string, latestRelease(version)));
};

describe("#1268: the bootstrap observation's git hardening", () => {
  it("leaves out exactly core.hooksPath; the worker's own hardening keeps every setting", () => {
    const worker = gitHardeningEnvironment();
    const observation = gitHardeningEnvironment({ except: [OBSERVATION_HARDENING_EXCEPTION] });
    const settings = (environment: Record<string, string>): string[] =>
      Array.from({ length: Number(environment["GIT_CONFIG_COUNT"]) }, (_, index) => `${environment[`GIT_CONFIG_KEY_${index}`]}=${environment[`GIT_CONFIG_VALUE_${index}`]}`);
    expect(settings(worker)).toEqual(GIT_HARDENING.filter((_, index) => index % 2 === 1));
    expect(settings(worker)).toContain("core.hooksPath=/dev/null");
    expect(settings(observation)).toEqual(settings(worker).filter((setting) => setting !== "core.hooksPath=/dev/null"));
    expect(GIT_HARDENING).toContain("core.hooksPath=/dev/null");
  });
});

describe("#1268 review r3: attribute-selected programs and the package the observation runs", () => {
  it("a git that ignores GIT_ATTR_SOURCE is found out, and a CommitLore run on it is refused rather than run unprotected", async () => {
    // A git that answers as one predating GIT_ATTR_SOURCE does: the work tree's attributes, whatever the variable says.
    const dir = tempDir("acp-1268-old-git-");
    writeFileSync(
      join(dir, "git"),
      `#!/bin/sh\nif [ "$1" = check-attr ]; then echo "probe: diff: acpprobe"; exit 0; fi\nexec /usr/bin/git "$@"\n`,
      { mode: 0o755 },
    );
    expect(await gitIgnoresAttrSource(`${dir}:/usr/bin:/bin`)).toMatch(/does not honour GIT_ATTR_SOURCE \(it answered "probe: diff: acpprobe"\)/);
    expect(await gitIgnoresAttrSource("/usr/bin:/bin")).toBeNull();
  });

  it("an observation in a sha256 repository reads attributes from the sha256 empty tree", async () => {
    const dir = tempDir("acp-1268-sha256-observation-");
    const log = join(dir, "attr-source.log");
    const { wrapper } = writeCommitLoreInstall(
      dir,
      `const fs = require('node:fs');
const argv = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, argv + ' ' + process.env.GIT_ATTR_SOURCE + '\\n');
const answer = (text) => process.stdout.write(text, () => process.exit(0));
if (argv === '--version') answer('1.7.3\\n');
else if (argv === 'doctor --help') answer('Usage: commitlore doctor [options]\\n\\nOptions:\\n  --json  emit the report as JSON\\n');
else if (argv === 'init --help') answer('Usage: commitlore init [options]\\n\\nOptions:\\n  --mcp-scope <scope>  where\\n  --no-unattended      off\\n  --no-agent-hooks     nothing in the tree\\n');
else answer(${JSON.stringify(JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] }))} + '\\n');
`,
    );
    const checkout = tempDir("acp-1268-sha256-repo-");
    execFileSync("git", ["init", "-q", "--object-format=sha256", checkout], { timeout: 20_000 });
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, wrapper, latestRelease("1.7.3"))).observe(checkout);
    expect(observed).toMatchObject({ outcome: "PASS" });
    const sources = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").at(-1));
    expect(sources).toHaveLength(5);
    expect(new Set(sources)).toEqual(new Set([EMPTY_TREE.sha256]));
  });

  it("the observation's checks and commands run one copy of the package, re-read before each spawn: a copy changed during a check is refused, its wrapper unchanged", async () => {
    const dir = tempDir("acp-1268-observation-copy-");
    const log = join(dir, "argv.log");
    // The program rewrites the file it was started from — the copy — during `doctor --help`.
    const { wrapper } = writeCommitLoreInstall(
      dir,
      `const fs = require('node:fs');
const argv = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, argv + '\\n');
const answer = (text) => process.stdout.write(text, () => process.exit(0));
if (argv === 'doctor --help') fs.appendFileSync(process.argv[1], '\\n// changed during a check\\n');
if (argv === '--version') answer('1.7.3\\n');
else if (argv === 'doctor --help') answer('Usage: commitlore doctor [options]\\n\\nOptions:\\n  --json  emit the report as JSON\\n');
else if (argv === 'init --help') answer('Usage: commitlore init [options]\\n\\nOptions:\\n  --mcp-scope <scope>  where\\n  --no-unattended      off\\n  --no-agent-hooks     nothing in the tree\\n');
else answer(${JSON.stringify(JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] }))} + '\\n');
`,
    );
    const wrapperBytes = readFileSync(wrapper, "utf8");
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, wrapper, latestRelease("1.7.3"))).observe(makeRepo({ "README.md": "# observed\n" }));
    expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringContaining("ACP_COMMITLORE_BINARY REPLACED: the CommitLore package copy is no longer the bytes its checks ran") });
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["--version", "doctor --help"]);
    expect(readFileSync(wrapper, "utf8")).toBe(wrapperBytes);
  });
});

describe.skipIf(REAL === null)("#1268: the bootstrap observation under that hardening (real CLI)", { timeout: 180_000 }, () => {
  it("a required bootstrap's probe and observation pass: init installs CommitLore's hooks", async () => {
    expect(await probeCommitLore(realPort())).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
    const checkout = makeRepo({ "README.md": "# observed\n" });
    expect(await requiredCommitLoreObservation(realPort(), checkout)).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
    expect(existsSync(join(checkout, ".git", "hooks", "prepare-commit-msg"))).toBe(true);
  });

  it("an fsmonitor program the checkout's config names is not run by init or doctor", async () => {
    const checkout = makeRepo({ "README.md": "# observed\n" });
    // A remote, as a bootstrap checkout has one: with it, init and doctor run the git calls that ask fsmonitor.
    const bare = join(tempDir("acp-1268-observation-remote-"), "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { timeout: 20_000 });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: checkout, timeout: 20_000 });
    const marker = join(tempDir("acp-1268-observation-fsmonitor-"), "ran");
    const program = join(tempDir("acp-1268-observation-program-"), "fsmonitor.sh");
    writeFileSync(program, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    execFileSync("git", ["config", "core.fsmonitor", program], { cwd: checkout, timeout: 20_000 });
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, REAL as string, latestRelease(execFileSync(REAL as string, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim()))).observe(checkout);
    expect(observed).toMatchObject({ outcome: "PASS" });
    expect(existsSync(marker), "a program the checkout's config named ran inside CommitLore's git").toBe(false);
  });

  it("review r3 P1: a bundle replaced behind an unchanged wrapper during the release lookup is never run by the observation", async () => {
    const { wrapper, bundle } = installedCopyOf(REAL as string, tempDir("acp-1268-observation-install-"));
    const marker = join(tempDir("acp-1268-observation-swap-"), "ran");
    const version = execFileSync(REAL as string, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
    // The wrapper is left as it is; the bundle it names is replaced the moment the newest release is asked for.
    const swapping = async (): Promise<unknown> => {
      writeFileSync(bundle, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log(${JSON.stringify(JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] }))});\n`);
      return stableReleaseAnswer(version);
    };
    const checkout = makeRepo({ "README.md": "# observed\n" });
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, wrapper, swapping)).observe(checkout);
    expect(existsSync(marker), "the replaced bundle ran").toBe(false);
    expect(observed).toMatchObject({ outcome: "PASS" });
    expect(existsSync(join(checkout, ".git", "hooks", "prepare-commit-msg"))).toBe(true);
  });

  it("an ssh program the checkout's config names for its ssh:// remote is not run by init or doctor", async () => {
    const checkout = makeRepo({ "README.md": "# observed\n" });
    const marker = join(tempDir("acp-1268-observation-ssh-"), "ran");
    const program = join(tempDir("acp-1268-observation-ssh-program-"), "ssh.sh");
    writeFileSync(program, `#!/bin/sh\necho "$*" >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    execFileSync("git", ["remote", "add", "origin", "ssh://example.invalid/r.git"], { cwd: checkout, timeout: 20_000 });
    execFileSync("git", ["config", "core.sshCommand", program], { cwd: checkout, timeout: 20_000 });
    await realPort().observe(checkout);
    expect(existsSync(marker), "the ssh program the checkout's config named ran inside CommitLore's git").toBe(false);
  });
});
