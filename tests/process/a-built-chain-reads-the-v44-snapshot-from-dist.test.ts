import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import {
  digestOfSchemaRows,
  privateStatePath,
  SCHEMA_ROWS_SQL,
  schemaRowsOf,
  userVersionOf,
  V38_TO_V44_BASE_CHECKSUMS,
  V44_SCHEMA_DIGEST_FROM_V11,
  V44_SCHEMA_DIGEST_FROM_V43,
  type SchemaRow,
  v11Image,
  v43Image,
} from "../helpers/released-v44-schema.ts";
import {
  toV44Image,
  V45_BASE_CHECKSUM,
  V45_SCHEMA_DIGEST_FROM_V11,
  V45_SCHEMA_DIGEST_FROM_V44,
} from "../helpers/released-v45-schema.ts";
import {
  toV45Image,
  V46_BASE_CHECKSUM,
  V46_SCHEMA_DIGEST_FROM_V11,
  V46_SCHEMA_DIGEST_FROM_V45,
} from "../helpers/released-v46-schema.ts";
import { V47_BASE_CHECKSUM, V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN } from "../helpers/released-v47-schema.ts";

afterAll(cleanupTempDirs);

/**
 * V45-A0, witnesses D3-a and D3-b: the *built* chain finds the v44 snapshot — and, since the v45, v46
 * and v47 freezes, the v45, v46 and v47 snapshots, which the released v45, v46 and v47 steps read in the
 * same way.
 *
 * `migrations.ts` resolves each schema file beside its own module, and the build input is
 * TypeScript only, so a schema file reaches `dist/db/` only if the `build` script copies it. A
 * source-level test cannot see a missing copy: the file is always beside the source. Deploys run
 * `pnpm build`, so its `build` script is what runs here, in a scratch copy of this working tree's build inputs —
 * never the checkout's own `dist/`, which can hold a copy an earlier build left behind.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// A cold build measured 262 s on a loaded host; the budget leaves room so load does not read as a failure.
const BUILD_BUDGET_MS = 600_000;
const NATIVE_EXTENSION = join(
  "native",
  "fd-vfs",
  "build",
  "Release",
  process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so",
);

/** Every schema file `migrations.ts` resolves beside itself, i.e. every file `schemaSqlAt` can return. */
const schemaFilesBesideMigrations = (): string[] =>
  [...readFileSync(join(ROOT, "src/db/migrations.ts"), "utf8")
    .matchAll(/new URL\("\.\/([\w.-]+\.sql)", import\.meta\.url\)/g)]
    .map((match) => match[1]!)
    .sort();

/**
 * What `pnpm build` reads, copied from the working tree, and built there. Returns the copy's root.
 *
 * It runs the copy's own `scripts.build` command line the way `pnpm run build` runs it — `sh -c`,
 * with the package's `node_modules/.bin` first on PATH — but not through pnpm. pnpm 11 checks
 * dependencies before a run by running `pnpm install` (`verify-deps-before-run`), and that install
 * refuses this copy's `node_modules`, a symlink resolving outside the copy
 * (ERR_PNPM_UNSAFE_MODULES_DIR); older pnpm does not, so going through pnpm makes this witness's
 * verdict depend on the host's pnpm. Reading the command line from `package.json` keeps it the
 * deploy's build: an edit to the script is an edit to what runs here.
 */
const scratchBuild = (): string => {
  const root = join(tempDir("acp-a0-build-"), "repo");
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json", NATIVE_EXTENSION]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  cpSync(join(ROOT, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: { build: string } };
  const built = boundedSpawnSync("sh", ["-c", scripts.build], {
    cwd: root,
    encoding: "utf8",
    timeout: BUILD_BUDGET_MS,
    env: {
      ...process.env,
      PATH: [join(root, "node_modules", ".bin"), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    },
  });
  if (built.status !== 0) {
    throw new Error(`the build script failed in the scratch copy (${built.status}):\n${built.stdout}\n${built.stderr}`);
  }
  return root;
};

/**
 * The compiled half, as a child: it imports only `dist/`, approves (unless told the parent did),
 * opens, and reports the schema at v44, at v45, at v46, at v47 and at the end. Rows rather than a
 * digest, so both sides digest with the same function.
 */
const CHILD = `
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
const [distRoot, dbPath, approval] = process.argv.slice(2);
const SQL = ${JSON.stringify(SCHEMA_ROWS_SQL)};
const rowsOf = () => {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return raw.prepare(SQL).all(); } finally { raw.close(); }
};
try {
  const { openDb } = await import(pathToFileURL(distRoot + "/db/database.js").href);
  const { approveMigration } = await import(pathToFileURL(distRoot + "/db/migration-approval.js").href);
  if (approval === "approve") approveMigration(dbPath, "V45-A0 compiled witness");
  const out = { atV44: null, atV45: null, atV46: null, atV47: null };
  openDb(dbPath, { afterMigration: (m) => {
    if (m.toVersion === 44) out.atV44 = rowsOf();
    if (m.toVersion === 45) out.atV45 = rowsOf();
    if (m.toVersion === 46) out.atV46 = rowsOf();
    if (m.toVersion === 47) out.atV47 = rowsOf();
  } }).close();
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    out.final = raw.prepare(SQL).all();
    out.receipts = raw.prepare("SELECT migration_id, checksum FROM schema_migrations ORDER BY version").all();
  } finally { raw.close(); }
  process.stdout.write(JSON.stringify(out));
} catch (error) {
  process.stderr.write(JSON.stringify({ message: error?.message, code: error?.code, evidence: error?.evidence }));
  process.exit(1);
}
`;

interface CompiledRun {
  atV44: SchemaRow[] | null;
  atV45: SchemaRow[] | null;
  atV46: SchemaRow[] | null;
  atV47: SchemaRow[] | null;
  final: SchemaRow[];
  receipts: Array<{ migration_id: string; checksum: string }>;
}

let build = "";
const runCompiled = (path: string, approval: "approve" | "approved-by-parent" | "fresh") =>
  boundedSpawnSync(process.execPath, [join(build, "compiled-chain.mjs"), join(build, "dist"), path, approval], {
    cwd: build,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const compiled = (path: string, approval: "approve" | "fresh"): CompiledRun => {
  const run = runCompiled(path, approval);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as CompiledRun;
};

/** The same fixture through this checkout's source, for the final-schema comparison. */
const sourceFinal = (path: string): string => {
  approveMigration(path, "V45-A0 source-level comparison");
  new Db(path).close();
  return digestOfSchemaRows(schemaRowsOf(path));
};

/** The v45 step's own receipt checksum, if the run wrote one. */
const v45Receipt = (run: CompiledRun): string | undefined =>
  run.receipts.find((row) => row.migration_id === "v45-first-manifest-activation")?.checksum;

/** The v46 step's own receipt checksum, if the run wrote one. */
const v46Receipt = (run: CompiledRun): string | undefined =>
  run.receipts.find((row) => row.migration_id === "v46-rowid-no-replace")?.checksum;

/** The v47 step's own receipt checksum, if the run wrote one. */
const v47Receipt = (run: CompiledRun): string | undefined =>
  run.receipts.find((row) => row.migration_id === "v47-owner-decision-authority-guard")?.checksum;

/** The released v46 image (`releasedChainImage`), never one taken back from a newer database. Not approved. */
const releasedV46Image = (prefix: string): string => releasedChainImage(privateStatePath(prefix), 46);

/** A v45 image of a database this checkout writes; see `toV45Image`. Not approved. */
const v45Image = (prefix: string): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  return toV45Image(path);
};

/** A v44 image of a database this checkout writes; see `toV44Image`. Not approved. */
const v44Image = (prefix: string): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  return toV44Image(path);
};

const releasedReceipts = (run: CompiledRun): Record<string, string> =>
  Object.fromEntries(
    run.receipts
      .filter((row) => row.migration_id in V38_TO_V44_BASE_CHECKSUMS)
      .map((row) => [row.migration_id, row.checksum]),
  );

describe("V45-A0: the built chain reads the v44 snapshot from dist", () => {
  beforeAll(() => {
    build = scratchBuild();
    writeFileSync(join(build, "compiled-chain.mjs"), CHILD);
  }, BUILD_BUDGET_MS + 60_000);

  it("D3-a: pnpm build puts every schema file schemaSqlAt can return into dist/db", () => {
    const wanted = schemaFilesBesideMigrations();
    expect(wanted).toEqual(expect.arrayContaining(["schema.sql", "schema-v37.sql", "schema-v44.sql", "schema-v45.sql", "schema-v46.sql", "schema-v47.sql"]));
    const built = readdirSync(join(build, "dist", "db"));
    for (const file of wanted) {
      expect(built, `dist/db/${file}`).toContain(file);
      expect(readFileSync(join(build, "dist", "db", file)).equals(readFileSync(join(ROOT, "src", "db", file)))).toBe(true);
    }
  });

  it("D3-b: a compiled upgrade of an approved v43 image matches the v44 build and the source upgrade", () => {
    const path = v43Image(privateStatePath("acp-a0-dist-v43-"));
    const twin = v43Image(privateStatePath("acp-a0-src-v43-"));
    const run = compiled(path, "approve");
    expect(run.atV44).not.toBeNull();
    expect(digestOfSchemaRows(run.atV44!)).toBe(V44_SCHEMA_DIGEST_FROM_V43);
    expect(digestOfSchemaRows(run.final)).toBe(sourceFinal(twin));
    expect(releasedReceipts(run)).toEqual({
      "v44-manifest-activation-grant": V38_TO_V44_BASE_CHECKSUMS["v44-manifest-activation-grant"],
    });
  });

  it("D3-b: a compiled upgrade from v11 runs every one of v38–v44 and matches the v44 build", () => {
    const path = v11Image(privateStatePath("acp-a0-dist-v11-"));
    const twin = v11Image(privateStatePath("acp-a0-src-v11-"));
    const run = compiled(path, "approve");
    expect(run.atV44).not.toBeNull();
    expect(digestOfSchemaRows(run.atV44!)).toBe(V44_SCHEMA_DIGEST_FROM_V11);
    expect(digestOfSchemaRows(run.final)).toBe(sourceFinal(twin));
    expect(releasedReceipts(run)).toEqual(V38_TO_V44_BASE_CHECKSUMS);
  });

  it("D3-b: a compiled fresh create matches the source fresh create", () => {
    const path = privateStatePath("acp-a0-dist-fresh-");
    const twin = privateStatePath("acp-a0-src-fresh-");
    new Db(twin).close();
    expect(digestOfSchemaRows(compiled(path, "fresh").final)).toBe(digestOfSchemaRows(schemaRowsOf(twin)));
  });

  it("v45 freeze: a compiled upgrade of an approved v44 image reaches the v45 build's schema, with v45's shipped receipt", () => {
    const path = v44Image("acp-v45f-dist-v44-");
    const twin = v44Image("acp-v45f-src-v44-");
    const run = compiled(path, "approve");
    expect(run.atV45).not.toBeNull();
    expect(digestOfSchemaRows(run.atV45!)).toBe(V45_SCHEMA_DIGEST_FROM_V44);
    expect(v45Receipt(run)).toBe(V45_BASE_CHECKSUM);
    expect(digestOfSchemaRows(run.final)).toBe(sourceFinal(twin));
  });

  it("v45 freeze: a compiled upgrade from v11 reaches the v45 build's schema at v45, with v45's shipped receipt", () => {
    const run = compiled(v11Image(privateStatePath("acp-v45f-dist-v11-")), "approve");
    expect(run.atV45).not.toBeNull();
    expect(digestOfSchemaRows(run.atV45!)).toBe(V45_SCHEMA_DIGEST_FROM_V11);
    expect(v45Receipt(run)).toBe(V45_BASE_CHECKSUM);
  });

  it("v46 freeze: a compiled upgrade of an approved v45 image reaches the v46 build's schema, with v46's shipped receipt", () => {
    const path = v45Image("acp-v46f-dist-v45-");
    const twin = v45Image("acp-v46f-src-v45-");
    const run = compiled(path, "approve");
    expect(run.atV46).not.toBeNull();
    expect(digestOfSchemaRows(run.atV46!)).toBe(V46_SCHEMA_DIGEST_FROM_V45);
    expect(v46Receipt(run)).toBe(V46_BASE_CHECKSUM);
    expect(digestOfSchemaRows(run.final)).toBe(sourceFinal(twin));
  });

  it("v46 freeze: a compiled upgrade from v11 reaches the v46 build's schema at v46, with v45's and v46's shipped receipts", () => {
    const run = compiled(v11Image(privateStatePath("acp-v46f-dist-v11-")), "approve");
    expect(run.atV46).not.toBeNull();
    expect(digestOfSchemaRows(run.atV46!)).toBe(V46_SCHEMA_DIGEST_FROM_V11);
    expect(v45Receipt(run)).toBe(V45_BASE_CHECKSUM);
    expect(v46Receipt(run)).toBe(V46_BASE_CHECKSUM);
  });

  it("v47 freeze: a compiled upgrade of the approved released v46 image reaches the v47 build's schema, with v47's shipped receipt", () => {
    const path = releasedV46Image("acp-v47f-dist-v46-");
    const twin = releasedV46Image("acp-v47f-src-v46-");
    const run = compiled(path, "approve");
    expect(run.atV47).not.toBeNull();
    expect(digestOfSchemaRows(run.atV47!)).toBe(V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    expect(v47Receipt(run)).toBe(V47_BASE_CHECKSUM);
    expect(digestOfSchemaRows(run.final)).toBe(sourceFinal(twin));
  });

  it("v47 freeze: a compiled upgrade from v11 reaches the v47 build's schema at v47, with v45's, v46's and v47's shipped receipts", () => {
    const run = compiled(v11Image(privateStatePath("acp-v47f-dist-v11-")), "approve");
    expect(run.atV47).not.toBeNull();
    expect(digestOfSchemaRows(run.atV47!)).toBe(V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    expect(v45Receipt(run)).toBe(V45_BASE_CHECKSUM);
    expect(v46Receipt(run)).toBe(V46_BASE_CHECKSUM);
    expect(v47Receipt(run)).toBe(V47_BASE_CHECKSUM);
  });

  // Fourth to last: it removes the v47 snapshot from this file's build. The v46, v45 and v44 REDs below
  // fail at v46, v45 and v44, before any step reads the v47 snapshot, so they are unaffected.
  it("v47 freeze RED: without dist/db/schema-v47.sql the chain fails on ENOENT and the v46 image is unchanged", () => {
    rmSync(join(build, "dist", "db", "schema-v47.sql"));
    expect(existsSync(join(build, "dist", "db", "schema-v47.sql"))).toBe(false);
    const path = releasedV46Image("acp-v47f-dist-missing-");
    approveMigration(path, "v47 freeze compiled witness, snapshot removed");
    const before = digestOfSchemaRows(schemaRowsOf(path));
    const run = runCompiled(path, "approved-by-parent");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ENOENT/);
    expect(run.stderr).toMatch(/schema-v47\.sql/);
    expect(userVersionOf(path)).toBe(46);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(before);
  });

  // Third to last: it removes the v46 snapshot from this file's build. The v45 and v44 REDs below fail
  // at v45 and v44, before any step reads the v46 snapshot, so they are unaffected.
  it("v46 freeze RED: without dist/db/schema-v46.sql the chain fails on ENOENT and the v45 image is unchanged", () => {
    rmSync(join(build, "dist", "db", "schema-v46.sql"));
    expect(existsSync(join(build, "dist", "db", "schema-v46.sql"))).toBe(false);
    const path = v45Image("acp-v46f-dist-missing-");
    approveMigration(path, "v46 freeze compiled witness, snapshot removed");
    const before = digestOfSchemaRows(schemaRowsOf(path));
    const run = runCompiled(path, "approved-by-parent");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ENOENT/);
    expect(run.stderr).toMatch(/schema-v46\.sql/);
    expect(userVersionOf(path)).toBe(45);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(before);
  });

  // Second to last: it removes the v45 snapshot from this file's build. The v44 RED below fails at
  // v44, before any step reads the v45 snapshot, so it is unaffected.
  it("v45 freeze RED: without dist/db/schema-v45.sql the chain fails on ENOENT and the v44 image is unchanged", () => {
    rmSync(join(build, "dist", "db", "schema-v45.sql"));
    expect(existsSync(join(build, "dist", "db", "schema-v45.sql"))).toBe(false);
    const path = v44Image("acp-v45f-dist-missing-");
    approveMigration(path, "v45 freeze compiled witness, snapshot removed");
    const before = digestOfSchemaRows(schemaRowsOf(path));
    const run = runCompiled(path, "approved-by-parent");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ENOENT/);
    expect(run.stderr).toMatch(/schema-v45\.sql/);
    expect(userVersionOf(path)).toBe(44);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(before);
  });

  // Last: it removes the snapshot from this file's build.
  it("D3-b RED: without dist/db/schema-v44.sql the chain fails on ENOENT and the v43 image is unchanged", () => {
    rmSync(join(build, "dist", "db", "schema-v44.sql"));
    expect(existsSync(join(build, "dist", "db", "schema-v44.sql"))).toBe(false);
    const path = v43Image(privateStatePath("acp-a0-dist-missing-"));
    approveMigration(path, "V45-A0 compiled witness, snapshot removed");
    const before = digestOfSchemaRows(schemaRowsOf(path));
    const run = runCompiled(path, "approved-by-parent");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ENOENT/);
    expect(run.stderr).toMatch(/schema-v44\.sql/);
    expect(userVersionOf(path)).toBe(43);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(before);
  });
});
