import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { minimalBootstrapManifest } from "../../src/bootstrap/bootstrap-plan.ts";
import {
  COMMITLORE_LIMITS,
  commitloreActivationGate,
  commitloreRequired,
  commitloreRunner,
  createCommitLoreCliPort,
  probeCommitLore,
} from "../../src/bootstrap/commitlore-observation.ts";
import * as pin from "../../src/bootstrap/commitlore-pin.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { latestRelease, stableReleaseAnswer } from "../helpers/commitlore-release.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * #1268 — the CommitLore an attempt runs is the newest published stable release of the official repository,
 * confirmed for that attempt, and a manifest that names no mode requires CommitLore.
 *
 * Each CLI here is a script run by this Node, pinned by its absolute path, answering the pin's checks and the
 * observation's two commands as a supported CLI does; the release lookup is injected, so no witness reaches
 * the network except where it says it stubs `fetch`.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(cleanupTempDirs);

const INIT = "init --mcp-scope none --no-unattended --no-agent-hooks";
const CHECKS = ["--version", "doctor --help", "init --help"];
const OBSERVATION = [...CHECKS, INIT, "doctor --json"];
const OK_REPORT = JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] });

/** A pinned CLI answering `version`; every invocation's argv is appended to its log. */
const cli = (name: string, version: string): { bin: string; log: string } => {
  const dir = tempDir(`acp-1268-${name}-`);
  const bin = join(dir, "commitlore");
  const log = join(dir, "argv.log");
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const argv = process.argv.slice(2).join(" ");
require("node:fs").appendFileSync(${JSON.stringify(log)}, argv + "\\n");
const answer = (text) => process.stdout.write(text, () => process.exit(0));
if (argv === "--version") answer(${JSON.stringify(`${version}\n`)});
else if (argv === "doctor --help") answer("Usage: commitlore doctor [options]\\n\\nOptions:\\n  --json  emit the report as JSON\\n");
else if (argv === "init --help") answer("Usage: commitlore init [options]\\n\\nOptions:\\n  --mcp-scope <scope>  where\\n  --no-unattended      off\\n  --no-agent-hooks     nothing in the tree\\n");
else if (argv === ${JSON.stringify(INIT)}) answer("");
else if (argv === "doctor --json") answer(${JSON.stringify(OK_REPORT)});
else process.stderr.write("unknown " + argv + "\\n", () => process.exit(2));
`,
    { mode: 0o700 },
  );
  // Executed once before any witness, so a cold first exec is no part of what is judged.
  execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 30_000 });
  writeFileSync(log, "");
  return { bin, log };
};
const ran = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);
const portAt = (bin: string, latest: pin.CommitLoreReleaseLookup) => createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, bin, latest));

describe("#1268: the pinned CLI must be the newest published stable CommitLore release, confirmed for each attempt", () => {
  it("a pin older than the newest release is refused NOT_LATEST at its checks, and neither init nor doctor runs", async () => {
    const stale = cli("stale", "1.7.4");
    const probed = await probeCommitLore(portAt(stale.bin, latestRelease("1.7.5", 416745372)));
    expect(probed).toMatchObject({
      allowed: false,
      evidence: {
        refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED",
        observation: { outcome: "FAIL", detail: expect.stringContaining("ACP_COMMITLORE_BINARY NOT_LATEST: ") },
      },
    });
    expect(JSON.stringify(probed)).toContain("is v1.7.5 (release 416745372)");
    expect(ran(stale.log)).toEqual(CHECKS);
  });

  it("a pin newer than the newest release is no published release, and is refused NOT_LATEST too", async () => {
    const ahead = cli("ahead", "1.7.6");
    await expect(commitloreRunner(COMMITLORE_LIMITS, ahead.bin, latestRelease("1.7.5")).ready(tempDir("acp-1268-ahead-"))).rejects.toThrow(
      /^ACP_COMMITLORE_BINARY NOT_LATEST: .* --version answered "1\.7\.6", and the newest published stable release of MongLong0214\/commitlore is v1\.7\.5/,
    );
  });

  it("a pin that is the newest release passes, and the observation runs as before", async () => {
    const current = cli("current", "1.7.5");
    const latest = latestRelease("1.7.5");
    expect(await probeCommitLore(portAt(current.bin, latest))).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
    expect(ran(current.log)).toEqual(OBSERVATION);
    expect(latest.calls()).toBe(1);
  });

  it.each([
    ["the lookup fails", async () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com"))],
    ["a draft", async () => ({ ...stableReleaseAnswer("1.7.5"), draft: true })],
    ["a prerelease", async () => ({ ...stableReleaseAnswer("1.7.5"), prerelease: true })],
    ["an unpublished release", async () => ({ ...stableReleaseAnswer("1.7.5"), published_at: null })],
    ["a tag without its v", async () => ({ ...stableReleaseAnswer("1.7.5"), tag_name: "1.7.5" })],
    ["a prerelease tag", async () => stableReleaseAnswer("1.7.5-rc.1")],
    ["no id", async () => ({ ...stableReleaseAnswer("1.7.5"), id: 0 })],
    ["a list instead of one release", async () => [stableReleaseAnswer("1.7.5")]],
    ["nothing", async () => null],
  ])("%s: RELEASE_UNCONFIRMED, though the pin is the release the answer names; neither init nor doctor runs", async (_name, lookup) => {
    const current = cli("unconfirmed", "1.7.5");
    const observed = await portAt(current.bin, lookup).observe(tempDir("acp-1268-unconfirmed-"));
    expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringContaining("ACP_COMMITLORE_BINARY RELEASE_UNCONFIRMED: ") });
    expect(ran(current.log)).toEqual(CHECKS);
  });

  it("a confirmation is never kept: the next attempt asks again, and a failed lookup there is not answered by the earlier success", async () => {
    const current = cli("not-kept", "1.7.5");
    let reachable = true;
    let calls = 0;
    const port = portAt(current.bin, async () => {
      calls += 1;
      if (!reachable) throw new Error("connect ETIMEDOUT");
      return stableReleaseAnswer("1.7.5");
    });
    const checkout = tempDir("acp-1268-not-kept-");
    expect(await port.observe(checkout)).toMatchObject({ outcome: "PASS" });
    reachable = false;
    expect(await port.observe(checkout)).toMatchObject({ outcome: "FAIL", detail: expect.stringContaining("RELEASE_UNCONFIRMED") });
    expect(calls).toBe(2);
    expect(ran(current.log)).toEqual([...OBSERVATION, ...CHECKS]);
  });

  it("a release published after an attempt's lookup does not fail that attempt; the next attempt's lookup sees it", async () => {
    const current = cli("published-after", "1.7.5");
    // The first lookup answers v1.7.5, and v1.7.6 is published the moment it has answered.
    let newest = "1.7.5";
    const port = portAt(current.bin, async () => {
      const answer = stableReleaseAnswer(newest);
      newest = "1.7.6";
      return answer;
    });
    const checkout = tempDir("acp-1268-published-after-");
    expect(await port.observe(checkout)).toMatchObject({ outcome: "PASS" });
    expect(await port.observe(checkout)).toMatchObject({ outcome: "FAIL", detail: expect.stringContaining("NOT_LATEST") });
    expect(ran(current.log)).toEqual([...OBSERVATION, ...CHECKS]);
  });
});

describe("#1268: the production lookup asks the official repository's releases/latest, bounded, and trusts nothing else", () => {
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("asks exactly the official repository, follows no redirect, and returns the answer it was given", async () => {
    const fetched: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetched.push({ url, init });
      return response(stableReleaseAnswer("1.7.5"));
    });
    expect(pin.confirmCommitLoreRelease(await pin.officialCommitLoreRelease())).toEqual({ id: 1, tag: "v1.7.5", version: [1n, 7n, 5n] });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toBe("https://api.github.com/repos/MongLong0214/commitlore/releases/latest");
    expect(fetched[0]?.init).toMatchObject({ redirect: "error" });
    expect(fetched[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("any answer but 200 rejects, so the attempt is refused rather than passed", async () => {
    for (const status of [304, 403, 404, 500]) {
      vi.stubGlobal("fetch", async () => new Response(null, { status }));
      await expect(pin.officialCommitLoreRelease(), String(status)).rejects.toThrow(`GitHub answered ${status}`);
    }
  });

  it("an answer larger than one release rejects", async () => {
    vi.stubGlobal("fetch", async () => response({ ...stableReleaseAnswer("1.7.5"), body: "x".repeat(1024 * 1024) }));
    await expect(pin.officialCommitLoreRelease()).rejects.toThrow("larger than one release");
  });
});

describe("#1268: a manifest that names no CommitLore mode requires CommitLore", () => {
  const unnamed = () => minimalBootstrapManifest({ projectId: "p-1268", repositoryIdentity: "github.com/example/p-1268" });

  it("the schema fills in required, and the activation gate then refuses a result with no passing CommitLore verification", () => {
    const manifest = projectManifestSchema.parse(unnamed());
    expect(manifest.commitlore).toEqual({ mode: "required" });
    expect(commitloreRequired(manifest.commitlore.mode)).toBe(true);
    const result = { bootstrapVerification: [] } as unknown as RepoFactoryResult;
    expect(commitloreActivationGate(manifest.commitlore.mode, result, [{ identity: "github.com/example/p-1268", head: "a".repeat(40) }])).toMatchObject({
      allowed: false,
      evidence: { refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", commitloreMode: "required" },
    });
  });

  it("control: a manifest that names its mode keeps it, so a stored manifest and its digest do not change", () => {
    for (const mode of ["required", "preferred", "off"] as const) {
      const named = { ...unnamed(), commitlore: { mode } };
      const parsed = projectManifestSchema.parse(named);
      expect(parsed.commitlore.mode).toBe(mode);
      // A stored manifest is the parsed object; parsing it again gives the same digest.
      expect(manifestDigest(projectManifestSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(manifestDigest(parsed));
    }
  });
});
