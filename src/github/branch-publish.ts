import { NON_PORTABLE_PATTERNS } from "../contracts/manifest.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { BranchObjects, BranchPublishLimits } from "../git/branch-objects.ts";

/**
 * #512 S-PUSH (CEO f5879479) — the refusing public-safety scan over everything a branch publication sends,
 * completed before the first upload. The objects are read by `src/git/branch-objects.ts`; nothing here
 * spawns a process or sends a request.
 */


/** D5 — a publication never changes a workflow: the App holds no workflows permission, and none is added. */
export const workflowChanges = (paths: readonly string[]): string[] =>
  paths.filter((path) => {
    const lower = path.toLowerCase();
    return lower === ".github/workflows" || lower.startsWith(".github/workflows/");
  });

/** What the public-safety scan refuses, by name. A finding names its rule and its object, never the text. */
const SCAN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  ...NON_PORTABLE_PATTERNS.map(([pattern, name]) => [pattern, name] as const),
  [/\bclaude\.ai\/(?:code|chat|share)\b/i, "session url"],
  [/https?:\/\/[^\s\x22\x27<>]*\/sessions?\/[A-Za-z0-9_-]{8,}/i, "session url"],
  [/^[ \t]*(?:[A-Za-z][A-Za-z0-9]*-)*Session(?:-Id|-Url|-Link)?[ \t]*:/im, "session trailer"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, "private key"],
  [/~\/\.(?:hermes|agent-control-plane)(?![A-Za-z0-9_-])/, "home state path"],
  [/\$\{?HOME\}?\/\.(?:hermes|agent-control-plane)(?![A-Za-z0-9_-])/, "home state path"],
  [/(?:^|[^A-Za-z0-9._~-])\/(?:Users|home)\/[A-Za-z0-9._-]+\//m, "absolute home path"],
];

export const BRANCH_PUBLISH_SCANNER = "acp.branch-publish-scan.v1";

export interface PublicationScanInput {
  objects: BranchObjects;
  branch: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  /** Absolute paths that never leave the machine: the home directory, the ACP state root, registered checkouts. */
  forbiddenPaths: readonly string[];
  limits: BranchPublishLimits;
}

export interface PublicationScan {
  scanDigest: string;
  counts: { commits: number; trees: number; blobs: number; bytes: number };
}

/**
 * The refusing public-safety scan, over every object the publication sends and the pull request text that
 * follows it, completed before the first upload. A finding refuses the whole publication: redacting would
 * change the bytes and so the commit id. The digest names the scanner and every object it read, so a
 * receipt binds the exact set that was found clean.
 */
export const scanPublication = (input: PublicationScanInput): Decision<PublicationScan> => {
  const { objects } = input;
  for (const [label, text] of [["pull request title", input.pullRequestTitle], ["pull request body", input.pullRequestBody]] as const) {
    if (Buffer.byteLength(text, "utf8") > input.limits.maxTextBytes) {
      return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, `${label} is longer than a publication may send`, {
        object: label,
        limit: input.limits.maxTextBytes,
      });
    }
  }
  const literals = [...new Set(input.forbiddenPaths.map((path) => path.replace(/\/+$/, "")).filter((path) => path.length > 1))];
  const findings: Array<{ object: string; rule: string }> = [];
  let findingCount = 0;
  const scan = (object: string, text: string): void => {
    for (const [pattern, rule] of SCAN_RULES) {
      if (pattern.test(text)) {
        findingCount += 1;
        if (findings.length < 20) findings.push({ object, rule });
      }
    }
    for (const literal of literals) {
      if (text.includes(literal)) {
        findingCount += 1;
        if (findings.length < 20) findings.push({ object, rule: "local absolute path" });
      }
    }
  };
  scan("ref", `refs/heads/${input.branch}`);
  scan("pull request title", input.pullRequestTitle);
  scan("pull request body", input.pullRequestBody);
  for (const commit of objects.commits) scan(`commit:${commit.sha}`, commit.raw.toString("latin1"));
  for (const tree of objects.trees) {
    for (const entry of tree.entries) scan(`tree:${tree.sha}:entry`, entry.path);
  }
  let bytes = 0;
  for (const blob of objects.blobs) {
    bytes += blob.content.length;
    scan(`blob:${blob.sha}`, blob.content.toString("latin1"));
  }
  if (findingCount > 0) {
    return deny(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED, "the public-safety scan refused the publication; nothing was sent", {
      scanner: BRANCH_PUBLISH_SCANNER,
      findings,
      findingCount,
    });
  }
  return allow(ReasonCode.OK, {
    scanDigest: digestOf({
      scanner: BRANCH_PUBLISH_SCANNER,
      ref: `refs/heads/${input.branch}`,
      commits: objects.commits.map((commit) => commit.sha),
      trees: objects.trees.map((tree) => tree.sha),
      blobs: objects.blobs.map((blob) => blob.sha),
      pullRequestTitle: sha256(input.pullRequestTitle),
      pullRequestBody: sha256(input.pullRequestBody),
    }),
    counts: { commits: objects.commits.length, trees: objects.trees.length, blobs: objects.blobs.length, bytes },
  });
};
