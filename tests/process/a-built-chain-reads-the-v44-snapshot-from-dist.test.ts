import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
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

afterAll(cleanupTempDirs);

/**
 * V45-A0, witnesses D3-a and D3-b: the *built* chain finds the v44 snapshot.
 *
 * `migrations.ts` resolves each schema file beside its own module, and the build input is
 * TypeScript only, so a schema file reaches `dist/db/` only if the `build` script copies it. A
 * source-level test cannot see a missing copy: the file is always beside the source. Deploys run
 * `pnpm build`, so that is what runs here, in a scratch copy of this working tree's build inputs —
 * never the checkout's own `dist/`, which can hold a copy an earlier build left behind.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILD_BUDGET_MS = 300_000;
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

/** What `pnpm build` reads, copied from the working tree, and built there. Returns the copy's root. */
const scratchBuild = (): string => {
  const root = join(tempDir("acp-a0-build-"), "repo");
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json", "scripts/copy-native-fd-vfs-into-dist.mjs", NATIVE_EXTENSION]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  const built = boundedSpawnSync("pnpm", ["run", "build"], { cwd: root, encoding: "utf8", timeout: BUILD_BUDGET_MS });
  if (built.status !== 0) {
    throw new Error(`pnpm build failed in the scratch copy (${built.status}):\n${built.stdout}\n${built.stderr}`);
  }
  return root;
};

/**
 * The compiled half, as a child: it imports only `dist/`, approves (unless told the parent did),
 * opens, and reports the schema at v44 and at the end. Rows rather than a digest, so both sides
 * digest with the same function.
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
  const out = { atV44: null };
  openDb(dbPath, { afterMigration: (m) => { if (m.toVersion === 44) out.atV44 = rowsOf(); } }).close();
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
    expect(wanted).toEqual(expect.arrayContaining(["schema.sql", "schema-v37.sql", "schema-v44.sql"]));
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
