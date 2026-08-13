import { afterAll, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { __testing, reviewerEnvironment } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

describe("CP-HI-04 reviewer isolation probes", () => {
  it("#360 actively proves the profile denies producer transcript reads", async () => {
    const packetRoot = tempDir("acp-review-probe-packet-");
    const transcript = join(tempDir("acp-review-probe-transcript-"), "cto-history.jsonl");
    const credentialScope = tempDir("acp-review-probe-provider-");
    writeFileSync(transcript, "private producer reasoning");
    const profile = __testing.reviewerProfile(
      packetRoot,
      [transcript],
      "/usr/bin/true",
      [credentialScope],
    );
    const result = await __testing.probeDeniedTranscriptPaths(
      profile,
      packetRoot,
      reviewerEnvironment(packetRoot, credentialScope),
      packetRoot,
      [transcript],
      5_000,
    );

    if (!seatbeltCanApply()) {
      expect(result.enforced).toBe(false);
      return;
    }
    expect(result).toEqual({ enforced: true });
    // Removing either the profile's file-read deny or the live probe turns this into a
    // false result instead of a static list assertion.
  });

  it("#360 actively proves a reviewer cannot execute a shell or write outside its packet", async () => {
    const packetRoot = tempDir("acp-review-probe-packet-");
    const credentialScope = tempDir("acp-review-probe-provider-");
    const profile = __testing.reviewerProfile(
      packetRoot,
      [],
      "/usr/bin/true",
      [credentialScope],
    );
    const result = await __testing.probeNoTools(
      profile,
      packetRoot,
      reviewerEnvironment(packetRoot, credentialScope),
      packetRoot,
      5_000,
    );

    if (!seatbeltCanApply()) {
      expect(result.enforced).toBe(false);
      return;
    }
    expect(result).toEqual({ enforced: true });
    // If `(deny process-exec*)`, `(deny file-write*)`, or either active probe disappears,
    // one of the attempted shell/write effects succeeds and this assertion fails.
  });

});
