import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { hostScript, residentGitHost } from "../helpers/resident-git-host.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R2-01 — the fleet watcher's recovery entry (`resident-fleet-up.mjs`) relaunches a dead
 * resident CTO over its unfinished work and exits 0; the edits and HEAD are exactly as the CTO left them.
 */
const fleetUp = fileURLToPath(new URL("../../scripts/resident-fleet-up.mjs", import.meta.url));

describe("V52-R2-01 fleet recovery over unfinished work", () => {
  it("fleet-up restarts the allocated resident with unfinished work preserved", async () => {
    const h = await residentGitHost();
    await h.invoke("ensure-checkout");
    await h.invoke("ensure-resident");
    h.killResident();
    writeFileSync(join(h.clone, "test.js"), "unfinished tracked edits");
    writeFileSync(join(h.clone, "new.txt"), "unfinished new file");
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [fleetUp], { env: { ...h.env, ACP_HOST_PROJECT_PROVISIONER: hostScript }, timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
    });
    expect(JSON.parse(readFileSync(join(h.home, "fake.json"), "utf8")).launched).toBe(true);
    expect(readFileSync(join(h.state, "resident-test.sh"), "utf8")).toContain("--resume");
    expect(readFileSync(join(h.clone, "test.js"), "utf8")).toBe("unfinished tracked edits");
    expect(readFileSync(join(h.clone, "new.txt"), "utf8")).toBe("unfinished new file");
    expect(await h.head()).toBe(h.genesis);
  });
});
