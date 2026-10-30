import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git, withoutRepositoryPrograms } from "../git/git.ts";
import { type GitHubClient, transportOutcome } from "./github-kernel.ts";

/**
 * #512 (v45) — the exact-commit reader: the sha256 of one workflow file's bytes at one exact commit
 * object of one exact repository, used by a first activation at PRE_MERGE and again at ACTIVATION.
 *
 * `workflowDigestAt` copies a supplied SHA into its revision and reads `git show <ref>:<path>`, which
 * accepts a tree, a tag or any ref, and its local commit checks dereference an annotated tag with
 * `^{commit}`. None of that is used here. Every step names the same repository identity and the same
 * 40-hex commit id: there is no `^{…}` suffix, no rev-parse, no ref or branch resolution, no tag is
 * dereferenced and no other object is substituted.
 *
 * Local: the repository's REGISTERED checkout in the project, every read with replacement objects
 * disabled and the repository's filter and hook programs off (`withoutRepositoryPrograms`, which
 * leads with `--no-replace-objects`): `cat-file -t <sha>` must print `commit`, `cat-file -t
 * <sha>:<path>` must print `blob`, and the bytes come from `cat-file blob <sha>:<path>`, so no
 * textconv or filter runs. A local object of any other type is refused, with no remote fallback; only
 * an absent object (a failed `cat-file -t`) falls through to the remote read.
 *
 * Remote: by object id only — `git/commits/{sha}` (which addresses commit objects only) must answer
 * with that same sha and the commit-only fields `tree.sha` and `parents`; the tree is walked one path
 * segment at a time with `git/trees/{sha}`, every intermediate entry a tree and the last a blob; the
 * bytes come from `git/blobs/{sha}`. The contents API, whose `?ref=` resolves names, is not used.
 *
 * After the exact read, whether the default branch head reaches the commit is recorded as evidence
 * only: it never refuses and the head never replaces the commit.
 */

export type ReachabilityEvidence = "REACHABLE" | "NOT_REACHABLE" | "UNKNOWN";

/** One exact read: what was read, where from, and how it hashes. */
export interface ExactWorkflowRead {
  repositoryIdentity: string;
  commitSha: string;
  objectType: "commit";
  blobSha: string;
  path: string;
  observedDigest: string;
  readVia: "LOCAL" | "GITHUB";
  /** Evidence only. */
  reachable: ReachabilityEvidence;
  defaultBranch: string;
  /** The default branch head the reachability evidence was taken against; never read from. */
  defaultBranchHead: string | null;
}

/** Why a read was refused, in `evidence.refusal`; the reason code is always MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED. */
export const ExactReadRefusal = {
  COMMIT_SHA_MALFORMED: "EXACT_READ_COMMIT_SHA_MALFORMED",
  PATH_MALFORMED: "EXACT_READ_PATH_MALFORMED",
  REPOSITORY_NOT_REGISTERED: "EXACT_READ_REPOSITORY_NOT_REGISTERED",
  NOT_A_GITHUB_REPOSITORY: "EXACT_READ_NOT_A_GITHUB_REPOSITORY",
  OBJECT_NOT_COMMIT: "EXACT_READ_OBJECT_NOT_COMMIT",
  PATH_NOT_BLOB: "EXACT_READ_PATH_NOT_BLOB",
  OBJECT_UNREADABLE: "EXACT_READ_OBJECT_UNREADABLE",
  SHA_MISMATCH: "EXACT_READ_SHA_MISMATCH",
} as const;

export interface ExactCommitReaderPorts {
  /** The repository registry's lookup by identity. */
  repositories: {
    byIdentity(identity: string): { checkoutPath: string; projectId: string | null; registration: string } | null;
  };
  /** The GitHub API client; only GET is ever sent. */
  client: GitHubClient;
}

export interface ExactCommitReadRequest {
  repositoryIdentity: string;
  /** The project the repository must be REGISTERED in. */
  projectId: string;
  commitSha: string;
  path: string;
  /** Named only for the reachability evidence. */
  defaultBranch: string;
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
/** A git object id as the API reports it: 40 (SHA-1) or 64 (SHA-256) lowercase hex. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const refused = (refusal: string, message: string, evidence: Record<string, unknown>): Decision<never> =>
  deny(ReasonCode.MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED, message, { refusal, ...evidence });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A repository-relative path of plain segments: no empty, `.` or `..` segment, no leading slash. */
const pathSegments = (path: string): string[] | null => {
  const segments = path.split("/");
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    ? segments
    : null;
};

type LocalOutcome =
  | { kind: "READ"; content: string; blobSha: string }
  | { kind: "ABSENT" }
  | { kind: "REFUSED"; decision: Decision<never> };

const readLocal = async (checkoutPath: string, request: ExactCommitReadRequest): Promise<LocalOutcome> => {
  const evidence = { repositoryIdentity: request.repositoryIdentity, commitSha: request.commitSha, path: request.path, readVia: "LOCAL" };
  const protectedRead = await withoutRepositoryPrograms(checkoutPath);
  const typeOf = await git(checkoutPath, [...protectedRead, "cat-file", "-t", request.commitSha], { allowFailure: true });
  // Only an absent object goes to GitHub; an object that is here is judged here.
  if (typeOf.exitCode !== 0) return { kind: "ABSENT" };
  const objectType = typeOf.stdout.trim();
  if (objectType !== "commit") {
    return {
      kind: "REFUSED",
      decision: refused(ExactReadRefusal.OBJECT_NOT_COMMIT, "the bound object is not a commit; it is not dereferenced or replaced", { ...evidence, objectType }),
    };
  }
  const entry = `${request.commitSha}:${request.path}`;
  const pathType = await git(checkoutPath, [...protectedRead, "cat-file", "-t", entry], { allowFailure: true });
  if (pathType.exitCode !== 0 || pathType.stdout.trim() !== "blob") {
    return {
      kind: "REFUSED",
      decision: refused(ExactReadRefusal.PATH_NOT_BLOB, "the workflow path is not a file at the bound commit", {
        ...evidence,
        pathType: pathType.exitCode === 0 ? pathType.stdout.trim() : null,
      }),
    };
  }
  // The blob's own id, as the commit's tree names it: `ls-tree` of the commit object, not of a ref.
  const listed = await git(checkoutPath, [...protectedRead, "ls-tree", "-z", "--full-tree", request.commitSha, "--", request.path], {
    allowFailure: true,
  });
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)\0?$/.exec(listed.stdout.replace(/\0$/, ""));
  if (listed.exitCode !== 0 || !match || match[2] !== "blob" || match[4] !== request.path || !OBJECT_ID.test(match[3]!)) {
    return {
      kind: "REFUSED",
      decision: refused(ExactReadRefusal.OBJECT_UNREADABLE, "the bound commit's tree does not name the workflow file's blob", evidence),
    };
  }
  const content = await git(checkoutPath, [...protectedRead, "cat-file", "blob", entry], { allowFailure: true });
  if (content.exitCode !== 0) {
    return {
      kind: "REFUSED",
      decision: refused(ExactReadRefusal.OBJECT_UNREADABLE, "the workflow file's bytes at the bound commit could not be read", evidence),
    };
  }
  return { kind: "READ", content: content.stdout, blobSha: match[3]! };
};

const readRemote = async (
  client: GitHubClient,
  owner: string,
  repo: string,
  request: ExactCommitReadRequest,
  segments: readonly string[],
): Promise<Decision<{ content: string; blobSha: string }>> => {
  const evidence = { repositoryIdentity: request.repositoryIdentity, commitSha: request.commitSha, path: request.path, readVia: "GITHUB" };
  const base = `/repos/${owner}/${repo}/git`;
  let commit: unknown;
  try {
    commit = await client.request<unknown>("GET", `${base}/commits/${request.commitSha}`);
  } catch (error) {
    return refused(ExactReadRefusal.OBJECT_UNREADABLE, "GitHub did not return the bound commit object", {
      ...evidence,
      error: error instanceof Error ? error.message : String(error),
      // #1189 B13 — whether GitHub answered (a permission error is permanent) or went unheard.
      ...transportOutcome(error),
    });
  }
  const tree = isRecord(commit) && isRecord(commit["tree"]) ? commit["tree"]["sha"] : undefined;
  if (!isRecord(commit) || typeof commit["sha"] !== "string" || typeof tree !== "string" || !Array.isArray(commit["parents"])) {
    return refused(ExactReadRefusal.OBJECT_NOT_COMMIT, "GitHub's answer for the bound id is not a commit object", evidence);
  }
  if (commit["sha"] !== request.commitSha) {
    return refused(ExactReadRefusal.SHA_MISMATCH, "GitHub answered with another object than the bound commit", {
      ...evidence,
      answeredSha: commit["sha"],
    });
  }
  let current = tree;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    let listing: unknown;
    try {
      listing = await client.request<unknown>("GET", `${base}/trees/${current}`);
    } catch (error) {
      return refused(ExactReadRefusal.OBJECT_UNREADABLE, "GitHub did not return a tree on the workflow's path", {
        ...evidence,
        tree: current,
        error: error instanceof Error ? error.message : String(error),
        ...transportOutcome(error),
      });
    }
    if (!isRecord(listing) || listing["sha"] !== current || !Array.isArray(listing["tree"])) {
      return refused(ExactReadRefusal.SHA_MISMATCH, "GitHub answered with another tree than the one the path names", { ...evidence, tree: current });
    }
    const entries = (listing["tree"] as unknown[]).filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry["path"] === segment);
    const wanted = last ? "blob" : "tree";
    if (entries.length !== 1 || entries[0]!["type"] !== wanted || typeof entries[0]!["sha"] !== "string" || !OBJECT_ID.test(entries[0]!["sha"] as string)) {
      return refused(ExactReadRefusal.PATH_NOT_BLOB, "the workflow path is not a file at the bound commit", {
        ...evidence,
        segment,
        found: entries.length === 1 ? (entries[0]!["type"] ?? null) : entries.length,
      });
    }
    current = entries[0]!["sha"] as string;
  }
  let blob: unknown;
  try {
    blob = await client.request<unknown>("GET", `${base}/blobs/${current}`);
  } catch (error) {
    return refused(ExactReadRefusal.OBJECT_UNREADABLE, "GitHub did not return the workflow file's blob", {
      ...evidence,
      blobSha: current,
      error: error instanceof Error ? error.message : String(error),
      ...transportOutcome(error),
    });
  }
  if (!isRecord(blob) || blob["sha"] !== current || blob["encoding"] !== "base64" || typeof blob["content"] !== "string") {
    return refused(ExactReadRefusal.SHA_MISMATCH, "GitHub answered with another blob than the one the tree names", { ...evidence, blobSha: current });
  }
  return allow(ReasonCode.OK, {
    content: Buffer.from((blob["content"] as string).replace(/\s/g, ""), "base64").toString("utf8"),
    blobSha: current,
  });
};

/** Evidence only: never refuses, never changes what was read. */
const reachability = async (
  client: GitHubClient,
  owner: string,
  repo: string,
  checkoutPath: string | null,
  request: ExactCommitReadRequest,
): Promise<{ reachable: ReachabilityEvidence; defaultBranchHead: string | null }> => {
  let head: string | null = null;
  try {
    const ref = await client.request<unknown>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(request.defaultBranch)}`,
    );
    const sha = isRecord(ref) && isRecord(ref["object"]) ? ref["object"]["sha"] : undefined;
    head = typeof sha === "string" && OBJECT_ID.test(sha) ? sha : null;
  } catch {
    head = null;
  }
  if (head === null) return { reachable: "UNKNOWN", defaultBranchHead: null };
  if (checkoutPath !== null) {
    try {
      const protectedRead = await withoutRepositoryPrograms(checkoutPath);
      const ancestor = await git(checkoutPath, [...protectedRead, "merge-base", "--is-ancestor", request.commitSha, head], { allowFailure: true });
      if (ancestor.exitCode === 0) return { reachable: "REACHABLE", defaultBranchHead: head };
      if (ancestor.exitCode === 1) return { reachable: "NOT_REACHABLE", defaultBranchHead: head };
    } catch {
      // Fall through to GitHub's answer.
    }
  }
  try {
    const compared = await client.request<unknown>("GET", `/repos/${owner}/${repo}/compare/${request.commitSha}...${head}`);
    const status = isRecord(compared) ? compared["status"] : undefined;
    if (status === "ahead" || status === "identical") return { reachable: "REACHABLE", defaultBranchHead: head };
    if (status === "behind" || status === "diverged") return { reachable: "NOT_REACHABLE", defaultBranchHead: head };
  } catch {
    // Unknown, which is what it is.
  }
  return { reachable: "UNKNOWN", defaultBranchHead: head };
};

export const workflowDigestAtCommit = async (
  ports: ExactCommitReaderPorts,
  request: ExactCommitReadRequest,
): Promise<Decision<ExactWorkflowRead>> => {
  const evidence = { repositoryIdentity: request.repositoryIdentity, commitSha: request.commitSha, path: request.path };
  if (!FULL_COMMIT_SHA.test(request.commitSha)) {
    return refused(ExactReadRefusal.COMMIT_SHA_MALFORMED, "a bound commit is a full object id: 40 lowercase hex", evidence);
  }
  const segments = pathSegments(request.path);
  if (segments === null) {
    return refused(ExactReadRefusal.PATH_MALFORMED, "a workflow path is repository-relative, of plain segments", evidence);
  }
  const repository = ports.repositories.byIdentity(request.repositoryIdentity);
  if (!repository || repository.registration !== "REGISTERED" || repository.projectId !== request.projectId) {
    return refused(ExactReadRefusal.REPOSITORY_NOT_REGISTERED, "the bound repository is not REGISTERED in the run's project", {
      ...evidence,
      projectId: request.projectId,
      registeredProjectId: repository?.projectId ?? null,
      registration: repository?.registration ?? null,
    });
  }
  const slug = parseGitHubIdentity(request.repositoryIdentity);
  if (!slug) {
    return refused(ExactReadRefusal.NOT_A_GITHUB_REPOSITORY, "the bound repository is not a GitHub repository identity", evidence);
  }

  const local = await readLocal(repository.checkoutPath, request);
  if (local.kind === "REFUSED") return local.decision;
  let read: { content: string; blobSha: string; readVia: "LOCAL" | "GITHUB" };
  if (local.kind === "READ") {
    read = { content: local.content, blobSha: local.blobSha, readVia: "LOCAL" };
  } else {
    const remote = await readRemote(ports.client, slug.owner, slug.repo, request, segments);
    if (!remote.allowed) return remote as Decision<never>;
    read = { ...remote.value, readVia: "GITHUB" };
  }
  const reached = await reachability(ports.client, slug.owner, slug.repo, local.kind === "READ" ? repository.checkoutPath : null, request);
  return allow(ReasonCode.OK, {
    repositoryIdentity: request.repositoryIdentity,
    commitSha: request.commitSha,
    objectType: "commit",
    blobSha: read.blobSha,
    path: request.path,
    // The digest definition is unchanged: sha256 of the read content.
    observedDigest: sha256(read.content),
    readVia: read.readVia,
    reachable: reached.reachable,
    defaultBranch: request.defaultBranch,
    defaultBranchHead: reached.defaultBranchHead,
  });
};
