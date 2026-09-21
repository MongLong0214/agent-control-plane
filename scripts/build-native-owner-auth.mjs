#!/usr/bin/env node
/**
 * Builds `native/owner-auth/OwnerAuth.swift` into `dist/acp-owner-auth`, or fails loudly.
 *
 * Exposed as `pnpm native:owner-auth:build` and wired into `build`, the same shape as
 * `build-native-peercred.mjs` and `build-native-fd-vfs.mjs`. It exists because
 * `docs/native-owner-auth.md` gave the compile as a command for a person to type, and a step
 * that only completes when someone runs a line by hand is not a build — it is an artifact that
 * is absent from every deployment nobody remembered to prepare. Measured against a deployed
 * runtime: it carried the reviewed Swift source while `dist/acp-owner-auth` existed in neither
 * the repository's `dist/` nor that runtime, so the owner-authentication connector could not be
 * launched at all.
 *
 * Darwin-only, like peercred and for the same reason: `LAContext` and `AppKit` are macOS
 * frameworks. This repository's CI runs jobs on both `macos-15` and `ubuntu-latest`, so a
 * non-Darwin runner must see a skip rather than an attempted (and failing) build.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "native", "owner-auth", "OwnerAuth.swift");
const DIST = join(ROOT, "dist");
const ARTIFACT = join(DIST, "acp-owner-auth");

/**
 * The define that removes the production entry point. `OwnerAuth.swift` guards `@main
 * NativeOwnerAuth` with `#if !OWNER_AUTH_TEST`, so a build carrying it produces a binary whose
 * only executable surface is the test fixture — one that takes a caller-supplied socket path and
 * mode on argv, which is precisely the door around the AppKit confirmation and `LAContext`
 * authentication that the dialog exists to be. It must never reach the shipping artifact.
 */
const TEST_DEFINE = "OWNER_AUTH_TEST";

/*
 * Variables whose contents are appended to a compile as flags, and so could carry `-D
 * OWNER_AUTH_TEST` into the shipping build from a caller's ambient environment. `SDKROOT`,
 * `DEVELOPER_DIR` and `TOOLCHAINS` are deliberately *not* stripped: they select a toolchain
 * rather than inject a define, a CI image may legitimately need them, and the post-build
 * assertion below checks the produced binary's behaviour rather than trusting how it was made.
 */
const FLAG_CARRYING = ["SWIFT_FLAGS", "OTHER_SWIFT_FLAGS", "CFLAGS", "CPPFLAGS", "CXXFLAGS", "LDFLAGS"];

if (process.platform !== "darwin") {
  process.stderr.write(
    "build-native-owner-auth: skipping — the owner-authentication connector is Darwin-only " +
      `(LAContext, AppKit) and this runner is ${process.platform}\n`,
  );
  process.exit(0);
}

const buildEnv = { ...process.env };
for (const name of FLAG_CARRYING) delete buildEnv[name];

/*
 * Anything left that still names the test define is a route this list does not know about.
 * Refuse rather than guess, and name only the variable — its value is the caller's.
 */
const smuggled = Object.entries(buildEnv)
  .filter(([, value]) => typeof value === "string" && value.includes(TEST_DEFINE))
  .map(([name]) => name);
if (smuggled.length > 0) {
  process.stderr.write(
    `build-native-owner-auth: refusing to build; ${smuggled.sort().join(", ")} names ${TEST_DEFINE}, ` +
      "which removes the production entry point and must never reach the shipping artifact\n",
  );
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

/*
 * Exactly the command `docs/native-owner-auth.md` states, so the artifact this produces is the
 * one that document describes. Adding or reordering flags here would make the built binary
 * something other than the reviewed one.
 */
const compile = spawnSync(
  "/usr/bin/xcrun",
  ["swiftc", "-parse-as-library", SOURCE, "-o", ARTIFACT],
  { cwd: ROOT, stdio: "inherit", env: buildEnv, timeout: 180000 },
);
if (compile.error) {
  process.stderr.write(`build-native-owner-auth: failed to run xcrun swiftc: ${compile.error.message}\n`);
  process.exit(1);
}
if (compile.status !== 0) process.exit(compile.status ?? 1);

/*
 * What was actually produced, asked of the binary rather than of the build.
 *
 * The production `@main` accepts no arguments at all (`CommandLine.arguments.count == 1`) and
 * answers anything else with `SCOPE_INVALID` and a nonzero exit, before reading stdin, before
 * `SecItemCopyMatching`, and before any dialog. It is safe to run here precisely because the
 * refusal happens before the owner-facing work. A valid scope is never written to this process:
 * that would open the authentication UI, which a build must not do.
 *
 * This is not what stops a test-define artifact from shipping — measured 2026-09-21, compiling
 * `OwnerAuth.swift` with `-D OWNER_AUTH_TEST` alone does not link at all (`ld: symbol(s) not
 * found`), because the define removes `@main` and leaves the binary with no entry point. The
 * refusal above and the linker are what cover that. What this probe adds is an assertion about
 * the artifact actually sitting at that path: that it is executable on this machine and answers
 * as the production entry point, which also catches a stale or mismatched file the compile step
 * did not in fact replace.
 */
const probe = spawnSync(ARTIFACT, ["--not-a-production-argument"], {
  encoding: "utf8", env: {}, timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
});
if (probe.error) {
  process.stderr.write(`build-native-owner-auth: built artifact could not be executed: ${probe.error.message}\n`);
  process.exit(1);
}
if (probe.status !== 1 || !(probe.stdout ?? "").includes("SCOPE_INVALID")) {
  process.stderr.write(
    "build-native-owner-auth: the built artifact did not refuse an argument the way the production " +
      `entry point does (exit ${String(probe.status)}, stdout ${JSON.stringify(probe.stdout ?? "")}). ` +
      `A binary built with ${TEST_DEFINE} has no production entry point; refusing to ship this one\n`,
  );
  process.exit(1);
}

process.stdout.write(`build-native-owner-auth: built ${ARTIFACT}\n`);
