import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_EXECUTOR_VERSION,
  defaultExecutingImageInspector,
  defaultProcessAncestryInspector,
  deriveClaimantIdentity,
  extractSessionUuidFromCommand,
  looksLikeClaudeInvocation,
  makeDefaultTranscriptReader,
} from "../../src/registry/canonical-self-claim.ts";

/**
 * Exercises the *real*, OS-backed implementations this module ships as defaults — never the
 * fakes the unit test injects. Everything here is a real spawned process and a real temp
 * filesystem; nothing touches a database, the daemon, or a live deployment.
 */

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  // Give the kernel a moment to reap before the temp root that backed the exec image is removed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "acp-self-claim-identity-"));
  roots.push(dir);
  return dir;
};

/**
 * A real, independent executable file at `dest` — a clonefile copy of the running node binary
 * where the platform supports it (instant, near-zero cost on APFS/btrfs/xfs), falling back to a
 * plain copy otherwise. Never a symlink: lsof/`/proc` resolve a symlink straight through to its
 * target, so two symlinks to the same node binary would collapse into one indistinguishable
 * image. A clone is a genuinely separate file the kernel maps as its own executing image.
 */
const cloneExecutable = (dest: string): void => {
  mkdirSync(join(dest, ".."), { recursive: true });
  try {
    execFileSync("cp", ["-c", process.execPath, dest], { stdio: "ignore" });
    return;
  } catch {
    /* not APFS, or not macOS; fall through to a plain copy */
  }
  try {
    execFileSync("cp", ["--reflink=auto", process.execPath, dest], { stdio: "ignore" });
    return;
  } catch {
    /* no reflink support either */
  }
  copyFileSync(process.execPath, dest);
};

const writeVersionedClaude = (versionsRoot: string, version: string): string => {
  const dir = join(versionsRoot, version);
  mkdirSync(dir, { recursive: true });
  const executable = join(dir, "claude");
  cloneExecutable(executable);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return executable;
};

const waitUntil = async (predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * The stand-in "claude" executable is actually a clone of the `node` binary (see
 * `cloneExecutable`), so its own CLI flag parser is node's — and node parses every `--foo`
 * token *before* the first positional argument as one of its own flags, exiting with
 * "bad option" on anything it does not recognize (measured directly). `-e <script>` has to come
 * first; identity-bearing flags like `--session-id` are appended after a positional guard token
 * so they land in `process.argv` instead of node's own option parser, while still appearing in
 * `ps`'s full command line exactly as a real interactive invocation's would.
 */
const spawnHeld = (executable: string, identityArgs: readonly string[], cwd: string): ChildProcess => {
  const child = spawn(
    executable,
    ["-e", "setTimeout(() => {}, 120000)", "argv-guard", ...identityArgs],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  return child;
};

describe("real process ancestry — ps-backed, not a fake", () => {
  it("reports the exact command line, a resolvable start time, and the real cwd of a live process", async () => {
    const root = tempRoot();
    const claude = writeVersionedClaude(join(root, "versions"), REQUIRED_EXECUTOR_VERSION);
    const sessionUuid = "33333333-3333-4333-8333-333333333333";
    const child = spawnHeld(claude, ["--session-id", sessionUuid], root);
    await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

    let snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
    // ps can race a just-exec'd process; retry briefly rather than accept a flaky null.
    for (let attempt = 0; !snapshot && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
    }
    expect(snapshot).not.toBeNull();
    expect(snapshot!.command).toContain(sessionUuid);
    expect(looksLikeClaudeInvocation(snapshot!.command)).toBe(true);
    expect(extractSessionUuidFromCommand(snapshot!.command)).toBe(sessionUuid);
    expect(snapshot!.startedAt).not.toBeNull();
    // macOS's /tmp is itself a symlink to /private/tmp; lsof's cwd descriptor reports the fully
    // resolved path, so the comparison side has to be resolved the same way rather than compared
    // against the unresolved `tmpdir()`-based root.
    expect(snapshot!.cwd).toBe(realpathSync(root));
  });

  it("walks a real two-hop ancestry (grandchild -> claude parent) to the claude process", async () => {
    const root = tempRoot();
    const claude = writeVersionedClaude(join(root, "versions"), REQUIRED_EXECUTOR_VERSION);
    const sessionUuid = "44444444-4444-4444-8444-444444444444";
    const resultPath = join(root, "grandchild-pid.txt");
    // The "claude" process spawns a plain, non-claude grandchild and writes its pid to disk —
    // this is a real parent/child relationship the kernel tracks, not a constructed fixture.
    //
    // The grandchild must NOT be launched via `process.execPath` *as read inside the spawned
    // script* — that clone of node is itself named "claude" (see `cloneExecutable`), so a
    // grandchild spawned through its own `process.execPath` would look like a second claude
    // ancestor and get matched immediately at hop zero instead of exercising a real climb.
    // `realNodeExecPath` is this outer, genuinely-node-named test process's own path instead.
    const realNodeExecPath = process.execPath;
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grandchild = spawn(${JSON.stringify(realNodeExecPath)}, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(resultPath)}, String(grandchild.pid));
      setTimeout(() => {}, 120000);
    `;
    const claudeProcess = spawn(claude, ["-e", script, "argv-guard", "--session-id", sessionUuid], {
      cwd: root,
      stdio: "ignore",
    });
    children.push(claudeProcess);
    await waitUntil(() => {
      try { return readdirSync(root).includes("grandchild-pid.txt"); } catch { return false; }
    }, "the grandchild pid file");

    const grandchildPid = Number.parseInt(
      execFileSync("cat", [resultPath], { encoding: "utf8" }).trim(),
      10,
    );
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);

    let derived = deriveClaimantIdentity(grandchildPid, defaultProcessAncestryInspector);
    for (let attempt = 0; !derived.allowed && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      derived = deriveClaimantIdentity(grandchildPid, defaultProcessAncestryInspector);
    }
    expect(derived.allowed, JSON.stringify(derived)).toBe(true);
    if (!derived.allowed) return;
    expect(derived.value.pid).toBe(claudeProcess.pid);
    expect(derived.value.sessionUuid).toBe(sessionUuid);
  });
});

describe("real executing-image resolution — the measured symlink/image divergence", () => {
  it(
    "keeps reporting the version the live process actually loaded after its launch symlink is repointed to a decoy",
    async () => {
      const root = tempRoot();
      const versionsRoot = join(root, "versions");
      const realExecutable = writeVersionedClaude(versionsRoot, "2.1.241");
      writeVersionedClaude(versionsRoot, "9.9.9");
      const binDir = join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      const launchPath = join(binDir, "claude");
      symlinkSync(realExecutable, launchPath);

      const child = spawnHeld(launchPath, [], root);
      await waitUntil(() => child.pid !== undefined, "child pid to be assigned");
      const pid = child.pid!;

      let before = defaultExecutingImageInspector.resolve(pid);
      for (let attempt = 0; !before && attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        before = defaultExecutingImageInspector.resolve(pid);
      }
      expect(before, "the executing image could not be resolved before the repoint").not.toBeNull();
      expect(before!.version).toBe("2.1.241");

      // Measured, live bug: repoint the launch symlink while the process keeps running.
      unlinkSync(launchPath);
      symlinkSync(join(versionsRoot, "9.9.9", "claude"), launchPath);

      const after = defaultExecutingImageInspector.resolve(pid);
      expect(after, "the executing image could not be resolved after the repoint").not.toBeNull();
      // The property under test: still 2.1.241, the image this pid actually loaded — not 9.9.9.
      expect(after!.version).toBe("2.1.241");
      expect(after!.imagePath).toBe(before!.imagePath);

      // Contrast case, spelled out: the adversarial mutation the packet names is "read the
      // version from the symlink instead of the image". This is what that mutant would report —
      // wrong, and exactly what `defaultExecutingImageInspector` above did not report.
      const naiveSymlinkRead = execFileSync("readlink", [launchPath], { encoding: "utf8" }).trim();
      expect(naiveSymlinkRead).toContain("9.9.9");
    },
    20_000,
  );

  it("resolves the exact required production version end to end (2.1.259)", async () => {
    const root = tempRoot();
    const claude = writeVersionedClaude(join(root, "versions"), REQUIRED_EXECUTOR_VERSION);
    const child = spawnHeld(claude, [], root);
    await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

    let image = defaultExecutingImageInspector.resolve(child.pid!);
    for (let attempt = 0; !image && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      image = defaultExecutingImageInspector.resolve(child.pid!);
    }
    expect(image).not.toBeNull();
    expect(image!.version).toBe(REQUIRED_EXECUTOR_VERSION);
  });
});

describe("real transcript lookup — a genuine file on disk, not an assumption", () => {
  it("finds a transcript nested under a project directory and refuses when none exists", () => {
    const root = tempRoot();
    const projectDir = join(root, "-work-repo-factory");
    mkdirSync(projectDir, { recursive: true });
    const sessionUuid = "55555555-5555-4555-8555-555555555555";
    writeFileSync(join(projectDir, `${sessionUuid}.jsonl`), '{"line":1}\n');

    const reader = makeDefaultTranscriptReader(root);
    const found = reader.locate(sessionUuid);
    expect(found).not.toBeNull();
    expect(found!.sizeBytes).toBeGreaterThan(0);

    expect(reader.locate("66666666-6666-4666-8666-666666666666")).toBeNull();
    expect(makeDefaultTranscriptReader(join(root, "does-not-exist")).locate(sessionUuid)).toBeNull();
  });
});
