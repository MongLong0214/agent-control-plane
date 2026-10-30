import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, writeFileSync } from "node:fs";
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
import { latestRelease } from "../helpers/commitlore-release.ts";
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
