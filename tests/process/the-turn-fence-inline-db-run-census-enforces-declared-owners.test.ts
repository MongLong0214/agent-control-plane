import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { cleanupTempDirsAsync, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirsAsync);

/**
 * #676: a writer census that tries to evaluate JavaScript has no stable edge. Six review rounds
 * found another spelling each time: SQL regex alternatives, comments, escapes, binary `+`, and
 * finally `Array.join`. This test drives the exact-symbol, inline-SQL `Db.run` boundary in a
 * throwaway source tree and makes the excluded forms observable without claiming their ownership.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-turn-fence-writer-census.mjs";
const CLAIM =
  "Every inline-SQL direct call whose TypeScript property symbol is exactly Db.run and that names a turn-fence table is in that table's declared application owner.";

/**
 * Follow the replace-census process test's clone-then-copy shape: the scratch repository owns
 * every input it runs. Most cases need only the census's TypeScript dependency; the three probes
 * that typecheck and execute get the complete installed dependency tree. Neither form leaves pnpm
 * looking at a modules directory whose resolved target is outside the scratch repository.
 */
interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const runChild = (command: string, args: string[], cwd: string): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });

const scratchRepo = async (
  dependencies: "typescript" | "all" = "typescript",
): Promise<string> => {
  const dir = join(tempDir("acp-writer-census-"), "repo");
  const cloned = await runChild(
    "git",
    ["clone", "--quiet", "--no-hardlinks", "--depth", "1", ROOT, dir],
    ROOT,
  );
  if (cloned.status !== 0) throw new Error(`scratch clone failed: ${cloned.stderr}`);
  await cp(join(ROOT, SCRIPT), join(dir, SCRIPT));
  await rm(join(dir, "src"), { recursive: true, force: true });
  await cp(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  if (dependencies === "all") {
    await cp(join(ROOT, "node_modules"), join(dir, "node_modules"), { recursive: true });
  } else {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await cp(
      realpathSync(join(ROOT, "node_modules/typescript")),
      join(dir, "node_modules/typescript"),
      { recursive: true },
    );
  }
  return dir;
};

const censusOn = (dir: string): Promise<ChildResult> => runChild("node", [SCRIPT], dir);

const esbuildBin = (repo: string): string =>
  createRequire(realpathSync(join(repo, "node_modules/tsx/package.json"))).resolve(
    "esbuild/bin/esbuild",
  );

const writeProbe = (repo: string, name: string, body: string, imports: string[] = []): void => {
  mkdirSync(join(repo, "src/probe"), { recursive: true });
  writeFileSync(
    join(repo, "src/probe", name),
    [
      'import type { Db } from "../db/database.ts";',
      ...imports,
      "",
      "export const rogueWrite = (db: Db, turnRequestId: string): void => {",
      `  ${body}`,
      "};",
      "",
    ].join("\n"),
  );
};

const replaceInFile = (path: string, search: string, replacement: string): void => {
  writeFileSync(path, readFileSync(path, "utf8").replace(search, replacement));
};

describe(CLAIM, () => {
  it("fails when an inline SQL exact Db run call names a governed table outside its owner", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "rogue-writer-676.ts",
      "db.run(`UPDATE canonical_turns SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [turnRequestId]);",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-writer-676.ts");
    expect(done.stdout).toContain("canonical_turns");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("counts string and no substitution template literal calls", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "rogue-string-literal.ts",
      'db.run("UPDATE canonical_turns SET lifecycle_state = \'IN_DOUBT\'");',
    );
    writeProbe(
      repo,
      "rogue-template-literal.ts",
      "db.run(`DELETE FROM canonical_turns WHERE 1 = 0`);",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-string-literal.ts");
    expect(done.stdout).toContain("src/probe/rogue-template-literal.ts");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("measures inline SQL syntax and semantic run key boundary forms", async () => {
    const repo = await scratchRepo("all");
    const inline = [
      {
        name: "parenthesized-inline-sql.ts",
        body: 'db.run(("DELETE FROM canonical_turns WHERE 1 = 0"));',
      },
      {
        name: "unicode-escaped-inline-sql.ts",
        body: String.raw`db.run("DELETE FROM canonical_t\u0075rns WHERE 1 = 0");`,
      },
    ];
    const outside = [
      {
        name: "as-const-sql.ts",
        body: 'db.run("DELETE FROM canonical_turns WHERE 1 = 0" as const);',
      },
      {
        name: "satisfies-sql.ts",
        body: 'db.run("DELETE FROM canonical_turns WHERE 1 = 0" satisfies string);',
      },
      {
        name: "const-identifier-sql.ts",
        body: 'const sql = "DELETE FROM canonical_turns WHERE 1 = 0"; db.run(sql);',
      },
      {
        name: "substitution-template-sql.ts",
        body: 'db.run(`DELETE FROM canonical_turns WHERE ${1} = 0`);',
      },
    ];
    const semanticKeys = [
      {
        name: "parenthesized-run-key.ts",
        body: 'db[("run")]("DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "as-const-run-key.ts",
        body: 'const captured = db["run" as const]; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "satisfies-run-key.ts",
        body: 'const captured = db["run" satisfies string]; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "template-run-key.ts",
        body: 'const captured = db[`run`]; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "unicode-escaped-run-key.ts",
        body: String.raw`const captured = db["r\u0075n"]; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");`,
      },
      {
        name: "unicode-escaped-run-identifier.ts",
        body: String.raw`const captured = db.r\u0075n; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");`,
      },
      {
        name: "const-identifier-run-key.ts",
        body: 'const key = "run"; const captured = db[key]; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "parenthesized-binding-key.ts",
        body: 'const { [("run")]: captured } = db; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "as-const-binding-key.ts",
        body: 'const { ["run" as const]: captured } = db; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "satisfies-binding-key.ts",
        body: 'const { ["run" satisfies string]: captured } = db; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "template-binding-key.ts",
        body: 'const { [`run`]: captured } = db; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "unicode-escaped-binding-key.ts",
        body: String.raw`const { ["r\u0075n"]: captured } = db; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");`,
      },
      {
        name: "const-identifier-binding-key.ts",
        body: 'const key = "run"; const { [key]: captured } = db; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "parenthesized-assignment-key.ts",
        body: 'let captured: Db["run"] | undefined; ({ [("run")]: captured } = db); captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
      {
        name: "const-identifier-assignment-key.ts",
        body: 'const key = "run"; let captured: Db["run"] | undefined; ({ [key]: captured } = db); captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      },
    ];
    for (const probe of [...inline, ...outside, ...semanticKeys]) {
      writeProbe(repo, probe.name, probe.body);
    }
    writeProbe(
      repo,
      "widened-run-keys.ts",
      [
        'const widened = "run" as keyof Db;',
        'const concatenated = ("r" + "un") as keyof Db;',
        'const substituted = `r${"un"}` as keyof Db;',
        'void db[widened];',
        'void db[concatenated];',
        'void db[substituted];',
        'const { [widened]: widenedBinding } = db;',
        'let widenedAssignment: Db[keyof Db] | undefined;',
        '({ [concatenated]: widenedAssignment } = db);',
        'void widenedBinding;',
        'void widenedAssignment;',
      ].join("\n  "),
    );

    const typed = await runChild(
      "node",
      ["node_modules/typescript/bin/tsc", "--noEmit"],
      repo,
    );
    const done = await censusOn(repo);

    expect(typed.status, typed.stdout + typed.stderr).toBe(0);
    for (const probe of inline) expect(done.stdout).toContain(`src/probe/${probe.name}`);
    for (const probe of outside) {
      expect(done.stdout).toContain(`src/probe/${probe.name}`);
      expect(done.stdout).toContain("governed-table ownership unmeasured");
    }
    for (const probe of semanticKeys) {
      expect(done.stdout).toContain(`src/probe/${probe.name}`);
    }
    expect(done.stdout).not.toContain("src/probe/widened-run-keys.ts");
    expect(done.stdout).toContain("escapes its direct call surface");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("reports Array join SQL outside the inline SQL boundary", async () => {
    const repo = await scratchRepo("all");
    writeProbe(
      repo,
      "rogue-array-join-676.ts",
      [
        "const sql = [",
        '  "INSERT",',
        '  " INTO canonical_turn_sources",',
        '  " (turn_request_id, source_channel, source_nonce, source_attempt, batch_ordinal,",',
        '  " source_digest, predecessor_turn_request_id, admission_audit_event_id)",',
        '  " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",',
        '].join("");',
        "db.run(sql, [turnRequestId, 'telegram', 'probe', 1, 0, 'digest', null, 1]);",
      ].join("\n  "),
    );
    writeFileSync(
      join(repo, "tests/execute-array-join-probe.ts"),
      [
        'import { Db } from "../src/db/database.ts";',
        'import { rogueWrite } from "../src/probe/rogue-array-join-676.ts";',
        "",
        'const db = new Db(":memory:");',
        "db.run(`INSERT INTO sessions",
        "  (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)",
        "  VALUES ('session:probe', 'inc-1', 'claude', 'opus', 'READY', 'now', 'now')`);",
        "db.run(`INSERT INTO conversational_actors",
        "  (actor_id, kind, current_session_id, current_session_incarnation, created_at)",
        "  VALUES ('actor:probe', 'CEO', 'session:probe', 'inc-1', 'now')`);",
        "db.run(`INSERT INTO actor_target_bindings",
        "  (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)",
        "  VALUES ('binding:probe', 'actor:probe', 'hermes', 'target:probe', 'digest:target', 'now')`);",
        "db.run(`INSERT INTO assignments",
        "  (assignment_id, role_key, role, actor_id, session_id, session_incarnation,",
        "   binding_generation, mode, status, created_at)",
        "  VALUES ('assignment:probe', 'CEO:probe', 'CEO', 'actor:probe', 'session:probe',",
        "          'inc-1', 1, 'PREFERRED', 'ACTIVE', 'now')`);",
        "db.run(`INSERT INTO actor_target_attestations",
        "  (target_attestation_id, target_binding_id, protocol_version, attestation_digest,",
        "   executor_session_id, executor_session_incarnation, binding_generation, assignment_id, attested_at)",
        "  VALUES ('attestation:probe', 'binding:probe', 'v1', 'digest:attestation',",
        "          'session:probe', 'inc-1', 1, 'assignment:probe', 'now')`);",
        "db.run(`INSERT INTO audit_events (at, kind, evidence_json) VALUES ('now', 'PROBE', '{}')`);",
        "db.run(`INSERT INTO canonical_turns",
        "  (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,",
        "   executor_session_id, executor_session_incarnation, binding_generation, prompt_digest,",
        "   claimed_at, claim_audit_event_id, lifecycle_state)",
        "  VALUES ('turn:probe', 'actor:probe', 'binding:probe', 'attestation:probe',",
        "          'session:probe', 'inc-1', 1, 'digest:prompt', 'now', 1, 'IN_DOUBT')`);",
        'rogueWrite(db, "turn:probe");',
        "const landed = db.all<{ n: number }>(",
        "  `SELECT COUNT(*) AS n FROM canonical_turn_sources WHERE turn_request_id = 'turn:probe'`,",
        ");",
        'if (landed[0]?.n !== 1) throw new Error("Array.join writer did not execute");',
        "db.close();",
        "",
      ].join("\n"),
    );

    // The counterexample typechecks and actually inserts through the real Db.run implementation.
    // The old shadow probe called a nonexistent Db.exec and could pass without either property.
    const typed = await runChild(join(repo, "node_modules/.bin/tsc"), ["--noEmit"], repo);
    const built = await runChild(
      esbuildBin(repo),
      [
        "tests/execute-array-join-probe.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=external",
        "--outfile=src/db/execute-array-join-probe.mjs",
      ],
      repo,
    );
    const executed = await runChild("node", ["src/db/execute-array-join-probe.mjs"], repo);
    const done = await censusOn(repo);

    expect(typed.status, typed.stdout + typed.stderr).toBe(0);
    expect(built.status, built.stdout + built.stderr).toBe(0);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(done.stdout).toContain("OUTSIDE INLINE-SQL BOUNDARY:");
    expect(done.stdout).toContain("src/probe/rogue-array-join-676.ts");
    expect(done.stdout).toContain("governed-table ownership unmeasured");
    expect(done.stdout).toContain("residual: 0 within boundary");
    expect(done.stdout).toContain("outside-boundary ownership: unmeasured");
    expect(done.status).toBe(0);
  });

  it("documents that a RunPort alias is outside the exact symbol boundary", async () => {
    const repo = await scratchRepo("all");
    writeProbe(
      repo,
      "rogue-run-port-676.ts",
      [
        'interface RunPort { run: Db["run"] }',
        "const port: RunPort = db;",
        "const result = port.run(`DELETE FROM canonical_turns WHERE 1 = 0`);",
        'if (result.changes !== 0) throw new Error("RunPort probe changed a row");',
      ].join("\n  "),
    );
    writeFileSync(
      join(repo, "tests/execute-run-port-probe.ts"),
      [
        'import { Db } from "../src/db/database.ts";',
        'import { rogueWrite } from "../src/probe/rogue-run-port-676.ts";',
        "",
        'const db = new Db(":memory:");',
        'rogueWrite(db, "turn:probe");',
        "db.close();",
        "",
      ].join("\n"),
    );

    const typed = await runChild(join(repo, "node_modules/.bin/tsc"), ["--noEmit"], repo);
    const built = await runChild(
      esbuildBin(repo),
      [
        "tests/execute-run-port-probe.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=external",
        "--outfile=src/db/execute-run-port-probe.mjs",
      ],
      repo,
    );
    const executed = await runChild("node", ["src/db/execute-run-port-probe.mjs"], repo);
    const done = await censusOn(repo);

    expect(typed.status, typed.stdout + typed.stderr).toBe(0);
    expect(built.status, built.stdout + built.stderr).toBe(0);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(done.stdout).not.toContain("src/probe/rogue-run-port-676.ts");
    expect(done.stdout).toContain("interface and other property aliases such as RunPort.run");
    expect(done.stdout).toContain("Interface and other property aliases cannot be counted by this check");
    expect(done.stdout).toContain("residual: 0 within boundary");
    expect(done.stdout).toContain("outside-boundary ownership: unmeasured");
    expect(done.status).toBe(0);
  });

  const nonInlineForms = [
    {
      label: "concat call",
      body: 'db.run("UPDATE ".concat("canonical_turns SET lifecycle_state = \'SETTLED\'"));',
    },
    {
      label: "String raw tag",
      body: "db.run(String.raw`UPDATE canonical_turns SET lifecycle_state = 'SETTLED'`);",
    },
    {
      label: "const identifier",
      body: "const sql = `UPDATE canonical_turns SET lifecycle_state = 'SETTLED'`; db.run(sql);",
    },
  ];

  for (const { label, body } of nonInlineForms) {
    it(`reports a ${label} outside the inline SQL boundary`, async () => {
      const repo = await scratchRepo();
      writeProbe(repo, `rogue-${label.replaceAll(" ", "-")}.ts`, body);

      const done = await censusOn(repo);

      expect(done.stdout).toContain("OUTSIDE INLINE-SQL BOUNDARY:");
      expect(done.stdout).toContain("governed-table ownership unmeasured");
      expect(done.stdout).toContain("RESULT: PASS");
      expect(done.status).toBe(0);
    });
  }

  it("reports imported SQL outside the inline SQL boundary", async () => {
    const repo = await scratchRepo();
    mkdirSync(join(repo, "src/probe"), { recursive: true });
    writeFileSync(
      join(repo, "src/probe/imported-sql.ts"),
      'export const sql = "INSERT INTO canonical_turn_sources (turn_request_id) VALUES (?)";\n',
    );
    writeProbe(
      repo,
      "rogue-imported-sql.ts",
      "db.run(sql, [turnRequestId]);",
      ['import { sql } from "./imported-sql.ts";'],
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-imported-sql.ts");
    expect(done.stdout).toContain("governed-table ownership unmeasured");
    expect(done.status).toBe(0);
  });

  it("fails when exact Db run is captured instead of called directly", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "rogue-run-alias.ts",
      "const run = db.run.bind(db); run(`UPDATE canonical_turns SET lifecycle_state = 'SETTLED'`);",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("escapes its direct call surface");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("refuses Db run captured through literal bracket access", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "rogue-run-bracket.ts",
      'const captured = db["run"]; captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-run-bracket.ts");
    expect(done.stdout).toContain("escapes its direct call surface");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("refuses Db run captured by object binding destructuring", async () => {
    const repo = await scratchRepo("all");
    writeProbe(
      repo,
      "rogue-run-destructure.ts",
      [
        "const { run } = db;",
        'const result = run.call(db, "UPDATE canonical_turns SET lifecycle_state = ?", ["IN_DOUBT"]);',
        'if (result.changes !== 0) throw new Error("destructured writer changed a row");',
      ].join("\n  "),
    );
    writeFileSync(
      join(repo, "tests/execute-run-destructure-probe.ts"),
      [
        'import { Db } from "../src/db/database.ts";',
        'import { rogueWrite } from "../src/probe/rogue-run-destructure.ts";',
        "",
        'const db = new Db(":memory:");',
        'rogueWrite(db, "turn:probe");',
        "db.close();",
        "",
      ].join("\n"),
    );

    const typed = await runChild(join(repo, "node_modules/.bin/tsc"), ["--noEmit"], repo);
    const built = await runChild(
      esbuildBin(repo),
      [
        "tests/execute-run-destructure-probe.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=external",
        "--outfile=src/db/execute-run-destructure-probe.mjs",
      ],
      repo,
    );
    const executed = await runChild("node", ["src/db/execute-run-destructure-probe.mjs"], repo);
    const done = await censusOn(repo);

    expect(typed.status, typed.stdout + typed.stderr).toBe(0);
    expect(built.status, built.stdout + built.stderr).toBe(0);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(done.stdout).toContain("escapes its direct call surface");
    expect(done.stdout).toContain("src/probe/rogue-run-destructure.ts");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("refuses Db run captured by object assignment destructuring", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "rogue-run-assignment.ts",
      [
        'let captured: Db["run"] | undefined;',
        "({ run: captured } = db);",
        'captured.call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
      ].join("\n  "),
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-run-assignment.ts");
    expect(done.stdout).toContain("escapes its direct call surface");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("leaves the stated excluded reference forms outside coverage", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "excluded-reference-forms.ts",
      [
        '(db as any).run("DELETE FROM canonical_turns WHERE 1 = 0");',
        'Reflect.get(db, "run").call(db, "DELETE FROM canonical_turns WHERE 1 = 0");',
        'const { ...rest } = db; void rest;',
        'const spread = { ...db }; void spread;',
        'db.get("SELECT * FROM canonical_turns WHERE 1 = 0");',
      ].join("\n  "),
    );
    writeFileSync(
      join(repo, "src/probe/generated-writer.js"),
      'export const generatedWrite = (db) => db.run("DELETE FROM canonical_turns WHERE 1 = 0");\n',
    );
    writeFileSync(
      join(repo, "tests/outside-src-writer.ts"),
      [
        'import type { Db } from "../src/db/database.ts";',
        'export const outsideSrcWrite = (db: Db) => db.run("DELETE FROM canonical_turns WHERE 1 = 0");',
        "",
      ].join("\n"),
    );

    const done = await censusOn(repo);

    expect(done.stdout).not.toContain("excluded-reference-forms.ts");
    expect(done.stdout).not.toContain("generated-writer.js");
    expect(done.stdout).not.toContain("outside-src-writer.ts");
    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.status).toBe(0);
  });

  it("fails when an inline exact Db run call names a table outside its declared application owner", async () => {
    const repo = await scratchRepo();
    writeProbe(
      repo,
      "rogue-attester-676.ts",
      'db.run(`INSERT INTO actor_target_attestations (target_attestation_id) VALUES (?)`, ["x"]);',
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("actor_target_attestations");
    expect(done.stdout).toContain("outside its declared application owner list (src/session/binding-registry.ts)");
    expect(done.status).toBe(1);
  });

  it("passes on the source tree as it stands", async () => {
    const done = await censusOn(await scratchRepo());

    expect(done.stdout).toContain(`CHECK: ${CLAIM}`);
    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.stdout).toContain("residual: 0");
    expect(done.status).toBe(0);
  });

  it("fails when a declared application owner no longer names its table", async () => {
    const repo = await scratchRepo();
    replaceInFile(
      join(repo, SCRIPT),
      'actor_target_bindings: ["src/session/binding-registry.ts"],',
      'actor_target_bindings: ["src/session/a-file-that-does-not-write-this-anymore.ts"],',
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("actor_target_bindings");
    expect(done.stdout).toContain("application-owner entry");
    expect(done.status).toBe(1);
  });

  it("fails when a schema trigger body writes a governed table directly", async () => {
    const repo = await scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      [
        "",
        "CREATE TRIGGER IF NOT EXISTS probe_676_rogue_cascade",
        "AFTER INSERT ON canonical_turn_dispatches",
        "BEGIN",
        "  INSERT INTO canonical_turn_sources (turn_request_id) VALUES (NEW.turn_request_id);",
        "END;",
        "",
      ].join("\n"),
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("src/db/schema.sql");
    expect(done.stdout).toContain("canonical_turn_sources");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("scans source and destination table names in schema renames", async () => {
    const repo = await scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      [
        "",
        "INSERT INTO canonical_turn_sources (turn_request_id) VALUES ('turn:probe');",
        "UPDATE canonical_turns SET lifecycle_state = 'IN_DOUBT';",
        "REPLACE INTO actor_target_attestations (target_attestation_id) VALUES ('attestation:probe');",
        "DELETE FROM canonical_turn_adjudications WHERE 1 = 0;",
        "ALTER TABLE canonical_turn_dispatches RENAME TO archived_turn_dispatches;",
        "ALTER TABLE archived_turn_observations RENAME TO canonical_turn_observations;",
        "",
      ].join("\n"),
    );

    const done = await censusOn(repo);

    for (const table of [
      "canonical_turn_sources",
      "canonical_turns",
      "actor_target_attestations",
      "canonical_turn_adjudications",
      "canonical_turn_dispatches",
      "canonical_turn_observations",
    ]) {
      expect(done.stdout).toContain(
        `${table}: src/db/schema.sql is outside its declared application owner list`,
      );
    }
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("does not fabricate a schema write from an SQL comment", async () => {
    const repo = await scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      "\n-- `UPDATE canonical_turns SET outcome_kind='ABORTED'` is only documentation.\n",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.status).toBe(0);
  });

  it("discovers a governed table declared with an SQL comment between CREATE and TABLE", async () => {
    const repo = await scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      "\nCREATE/**/TABLE IF NOT EXISTS canonical_turn_probe_676a (turn_request_id TEXT PRIMARY KEY);\n",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("canonical_turn_probe_676a");
    expect(done.stdout).toContain("no application-owner entry");
    expect(done.status).toBe(1);
  });

  it("discovers a governed table declared with a schema-qualified name", async () => {
    const repo = await scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      "\nCREATE TABLE main.canonical_turn_probe_676b (turn_request_id TEXT PRIMARY KEY);\n",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("canonical_turn_probe_676b");
    expect(done.stdout).toContain("no application-owner entry");
    expect(done.status).toBe(1);
  });

  it("fails when declared ownership names a table the schema no longer declares", async () => {
    const repo = await scratchRepo();
    replaceInFile(
      join(repo, "src/db/schema.sql"),
      "CREATE TABLE IF NOT EXISTS actor_target_attestations (",
      "CREATE TABLE IF NOT EXISTS zzz_676_removed_attestations (",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("actor_target_attestations");
    expect(done.stdout).toContain("schema no longer declares");
    expect(done.status).toBe(1);
  });

  it("fails when a named migration rebuild surface goes stale", async () => {
    const repo = await scratchRepo();
    replaceInFile(
      join(repo, "src/db/migrations.ts"),
      "export const rebuildCanonicalTurnsIfStale =",
      "export const oldRebuildCanonicalTurnsIfStale =",
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain("rebuildCanonicalTurnsIfStale is missing");
    expect(done.stdout).toContain("declared migration rebuild surface");
    expect(done.status).toBe(1);
  });

  it("reports named migration rebuild functions without evaluating their SQL", async () => {
    const repo = await scratchRepo();
    replaceInFile(
      join(repo, "src/db/migrations.ts"),
      "export const rebuildCanonicalTurnsIfStale = (raw: Database.Database): void => {",
      [
        "export const rebuildCanonicalTurnsIfStale = (raw: Database.Database): void => {",
        '  const unevaluatedProbeSql = "UPDATE canonical_turns SET lifecycle_state = ?";',
        "  void unevaluatedProbeSql;",
      ].join("\n"),
    );

    const done = await censusOn(repo);

    expect(done.stdout).toContain(
      "canonical_turns: src/db/migrations.ts#rebuildCanonicalTurnsIfStale",
    );
    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.status).toBe(0);
  });

  it("prints the exact boundary on every run", async () => {
    const done = await censusOn(await scratchRepo());

    expect(done.stdout).toContain("BOUNDARY:");
    expect(done.stdout).toContain("property symbol resolves exactly to Db.run");
    expect(done.stdout).toContain("after parentheses are removed");
    expect(done.stdout).toContain("string literal or no-substitution template literal");
    expect(done.stdout).toContain("element access plus object binding or assignment destructuring");
    expect(done.stdout).toContain('TypeScript gives the key expression the string-literal type "run"');
    expect(done.stdout).toContain("as const, satisfies, no-substitution templates, Unicode escapes");
    expect(done.stdout).toContain('keys TypeScript does not type as literal "run"');
    expect(done.stdout).toContain("keyof Db widening, concatenation, and substitution templates");
    expect(done.stdout).toContain("interface and other property aliases such as RunPort.run");
    expect(done.stdout).toContain("non-inline SQL expressions");
    expect(done.stdout).toContain("receiver casts to any, reflection, generated JavaScript");
    expect(done.stdout).toContain("other SQL APIs");
    expect(done.stdout).toContain("object rest or spread");
    expect(done.stdout).toContain("both table names in ALTER TABLE RENAME TO");
    expect(done.stdout).toContain("after SQL comments are blanked");
    expect(done.stdout).toContain("named migration rebuild functions are reported but their SQL is not evaluated");
    expect(done.stdout).toContain("outside src are not covered");
  });
});
