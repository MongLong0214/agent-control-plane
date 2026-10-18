import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { runBoundedChild } from "../helpers/bounded-child.ts";
import { CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const NODE = process.execPath;
const WRITE_GUARD = new URL("../../src/bootstrap/bootstrap-write-guard.ts", import.meta.url).href;
/** Larger than any pipe or socket buffer, so a `gh` that does not read the body cannot have taken it. */
const LARGE = 1 << 20;

/**
 * A `gh` stand-in. Reads answer as GitHub would for an organization owner with no repository yet;
 * the create's POST does what `FAKE_GH_MODE` says. It never reaches a network, and the stand-in
 * daemon's PATH leaves the real `gh` out, so nothing here can write to GitHub.
 */
const FAKE_GH = String.raw`#!/bin/sh
method="$5"
path="$6"
if [ "$method" = GET ]; then
  case "$path" in
    users/*) printf '{"type":"Organization"}'; exit 0 ;;
    *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  esac
fi
repo() { printf '{"node_id":"R_kgDOfixture","full_name":"acme/fixture","visibility":"private","description":"%s","default_branch":"main"}' "$1"; }
case "$FAKE_GH_MODE" in
  exits-at-once) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4 ;;
  answers-without-reading) repo unread; exit 0 ;;
  closes-stdin-then-answers) exec 0<&-; sleep 0.3; repo unread; exit 0 ;;
  answers-while-a-holder-keeps-stdin) sleep 1 <&0 >/dev/null 2>&1 & echo $! > "$FAKE_GH_HOLDER"; repo unread; exit 0 ;;
  reads-all) n=$(wc -c | tr -d ' '); repo "$n"; exit 0 ;;
  reads-all-then-422) cat >/dev/null; echo "gh: Validation Failed (HTTP 422)" >&2; exit 1 ;;
  reads-all-then-killed) cat >/dev/null; kill -TERM $$ ;;
  reads-all-then-floods) cat >/dev/null; exec head -c 9437184 /dev/zero ;;
esac
echo "fake gh: unknown mode $FAKE_GH_MODE" >&2
exit 99
`;

/**
 * A process standing in for the daemon, on its path: `control-plane.ts` composes
 * `createBootstrapGitHubWritePort()` with no client, so every request goes through `GhCliGitHubClient`
 * and `spawnGh`. It installs no `uncaughtException` handler, exactly as `src` has none, so an `error`
 * event nobody hears ends it the way it would end the daemon. It makes one call, waits, and only then
 * reports: a process that died on the way reports nothing and exits non-zero.
 */
const STAND_IN = String.raw`
const [moduleUrl, path, mode, call, descriptionBytes] = process.argv.slice(2);
process.env.PATH = path;
process.env.FAKE_GH_MODE = mode;
process.env.FAKE_GH_HOLDER = process.argv[7];
const { createBootstrapGitHubWritePort, runUnderWriteGuard } = await import(moduleUrl);
const port = createBootstrapGitHubWritePort();
const target = { owner: "acme", name: "fixture" };
let result;
try {
  const value =
    call === "observe"
      ? await port.observeRepository(target)
      : await runUnderWriteGuard({ beforeRequest() {} }, () =>
          port.createRepository(target, "private", "x".repeat(Number(descriptionBytes))),
        );
  result = { settled: "resolved", value };
} catch (error) {
  result = {
    settled: "rejected",
    message: String(error?.message),
    reasonCode: error?.reasonCode ?? null,
    evidence: error?.evidence ?? null,
    code: error?.code ?? null,
  };
}
// Room for a late error from gh's stdin to arrive, were nothing listening for it.
await new Promise((resolve) => setTimeout(resolve, 250));
// Then it leaves. A gh that could not be started leaves the spawn's own 120 s kill timer armed (Node
// does not clear it on a failed spawn), which would hold the stand-in open past its budget.
process.stdout.write(JSON.stringify({ survived: true, ...result }), () => process.exit(0));
`;

interface Settled {
  readonly survived: true;
  readonly settled: "resolved" | "rejected";
  readonly value?: { readonly description?: string | null } | null;
  readonly message?: string;
  readonly reasonCode?: string | null;
  readonly evidence?: Record<string, unknown> | null;
  readonly code?: unknown;
}

const home = tempDir("acp-gh-stdin-");
const bin = join(home, "bin");
const noGh = join(home, "no-gh");
const standInPath = join(home, "stand-in.mjs");
const holderPidPath = join(home, "holder.pid");
writeFileSync(standInPath, STAND_IN);
for (const dir of [bin, noGh]) mkdirSync(dir);
writeFileSync(join(bin, "gh"), FAKE_GH);
chmodSync(join(bin, "gh"), 0o755);

/** One call in a fresh stand-in daemon; throws naming how the stand-in died, if it did. */
const standIn = async (
  mode: string,
  call: "create" | "observe",
  descriptionBytes = LARGE,
  path = `${bin}:/usr/bin:/bin`,
): Promise<Settled> => {
  const { status, stdout, stderr } = await runBoundedChild(
    NODE,
    ["--experimental-transform-types", "--no-warnings", standInPath, WRITE_GUARD, path, mode, call, String(descriptionBytes), holderPidPath],
    { budgetMs: CHILD_BUDGET_MS },
  );
  if (status !== 0 || stdout === "") {
    throw new Error(`the stand-in daemon did not survive the request: exit ${status}; stderr: ${stderr.slice(-1200)}`);
  }
  return JSON.parse(stdout) as Settled;
};

/** The create's body exactly as the port sends it, for counting what `gh` read. */
const createBodyBytes = (descriptionBytes: number): number =>
  Buffer.byteLength(
    JSON.stringify({ name: "fixture", description: "x".repeat(descriptionBytes), private: true, visibility: "private", auto_init: false }),
    "utf8",
  );

/** The result a create gets when its body did not reach gh: a refusal whose outcome is unknown. */
const outcomeUnknown = (settled: Settled): Record<string, unknown> => {
  expect(settled.survived).toBe(true);
  if (settled.settled !== "rejected") throw new Error(`a create gh never took the body of was answered: ${JSON.stringify(settled)}`);
  expect(settled.reasonCode).toBe(ReasonCode.INTERNAL_ERROR);
  expect(settled.evidence).not.toBeNull();
  // No HTTP status: GitHub's answer did not arrive through this request, so `transportOutcome`
  // reads it as unheard and the producer keeps the create's pending intent in doubt.
  expect(settled.evidence).toMatchObject({ status: null, requestOutcome: "unknown", stdinFinished: false });
  return settled.evidence!;
};

/**
 * FIX-STDIN-SIBLINGS: `spawnGh` handed a body to `gh` with `child.stdin.end(...)` and no `error`
 * listener on stdin. A `gh` that exits, or shuts its stdin, before reading the body closes the pipe
 * under the write, which fails with EPIPE; the unheard `error` event is an uncaught exception, and
 * the daemon reaches this through `control-plane.ts` → `createBootstrapGitHubWritePort`.
 */
describe("FIX-STDIN-SIBLINGS: a gh that does not take the body it is given", () => {
  it("leaves the daemon standing and answers outcome-unknown when gh exits before reading the create's body, every time", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const evidence = outcomeUnknown(await standIn("exits-at-once", "create"));
      expect(evidence).toMatchObject({ inputBytes: createBodyBytes(LARGE), exitCode: 4 });
      // EPIPE when the write fails first; none when gh's exit closes the stream first.
      expect(["EPIPE", null]).toContain(evidence["stdinError"]);
    }
  });

  it("does not report a repository gh answered for without reading the body", async () => {
    const evidence = outcomeUnknown(await standIn("answers-without-reading", "create"));
    expect(evidence).toMatchObject({ exitCode: 0 });
  });

  it("keeps the outcome unknown when gh shuts its stdin, stays alive and then answers 0: the request may have run", async () => {
    const evidence = outcomeUnknown(await standIn("closes-stdin-then-answers", "create"));
    expect(evidence).toMatchObject({ exitCode: 0, stdinError: "EPIPE" });
  });

  it("does not report a repository gh answered for while a process it left held its stdin unread, with no stdin error at all", async () => {
    const settled = await standIn("answers-while-a-holder-keeps-stdin", "create");
    // The holder is gh's own child and ends by itself within a second; nothing is left behind.
    const holder = Number(readFileSync(holderPidPath, "utf8").trim());
    const gone = async (): Promise<boolean> => {
      for (let waited = 0; waited < 5_000; waited += 50) {
        try {
          process.kill(holder, 0);
        } catch {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    expect(await gone()).toBe(true);
    const evidence = outcomeUnknown(settled);
    expect(evidence).toMatchObject({ exitCode: 0, stdinError: null });
  });
});

describe("FIX-STDIN-SIBLINGS controls: what gh did with a body it took is unchanged", () => {
  it("creates when gh reads the whole body, large or small, and gh read every byte of it", async () => {
    for (const bytes of [LARGE, 40]) {
      const settled = await standIn("reads-all", "create", bytes);
      expect(settled).toMatchObject({ survived: true, settled: "resolved" });
      expect(Number(settled.value?.description)).toBe(createBodyBytes(bytes));
    }
  });

  it("keeps an HTTP refusal after gh read the body as GitHub's answer, with its status", async () => {
    const settled = await standIn("reads-all-then-422", "create");
    expect(settled).toMatchObject({ survived: true, settled: "rejected", reasonCode: ReasonCode.INTERNAL_ERROR, evidence: { status: 422 } });
  });

  it("keeps a gh killed after reading the body as one that did not answer, as the time bound's kill is", async () => {
    const settled = await standIn("reads-all-then-killed", "create");
    expect(settled).toMatchObject({ survived: true, settled: "rejected", reasonCode: ReasonCode.INTERNAL_ERROR, evidence: { signal: "SIGTERM" } });
    expect(settled.message).toMatch(/did not answer/);
  });

  it("keeps a gh that floods its output as one this client does not read", async () => {
    const settled = await standIn("reads-all-then-floods", "create", 40);
    expect(settled).toMatchObject({ survived: true, settled: "rejected", reasonCode: ReasonCode.INTERNAL_ERROR });
    expect(settled.message).toMatch(/more output than this client reads/);
  });

  it("keeps a 404 read, which sends no body, as absent", async () => {
    expect(await standIn("reads-all", "observe")).toEqual({ survived: true, settled: "resolved", value: null });
  });

  it("keeps a gh that cannot be started as the spawn's own failure", async () => {
    const settled = await standIn("reads-all", "create", LARGE, noGh);
    expect(settled).toMatchObject({ survived: true, settled: "rejected", code: "ENOENT" });
  });
});
