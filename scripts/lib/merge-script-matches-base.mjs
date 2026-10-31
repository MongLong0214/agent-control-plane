/**
 * Refuses a merge-pr.mjs that differs from the current base of the pull request's own repository.
 *
 * A checkout still at an older `main` ran the squashing `merge-pr.mjs` after the change to merge
 * commits (#1269) had landed, and four pull requests went in by squash with nothing saying the copy
 * that ran was not the approved one. Copies older than this check do not carry it and are not
 * stopped by it. From this copy on, before any merge request: origin must be the pull request's base
 * repository, its base branch is fetched fresh, and the running script, every local module it
 * imports and every script it runs with `node`, found the same way, are compared byte for byte with
 * the same paths in the commit that fetch returned. A comparison that cannot be made is a refusal,
 * never a pass, and an older local ref is never consulted.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** A static or dynamic import of a relative specifier, resolved against the importing file. */
const LOCAL_IMPORT = /\b(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/gu;
/**
 * A `node` child whose first argument is a script path, resolved against the root: every child
 * merge-pr.mjs starts is given the root as its cwd. (Neither comment quotes an example: this file is
 * scanned with these patterns too.)
 */
const NODE_SCRIPT = /(?:["']node["']|process\.execPath)\s*,\s*\[\s*["']([^"']+\.[cm]?js)["']/gu;

/** The entry and everything it imports or runs with node, transitively, as paths relative to root. */
const localModules = (root, entry) => {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    const path = relative(root, file);
    if (seen.has(path)) continue;
    seen.add(path);
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      // Reported as unreadable by the comparison, which reads it again.
    }
    for (const [, specifier] of source.matchAll(LOCAL_IMPORT)) pending.push(resolve(dirname(file), specifier));
    for (const [, script] of source.matchAll(NODE_SCRIPT)) pending.push(resolve(root, script));
  }
  return [...seen].sort();
};

/** `owner/name` of a GitHub https, ssh:// or scp-style URL, lowercased; undefined if it is none of those. */
const repositoryOf = (url) =>
  /^(?:(?:https|ssh):\/\/(?:[^@/]+@)?[^/]+\/|(?:[^@/:]+@)?[^/:]+:)([^/]+\/[^/]+?)(?:\.git)?\/?$/u
    .exec(url)?.[1]?.toLowerCase();

const firstLine = (error) =>
  String(error?.stderr ?? error?.message ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "no output";

/**
 * Undefined when `entry` and what it loads are byte-identical to the current base of `pr` (the
 * `gh pr view` answer: `url`, `baseRefName`); otherwise the one-line reason to refuse.
 */
export const mergeScriptDiffersFromBase = (root, entry, pr) => {
  const base = typeof pr?.baseRefName === "string" && pr.baseRefName !== "" ? pr.baseRefName : undefined;
  const redo = `Run merge-pr.mjs from a checkout of current ${base ?? "<base>"}.`;
  // `gh pr view` has no base-repository field; the pull request's own URL names the repository it is in.
  const repository = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+$/u.exec(String(pr?.url ?? ""))?.[1];
  if (base === undefined || repository === undefined) {
    return `GitHub did not name the pull request's base repository and branch, so this copy of merge-pr.mjs cannot be compared with the current base. ${redo}`;
  }
  const git = (args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  let origin = "";
  try {
    origin = git(["remote", "get-url", "origin"]).toString().trim();
  } catch (error) {
    return `could not read origin's URL (${firstLine(error)}), so the current ${base} of ${repository} cannot be fetched to compare with. ${redo}`;
  }
  if (repositoryOf(origin) !== repository.toLowerCase()) {
    return `origin (${origin}) is not ${repository}, the pull request's base repository, so its ${base} is not the base to compare with. ${redo}`;
  }
  const remote = `refs/remotes/origin/${base}`;
  let fetched;
  try {
    git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:${remote}`]);
    fetched = git(["rev-parse", "--verify", `${remote}^{commit}`]).toString().trim();
  } catch (error) {
    return `could not fetch ${base} from origin (${firstLine(error)}), so this copy of merge-pr.mjs cannot be compared with the current base. ${redo}`;
  }
  const differing = [];
  for (const path of localModules(root, entry)) {
    let ours;
    try {
      ours = readFileSync(resolve(root, path));
    } catch {
      differing.push(`${path} (unreadable here)`);
      continue;
    }
    let theirs;
    try {
      theirs = git(["cat-file", "blob", `${fetched}:${path}`]);
    } catch {
      differing.push(`${path} (missing or unreadable at ${base})`);
      continue;
    }
    if (!ours.equals(theirs)) differing.push(path);
  }
  if (differing.length === 0) return undefined;
  return `this copy of merge-pr.mjs differs from the current ${base} of ${repository}; differing: ${differing.join(", ")}. ${redo}`;
};
