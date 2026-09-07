import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultExecutingImageInspector,
  defaultProcessAncestryInspector,
  deriveClaimantIdentity,
  extractSessionUuidFromArgv,
  looksLikeClaudeInvocation,
  makeDefaultTranscriptReader,
} from "../../src/registry/canonical-self-claim.ts";

/** Synthetic — never a value that names a real deployment's version. */
const TEST_REQUIRED_EXECUTOR_VERSION = "9.0.0-test";
/**
 * The two versions the symlink/image-divergence test below exercises. Both carry a `-symlink-*`
 * suffix so neither can be mistaken for a real deployment version; only their
 * inequality and their both existing as real version directories matter to the property under
 * test.
 */
const SYMLINK_TEST_VERSION_REAL = "1.0.0-symlink-test-real";
const SYMLINK_TEST_VERSION_DECOY = "9.0.0-symlink-test-decoy";
/** Synthetic version for the executable-file layout used by current Claude installations. */
const VERSION_FILE_LAYOUT_TEST_VERSION = "2.0.0-version-file-test";

/**
 * Exercises the *real*, OS-backed implementations this module ships as defaults — never the
 * fakes the unit test injects. Everything here is a real spawned process and a real temp
 * filesystem; nothing touches a database, the daemon, or a live deployment.
 *
 * This file loads the compiled native addon (`native/peercred/build/Release/peercred.node`) for
 * real. It does not build it: that artifact is shared with sibling test files running concurrently
 * in their own Vitest fork, and rebuilding it here would replace the build tree out from under
 * whichever of them is loading it at the same moment. Building it is the caller's job, once,
 * before this suite runs.
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

const writeVersionFileExecutable = (versionsRoot: string, version: string): string => {
  mkdirSync(versionsRoot, { recursive: true });
  const executable = join(versionsRoot, version);
  cloneExecutable(executable);
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
 * "bad option" on anything it does not recognize. `-e <script>` has to come
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
    const claude = writeVersionedClaude(join(root, "versions"), TEST_REQUIRED_EXECUTOR_VERSION);
    const sessionUuid = "33333333-3333-4333-8333-333333333333";
    const child = spawnHeld(claude, ["--session-id", sessionUuid], root);
    await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

    let snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
    // `ps` can race a just-exec'd process, and so can the kernel's own `KERN_PROCARGS2` record: a
    // freshly exec'd pid's argv can report EINVAL for a few milliseconds before the record
    // settles, entirely apart from `ps`. Retry briefly on either symptom rather than accept a
    // flaky null.
    for (let attempt = 0; (!snapshot || snapshot.argv === null) && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
    }
    expect(snapshot).not.toBeNull();
    expect(snapshot!.command).toContain(sessionUuid);
    expect(snapshot!.argv).not.toBeNull();
    expect(looksLikeClaudeInvocation(snapshot!.argv!)).toBe(true);
    expect(extractSessionUuidFromArgv(snapshot!.argv!)).toBe(sessionUuid);
    expect(snapshot!.startedAt).not.toBeNull();
    // macOS's /tmp is itself a symlink to /private/tmp; lsof's cwd descriptor reports the fully
    // resolved path, so the comparison side has to be resolved the same way rather than compared
    // against the unresolved `tmpdir()`-based root.
    expect(snapshot!.cwd).toBe(realpathSync(root));
  });

  it(
    "the real OS argv reader keeps one positional argument containing spaces and selector-looking text as exactly one argv element",
    async () => {
      const root = tempRoot();
      const claude = writeVersionedClaude(join(root, "versions"), TEST_REQUIRED_EXECUTOR_VERSION);
      const sessionUuid = "55555555-5555-4555-8555-555555555555";
      // `spawn` with an argument array never goes through a shell, so this one array element
      // reaches the kernel as exactly one argv entry — the shape a real attacker-controlled or
      // merely user-typed positional argument would take. A rendered, whitespace-joined
      // reconstruction of this same argv (`ps`'s own text, or any parser built on it) cannot tell
      // this apart from three separate tokens; only reading the kernel's real, delimited argv
      // vector can.
      const decoyPositional = "please use --session-id";
      const child = spawnHeld(claude, ["-p", decoyPositional, "--resume", sessionUuid], root);
      await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

      let snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
      for (let attempt = 0; (!snapshot || snapshot.argv === null) && attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
      }
      expect(snapshot).not.toBeNull();
      expect(snapshot!.argv).not.toBeNull();
      const argv = snapshot!.argv!;
      // The named assertion: the decoy positional survives as exactly one element, not split on
      // its embedded whitespace into "please", "use", "--session-id".
      expect(argv).toContain(decoyPositional);
      expect(argv.filter((element) => element === "--session-id")).toHaveLength(0);
      // The real selector elsewhere on the same argv still resolves — the decoy positional was
      // never counted as a selector occurrence at all.
      expect(extractSessionUuidFromArgv(argv)).toBe(sessionUuid);
    },
  );

  it("preserves a real, kernel-reported empty argv[0] instead of shifting every element into the next one", async () => {
    // `spawn`'s `argv0` option sets the kernel-level argv[0] independently of the executable
    // actually run — a real process whose own argv[0] is the empty string, exactly the shape a
    // naive "skip every NUL after the exec path" parser cannot tell apart from alignment padding.
    const child = spawn("/bin/sleep", ["5"], { argv0: "" });
    await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

    let snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
    for (let attempt = 0; (!snapshot || snapshot.argv === null) && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      snapshot = defaultProcessAncestryInspector.snapshot(child.pid!);
    }
    expect(snapshot).not.toBeNull();
    expect(snapshot!.argv).not.toBeNull();
    // The exact real argv: an empty first element, then "5" — never "5" alone with argv[1]
    // absorbing argv[0]'s position, and never an environment variable's value read as if it were
    // an argv element.
    expect(snapshot!.argv).toEqual(["", "5"]);
  });

  it("distinguishes two processes started within the same rendered ps -o lstart= second", async () => {
    const a = spawn("/bin/sleep", ["5"]);
    const b = spawn("/bin/sleep", ["5"]);
    children.push(a, b);
    await waitUntil(() => a.pid !== undefined && b.pid !== undefined, "both child pids to be assigned");

    let snapA = defaultProcessAncestryInspector.snapshot(a.pid!);
    let snapB = defaultProcessAncestryInspector.snapshot(b.pid!);
    for (
      let attempt = 0;
      (!snapA || !snapB || snapA.startedAt === null || snapB.startedAt === null) && attempt < 40;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapA = defaultProcessAncestryInspector.snapshot(a.pid!);
      snapB = defaultProcessAncestryInspector.snapshot(b.pid!);
    }
    expect(snapA?.startedAt).not.toBeNull();
    expect(snapB?.startedAt).not.toBeNull();

    // `ps -o lstart=` renders to whole-second, locale text; two back-to-back spawns commonly land
    // in the same rendered second.
    const renderedA = execFileSync("ps", ["-o", "lstart=", "-p", String(a.pid)], { encoding: "utf8" }).trim();
    const renderedB = execFileSync("ps", ["-o", "lstart=", "-p", String(b.pid)], { encoding: "utf8" }).trim();

    // The native-resolution token still tells the two processes apart regardless of whether the
    // rendered-text mechanism would have collided them; the rendered pair rides along in the
    // failure message so a run that actually hits the same-second collision is visible if this
    // ever fails.
    expect(
      snapA!.startedAt,
      `rendered ps -o lstart= for both processes: ${JSON.stringify([renderedA, renderedB])}`,
    ).not.toBe(snapB!.startedAt);
  });

  it("walks a real two-hop ancestry (grandchild -> claude parent) to the claude process", async () => {
    const root = tempRoot();
    const claude = writeVersionedClaude(join(root, "versions"), TEST_REQUIRED_EXECUTOR_VERSION);
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

describe("real executing-image resolution — symlink and image can diverge", () => {
  it(
    "resolves an executable stored exactly at versions/<version>",
    async () => {
      const root = tempRoot();
      const executable = writeVersionFileExecutable(
        join(root, "versions"),
        VERSION_FILE_LAYOUT_TEST_VERSION,
      );
      const child = spawnHeld(executable, [], root);
      await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

      let image = defaultExecutingImageInspector.resolve(child.pid!);
      for (let attempt = 0; !image && attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        image = defaultExecutingImageInspector.resolve(child.pid!);
      }

      expect(image, "the filename-layout executing image could not be resolved").not.toBeNull();
      expect(image!.version).toBe(VERSION_FILE_LAYOUT_TEST_VERSION);
      expect(image!.imagePath).toBe(realpathSync(executable));
    },
    20_000,
  );

  it(
    "keeps reporting the version the live process actually loaded after its launch symlink is repointed to a decoy",
    async () => {
      const root = tempRoot();
      const versionsRoot = join(root, "versions");
      const realExecutable = writeVersionedClaude(versionsRoot, SYMLINK_TEST_VERSION_REAL);
      writeVersionedClaude(versionsRoot, SYMLINK_TEST_VERSION_DECOY);
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
      expect(before!.version).toBe(SYMLINK_TEST_VERSION_REAL);

      // Repoint the launch symlink while the process keeps running.
      unlinkSync(launchPath);
      symlinkSync(join(versionsRoot, SYMLINK_TEST_VERSION_DECOY, "claude"), launchPath);

      const after = defaultExecutingImageInspector.resolve(pid);
      expect(after, "the executing image could not be resolved after the repoint").not.toBeNull();
      // The property under test: still the real version, the image this pid actually loaded —
      // not the decoy the symlink now points at.
      expect(after!.version).toBe(SYMLINK_TEST_VERSION_REAL);
      expect(after!.imagePath).toBe(before!.imagePath);

      // Contrast case, spelled out: a naive implementation reading "the symlink's current
      // target" instead of "the image this pid actually loaded" would report the decoy version
      // here — wrong, and exactly what `defaultExecutingImageInspector` above does not report.
      const naiveSymlinkRead = execFileSync("readlink", [launchPath], { encoding: "utf8" }).trim();
      expect(naiveSymlinkRead).toContain(SYMLINK_TEST_VERSION_DECOY);
    },
    20_000,
  );

  it(
    "refuses rather than hashes a decoy when the resolved image path is replaced after the running process opened it",
    async () => {
      const root = tempRoot();
      const versionsRoot = join(root, "versions");
      const claude = writeVersionedClaude(versionsRoot, "1.0.0-fd-swap-test");
      const child = spawnHeld(claude, [], root);
      await waitUntil(() => child.pid !== undefined, "child pid to be assigned");
      const pid = child.pid!;

      let before = defaultExecutingImageInspector.resolve(pid);
      for (let attempt = 0; !before && attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        before = defaultExecutingImageInspector.resolve(pid);
      }
      expect(before, "the executing image could not be resolved before the swap").not.toBeNull();

      // An atomic rename over the exact same path, while the process keeps running: the running
      // process's own open image descriptor stays bound to the original inode (Unix keeps a
      // replaced inode alive as long as something still references it) — the path now names a
      // different file than the one still executing, exactly the shape a resolve-then-reopen race
      // would hit.
      const decoyPath = `${before!.imagePath}.decoy`;
      writeFileSync(decoyPath, "not the real image");
      renameSync(decoyPath, before!.imagePath);

      const after = defaultExecutingImageInspector.resolve(pid);
      if (process.platform === "linux") {
        // `/proc/<pid>/exe` is a magic symlink the kernel resolves to the live mapped image at
        // `open()` time — it never re-reads the swapped path at all, so resolution on this
        // platform stays correct through the swap rather than needing to detect and refuse it.
        expect(after, "the executing image could not be resolved after the swap").not.toBeNull();
        expect(after!.sha256).toBe(before!.sha256);
      } else {
        // Darwin has no magic-symlink equivalent: refused, not the decoy's hash. The bytes this
        // reads are bound to the fd `fstat` verified against the kernel's own record of what the
        // process has open, not re-resolved from the path a second time.
        expect(after).toBeNull();
      }
    },
    20_000,
  );

  it("a forged adjacent manifest cannot change the version of the kernel-resolved image", async () => {
    // The version authority is the resolved image's own `/versions/<version>/` path segment, not
    // any file living beside it. This writes a real, correctly-versioned image, then overwrites
    // its adjacent `package.json` with a different, forged version string — the exact shape a
    // deployment's own manifest write, or an attacker with write access to that one file but not
    // the version-directory layout, could produce — and asserts the resolved version is still the
    // real one, unmoved by the forgery.
    const root = tempRoot();
    const versionsRoot = join(root, "versions");
    const claude = writeVersionedClaude(versionsRoot, SYMLINK_TEST_VERSION_REAL);
    writeFileSync(
      join(versionsRoot, SYMLINK_TEST_VERSION_REAL, "package.json"),
      JSON.stringify({ version: "0.0.1-forged-manifest-version" }),
    );

    const child = spawnHeld(claude, [], root);
    await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

    let image = defaultExecutingImageInspector.resolve(child.pid!);
    for (let attempt = 0; !image && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      image = defaultExecutingImageInspector.resolve(child.pid!);
    }
    expect(image, "the executing image could not be resolved").not.toBeNull();
    expect(image!.version).toBe(SYMLINK_TEST_VERSION_REAL);
    expect(image!.version).not.toBe("0.0.1-forged-manifest-version");
  });

  it("resolves the exact required version end to end", async () => {
    const root = tempRoot();
    const claude = writeVersionedClaude(join(root, "versions"), TEST_REQUIRED_EXECUTOR_VERSION);
    const child = spawnHeld(claude, [], root);
    await waitUntil(() => child.pid !== undefined, "child pid to be assigned");

    let image = defaultExecutingImageInspector.resolve(child.pid!);
    for (let attempt = 0; !image && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      image = defaultExecutingImageInspector.resolve(child.pid!);
    }
    expect(image).not.toBeNull();
    expect(image!.version).toBe(TEST_REQUIRED_EXECUTOR_VERSION);
  });
});

describe("executing-image version path parsing — bounded accepted layouts", () => {
  it.each([
    ["/tmp/versions//claude", "an empty version"],
    ["/tmp/versions/9.0.0-test/", "a trailing empty component"],
    ["/tmp/versions/9.0.0-test/claude/extra", "a path deeper than the legacy layout"],
  ])("refuses %s (%s)", async (imagePath) => {
    const module = await import("../../src/registry/canonical-self-claim.ts");
    const parser = (
      module as typeof module & {
        versionFromImagePath?: (candidate: string) => string | null;
      }
    ).versionFromImagePath;
    expect(parser).toBeTypeOf("function");
    expect(parser!(imagePath)).toBeNull();
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
