import { chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DATABASE_FAMILY_SUFFIXES,
  type DatabaseFile,
  type OwnedProcess,
  type ProbeSignal,
  type ProductionCensus,
  type RealmPaths,
  REALM_EVIDENCE_CLAIM,
  assertProductionUnchanged,
  censusDatabaseFamily,
  classifyProbeSignal,
  mayTerminate,
  planDisposableRealm,
  productionRoot,
  realmLayout,
  verifyRealmResidue,
} from "../../src/acceptance/disposable-realm.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The negative matrix. Every safety condition #655 was granted under is exercised by making it
 * false and requiring a refusal.
 *
 * The procedure this replaces listed its preconditions in prose and would have run anyway. So
 * the tests that matter here are the ones where the realm is *almost* isolated — a path under a
 * plausible scratch directory that is a symlink into production, a socket placed next to the
 * state directory rather than inside it, a probe target that resolves to the canonical root by a
 * different spelling. A test that only checks the obviously-wrong case leaves exactly the shapes
 * a careless run actually takes.
 *
 * Nothing here touches a live process, a real state directory, or the network. That is the point
 * of doing it first: the driver has to be falsifiable before it is ever pointed at anything.
 */
const fakeHome = (): string => {
  const home = tempDir("acp-fake-home-");
  mkdirSync(productionRoot(home), { recursive: true });
  writeFileSync(join(productionRoot(home), "state.sqlite"), "");
  return home;
};

const realmUnder = (root: string): RealmPaths => {
  const stateDir = join(root, "realm");
  mkdirSync(stateDir, { recursive: true });
  return {
    stateDir,
    databasePath: join(stateDir, "state.sqlite"),
    runtimeRoot: join(stateDir, "runtime"),
    socketDir: join(stateDir, "sockets"),
    lockPath: join(stateDir, "agentcpd.lock"),
  };
};

const request = (home: string, overrides: Partial<Parameters<typeof planDisposableRealm>[0]> = {}) => {
  const scratch = tempDir("acp-realm-");
  return {
    home,
    paths: realmUnder(scratch),
    probeTargetRoot: join(scratch, "probe-root"),
    canonicalTargetRoot: join(scratch, "canonical-root"),
    ...overrides,
  };
};

describe("a realm that shares a path with production is not a realm", () => {
  it("accepts a realm that is separate in every path", () => {
    const home = fakeHome();
    expect(planDisposableRealm(request(home)).allowed).toBe(true);
  });

  it("refuses a state directory inside production", () => {
    const home = fakeHome();
    const inside = join(productionRoot(home), "acceptance");
    mkdirSync(inside, { recursive: true });

    const decision = planDisposableRealm(
      request(home, {
        paths: {
          stateDir: inside,
          databasePath: join(inside, "state.sqlite"),
          runtimeRoot: join(inside, "runtime"),
          socketDir: join(inside, "sockets"),
          lockPath: join(inside, "agentcpd.lock"),
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("refuses a scratch directory that is a symlink into production", () => {
    // The shape a careless run actually takes. Compared by declared path this realm is clean;
    // it is production, and only the resolved path says so.
    const home = fakeHome();
    const scratch = tempDir("acp-realm-link-");
    const link = join(scratch, "realm");
    symlinkSync(productionRoot(home), link);

    const decision = planDisposableRealm({
      home,
      paths: {
        stateDir: link,
        databasePath: join(link, "state.sqlite"),
        runtimeRoot: join(link, "runtime"),
        socketDir: join(link, "sockets"),
        lockPath: join(link, "agentcpd.lock"),
      },
      probeTargetRoot: join(scratch, "probe-root"),
      canonicalTargetRoot: join(scratch, "canonical-root"),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("refuses a socket placed beside the state directory rather than inside it", () => {
    // Isolated from production and still wrong: removing the state directory would leave this,
    // and a residue check that only looks inside the realm would report success.
    const home = fakeHome();
    const base = request(home);
    const decision = planDisposableRealm({
      ...base,
      paths: { ...base.paths, socketDir: join(base.paths.stateDir, "..", "sockets") },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("refuses a leaf whose existing ancestor is a symlink into production", () => {
    // The hole in resolving only the whole path: `realpathSync` throws on a missing leaf, and
    // falling back to the lexical path reads a link-through-production as clean. Only the
    // ancestor exists here, which is exactly the state a realm's paths are in before it runs.
    const home = fakeHome();
    const base = request(home);
    const escape = join(base.paths.stateDir, "escape");
    symlinkSync(productionRoot(home), escape);

    const decision = planDisposableRealm({
      ...base,
      paths: { ...base.paths, databasePath: join(escape, "new.sqlite") },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("still accepts a realm whose paths do not exist yet", () => {
    // The other half. Refusing to plan because a directory has not been created would make the
    // ancestor walk useless — every real realm is planned before it is built.
    const home = fakeHome();
    const base = request(home);
    const unborn = join(base.paths.stateDir, "not", "yet", "made");
    expect(
      planDisposableRealm({ ...base, paths: { ...base.paths, runtimeRoot: unborn } }).allowed,
    ).toBe(true);
  });

  it("refuses a path whose symlink cycles (ELOOP)", () => {
    // Only "it does not exist yet" justifies walking up and keeping the suffix. A cycle means
    // the identity of this path is unknowable, and an unknown identity reported as a clean one
    // is the failure this module exists to not commit. Measured on the previous version: a
    // self-referential link was allowed as a realm path.
    const home = fakeHome();
    const base = request(home);
    const loop = join(base.paths.stateDir, "loop");
    symlinkSync(loop, loop);

    const decision = planDisposableRealm({
      ...base,
      paths: { ...base.paths, databasePath: join(loop, "state.sqlite") },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_UNRESOLVABLE);
  });

  it("refuses a path under a directory it cannot read (EACCES)", () => {
    const home = fakeHome();
    const base = request(home);
    const locked = join(base.paths.stateDir, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);

    try {
      const decision = planDisposableRealm({
        ...base,
        paths: { ...base.paths, databasePath: join(locked, "deeper", "state.sqlite") },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_UNRESOLVABLE);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("refuses a state directory that contains production", () => {
    // The direction the isolation loop cannot see. Every realm path being inside the state
    // directory is what licenses removing that directory whole; a state directory containing
    // production turns that completeness argument into a licence to delete production. Measured
    // on the previous version: `stateDir` set to the home directory was allowed.
    const home = fakeHome();
    const decision = planDisposableRealm({
      home,
      paths: {
        stateDir: home,
        databasePath: join(home, "state.sqlite"),
        runtimeRoot: join(home, "runtime"),
        socketDir: join(home, "sockets"),
        lockPath: join(home, "lock"),
      },
      probeTargetRoot: join(home, "..", "probe"),
      canonicalTargetRoot: join(home, "..", "canonical"),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("refuses a relative path", () => {
    const home = fakeHome();
    const base = request(home);
    const decision = planDisposableRealm({
      ...base,
      paths: { ...base.paths, runtimeRoot: "runtime" },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });
});

describe("the probe may not address the canonical conversation", () => {
  it("refuses a probe target equal to the canonical root", () => {
    const home = fakeHome();
    const base = request(home);
    const decision = planDisposableRealm({
      ...base,
      probeTargetRoot: base.canonicalTargetRoot,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_TARGET_IS_CANONICAL);
  });

  it("refuses a probe target that reaches the canonical root through a link", () => {
    // Same conversation, different spelling. This is the case a string comparison passes and
    // the owner's transcript pays for.
    const home = fakeHome();
    const scratch = tempDir("acp-probe-link-");
    const canonical = join(scratch, "canonical-root");
    mkdirSync(canonical, { recursive: true });
    const alias = join(scratch, "probe-root");
    symlinkSync(canonical, alias);

    const decision = planDisposableRealm({
      home,
      paths: realmUnder(scratch),
      probeTargetRoot: alias,
      canonicalTargetRoot: canonical,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_TARGET_IS_CANONICAL);
  });
});

describe("production has to be the same set of facts afterwards", () => {
  const family = (overrides: Partial<DatabaseFile> = {}): readonly DatabaseFile[] =>
    DATABASE_FAMILY_SUFFIXES.map((suffix) =>
      suffix === "-wal"
        ? { suffix, present: true, size: 4_152, mtimeMs: 2_000, ...overrides }
        : { suffix, present: suffix === "", size: 8_192, mtimeMs: 1_000 },
    );

  const census = (overrides: Partial<ProductionCensus> = {}): ProductionCensus => ({
    actorIds: ["actor:ceo"],
    bindingGenerations: ["CEO:1"],
    assignmentIds: ["assign:1"],
    databaseFamily: family(),
    ...overrides,
  });

  it("passes when nothing moved", () => {
    expect(assertProductionUnchanged(census(), census()).allowed).toBe(true);
  });

  it("does not care about ordering", () => {
    // A census is a set. Reporting a reordered read as a change would train whoever runs this
    // to ignore the check, which is worse than not having it.
    const before = census({ actorIds: ["a", "b"] });
    const after = census({ actorIds: ["b", "a"] });
    expect(assertProductionUnchanged(before, after).allowed).toBe(true);
  });

  it("refuses a new actor", () => {
    const decision = assertProductionUnchanged(census(), census({ actorIds: ["actor:ceo", "actor:probe"] }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_PRODUCTION_CHANGED);
    expect(decision.evidence).toMatchObject({ differences: ["actorIds"] });
  });

  it("refuses a new binding generation", () => {
    const after = census({ bindingGenerations: ["CEO:1", "CEO:2"] });
    expect(assertProductionUnchanged(census(), after).reasonCode).toBe(
      ReasonCode.ACCEPTANCE_PRODUCTION_CHANGED,
    );
  });

  it("refuses a write that only the -wal sidecar records", () => {
    // The counterexample that killed the previous census. Under WAL a committed write leaves
    // state.sqlite byte-identical and grows the sidecar — measured at two hundred inserts, main
    // file unchanged and -wal past 800KB. Watching the main file alone reports an untouched
    // production database.
    const decision = assertProductionUnchanged(
      census(),
      census({ databaseFamily: family({ size: 831_112, mtimeMs: 2_500 }) }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.evidence).toMatchObject({ differences: ["databaseFamily"] });
  });

  it("refuses a checkpoint that removes the sidecar", () => {
    // A -wal that disappears is a write to the main file under another name. Recording absence
    // as a value is what makes it visible; skipping missing files would read as no change.
    const after = census({
      databaseFamily: DATABASE_FAMILY_SUFFIXES.map((suffix) => ({
        suffix,
        present: suffix === "",
        size: suffix === "" ? 8_192 : 0,
        mtimeMs: suffix === "" ? 1_000 : 0,
      })),
    });
    expect(assertProductionUnchanged(census(), after).allowed).toBe(false);
  });

  // Every delimiter a join-based comparison might plausibly pick. Testing one of them proves
  // only that *that* delimiter was not chosen — the first version of this test used a NUL and
  // passed happily against an implementation joining on "|". An id is opaque, so the byte
  // assumed not to appear in it is the one that eventually does; the property is that no
  // delimiter is used at all, and the way to state it is to try each one.
  const DELIMITERS = ["\u0000", "|", " ", ",", "\n", "\t", ":"];

  it.each(DELIMITERS)("does not confuse two multisets joined on %j", (delimiter) => {
    const before = census({ actorIds: ["a", `b${delimiter}c`] });
    const after = census({ actorIds: [`a${delimiter}b`, "c"] });
    expect(assertProductionUnchanged(before, after).allowed).toBe(false);
  });
});

describe("a failure to look is not an observation of absence", () => {
  it("records a missing sidecar as absent", () => {
    // ENOENT is the one error that *is* an observation: the file is not there. Refusing here
    // would make every ordinary database — one with no -shm, no -journal — uncensusable.
    const dir = tempDir("acp-census-");
    const database = join(dir, "state.sqlite");
    writeFileSync(database, "x".repeat(4_096));
    writeFileSync(`${database}-wal`, "y".repeat(2_048));

    const census = censusDatabaseFamily(database);

    expect(census.allowed).toBe(true);
    if (!census.allowed) return;
    expect(census.value.map((file) => `${file.suffix || "(main)"}=${file.present}`)).toEqual([
      "(main)=true",
      "-wal=true",
      "-shm=false",
      "-journal=false",
    ]);
  });

  it("refuses when the family cannot be read at all", () => {
    // The counterexample. The previous version recorded every error as absence, so an unreadable
    // parent turned a populated family into four "not present" rows — and two such censuses
    // compared equal, reporting an unchanged production database that had never been read.
    const dir = tempDir("acp-census-locked-");
    const inner = join(dir, "locked");
    mkdirSync(inner, { recursive: true });
    const database = join(inner, "state.sqlite");
    writeFileSync(database, "x".repeat(4_096));
    writeFileSync(`${database}-wal`, "y".repeat(2_048));
    chmodSync(inner, 0o000);

    try {
      const census = censusDatabaseFamily(database);
      expect(census.allowed).toBe(false);
      expect(census.reasonCode).toBe(ReasonCode.ACCEPTANCE_CENSUS_UNOBSERVABLE);
    } finally {
      chmodSync(inner, 0o755);
    }
  });

  it("never yields two censuses that compare equal because neither could be read", () => {
    // The property the refusal exists for, stated end to end rather than left implied: an
    // unreadable family produces no census, so there is nothing to compare and no way to
    // conclude that production is unchanged.
    const dir = tempDir("acp-census-pair-");
    const inner = join(dir, "locked");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "state.sqlite"), "x");
    chmodSync(inner, 0o000);

    try {
      const first = censusDatabaseFamily(join(inner, "state.sqlite"));
      const second = censusDatabaseFamily(join(inner, "state.sqlite"));
      expect(first.allowed).toBe(false);
      expect(second.allowed).toBe(false);
    } finally {
      chmodSync(inner, 0o755);
    }
  });
});

describe("disposable means observed to be gone", () => {
  it("passes on a realm that was fully removed", () => {
    const paths = realmUnder(tempDir("acp-residue-"));
    rmSync(paths.stateDir, { recursive: true, force: true });
    expect(verifyRealmResidue(paths).allowed).toBe(true);
  });

  it("names what remains rather than reporting a boolean", () => {
    const paths = realmUnder(tempDir("acp-residue-"));
    writeFileSync(paths.databasePath, "");

    const decision = verifyRealmResidue(paths);

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_RESIDUE);
    expect(decision.evidence["remaining"]).toContain(paths.databasePath);
  });

  it("notices an empty state directory that was never removed", () => {
    // "The files are gone" is not "the realm is gone". A left-behind directory is the residue
    // a check written against files alone reports as clean.
    const paths = realmUnder(tempDir("acp-residue-"));
    expect(verifyRealmResidue(paths).allowed).toBe(false);
  });
});

describe("an unanswerable question is never followed by another message", () => {
  const inconclusive: readonly ProbeSignal[] = [
    "TIMEOUT",
    "SESSION_STORAGE_BUSY",
    "SOCKET_CLOSED",
    "TELEGRAM_SEND_AMBIGUOUS",
    "CHILD_IDENTITY_DRIFT",
  ];

  it.each(inconclusive)("treats %s as inconclusive", (signal) => {
    expect(classifyProbeSignal(signal)).toBe("INCONCLUSIVE");
  });

  it("continues only on an observed reply", () => {
    expect(classifyProbeSignal("REPLY_OBSERVED")).toBe("CONTINUE");
  });

  it("has no signal that means retry", () => {
    // Enumerated deliberately. A retry disposition is the one thing that would turn an
    // unanswerable outcome into a duplicate, so its absence is a property worth pinning.
    const dispositions = new Set([...inconclusive, "REPLY_OBSERVED" as const].map(classifyProbeSignal));
    expect([...dispositions].sort()).toEqual(["CONTINUE", "INCONCLUSIVE"]);
  });
});

describe("cleanup terminates only what this run started", () => {
  const owned: readonly OwnedProcess[] = [{ pid: 4242, startedAtMs: 1_700_000_000_000 }];

  it("terminates a process this run started", () => {
    expect(mayTerminate(owned, { pid: 4242, startedAtMs: 1_700_000_000_000 })).toBe(true);
  });

  it("refuses a reused pid", () => {
    // The failure a pid-only cleanup produces. Same number, different process — and on this
    // host the process that must survive is the shared Hermes instance.
    expect(mayTerminate(owned, { pid: 4242, startedAtMs: 1_700_000_009_999 })).toBe(false);
  });

  it("refuses a process this run never started", () => {
    expect(mayTerminate(owned, { pid: 81_294, startedAtMs: 1_700_000_000_000 })).toBe(false);
  });

  it("refuses everything when this run started nothing", () => {
    expect(mayTerminate([], { pid: 4242, startedAtMs: 1_700_000_000_000 })).toBe(false);
  });
});

describe("the evidence claim is bounded in the code, not in the write-up", () => {
  it("says what was observed and what was not", () => {
    expect(REALM_EVIDENCE_CLAIM).toContain("isolated disposable ACP instance");
    for (const excluded of [
      "canonical safety",
      "actor reconstitution",
      "duplicate freedom",
      "activation",
    ]) {
      expect(REALM_EVIDENCE_CLAIM).toContain(excluded);
    }
  });

  it("reports the realm's layout relative to its own root", () => {
    const paths = realmUnder(tempDir("acp-layout-"));
    expect(realmLayout(paths)).toEqual(["agentcpd.lock", "runtime", "sockets", "state.sqlite"]);
  });
});

/**
 * The gap a review reached production through, twice, on the host this module reasons about.
 *
 * `realpathSync` resolves symlinks and leaves case alone, while a default macOS volume does not
 * distinguish it. So two spellings of one directory produce two different strings, and a decision
 * made of strings calls them two places:
 *
 * ```
 * realpath(FooBar) = FooBar     realpath(foobar) = foobar
 * string equal: false           same inode: true
 * ```
 *
 * These run on any filesystem. On a case-sensitive one the two spellings really are two
 * directories and the refusals below come from the ordinary rules — the test still passes, and it
 * is measuring something weaker there. That is worth saying rather than pretending otherwise.
 */
describe("a different spelling of a path is the same path", () => {
  it("refuses a probe target spelled as a case variant of the canonical root", () => {
    const home = fakeHome();
    const scratch = tempDir("acp-case-probe-");
    const canonical = join(scratch, "Canonical-Root");
    mkdirSync(canonical, { recursive: true });

    const decision = planDisposableRealm({
      home,
      paths: realmUnder(scratch),
      canonicalTargetRoot: canonical,
      probeTargetRoot: join(scratch, "canonical-root"),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_TARGET_IS_CANONICAL);
  });

  it("refuses a state directory spelled as a case variant of the production root", () => {
    const home = fakeHome();
    // `.Agent-Control-Plane` is `.agent-control-plane` on a case-insensitive volume, so this
    // realm's database, sockets and lock would be created inside production.
    const variant = join(home, ".Agent-Control-Plane", "acceptance");
    mkdirSync(variant, { recursive: true });

    const decision = planDisposableRealm({
      home,
      paths: {
        stateDir: variant,
        databasePath: join(variant, "state.sqlite"),
        runtimeRoot: join(variant, "runtime"),
        socketDir: join(variant, "sockets"),
        lockPath: join(variant, "agentcpd.lock"),
      },
      probeTargetRoot: join(variant, "probe"),
      canonicalTargetRoot: join(variant, "canonical"),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });
});

describe("resolving a path does not reveal a second name for it", () => {
  it("refuses a realm file that is a hard link to something else", () => {
    // A hard link resolves to itself. The realm path looks clean and the bytes are production's:
    // measured before this refusal existed, a write through the realm database changed production.
    const home = fakeHome();
    const scratch = tempDir("acp-hardlink-realm-");
    const paths = realmUnder(scratch);
    linkSync(join(productionRoot(home), "state.sqlite"), paths.databasePath);

    const decision = planDisposableRealm({
      home,
      paths,
      probeTargetRoot: join(scratch, "probe-root"),
      canonicalTargetRoot: join(scratch, "canonical-root"),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("still allows an ordinary realm, whose directories all have several links of their own", () => {
    // The first version of the link check asked `nlink > 1` on every path. A directory always has
    // at least two — itself and its `.` — so it refused every realm there could be, and each
    // scenario above "passed" for a reason that had nothing to do with what it was named for.
    const home = fakeHome();
    const scratch = tempDir("acp-ordinary-realm-");

    expect(
      planDisposableRealm({
        home,
        paths: realmUnder(scratch),
        probeTargetRoot: join(scratch, "probe-root"),
        canonicalTargetRoot: join(scratch, "canonical-root"),
      }).allowed,
    ).toBe(true);
  });
});

describe("the two roots whose comparison is the safety decision", () => {
  it.each(["probeTargetRoot", "canonicalTargetRoot"] as const)(
    "refuses a relative %s, which would resolve against whatever cwd it ran in",
    (field) => {
      const home = fakeHome();
      const scratch = tempDir("acp-relative-root-");

      const decision = planDisposableRealm({
        home,
        paths: realmUnder(scratch),
        probeTargetRoot: join(scratch, "probe-root"),
        canonicalTargetRoot: join(scratch, "canonical-root"),
        [field]: "relative-root",
      });

      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    },
  );
});

describe("residue is the entry on disk, not what it points at", () => {
  it("reports a leftover symlink whose target is gone", () => {
    // `existsSync` follows the link and answers about the target, so a dangling one — a real
    // directory entry, still there — reported clean. Reachable: a socket directory declared
    // outside the state directory but resolving inside it passes planning, cleanup removes the
    // state directory, and the entry outside is left behind and invisible.
    const scratch = tempDir("acp-residue-symlink-");
    const stateDir = join(scratch, "realm");
    mkdirSync(stateDir, { recursive: true });
    const dangling = join(scratch, "sockets");
    symlinkSync(join(stateDir, "gone"), dangling);
    rmSync(stateDir, { recursive: true, force: true });

    const decision = verifyRealmResidue({
      stateDir,
      databasePath: join(stateDir, "state.sqlite"),
      runtimeRoot: join(stateDir, "runtime"),
      socketDir: dangling,
      lockPath: join(stateDir, "agentcpd.lock"),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_RESIDUE);
    expect((decision.evidence as { remaining: string[] }).remaining).toContain(dangling);
  });
});
