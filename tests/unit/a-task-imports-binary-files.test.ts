import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import * as taskImport from "../../src/run/task-import.ts";
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_TOTAL_BYTES } from "../../src/run/task-import.ts";
import { TaskWriteTargets } from "../../src/run/task-write-target.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, commitAll, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import {
  VALID_TTF,
  pngWithActivePixelBytes,
  pngWithIdatSuffix,
  pngWithOversizedPalette,
  pngWithPrivateAncillary,
  ttfWithCmapSubtableOutside,
  ttfWithBadFormat4Search,
  ttfWithActiveInstructions,
  ttfWithCompositeChain,
  ttfWithCompositeContoursMinusTwo,
  ttfWithCompositeCycle,
  ttfWithCompositeReservedFlag,
  ttfWithConflictingOffsetFlags,
  ttfWithFormat4RangeOutside,
  ttfWithHiddenHmtxPayload,
  ttfWithInstructionsPastMaxp,
  ttfWithNameStringOutside,
  ttfWithNonfinalInstructions,
  ttfWithMissingFormat4Glyph,
  ttfWithNonzeroGlyfPadding,
  ttfWithPointArgsOutside,
  ttfWithReservedSimpleFlag,
  ttfWithShortFormat4,
  ttfWithShortGlyphRecords,
  ttfWithSelfComposite,
  ttfWithUncoveredCmapPayload,
  ttfWithUnreferencedFormat4Glyph,
  ttfWithWrongSimpleBbox,
  validPng,
  validPngOfSize,
} from "../helpers/import-fixtures.ts";
import { FakeWorkerAdapter, recordSeededTarget, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1232 — a STANDARD_WORK worker writes only through apply_patch inside its checkout, so it cannot add
 * a font or an image, or reproduce a large generated file byte for byte. The supported path is a CTO
 * import manifest on the task's recorded write target: each entry names a path inside the target's
 * paths, its size and its sha256, and the bytes are staged in the task's ACP-owned staging directory
 * (`<import root>/<runId>/<taskId>/<sha256 hex>`). Before the worker is launched the control plane
 * reads every staged file, verifies each byte against the manifest, and only then writes them into
 * the claimed worktree through the Managed Write Guard; any mismatch, out-of-scope path, missing file,
 * symlink or traversal refuses the whole import and nothing is written. The imported files are
 * committed with the worker's change, and the success receipt binds the manifest.
 *
 * Literals stand for the new reason code, so a tree without the import path fails on behaviour.
 */

const DIGEST_MISMATCH = "IMPORT_DIGEST_MISMATCH";

const PNG = validPng();
const FONT = VALID_TTF;

interface ImportEntry { path: string; size: number; sha256: string }

const entry = (path: string, bytes: Buffer): ImportEntry => ({ path, size: bytes.length, sha256: sha256(bytes) });
const hexOf = (digest: string): string => digest.slice("sha256:".length);

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const fakeFor = (world: WorkerWorld): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  return adapter;
};

const makeRunner = (world: WorkerWorld, adapter: FakeWorkerAdapter, options: WorkerTurnOptions & { importRoot?: string } = {}): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix), ...options } as WorkerTurnOptions,
  );

const startTurn = (world: WorkerWorld, runner: WorkerTurnRunner) =>
  runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: world.cto.sessionId,
    ownerBindingGeneration: world.cto.generation,
  });

/** The task's ACP-owned staging directory, made the way the CTO makes it. */
const stagingDir = (root: string, world: WorkerWorld): string => {
  const dir = join(root, world.runId, world.taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** Stages bytes under the name the manifest gives them: their sha256. */
const stage = (root: string, world: WorkerWorld, digest: string, bytes: Buffer): void => {
  writeFileSync(join(stagingDir(root, world), hexOf(digest)), bytes);
};

/**
 * Records the task's write target again, now carrying `imports`, into its spec and the audit log, as
 * provisioning records the one a PLAN declares. The newest record is the task's.
 */
const declareImports = (world: WorkerWorld, imports: unknown): void => {
  const task = world.db.get<{ spec_json: string }>(`SELECT spec_json FROM tasks WHERE task_id = ?`, [world.taskId])!;
  const spec = JSON.parse(task.spec_json) as { writeTarget: Record<string, unknown> };
  const writeTarget = { ...spec.writeTarget, imports };
  world.db.run(`UPDATE tasks SET spec_json = ? WHERE task_id = ?`, [JSON.stringify({ ...spec, writeTarget }), world.taskId]);
  world.audit.record({ kind: "TASK_WRITE_TARGET_RECORDED", runId: world.runId, evidence: { taskId: world.taskId, writeTarget } });
};

const blobAt = (repo: string, spec: string): Buffer =>
  execFileSync("git", ["-C", repo, "cat-file", "blob", spec], { timeout: 30_000, maxBuffer: 2 * IMPORT_MAX_FILE_BYTES });
const status = (world: WorkerWorld): string => gitSync(world.repoPath, ["status", "--porcelain", "--untracked-files=all"]);

/** A refused import opens no execution, launches nothing and writes nothing. */
const expectNothingImported = (world: WorkerWorld, adapter: FakeWorkerAdapter, head: string): void => {
  expect(adapter.launches).toBe(0);
  expect(world.tasks.executions(world.runId)).toHaveLength(0);
  expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(head);
  expect(status(world)).toBe("");
};

describe("#1232 a task imports binary files through its write target", () => {
  it("W1 imports a PNG and a font before the worker runs, commits them byte for byte, and the receipt binds both sha256", async () => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets", "src"] });
    const root = tempDir("acp-imports-");
    const imports = [entry("assets/fonts/Inter.ttf", FONT), entry("assets/logo.png", PNG)];
    declareImports(world, imports);
    stage(root, world, imports[0]!.sha256, FONT);
    stage(root, world, imports[1]!.sha256, PNG);
    const adapter = fakeFor(world);
    const seenAtLaunch: boolean[] = [];
    adapter.script = {
      writes: { "src/app.js": "module.exports = () => 2;\n" },
      beforeSpawn: async () => {
        seenAtLaunch.push(existsSync(join(world.repoPath, "assets/logo.png")), existsSync(join(world.repoPath, "assets/fonts/Inter.ttf")));
      },
    };
    const runner = makeRunner(world, adapter, { importRoot: root });

    const started = await startTurn(world, runner);
    if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
    await runner.settled(started.value.executionId);

    const execution = world.tasks.execution(started.value.executionId)!;
    expect(execution.status).toBe("SUCCEEDED");
    // The worker found the files in its checkout when it started.
    expect(seenAtLaunch).toEqual([true, true]);
    // One commit holds the worker's change and both files, byte for byte.
    expect(blobAt(world.repoPath, "HEAD:assets/logo.png").equals(PNG)).toBe(true);
    expect(blobAt(world.repoPath, "HEAD:assets/fonts/Inter.ttf").equals(FONT)).toBe(true);
    expect(gitSync(world.repoPath, ["diff", "--name-only", "HEAD~1", "HEAD"]).split("\n")).toEqual([
      "assets/fonts/Inter.ttf", "assets/logo.png", "src/app.js",
    ]);
    expect(status(world)).toBe("");

    // The receipt binds the manifest: every imported file's path, size and sha256 is an input of its digest.
    const [succeeded] = world.audit.byKind(WorkerTurnEvent.SUCCEEDED);
    const evidence = succeeded!.evidence as Record<string, unknown>;
    expect(evidence["imports"]).toEqual(imports);
    const inputs = {
      executionId: String(evidence["executionId"]), workerSessionId: String(evidence["workerSessionId"]),
      sessionIncarnation: String(evidence["sessionIncarnation"]), providerSessionId: String(evidence["providerSessionId"]),
      exitCode: Number(evidence["exitCode"]), stdoutSha256: String(evidence["stdoutSha256"]),
      commitHead: String(evidence["commitHead"]), diffDigest: String(evidence["diffDigest"]),
    };
    expect(workerSuccessDigest({ ...inputs, imports } as Parameters<typeof workerSuccessDigest>[0])).toBe(execution.resultDigest);
    expect(workerSuccessDigest(inputs)).not.toBe(execution.resultDigest);
  }, 60_000);

  it("W1b a worker that changes an imported file fails its turn, and nothing is committed", async () => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets", "src"] });
    const root = tempDir("acp-imports-");
    const imports = [entry("assets/logo.png", PNG)];
    declareImports(world, imports);
    stage(root, world, imports[0]!.sha256, PNG);
    const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);
    adapter.script = { writes: { "assets/logo.png": "not the imported bytes\n", "src/app.js": "module.exports = () => 2;\n" } };
    const runner = makeRunner(world, adapter, { importRoot: root });

    const started = await startTurn(world, runner);
    if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
    await runner.settled(started.value.executionId);

    expect(world.tasks.execution(started.value.executionId)!.status).toBe("FAILED");
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(head);
    const [failed] = world.audit.byKind(WorkerTurnEvent.FAILED);
    expect(failed!.evidence).toMatchObject({ reason: "IMPORT_ALTERED", altered: ["assets/logo.png"] });
  }, 60_000);

  it("W1c the largest import set validation accepts, every file at its maximum size, is imported and committed", async () => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets", "src"] });
    const root = tempDir("acp-imports-");
    const count = Math.floor(IMPORT_MAX_TOTAL_BYTES / IMPORT_MAX_FILE_BYTES);
    const files = Array.from({ length: count }, (_, index) => ({ path: `assets/blob-${index}.png`, bytes: validPngOfSize(IMPORT_MAX_FILE_BYTES, index) }));
    const imports = files.map((file) => entry(file.path, file.bytes));
    declareImports(world, imports);
    for (const [index, file] of files.entries()) stage(root, world, imports[index]!.sha256, file.bytes);
    const adapter = fakeFor(world);
    const runner = makeRunner(world, adapter, { importRoot: root });

    const started = await startTurn(world, runner);
    if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
    await runner.settled(started.value.executionId);

    expect(world.tasks.execution(started.value.executionId)!.status).toBe("SUCCEEDED");
    for (const file of files) expect(sha256(blobAt(world.repoPath, `HEAD:${file.path}`))).toBe(sha256(file.bytes));
    expect((world.audit.byKind(WorkerTurnEvent.SUCCEEDED)[0]!.evidence as Record<string, unknown>)["imports"]).toEqual(imports);
  }, 300_000);

  it("W2 a sha256 mismatch refuses the whole import: nothing is written and no worker is launched", async () => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets"] });
    const root = tempDir("acp-imports-");
    const imports = [entry("assets/fonts/Inter.ttf", FONT), entry("assets/logo.png", PNG)];
    declareImports(world, imports);
    // The font is staged under its declared name with other bytes; the logo is staged correctly.
    const alteredFont = Buffer.from(FONT);
    alteredFont[alteredFont.length - 1] = alteredFont[alteredFont.length - 1]! ^ 0xff;
    stage(root, world, imports[0]!.sha256, alteredFont);
    stage(root, world, imports[1]!.sha256, PNG);
    const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);

    const refused = await startTurn(world, makeRunner(world, adapter, { importRoot: root }));

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(DIGEST_MISMATCH);
    expect(refused.evidence).toMatchObject({ mismatched: ["assets/fonts/Inter.ttf"] });
    expectNothingImported(world, adapter, head);
  }, 60_000);

  it("W2b a manifest entry with no staged file refuses the whole import", async () => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets"] });
    const root = tempDir("acp-imports-");
    const imports = [entry("assets/fonts/Inter.ttf", FONT), entry("assets/logo.png", PNG)];
    declareImports(world, imports);
    stage(root, world, imports[1]!.sha256, PNG);
    const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);

    const refused = await startTurn(world, makeRunner(world, adapter, { importRoot: root }));

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe("EVIDENCE_MISSING");
    expect(refused.evidence).toMatchObject({ missing: ["assets/fonts/Inter.ttf"] });
    expectNothingImported(world, adapter, head);
  }, 60_000);

  it("W3 a path outside the task's write-target paths is refused, at the turn and when the target is recorded", async () => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["src"] });
    const root = tempDir("acp-imports-");
    const imports = [entry("assets/logo.png", PNG), entry("src/font.ttf", FONT)];
    declareImports(world, imports);
    stage(root, world, imports[0]!.sha256, PNG);
    stage(root, world, imports[1]!.sha256, FONT);
    const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);

    const refused = await startTurn(world, makeRunner(world, adapter, { importRoot: root }));

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe("WRITE_TARGET_OUTSIDE_RUN_SCOPE");
    expect(refused.evidence).toMatchObject({ outOfScope: ["assets/logo.png"] });
    expectNothingImported(world, adapter, head);

    // A PLAN that declares it is refused before any target is recorded for its task.
    const submitted = world.tasks.submit(world.runId, [{
      key: "T2", title: "import a logo", category: "implementation",
      spec: { writeTarget: { paths: ["src"], imports: [entry("assets/logo.png", PNG)] } },
    }]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const taskId = submitted.value[0]!.taskId;
    const recorded = await new TaskWriteTargets({ db: world.db, clock: world.clock, audit: world.audit, scratchDir: (prefix) => tempDir(prefix) })
      .ensure(world.runId, taskId, () => allow(ReasonCode.OK, undefined));
    expect(recorded.allowed).toBe(false);
    expect(recorded.reasonCode).toBe("WRITE_TARGET_OUTSIDE_RUN_SCOPE");
  }, 60_000);

  it("W4 a traversal, a staged symlink, a symlinked staging directory and a symlink in the destination are each refused", async () => {
    const cases: Array<{ name: string; arrange: (world: WorkerWorld, root: string, outside: string) => void; reasonCode: string }> = [
      {
        name: "a '..' segment in the manifest path",
        arrange: (world, root) => {
          const imports = [entry("assets/../.git/hooks/pre-commit", PNG)];
          declareImports(world, imports);
          stage(root, world, imports[0]!.sha256, PNG);
        },
        reasonCode: "INVALID_ARGUMENT",
      },
      {
        name: "a staged file that is a symlink to the right bytes",
        arrange: (world, root) => {
          const imports = [entry("assets/logo.png", PNG)];
          declareImports(world, imports);
          const target = join(tempDir("acp-symlink-target-"), "logo.png");
          writeFileSync(target, PNG);
          symlinkSync(target, join(stagingDir(root, world), hexOf(imports[0]!.sha256)));
        },
        reasonCode: "STATE_PATH_INSECURE",
      },
      {
        name: "a task staging directory that is a symlink",
        arrange: (world, root) => {
          const imports = [entry("assets/logo.png", PNG)];
          declareImports(world, imports);
          const elsewhere = tempDir("acp-staged-elsewhere-");
          writeFileSync(join(elsewhere, hexOf(imports[0]!.sha256)), PNG);
          mkdirSync(join(root, world.runId), { recursive: true, mode: 0o700 });
          symlinkSync(elsewhere, join(root, world.runId, world.taskId));
        },
        reasonCode: "STATE_PATH_INSECURE",
      },
      {
        name: "a tracked symlink on the destination path",
        arrange: (world, root, outside) => {
          symlinkSync(outside, join(world.repoPath, "assets"));
          commitAll(world.repoPath, "a symlink where the import would land");
          recordSeededTarget(world);
          const imports = [entry("assets/logo.png", PNG)];
          declareImports(world, imports);
          stage(root, world, imports[0]!.sha256, PNG);
        },
        reasonCode: "WRITE_TARGET_OUTSIDE_RUN_SCOPE",
      },
    ];
    for (const testCase of cases) {
      const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets"] });
      const root = tempDir("acp-imports-");
      // Nothing may land outside the checkout: this directory stays empty whatever the case.
      const outside = tempDir("acp-outside-");
      testCase.arrange(world, root, outside);
      const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
      const adapter = fakeFor(world);

      const refused = await startTurn(world, makeRunner(world, adapter, { importRoot: root }));

      expect(refused.allowed, testCase.name).toBe(false);
      expect(refused.reasonCode, testCase.name).toBe(testCase.reasonCode);
      expectNothingImported(world, adapter, head);
      expect(existsSync(join(world.repoPath, ".git", "hooks", "pre-commit")), testCase.name).toBe(false);
      expect(readdirSync(outside), testCase.name).toEqual([]);
    }
  }, 120_000);
  /** Imports one file through a worker turn and expects the whole import refused before anything is written. */
  const expectRefusedImport = async (testCase: { name: string; path: string; bytes: Buffer }): Promise<void> => {
    const world = seedWorkerWorld(makeCore(), { ownedPaths: ["assets"] });
    const root = tempDir("acp-imports-");
    const imports = [entry(testCase.path, testCase.bytes)];
    declareImports(world, imports);
    stage(root, world, imports[0]!.sha256, testCase.bytes);
    const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);

    const refused = await startTurn(world, makeRunner(world, adapter, { importRoot: root }));

    expect(refused.allowed, testCase.name).toBe(false);
    expect(refused.reasonCode, testCase.name).toBe("IMPORT_CONTENT_REFUSED");
    expect(JSON.stringify(refused.evidence), testCase.name).toContain(testCase.path);
    expectNothingImported(world, adapter, head);
  };

  it("W8 top-level native/archive policy signatures and an unsupported source-path binary are refused", async () => {
    const tail = Buffer.concat([Buffer.alloc(64, 0x00), randomBytes(64)]);
    const cases: Array<{ name: string; path: string; bytes: Buffer }> = [
      { name: "an ELF executable", path: "assets/tool", bytes: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), tail]) },
      { name: "a Mach-O library", path: "assets/libhelper.dylib", bytes: Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]), tail]) },
      { name: "a zip archive", path: "assets/bundle.zip", bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]), tail]) },
      { name: "a WebAssembly module", path: "assets/module.bin", bytes: Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), tail]) },
      { name: "a gzip archive", path: "assets/data.gz", bytes: Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), tail]) },
      { name: "JavaScript with a NUL byte, which git reads as binary", path: "assets/hidden.js", bytes: Buffer.from("require('child_process').execSync('id'); // \0\n") },
    ];
    for (const testCase of cases) await expectRefusedImport(testCase);
  }, 120_000);

  it("W8a fails closed when executable bytes masquerade as an unknown or magic-only data file", () => {
    const nulJavaScript = Buffer.concat([
      Buffer.from("// binary"), Buffer.from([0]), Buffer.from(" comment\nprocess.stdout.write('EXECUTED')\n"),
    ]);
    const forgedBmp = Buffer.concat([
      Buffer.from("BM=0// binary"), Buffer.from([0]), Buffer.from(" comment\nprocess.stdout.write('EXECUTED')\n"),
    ]);
    const malformedPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const pngWithTrailingJavaScript = Buffer.concat([validPng(), Buffer.from("process.stdout.write('EXECUTED')\n")]);

    for (const [path, bytes] of [
      ["assets/payload", nulJavaScript],
      ["assets/payload.bmp", forgedBmp],
      ["assets/malformed.png", malformedPng],
      ["assets/trailing.png", pngWithTrailingJavaScript],
      ["assets/idat-trailing.png", pngWithIdatSuffix(Buffer.from("process.stdout.write('EXECUTED')\n"))],
      ["assets/oversized-palette.png", pngWithOversizedPalette()],
      ["assets/private-code.png", pngWithPrivateAncillary(Buffer.from("<?php echo 'EXECUTED'; ?>"))],
      ["assets/trailing.ttf", Buffer.concat([VALID_TTF, Buffer.from("process.stdout.write('EXECUTED')\n")])],
      ["assets/glyf-padding.ttf", ttfWithNonzeroGlyfPadding()],
      ["assets/short-glyphs.ttf", ttfWithShortGlyphRecords()],
      ["assets/hidden-hmtx.ttf", ttfWithHiddenHmtxPayload()],
      ["assets/cmap-outside.ttf", ttfWithCmapSubtableOutside()],
      ["assets/cmap-short-format4.ttf", ttfWithShortFormat4()],
      ["assets/cmap-search.ttf", ttfWithBadFormat4Search()],
      ["assets/cmap-range.ttf", ttfWithFormat4RangeOutside()],
      ["assets/cmap-uncovered.ttf", ttfWithUncoveredCmapPayload()],
      ["assets/cmap-unreferenced-glyph.ttf", ttfWithUnreferencedFormat4Glyph()],
      ["assets/cmap-missing-glyph.ttf", ttfWithMissingFormat4Glyph()],
      ["assets/composite-self-cycle.ttf", ttfWithSelfComposite()],
      ["assets/composite-two-cycle.ttf", ttfWithCompositeCycle()],
      ["assets/composite-too-deep.ttf", ttfWithCompositeChain(33)],
      ["assets/composite-minus-two.ttf", ttfWithCompositeContoursMinusTwo()],
      ["assets/composite-reserved.ttf", ttfWithCompositeReservedFlag()],
      ["assets/composite-offset-flags.ttf", ttfWithConflictingOffsetFlags()],
      ["assets/composite-nonfinal-instructions.ttf", ttfWithNonfinalInstructions()],
      ["assets/composite-point-args.ttf", ttfWithPointArgsOutside()],
      ["assets/simple-reserved.ttf", ttfWithReservedSimpleFlag()],
      ["assets/simple-bbox.ttf", ttfWithWrongSimpleBbox()],
      ["assets/instructions-past-maxp.ttf", ttfWithInstructionsPastMaxp()],
      ["assets/name-outside.ttf", ttfWithNameStringOutside()],
      ["assets/mismatched.ttf", validPng()],
      ["assets/mismatched.png", VALID_TTF],
    ] as const) {
      expect(taskImport.classifyImport(path, bytes), path).toMatchObject({ kind: "refused" });
    }
    expect(taskImport.classifyImport("assets/composite-depth-limit.ttf", ttfWithCompositeChain(32))).toMatchObject({
      kind: "data", type: "font (TrueType)",
    });
    expect(taskImport.classifyImport("assets/active-pixels.png", pngWithActivePixelBytes())).toMatchObject({ kind: "data", type: "PNG" });
    expect(taskImport.classifyImport("assets/active-instructions.ttf", ttfWithActiveInstructions())).toMatchObject({
      kind: "data", type: "font (TrueType)",
    });
  });

  it("W8b a text import past the text limit derived from the patch cap is refused", async () => {
    const limits = taskImport as unknown as Record<string, unknown>;
    expect(typeof limits["IMPORT_MAX_TEXT_BYTES"], "the text limit is exported").toBe("number");
    await expectRefusedImport({ name: "text one byte past the limit", path: "assets/table.json", bytes: Buffer.alloc((limits["IMPORT_MAX_TEXT_BYTES"] as number) + 1, 0x0a) });
  }, 120_000);
});
