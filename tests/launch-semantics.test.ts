import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseVerificationCommand, resolveVerificationExecutable } from "../src/contracts/verification-command.ts";
import { stableFixtureBinDir, stableFixtureExecutable, stableFixtureLink } from "../tests/helpers/stable-fixture-executable.ts";

import * as sandbox from "../src/verify/sandbox.ts";

const launch = sandbox.verificationLaunchArgv;
const roots: string[] = [];
const originalPath = process.env.PATH;
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "review-launch-"));
  roots.push(dir);
  return realpathSync(dir);
};
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const systemPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

it("preserves the declared tool personality when an approved executable is a symlink", async () => {
  const repository = temp();
  const aliases = temp();
  const tool = stableFixtureExecutable("multiplexer", '#!/bin/sh\ncase "${0##*/}" in\n pnpm) echo declared-verification-ran; exit 17 ;;\n *) echo multiplexer-help; exit 0 ;;\nesac\n');
  const alias = join(aliases, "pnpm");
  symlinkSync(tool, alias);
  process.env.PATH = [aliases, dirname(tool), systemPath].join(":");
  const command = parseVerificationCommand({ id: "tool-personality", argv: [alias, "test"] });
  const context = { cwd: repository, additionalRoots: [repository] };
  expect(resolveVerificationExecutable(alias, context).allowed).toBe(true);
  const selected = await launch(command.argv, context);
  expect(selected.allowed).toBe(true);
  if (!selected.allowed) throw new Error(selected.message);
  const env = sandbox.buildSandboxEnvironment(command, repository, undefined, repository);
  const actual = spawnSync(selected.value[0]!, selected.value.slice(1), { cwd: repository, env, encoding: "utf8", timeout: 5000 });
  expect(actual.error).toBeUndefined();
  expect(actual.status).toBe(17);
  expect(actual.stdout.trim()).toBe("declared-verification-ran");
});

it("selects the approved daemon tool instead of the same-name candidate executable", async () => {
  const repository = temp();
  const trusted = stableFixtureBinDir({ pnpm: "#!/bin/sh\necho trusted-tool\n" });
  stableFixtureLink(join(repository, "pnpm"), "#!/bin/sh\necho candidate-tool\n");
  const git = (args: string[]) => execFileSync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8", timeout: 10000,
    env: { HOME: process.env.HOME, PATH: systemPath, GIT_CONFIG_NOSYSTEM: "1" },
  });
  git(["init", "-q", "-b", "dev"]);
  git(["add", "pnpm"]);
  git(["-c", "user.name=Review", "-c", "user.email=review@example.invalid", "commit", "-q", "-m", "candidate shadows pnpm"]);
  expect(git(["ls-files", "-s", "pnpm"])).toMatch(/^100755 /);
  process.env.PATH = [trusted, systemPath].join(":");
  const command = parseVerificationCommand({ id: "shadowed", argv: ["pnpm"] });
  const context = { cwd: repository, additionalRoots: [repository] };
  const resolution = resolveVerificationExecutable("pnpm", context);
  expect(resolution.resolvedPath).toBe(join(trusted, "pnpm"));
  const selected = await launch(command.argv, context);
  expect(selected.allowed).toBe(true);
  if (!selected.allowed) throw new Error(selected.message);
  const env = sandbox.buildSandboxEnvironment(command, repository, undefined, repository);
  const actual = spawnSync(selected.value[0]!, selected.value.slice(1), { cwd: repository, env, encoding: "utf8", timeout: 5000 });
  expect(actual.error).toBeUndefined();
  expect(actual.status).toBe(0);
  expect(actual.stdout.trim()).toBe("trusted-tool");
});
