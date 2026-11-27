import { type Decision, type Evidence, allow, deny, isAcpError } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  NOT_A_NAME, SHA, type PrEvidenceSource, isPermissionFailure, resolveRepository, statusOf,
} from "./pr-evidence.ts";

/**
 * `repository_blob_get` — the CEO's own read of one file's git blob id at one exact commit of a project's
 * registered repository, so two files can be compared by blob id when GitHub left a patch out of a PR.
 *
 * Same scope as `pr_evidence_get`: the repository is the registry's for the project, never a caller's URL,
 * path or remote identity, and GitHub is reached only through `GitHubReadClient`, which has no method that
 * writes. It reads by object id like the exact-commit workflow reader (`workflow-digest-at-commit.ts`): the
 * commit by `git/commits/{sha}`, which addresses commit objects only, then the tree one path segment at a
 * time by `git/trees/{sha}`, by object id instead of the contents API, whose `?ref=` resolves names. The blob id and size
 * are the tree entry's own; no bytes are fetched. It reads and reports; it marks nothing reviewed.
 */

export interface RepositoryBlobInput {
  projectId: string;
  repositoryRole?: string | undefined;
  commit: string;
  path: string;
}

export interface RepositoryBlob {
  schema: "acp.repository-blob.v1";
  projectId: string;
  repositoryIdentity: string;
  repositoryRole: string | null;
  commit: string;
  path: string;
  /** The git blob id the commit's tree names for the path. */
  blobSha: string;
  /** The blob's size in bytes as the tree entry reports it. */
  size: number | null;
  /** The tree entry's file mode, e.g. 100644; 120000 is a symlink. */
  mode: string | null;
}

/** A blob id as GitHub reports one: 40 (SHA-1) or 64 (SHA-256) lowercase hex. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATH_MAX_CHARS = 1024;
const SEGMENT_MAX_CHARS = 255;
const FORBIDDEN_IN_PATH = /[\\\u0000-\u001f\u007f]/;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A repository-relative path of plain segments: no empty, `.` or `..` segment, no leading slash, no URL. */
const segmentsOf = (path: string): string[] | null => {
  if (path.length === 0 || path.length > PATH_MAX_CHARS || FORBIDDEN_IN_PATH.test(path)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return null;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment.length <= SEGMENT_MAX_CHARS && segment !== "." && segment !== "..")
    ? segments
    : null;
};

const validate = (input: RepositoryBlobInput): Decision<string[]> => {
  if (NOT_A_NAME.test(input.projectId)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "projectId names a registered project; a URL, path or remote identity is refused", {});
  }
  if (input.repositoryRole !== undefined && NOT_A_NAME.test(input.repositoryRole)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "repositoryRole names a registered repository role; a URL, path or remote identity is refused", {});
  }
  if (!SHA.test(input.commit)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "commit is a full 40-hex commit SHA", {});
  }
  const segments = segmentsOf(input.path);
  if (segments === null) {
    return deny(ReasonCode.INVALID_ARGUMENT, "path is a repository-relative file path of plain segments; a URL, an absolute path or a . or .. segment is refused", {});
  }
  return allow(ReasonCode.OK, segments);
};

/** What a failed GET means for the caller, without echoing the error's own text. */
const failure = (error: unknown, what: string, evidence: Evidence): Decision<never> => {
  const status = statusOf(error);
  const withStatus: Evidence = { ...evidence, ...(status === undefined ? {} : { status }) };
  if (isPermissionFailure(error)) {
    return deny(ReasonCode.GITHUB_APP_PERMISSION_DENIED, `GitHub refused the App's read of ${what}`, withStatus);
  }
  if (isAcpError(error) && error.reasonCode === ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE) {
    return deny(ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE, "the trusted GitHub credential is not available", withStatus);
  }
  return deny(ReasonCode.PROBE_FAILED, `${what} could not be read from GitHub`, withStatus);
};

export const readRepositoryBlob = async (
  source: Pick<PrEvidenceSource, "projects" | "repositories" | "github">,
  input: RepositoryBlobInput,
): Promise<Decision<RepositoryBlob>> => {
  const valid = validate(input);
  if (!valid.allowed) return valid as Decision<RepositoryBlob>;
  const segments = valid.value;
  const repository = resolveRepository(source, input);
  if (!repository.allowed) return repository as Decision<RepositoryBlob>;
  const identity = repository.value.identity;
  const { owner, repo } = parseGitHubIdentity(identity)!;
  const base = `/repos/${owner}/${repo}/git`;
  const evidence: Evidence = { repositoryIdentity: identity, commit: input.commit, path: input.path };

  let commit: unknown;
  try {
    commit = await source.github.get<unknown>(`${base}/commits/${input.commit}`);
  } catch (error) {
    const status = statusOf(error);
    if (status === 404 || status === 422) {
      return deny(ReasonCode.NOT_FOUND, "the registered repository has no commit with that id", { ...evidence, status });
    }
    return failure(error, "the commit", evidence);
  }
  const rootTree = isRecord(commit) && isRecord(commit["tree"]) ? commit["tree"]["sha"] : undefined;
  if (!isRecord(commit) || commit["sha"] !== input.commit || typeof rootTree !== "string" || !OBJECT_ID.test(rootTree)
      || !Array.isArray(commit["parents"])) {
    return deny(ReasonCode.PROBE_FAILED, "GitHub's answer is not the commit asked for", evidence);
  }

  let current = rootTree;
  let entry: Json | null = null;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    let listing: unknown;
    try {
      listing = await source.github.get<unknown>(`${base}/trees/${current}`);
    } catch (error) {
      return failure(error, "a tree on the path", { ...evidence, tree: current });
    }
    if (!isRecord(listing) || listing["sha"] !== current || !Array.isArray(listing["tree"])) {
      return deny(ReasonCode.PROBE_FAILED, "GitHub's answer is not the tree the path names", { ...evidence, tree: current });
    }
    const found = (listing["tree"] as unknown[]).filter((item): item is Json => isRecord(item) && item["path"] === segment);
    // A listing GitHub cut short cannot say the path is missing; it is a gap, never an absence.
    if (found.length === 0 && listing["truncated"] === true) {
      return deny(ReasonCode.PROBE_FAILED, "GitHub cut this tree's listing short, so the path cannot be told absent", { ...evidence, tree: current });
    }
    if (found.length === 0) {
      return deny(ReasonCode.NOT_FOUND, "the commit has no such path", { ...evidence, segment });
    }
    const hit = found[0]!;
    const id = hit["sha"];
    if (found.length !== 1 || typeof id !== "string" || !OBJECT_ID.test(id)) {
      return deny(ReasonCode.PROBE_FAILED, "GitHub's tree does not name one object for the path", { ...evidence, segment });
    }
    if (hit["type"] !== (last ? "blob" : "tree")) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the path is not a file at the commit", {
        ...evidence, segment, foundType: typeof hit["type"] === "string" ? hit["type"] : null,
      });
    }
    current = id;
    entry = hit;
  }
  const size = entry !== null && typeof entry["size"] === "number" && Number.isInteger(entry["size"]) && entry["size"] >= 0
    ? entry["size"]
    : null;
  const mode = entry !== null && typeof entry["mode"] === "string" ? entry["mode"] : null;
  return allow(ReasonCode.OK, {
    schema: "acp.repository-blob.v1",
    projectId: input.projectId,
    repositoryIdentity: identity,
    repositoryRole: repository.value.repositoryRole ?? null,
    commit: input.commit,
    path: input.path,
    blobSha: current,
    size,
    mode,
  });
};
