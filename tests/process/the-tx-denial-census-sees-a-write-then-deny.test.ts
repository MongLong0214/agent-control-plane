import { describe, expect, it, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #664 — `tx()` treats a denied `Decision` as an ordinary return value and commits it.
 * `scripts/verify-tx-denial-sites.mjs` is the check that a body writing and then denying
 * is either converted to `txDecision()` or named in that script's own EXEMPT/DEFERRED
 * list with a reason. This is not a test of the primitive (see core-hardening.test.ts for
 * that); it is a test that the *census* can see the shape it exists to catch, and does not
 * quietly pass over a real instance of it — the same discipline this repo already holds
 * its REPLACE census to (tests/process/the-replace-census-sees-every-guard-form.test.ts).
 *
 * An adversarial review of #679 found that this discipline was not actually being held:
 * every case below reverted a converted site to plain `tx()` and the census still passed,
 * because `WRITE_PATTERN`/`DENY_PATTERN` did not match the shape two of the six sites
 * actually used (see the comment above those patterns in the script for the full story).
 * The fix is in the script; the test here is that it now holds for *every* real site, not
 * just the one (`session/binding-registry.ts`) the original version of this file checked —
 * a census that catches a regression in one converted call site but not the others is the
 * same "I looked, but not everywhere" gap in miniature.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-tx-denial-sites.mjs";

/**
 * A copy of the working tree's `src/` and the census script itself, not a git clone — a
 * clone only carries committed history, and this has to measure the script and the call
 * sites as they stand right now, uncommitted included.
 */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-tx-census-"), "repo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, SCRIPT), join(dir, SCRIPT));
  return dir;
};

const censusIn = (dir: string): { status: number | null; stdout: string } => {
  const done = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout };
};

/** Reverts exactly one call site's `txDecision(() => {` opener back to plain `tx(() => {`. */
const revertOne = (repo: string, relFile: string, txDecisionOpener: string): void => {
  const path = join(repo, "src", relFile);
  const original = readFileSync(path, "utf8");
  expect(original, `expected ${relFile} to still contain the site's txDecision opener`).toContain(
    txDecisionOpener,
  );
  // `replaceAll` would be wrong here on purpose: if the anchor is not unique within the
  // file, that is itself a bug in this test's markers, not something to paper over by
  // reverting every match.
  const count = original.split(txDecisionOpener).length - 1;
  expect(count, `expected exactly one occurrence of the anchor in ${relFile}`).toBe(1);
  writeFileSync(path, original.replace(txDecisionOpener, txDecisionOpener.replace("txDecision", "tx")));
};

/**
 * Every real `txDecision()` call site this census currently credits with "converted",
 * keyed by an anchor unique within its file (some files, like cto-lifecycle.ts, convert
 * more than one site with an otherwise-identical opener line, so the anchor includes the
 * line above it). This list is meant to grow whenever a new site is converted — a site
 * added to `src` but never added here would defeat the point of this test the same way
 * an EXEMPT entry nothing consults defeats the census itself.
 */
const CONVERTED_SITES: Array<{ label: string; file: string; anchor: string }> = [
  {
    label: "VerificationEngine.pinRunScopedCommands",
    file: "verify/verification-engine.ts",
    anchor: "regardless of the outcome, so a denial must roll the pin attempt back.\n    return this.db.txDecision(() => {",
  },
  {
    label: "CtoLifecycle.prepareSwitchover",
    file: "cto/cto-lifecycle.ts",
    anchor: "so this body's own decision has to roll them back the same way a throw would.\n    const prepared = this.db.txDecision(() => {",
  },
  {
    label: "CtoLifecycle.acknowledgeHandoff",
    file: "cto/cto-lifecycle.ts",
    anchor: "that comes back from the nested `bindings.switchTo` call below.\n    return this.db.txDecision(() => {\n      const row = this.db.get<RawHandoff>",
  },
  {
    label: "CtoLifecycle.recoveryTakeover",
    file: "cto/cto-lifecycle.ts",
    anchor: "one that comes back from the nested `bindings.switchTo` call below.\n    const takeover = this.db.txDecision(() => {",
  },
  {
    label: "CtoLifecycle.suspendProject (prepare)",
    file: "cto/cto-lifecycle.ts",
    anchor: "denial *inside* this body left partial writes behind it.\n    const prepared = this.db.txDecision(() => {",
  },
  {
    label: "DaemonFinalizer lease acquisition",
    file: "daemon/finalizer.ts",
    anchor: "did not happen and must not leave a row behind.\n    return this.cp.db.txDecision(() => {",
  },
  {
    label: "RunEngine.invalidateCandidate",
    file: "run/run-engine.ts",
    anchor: "  ): Decision<RunRow> {\n    return this.db.txDecision(() => {\n      const run = this.require(runId);",
  },
  {
    label: "CandidatePipeline lease acquisition",
    file: "run/candidate-pipeline.ts",
    anchor: "did not happen and must not leave a row behind.\n    return this.db.txDecision(() => {",
  },
  {
    label: "BindingRegistry.switchTo",
    file: "session/binding-registry.ts",
    anchor: 'down already promised and `tx()` alone could not keep.\n    return this.db.txDecision(() => {',
  },
  {
    label: "TaskGraph.finishExecution (post-preflight)",
    file: "run/task-graph.ts",
    anchor: "underneath this second transaction.\n    return this.db.txDecision(() => {\n      const execution = this.execution(executionId)!;",
  },
];

/** Every EXEMPT and DEFERRED entry, so a marker drifting out of its body is caught for all of them, not just one. */
const NAMED_ENTRIES: Array<{ label: string; file: string; marker: string; expectStdout: string }> = [
  {
    label: "github-kernel expiry sweep (EXEMPT)",
    file: "github/github-kernel.ts",
    marker: "UPDATE resource_claims SET status = 'EXPIRED'",
    expectStdout: "stale exemption",
  },
  {
    label: "managed-write-guard renewal sweep (EXEMPT)",
    file: "guard/managed-write-guard.ts",
    marker: "the run holds no live claim on this repository, so the write cannot be fenced",
    expectStdout: "stale exemption",
  },
  {
    label: "ingress-guard claimTurn (EXEMPT)",
    file: "ingress/ingress-guard.ts",
    marker: "this message's turn was already claimed and its outcome was never recorded",
    expectStdout: "stale exemption",
  },
  {
    label: "production-gate CEO decision transition guard (EXEMPT)",
    file: "ceo/production-gate.ts",
    marker: "CEO ${input.decision}",
    expectStdout: "stale exemption",
  },
  {
    label: "suspendProject's completed tx (DEFERRED, #692)",
    file: "cto/cto-lifecycle.ts",
    marker: "the CTO binding changed while runtime shutdown was in progress",
    expectStdout: "stale deferral",
  },
  {
    label: "RunEngine.dispatch's applyRunStateTransition callback (EXEMPT)",
    file: "run/run-engine.ts",
    marker: "§29/§30.3 — activation, its envelope and its audit record are one operation",
    expectStdout: "stale exemption",
  },
  {
    label: "RunEngine.transition's applyRunStateTransition callback (EXEMPT)",
    file: "run/run-engine.ts",
    marker: "§29 — the state edge, its evidence and its envelope are one operation",
    expectStdout: "stale exemption",
  },
  {
    label: "TaskGraph.startExecution's recordInvocationStarted guard (EXEMPT)",
    file: "run/task-graph.ts",
    marker: "const invocationBaseline = this.#baseline.recordInvocationStarted(",
    expectStdout: "stale exemption",
  },
  {
    label: "BindingRegistry.bind's recordTargetBinding guard (EXEMPT)",
    file: "session/binding-registry.ts",
    marker: "const recorded = this.recordTargetBinding(actorId, input.verifiedTarget)",
    expectStdout: "stale exemption",
  },
  {
    label: "TaskGraph.finishExecution's preflight audit write (EXEMPT)",
    file: "run/task-graph.ts",
    marker: "TASK_EXECUTION_LATE_RESULT_IGNORED",
    expectStdout: "stale exemption",
  },
  {
    label: "ManagedWriteGuard.decideWrite's expiry sweep, reached only through the concise opener (EXEMPT)",
    file: "guard/managed-write-guard.ts",
    marker: "this.expireOverdueClaims();\n\n    const operation = request.operation as WriteOperation;",
    expectStdout: "stale exemption",
  },
  {
    label: "Outbox.acknowledgeInTx's rejection audit, reached only through the concise opener (EXEMPT)",
    file: "outbox/outbox.ts",
    marker: 'kind: "OUTBOX_ACK_REJECTED",',
    expectStdout: "stale exemption",
  },
];

describe("the tx-denial census sees a plain tx() body that writes and can deny", () => {
  it("passes on the working tree as it stands, and accounts for every site by name", () => {
    const repo = scratchRepo();
    const done = censusIn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.status).toBe(0);
    // Pin the counts so a site silently moving from one bucket to another (e.g. a
    // DEFERRED defect quietly becoming an EXEMPT "this is safe" without anyone updating
    // the census's own reasoning) fails this test rather than passing unnoticed.
    const exemptCount = NAMED_ENTRIES.filter((e) => e.expectStdout === "stale exemption").length;
    const deferredCount = NAMED_ENTRIES.filter((e) => e.expectStdout === "stale deferral").length;
    expect(done.stdout).toContain(
      `${CONVERTED_SITES.length} using txDecision, ${exemptCount} documented exemption(s), ` +
        `${deferredCount} deferred known defect(s), 0 undocumented trap(s)`,
    );
    expect(done.stdout).toContain("cto/cto-lifecycle.ts:732 (#692)");
  });

  it("fails on a new, undocumented write-then-deny tx() body (block form)", () => {
    const repo = scratchRepo();
    const path = join(repo, "src/daemon/finalizer.ts");
    const original = readFileSync(path, "utf8");
    // Inject a probe transaction with the exact shape #664 reported, using the same
    // `db` and `deny` this file already imports so the census's own patterns see it.
    const injected = `${original}
class CensusProbeDenialTrap {
  probe(db: import("../db/database.ts").Db) {
    return db.tx(() => {
      db.run("INSERT INTO census_probe_table (probe_id) VALUES ('x')");
      return deny(ReasonCode.CONFLICT, "probe");
    });
  }
}
`;
    writeFileSync(path, injected);
    const done = censusIn(repo);

    expect(done.stdout).toContain("daemon/finalizer.ts");
    expect(done.status).toBe(1);
  });

  it("fails on a new, undocumented write-then-deny tx() body (concise form) — the real shape a third review found invisible", () => {
    // A Sol review of #679 found the census matched only `tx(() => { ... })` — the braced
    // body — and could not even *see* `db.tx(() => this.decideWrite(request))` /
    // `db.tx(() => this.acknowledgeInTx(...))`, the concise-body shape two real production
    // sites (managed-write-guard.ts, outbox.ts) actually use. The block-form probe above
    // would have passed against the *pre-fix* scanner even after that finding, because it
    // injects the one shape already recognised — exactly the gap this test closes: it
    // feeds the real, other call shape, not a restatement of the one already covered.
    const repo = scratchRepo();
    const path = join(repo, "src/daemon/finalizer.ts");
    const original = readFileSync(path, "utf8");
    const injected = `${original}
class CensusProbeConciseDenialTrap {
  probe(db: import("../db/database.ts").Db) {
    return db.tx(() => this.probeInTx(db));
  }
  private probeInTx(db: import("../db/database.ts").Db) {
    db.run("INSERT INTO census_probe_table (probe_id) VALUES ('x')");
    return deny(ReasonCode.CONFLICT, "concise-form probe");
  }
}
`;
    writeFileSync(path, injected);
    const done = censusIn(repo);

    expect(done.stdout).toContain("daemon/finalizer.ts");
    expect(done.status).toBe(1);
  });

  it("fails, rather than silently passing, on a concise opener it cannot resolve to a definition", () => {
    // A concise body that is not a single call to a same-file name — here, a call to a
    // name this census will never find because it is never defined — must not be read as
    // "nothing to see": it is an opener the scanner *saw* and could not classify, and
    // "seen but not classified" has to fail the same as an undocumented trap, or the
    // output's "every" would again be wider than what the code actually inspects.
    const repo = scratchRepo();
    const path = join(repo, "src/daemon/finalizer.ts");
    const original = readFileSync(path, "utf8");
    const injected = `${original}
class CensusProbeUnresolvableOpener {
  probe(db: import("../db/database.ts").Db) {
    return db.tx(() => this.methodThatIsNeverDefinedAnywhereInThisFile());
  }
}
`;
    writeFileSync(path, injected);
    const done = censusIn(repo);

    expect(done.stdout).toContain("methodThatIsNeverDefinedAnywhereInThisFile");
    expect(done.stdout).toContain("Seen but not classified");
    expect(done.status).toBe(1);
  });

  describe("fails when a converted call site regresses back to plain tx() — every real site, not just one", () => {
    for (const site of CONVERTED_SITES) {
      it(`catches a regression at ${site.label} (${site.file})`, () => {
        const repo = scratchRepo();
        revertOne(repo, site.file, site.anchor);

        const done = censusIn(repo);

        expect(done.stdout).toContain(site.file);
        expect(done.status).toBe(1);
      });
    }
  });

  it("catches a regression even when it lands on the two sites #679's own review found invisible", () => {
    // The decisive reproduction from the #679 review: acknowledgeHandoff and
    // recoveryTakeover both reverted at once, exactly as Sol reverted them, with the
    // *original* (pre-fix) WRITE_PATTERN/DENY_PATTERN this would have passed silently.
    const repo = scratchRepo();
    revertOne(
      repo,
      "cto/cto-lifecycle.ts",
      "that comes back from the nested `bindings.switchTo` call below.\n    return this.db.txDecision(() => {\n      const row = this.db.get<RawHandoff>",
    );
    revertOne(
      repo,
      "cto/cto-lifecycle.ts",
      "one that comes back from the nested `bindings.switchTo` call below.\n    const takeover = this.db.txDecision(() => {",
    );

    const done = censusIn(repo);

    expect(done.stdout).toContain("cto/cto-lifecycle.ts");
    expect(done.status).toBe(1);
  });

  describe("fails when a named EXEMPT or DEFERRED entry names a body the census can no longer find", () => {
    // Drift the other direction: the marker in the script's own list stops matching
    // anything (as if the code it named had moved or been reworded), and the census must
    // say so rather than silently carrying a dead entry forward — "an exemption nothing
    // consults is a place for the next reader to believe something was decided" (this
    // repo's own REPLACE census learned this once already), and the same is true of a
    // deferred, tracked defect that silently stops being checked at all.
    for (const entry of NAMED_ENTRIES) {
      it(`catches drift on ${entry.label}`, () => {
        const repo = scratchRepo();
        const path = join(repo, "src", entry.file);
        const original = readFileSync(path, "utf8");
        expect(original).toContain(entry.marker);
        // `replaceAll`, not `replace`: a marker that (legitimately) occurs more than once in
        // its file — outbox.ts's rejection-audit `kind` field is written in two identical
        // early-deny branches — must have *every* occurrence corrupted, or the untouched
        // second copy keeps `site.body.includes(marker)` true and this test asserts nothing.
        writeFileSync(path, original.split(entry.marker).join("A_MARKER_NOTHING_MATCHES"));

        const done = censusIn(repo);

        expect(done.stdout).toContain(entry.expectStdout);
        expect(done.status).toBe(1);
      });
    }
  });
});
