import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

/**
 * Everything the claim requires, short of claiming — so nothing has to restate it.
 *
 * A reader that wants to know whether this capsule is usable had one way to find out, and it was
 * to claim it. That is a one-way door: `claimReviewerCodexHome` writes a marker with no
 * auto-release, so asking the question consumed the answer. A second implementation of the
 * contract is the other way it goes wrong — a checker built from `existsSync` calls agrees with
 * the claim right up to the case it does not model (a capsule outside the private namespace, a
 * receipt with the wrong mode, a symlinked ancestor), and then reports healthy for a capsule the
 * claim refuses.
 *
 * `UNUSABLE_CAPSULE` is deliberately one state and not a taxonomy of shapes: the remedy for all of
 * them is the same — provision a fresh capsule — and naming the specific violation would describe
 * a path this function was handed, which is not something to write into a report.
 */
export type ReviewerCodexHomeState =
  | { readonly state: "READY"; readonly identity: ReviewerCodexHome }
  | { readonly state: "ALREADY_CLAIMED" }
  | { readonly state: "NO_IDENTITY_RECEIPT" }
  | { readonly state: "UNUSABLE_CAPSULE" };

export const inspectReviewerCodexHome = (root: string): ReviewerCodexHomeState => {
  let identity: ReviewerCodexHome;
  try {
    identity = verifiedIdentity(root);
  } catch {
    // Absence of the receipt is a different action from a capsule that cannot be used: one is a
    // login that has not happened, the other is a path that is not a capsule. Everything else,
    // including a receipt that exists and does not verify, is the second.
    let present = false;
    try { present = existsSync(join(dirname(root), "identity.json")); } catch { present = false; }
    return { state: present ? "UNUSABLE_CAPSULE" : "NO_IDENTITY_RECEIPT" };
  }
  // Advisory only. The claim is still the `mkdirSync` below and nothing else: a capsule claimed
  // between this read and that call fails there, which is where atomicity has to live.
  if (existsSync(join(dirname(root), "claimed"))) return { state: "ALREADY_CLAIMED" };
  return { state: "READY", identity };
};

/** The claim's preconditions, with no side effect. Throws through `fail`, as the claim did. */
const verifiedIdentity = (root: string): ReviewerCodexHome => {
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
  return identity;
};

/** Irrevocable per-session claim. Crash/failed bootstrap leaves a tombstone, never reuse. */
export const claimReviewerCodexHome = (root: string): ReviewerCodexHome => {
  try {
    const identity = verifiedIdentity(root);
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
