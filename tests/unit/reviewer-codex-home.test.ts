import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertReviewerCodexHome, claimReviewerCodexHome, provisionReviewerCodexHome } from "../../src/runtime/reviewer-codex-home.ts";

const homes: string[] = [];
const fresh = () => { const root = provisionReviewerCodexHome(); homes.push(root); return root; };
// No processes are spawned in this file; every capsule is owned solely by this test.
afterAll(() => { for (const root of homes) rmSync(dirname(root), { recursive: true, force: true }); });

describe("private reviewer Codex home admission", () => {
  it("provisions empty owner-only state without credentials and refuses any second claim", () => {
    const root = fresh();
    expect(readdirSync(root)).toEqual([]);
    expect(lstatSync(root).uid).toBe(process.getuid?.());
    expect(lstatSync(root).mode & 0o7777).toBe(0o700);
    const binding = claimReviewerCodexHome(root);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => assertReviewerCodexHome(binding)).not.toThrow();
    expect(() => claimReviewerCodexHome(root)).toThrow("claimed");
    expect(() => assertReviewerCodexHome({ ...binding })).toThrow("private");
    expect(existsSync(root)).toBe(true);
  });
  it("rejects global, owner, credential-parent, sibling capsule and path-normalization targets", () => {
    const root = fresh();
    for (const target of [homedir(), join(homedir(), ".codex"), dirname(root), dirname(dirname(root)),
      join(homedir(), ".config", "gh"), `${root}/../home`, `${root}/`]) {
      expect(() => claimReviewerCodexHome(target)).toThrow("private");
    }
    expect(existsSync(join(dirname(root), "claimed"))).toBe(false);
  });
  it("rejects mode drift before claim without repairing permissions", () => {
    const root = fresh();
    chmodSync(root, 0o750);
    expect(() => claimReviewerCodexHome(root)).toThrow("private");
    expect(lstatSync(root).mode & 0o777).toBe(0o750);
    expect(existsSync(join(dirname(root), "claimed"))).toBe(false);
  });
  it("rejects symlink or new-inode replacement before exec/resume", () => {
    const root = fresh();
    const binding = claimReviewerCodexHome(root);
    renameSync(root, `${root}-original`);
    symlinkSync(`${root}-original`, root);
    expect(() => assertReviewerCodexHome(binding)).toThrow("private");
    rmSync(root);
    mkdirSync(root, { mode: 0o700 });
    expect(() => assertReviewerCodexHome(binding)).toThrow("private");
  });
  it("rejects symlinked capsule even when its home still resolves to the original inode", () => {
    const root = fresh();
    const binding = claimReviewerCodexHome(root);
    const capsule = dirname(root);
    renameSync(capsule, `${capsule}-original`);
    try {
      symlinkSync(`${capsule}-original`, capsule);
      expect(() => assertReviewerCodexHome(binding)).toThrow("private");
    } finally {
      rmSync(capsule);
      renameSync(`${capsule}-original`, capsule);
    }
  });
});
