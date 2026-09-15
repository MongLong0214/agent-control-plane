#!/usr/bin/env node
/**
 * The independent read-only verification of one sealed rollback pair, as a program rather than a
 * brief.
 *
 * `program-terminal-ssot.md` requires that a pair be checked by "a distinct read-only verifier",
 * because "producer self-validation alone is insufficient". On 2026-09-16 that was delegated to a
 * second session as prose. The session ran:
 *
 *     plutil -extract ProgramArguments json <plist>        # no -o
 *
 * `-o` is not optional decoration. Without it `plutil -extract` does not print to stdout — it
 * **overwrites the target file** with the extracted value. The live LaunchAgent plist went from a
 * ten-key dictionary to a one-element array, and the drift check the verifier was about to perform
 * measured a file the verifier had already rewritten. Reproduced here on a copy before this file
 * was written; the destructive form is not folklore.
 *
 * The brief said "mutate nothing" in eleven places. That is the wrong shape of defence: the command
 * *looked* like a read. So the defence is now a program, and it carries three properties a
 * paragraph cannot:
 *
 *   1. **The operator supplies no expectations.** Every `--expect-*` value is measured here from
 *      the deployment. The prose brief got `--expect-runtime-root` wrong — it is `$APP_ROOT/dist`,
 *      the install target, not `$APP_ROOT` — while the producer's own receipt already recorded the
 *      correction. A value a human retypes is a value that can disagree with the artifact.
 *   2. **Reads are reads, spelled once.** The plist is read with `plutil -convert json -o -`, which
 *      writes to stdout and leaves the file byte-identical (measured). `-extract` appears nowhere,
 *      and the launcher is parsed as text rather than executed.
 *   3. **Non-mutation is a postcondition, not a promise.** Every live path this run reads is
 *      digested before and after. A run that changed anything fails on its own evidence, whatever
 *      else it found — which is exactly what nobody could establish after the incident above.
 *
 * What it does not do: decide. It reports PASS / FAIL / BLOCKED and writes nothing outside a
 * disposable stage. Whether a PASS satisfies the roadmap's *identity* requirement is a fact about
 * who ran it, and this file cannot know that — the report names the question rather than answering
 * it.
 *
 * Usage:
 *   verify-pair-independently.mjs --pair-root DIR --receipt FILE [--stage-parent DIR] [--plist FILE]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A file's sha256, or null when it is not there. Absence is a fact, never an error to swallow. */
export const digestOfFile = (path) => {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
};

/**
 * A property list as data, without touching the file.
 *
 * `-convert json -o -` renders to stdout. The destructive sibling this exists to replace is
 * `plutil -extract KEY json FILE`, which rewrites FILE. There is one spelling here on purpose:
 * a second one is how the wrong one comes back.
 */
export const readPlist = (path) => {
  const rendered = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(rendered);
};

/**
 * The value a launcher assigns to `name`, read as text.
 *
 * Never sourced and never executed: a launcher is a program, and running one to learn what it sets
 * is the same category of mistake as `-extract` — an action that looks like a question.
 */
export const launcherAssignment = (text, name) => {
  const match = new RegExp(`^(?:export\\s+)?${name}=(.+)$`, "m").exec(text);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "");
};

const argumentValue = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

/** Receipt fields, from a file that must live outside the pair. A pair cannot vouch for its index. */
export const readReceipt = (text) => {
  const field = (name) => {
    const match = new RegExp(`^${name}=(.+)$`, "m").exec(text);
    return match ? match[1].trim() : null;
  };
  return {
    pairId: field("ACP_PAIR_ID"),
    indexDigest: field("ACP_PAIR_INDEX_DIGEST"),
    serviceGeneration: field("service_generation"),
  };
};

const blocked = (why, detail) => ({ verdict: "BLOCKED", why, detail });

/** Everything the validator needs, measured from the deployment rather than retyped by a person. */
export const measureDeployment = (plistPath) => {
  const plist = readPlist(plistPath);
  const label = plist.Label ?? null;
  const workingDirectory = plist.WorkingDirectory ?? null;
  const launcherPath = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments[0] : null;
  if (!label || !workingDirectory || !launcherPath) {
    return blocked("the plist does not name a label, a working directory and a launcher", {
      label,
      workingDirectory,
      launcherPath,
    });
  }
  if (!existsSync(launcherPath)) return blocked("the launcher the plist names is absent", { launcherPath });
  const launcher = readFileSync(launcherPath, "utf8");
  const stateDir = launcherAssignment(launcher, "ACP_STATE_DIR");
  const appRoot = launcherAssignment(launcher, "ACP_APP_ROOT");
  if (!stateDir || !appRoot) {
    return blocked("the launcher does not assign ACP_STATE_DIR and ACP_APP_ROOT", { stateDir, appRoot });
  }
  // The install target, not the closure. `validateRollbackPair` compares this against
  // `manifest.identity.runtime.installRoot`, which is `$APP_ROOT/dist`. The prose brief said
  // `$APP_ROOT` and the producer's own receipt had already corrected it — the reason this is
  // derived here and not supplied.
  const runtimeRoot = join(appRoot, "dist");
  const nodeExecutable = join(appRoot, "dist", "bin", "node");
  if (!existsSync(nodeExecutable)) return blocked("the generation carries no node executable", { nodeExecutable });
  const nodeVersion = execFileSync(nodeExecutable, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
  return {
    verdict: "MEASURED",
    label,
    workingDirectory,
    launcherPath,
    databasePath: join(stateDir, "state.sqlite"),
    appRoot,
    runtimeRoot,
    nodeExecutable,
    nodeVersion,
  };
};

/**
 * A database read from a private copy, never from the live file.
 *
 * `-wal` and `-shm` travel with it: a read-only handle on a live SQLite file can miss whatever is
 * still in the write-ahead log, and opening the live file can create siblings beside it.
 */
export const copyDatabaseInto = (stage, databasePath) => {
  const target = join(stage, "state.sqlite");
  copyFileSync(databasePath, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${databasePath}${suffix}`)) copyFileSync(`${databasePath}${suffix}`, `${target}${suffix}`);
  }
  return target;
};

const sqlite = (path, statement) =>
  execFileSync("/usr/bin/sqlite3", [path, statement], { encoding: "utf8", timeout: 120_000 }).trim();

export const inspectDatabase = (path) => ({
  integrity: sqlite(path, "PRAGMA integrity_check;"),
  userVersion: Number(sqlite(path, "PRAGMA user_version;")),
  foreignKeyViolations: sqlite(path, "PRAGMA foreign_key_check;"),
  tables: Number(sqlite(path, "SELECT count(*) FROM sqlite_master WHERE type='table';")),
});

/**
 * Proves the validator refuses a known-bad expectation, before any PASS is believed.
 *
 * A verifier that has only ever reported PASS on a good input has not shown it can fail. The second
 * session's run established this by hand -- it re-ran `validate` with a value it knew to be wrong
 * and got a non-zero exit with the expected/found difference printed -- and a property established
 * by an operator remembering to establish it is not established. So it runs every time, with a
 * deliberately wrong pair id: a `validate` that accepts that is a broken instrument whatever it
 * says about the real one.
 */
const provesItCanFail = (validatorPath, pairRoot, receipt, measured, schemaVersion) => {
  const argv = [
    validatorPath, "validate",
    "--pair-root", pairRoot,
    "--pair-id", "00000000-0000-0000-0000-000000000000",
    "--expected-index-digest", receipt.indexDigest,
    "--expect-database", measured.databasePath,
    "--expect-service-label", measured.label,
    "--expect-working-directory", measured.workingDirectory,
    "--expect-runtime-root", measured.runtimeRoot,
    "--expect-schema-version", String(schemaVersion),
    "--expect-service-generation", receipt.serviceGeneration ?? "",
    "--expect-node-version", measured.nodeVersion,
  ];
  try {
    execFileSync(process.execPath, argv, { encoding: "utf8", timeout: 600_000 });
    return false;
  } catch {
    return true;
  }
};

const main = (argv) => {
  const pairRoot = argumentValue(argv, "--pair-root");
  const receiptPath = argumentValue(argv, "--receipt");
  if (!pairRoot || !receiptPath) {
    process.stderr.write(
      "verify-pair-independently --pair-root DIR --receipt FILE [--stage-parent DIR] [--plist FILE]\n" +
        "  Every --expect-* value is measured from the deployment. There is nothing else to supply,\n" +
        "  and that is the point: a value a person retypes can disagree with the artifact.\n",
    );
    return 2;
  }
  if (!existsSync(pairRoot) || !statSync(pairRoot).isDirectory()) {
    process.stdout.write(`BLOCKED — the pair root is not a directory: ${pairRoot}\n`);
    return 2;
  }
  if (resolve(receiptPath).startsWith(`${resolve(pairRoot)}/`)) {
    // The whole reason the receipt is retained separately. A pair that supplies its own expected
    // index digest vouches for a forgery just as happily as for itself.
    process.stdout.write("BLOCKED — the receipt is inside the pair, so it cannot be the external authority\n");
    return 2;
  }
  if (!existsSync(receiptPath)) {
    process.stdout.write(`BLOCKED — no receipt at ${receiptPath}\n`);
    return 2;
  }
  const receipt = readReceipt(readFileSync(receiptPath, "utf8"));
  if (!receipt.pairId || !receipt.indexDigest) {
    process.stdout.write("BLOCKED — the receipt does not carry both ACP_PAIR_ID and ACP_PAIR_INDEX_DIGEST\n");
    return 2;
  }

  // `--plist` names the deployment to measure. It defaults to this machine's LaunchAgent and is
  // overridable for two reasons: a deployment under a different label, and a test that must be able
  // to fail for the reason it names rather than for an absent file on a Linux runner. It widens
  // nothing -- every path below is still read-only, and the non-mutation postcondition covers
  // whatever it points at.
  const plistPath = argumentValue(argv, "--plist")
    ?? join(process.env["HOME"] ?? "", "Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist");
  if (!existsSync(plistPath)) {
    process.stdout.write(`BLOCKED — no LaunchAgent plist at ${plistPath}\n`);
    return 2;
  }

  // Ruled out here, and the reason is worth keeping: a check that this file sits inside the
  // checkout it verifies from. It reads like the structural close for the direct-invocation defect,
  // and it is a tautology -- `checkoutRoot` is derived from `import.meta.url`, so `self` is inside
  // it by construction and no mutation can make the branch fire. A guard nothing can kill reports
  // coverage it does not have. What actually defends that class is the realpath comparison in the
  // invocation guard at the bottom, and a case above dies when it is weakened back to `resolve()`.
  const measured = measureDeployment(plistPath);
  if (measured.verdict === "BLOCKED") {
    process.stdout.write(`BLOCKED — ${measured.why}\n  ${JSON.stringify(measured.detail)}\n`);
    return 2;
  }

  // Every live path this run reads, digested before anything else happens. Compared again at the
  // end. A verifier that wrote to what it was measuring is the incident this file exists for, and
  // "I did not write" is not a claim a reader should have to take on trust.
  const watched = [plistPath, measured.launcherPath, measured.databasePath];
  const before = new Map(watched.map((path) => [path, digestOfFile(path)]));

  const stage = mkdtempSync(join(argumentValue(argv, "--stage-parent") ?? tmpdir(), "acp-pair-verify-"));
  const findings = [];
  let failed = false;
  try {
    // The verifier's own build, never the deployed one -- and an earlier draft of this file got it
    // backwards, preferring `$APP_ROOT/dist/deploy/rollback-pair.js` while the header above said
    // to build your own. It cost a false FAIL and was worth every minute: the deployed generation
    // is from 2026-09-13 and #929, which taught the member-path grammar to express a pnpm virtual
    // store, merged 2026-09-15T00:40Z. So the deployed validator refuses
    // `node_modules/.pnpm/@esbuild+darwin-arm64@0.28.2/...` as STATE_PATH_INSECURE while the same
    // path is legal on `main`. A pair validated by the binary the deployment already trusts asks
    // a weaker question than the one this file exists to ask, and here it asked an obsolete one.
    const validatorPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist/deploy/rollback-pair.js");
    if (!existsSync(validatorPath)) {
      process.stdout.write(
        "BLOCKED — this checkout has no dist/deploy/rollback-pair.js. Run `pnpm build` here; the\n" +
          "deployed generation's copy is deliberately not used, because validating a pair with the\n" +
          "binary the deployment already ships asks a weaker question.\n",
      );
      return 2;
    }
    const staged = copyDatabaseInto(stage, measured.databasePath);
    const live = inspectDatabase(staged);

    const validateArgv = [
      validatorPath, "validate",
      "--pair-root", pairRoot,
      "--pair-id", receipt.pairId,
      "--expected-index-digest", receipt.indexDigest,
      "--expect-database", measured.databasePath,
      "--expect-service-label", measured.label,
      "--expect-working-directory", measured.workingDirectory,
      "--expect-runtime-root", measured.runtimeRoot,
      "--expect-schema-version", String(live.userVersion),
      "--expect-service-generation", receipt.serviceGeneration ?? "",
      "--expect-node-version", measured.nodeVersion,
    ];
    let validateOut = "";
    let validateStatus = 0;
    try {
      validateOut = execFileSync(process.execPath, validateArgv, { encoding: "utf8", timeout: 600_000 });
    } catch (error) {
      validateStatus = typeof error?.status === "number" ? error.status : 1;
      validateOut = `${String(error?.stdout ?? "")}${String(error?.stderr ?? "")}`;
    }
    findings.push(["validate", validateStatus === 0 ? "PASS" : `FAIL exit ${String(validateStatus)}`, validateOut.trim()]);
    if (validateStatus !== 0) failed = true;

    const canFail = provesItCanFail(validatorPath, pairRoot, receipt, measured, live.userVersion);
    findings.push([
      "CAN_FAIL",
      canFail ? "PASS" : "FAIL",
      canFail ? "a deliberately wrong pair id was refused" : "a deliberately wrong pair id was ACCEPTED",
    ]);
    if (!canFail) failed = true;

    findings.push(["integrity_check", live.integrity === "ok" ? "PASS" : "FAIL", live.integrity]);
    if (live.integrity !== "ok") failed = true;
    findings.push([
      "foreign_key_check",
      live.foreignKeyViolations === "" ? "PASS" : "FAIL",
      live.foreignKeyViolations === "" ? "0 violations" : live.foreignKeyViolations,
    ]);
    if (live.foreignKeyViolations !== "") failed = true;
    findings.push(["user_version", "MEASURED", String(live.userVersion)]);
    findings.push(["tables", "MEASURED", String(live.tables)]);
    findings.push(["node", "MEASURED", `${measured.nodeVersion} at ${measured.nodeExecutable}`]);
    findings.push(["runtime_root", "MEASURED", measured.runtimeRoot]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  let mutated = false;
  for (const path of watched) {
    const after = digestOfFile(path);
    if (after !== before.get(path)) {
      mutated = true;
      findings.push(["NON_MUTATION", "FAIL", `${path} changed during this run`]);
    }
  }
  if (!mutated) findings.push(["NON_MUTATION", "PASS", `${String(watched.length)} live path(s) byte-identical`]);

  for (const [name, status, detail] of findings) {
    process.stdout.write(`  ${name.padEnd(18)} ${status.padEnd(14)} ${detail.split("\n")[0] ?? ""}\n`);
  }
  const verdict = mutated || failed ? "FAIL" : "PASS";
  process.stdout.write(
    `\nRESULT: ${verdict}\n` +
      "This says the pair matches the deployment it was sealed from and that this run changed nothing.\n" +
      "It does not say who ran it. The roadmap requires a verifier distinct from the producer, and\n" +
      "that is a fact about the operator which no program can establish about itself.\n",
  );
  return verdict === "PASS" ? 0 : 1;
};

/**
 * Direct invocation, compared through `realpath` on both sides.
 *
 * `import.meta.url` is already the resolved path -- Node resolves a module's real path -- while
 * `process.argv[1]` is whatever was typed. On macOS `/tmp` is a symlink to `/private/tmp`, so
 * comparing the two with `resolve()` alone made this file **do nothing and exit 0** whenever it was
 * invoked through a symlinked directory. A verification that silently performs no verification and
 * reports success is worse than one that crashes, and a test caught this rather than a reader.
 */
const invokedDirectly = process.argv[1] !== undefined
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
