import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "../../src/git/git.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { commit, residentGitHost } from "../helpers/resident-git-host.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R2-01 — after a CTO dies, `ensure-resident` relaunches it over the project's own clone with
 * its unfinished work exactly as it was: tracked edits, new files, any branch or a detached HEAD. It
 * never resets, stashes, cleans or checks out, and it still refuses a clone that is not the project's
 * or whose history does not contain the approved genesis head. Exact-head and clean stay activation's
 * requirement (`ensure-checkout`, and `observe` until the CTO has been observed on the clone).
 * Real Git; only GitHub's identity lookup, Claude, tmux, ps and lsof are doubles.
 */
describe("V52-R2-01 recovery relaunches the resident over unfinished work", () => {
  it("restarts the allocated resident with unfinished work preserved", async () => {
    const h = await residentGitHost();
    await h.invoke("ensure-checkout");
    await h.invoke("ensure-resident");
    h.killResident();
    writeFileSync(join(h.clone, "test.js"), "unfinished tracked edits");
    writeFileSync(join(h.clone, "new.txt"), "unfinished new file");
    await expect(h.invoke("ensure-resident")).resolves.toMatchObject({ fleet: true, checkout: { head: h.genesis } });
    expect(readFileSync(join(h.clone, "test.js"), "utf8")).toBe("unfinished tracked edits");
    expect(readFileSync(join(h.clone, "new.txt"), "utf8")).toBe("unfinished new file");
    expect(await h.head()).toBe(h.genesis);
    expect((await git(h.clone, ["status", "--porcelain"])).stdout).toContain("new.txt");
    expect((await git(h.clone, ["stash", "list"])).stdout.trim()).toBe("");
  });

  it("restarts a resident whose CTO left a detached HEAD on its own later commit, with edits kept", async () => {
    const h = await residentGitHost();
    await h.invoke("ensure-checkout");
    await h.invoke("ensure-resident");
    const later = await commit(h.clone, "work.js", "later work");
    await git(h.clone, ["checkout", "-q", "--detach", later]);
    writeFileSync(join(h.clone, "work.js"), "bisecting");
    h.killResident();
    await expect(h.invoke("ensure-resident")).resolves.toMatchObject({ fleet: true, checkout: { head: later } });
    expect(readFileSync(join(h.clone, "work.js"), "utf8")).toBe("bisecting");
    expect((await git(h.clone, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true })).exitCode).toBe(1);
  });

  it("still refuses history that does not contain the approved genesis head, or a clone that is not the project's", async () => {
    const h = await residentGitHost();
    await h.invoke("ensure-checkout");
    await git(h.clone, ["checkout", "-q", "--detach", h.autoInit]);
    await expect(h.invoke("ensure-resident")).rejects.toThrow("does not build on the approved genesis head");
    await git(h.clone, ["checkout", "-q", "dev"]);
    await git(h.clone, ["remote", "set-url", "origin", "https://github.com/other/fixture.git"]);
    await expect(h.invoke("ensure-resident")).rejects.toThrow("clone origin conflict");
    expect(await h.head()).toBe(h.genesis);
  });

  it("keeps exact-head and clean where activation needs them, until the CTO has been observed on the clone", async () => {
    const h = await residentGitHost();
    await h.invoke("ensure-checkout");
    await h.invoke("ensure-resident");
    expect((await h.invoke("observe")).checkout?.head).toBe(h.genesis);
    const later = await commit(h.clone, "work.js", "later work");
    writeFileSync(join(h.clone, "draft.txt"), "unfinished");
    await expect(h.invoke("ensure-checkout")).rejects.toThrow("uncommitted changes");
    await expect(h.invoke("observe")).rejects.toThrow("uncommitted changes");
    // The activation pass after the handoff ACK: the clone is the CTO's workspace now.
    const handedOver = { ...h.a, checkoutRequirement: "development" as const };
    expect((await h.invoke("ensure-checkout", handedOver)).checkout?.head).toBe(later);
    expect((await h.invoke("observe", handedOver)).checkout?.head).toBe(later);
    expect(readFileSync(join(h.clone, "draft.txt"), "utf8")).toBe("unfinished");
  });
});
