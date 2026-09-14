import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Control metadata stays outside CODEX_HOME, where the reviewer cannot replace it. */
export interface ReviewerCodexHome {
  readonly root: string;
  readonly dev: number;
  readonly ino: number;
  readonly capsuleDev: number;
  readonly capsuleIno: number;
}
const admitted = new WeakSet<ReviewerCodexHome>();
const fail = (): never => { throw new Error("invalid or already claimed private reviewer CODEX_HOME"); };
const namespace = (): string => join(homedir(), ".agent-control-plane", "reviewer-codex-homes");

const privateDirectory = (path: string) => {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) fail();
  return stat;
};

const validatePath = (root: string): void => {
  const capsule = dirname(root);
  if (resolve(root) !== root || basename(root) !== "home" || dirname(capsule) !== namespace() ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename(capsule))) fail();
  // No symlink ancestor can turn the private namespace into a shared credential store.
  for (let path = root; path !== dirname(path); path = dirname(path)) {
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) fail();
  }
  privateDirectory(dirname(namespace()));
  privateDirectory(namespace());
  privateDirectory(capsule);
  privateDirectory(root);
};

/** Fresh, empty root only: no credential discovery, import, copying, login, or cleanup. */
export const provisionReviewerCodexHome = (): string => {
  const parent = dirname(namespace());
  try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateDirectory(parent);
  try { mkdirSync(namespace(), { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateDirectory(namespace());
  const capsule = join(namespace(), randomUUID());
  mkdirSync(capsule, { mode: 0o700 });
  const root = join(capsule, "home");
  mkdirSync(root, { mode: 0o700 });
  validatePath(root);
  const stat = privateDirectory(root);
  const owner = privateDirectory(capsule);
  writeFileSync(join(capsule, "identity.json"), JSON.stringify({ root, dev: stat.dev, ino: stat.ino,
    capsuleDev: owner.dev, capsuleIno: owner.ino }), { flag: "wx", mode: 0o600 });
  return root;
};

/** Irrevocable per-session claim. Crash/failed bootstrap leaves a tombstone, never reuse. */
export const claimReviewerCodexHome = (root: string): ReviewerCodexHome => {
  try {
    validatePath(root);
    const receipt = join(dirname(root), "identity.json");
    const stat = lstatSync(receipt);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 || stat.size > 2048) fail();
    const identity = JSON.parse(readFileSync(receipt, "utf8")) as ReviewerCodexHome;
    if (Object.keys(identity).sort().join(",") !== "capsuleDev,capsuleIno,dev,ino,root" || identity.root !== root) fail();
    const home = privateDirectory(root);
    const capsule = privateDirectory(dirname(root));
    if (identity.dev !== home.dev || identity.ino !== home.ino ||
        identity.capsuleDev !== capsule.dev || identity.capsuleIno !== capsule.ino) fail();
    // Atomic across adapters/processes. No auto-release, even on failure or stopSession:
    // a lack of session bookkeeping is not proof that every native descendant has exited.
    mkdirSync(join(dirname(root), "claimed"), { mode: 0o700 });
    const binding = Object.freeze({ ...identity });
    admitted.add(binding);
    return binding;
  } catch { return fail(); }
};

export const assertReviewerCodexHome = (binding: ReviewerCodexHome): void => {
  try {
    if (!admitted.has(binding)) fail();
    validatePath(binding.root);
    const home = privateDirectory(binding.root);
    const capsule = privateDirectory(dirname(binding.root));
    privateDirectory(join(dirname(binding.root), "claimed"));
    if (binding.dev !== home.dev || binding.ino !== home.ino ||
        binding.capsuleDev !== capsule.dev || binding.capsuleIno !== capsule.ino) fail();
  } catch { fail(); }
};
