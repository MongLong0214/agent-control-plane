import { randomUUID } from "node:crypto";

export type Branded<T, B extends string> = T & { readonly __brand: B };

export type ProjectId = Branded<string, "ProjectId">;
export type RepositoryId = Branded<string, "RepositoryId">;
export type SessionId = Branded<string, "SessionId">;
export type RunId = Branded<string, "RunId">;
export type TaskId = Branded<string, "TaskId">;
export type ArtifactId = Branded<string, "ArtifactId">;
export type ClaimId = Branded<string, "ClaimId">;
export type MessageId = Branded<string, "MessageId">;
export type AssignmentId = Branded<string, "AssignmentId">;

const mint = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const newProjectId = (): ProjectId => mint("prj") as ProjectId;
export const newRepositoryId = (): RepositoryId => mint("repo") as RepositoryId;
export const newSessionId = (): SessionId => mint("ses") as SessionId;
export const newRunId = (): RunId => mint("run") as RunId;
export const newTaskId = (): TaskId => mint("task") as TaskId;
export const newArtifactId = (): ArtifactId => mint("art") as ArtifactId;
export const newClaimId = (): ClaimId => mint("clm") as ClaimId;
export const newMessageId = (): MessageId => mint("msg") as MessageId;
export const newAssignmentId = (): AssignmentId => mint("asg") as AssignmentId;

/**
 * Normalized remote identity (PRD §9.2). `github:owner/repo` for GitHub remotes,
 * `git:<host>/<path>` otherwise, `local:<abs-path-digest>` for remoteless checkouts.
 */
export const normalizeRemoteIdentity = (remoteUrl: string): string => {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (ssh) {
    const host = ssh[1]!;
    const path = ssh[2]!.replace(/^\/+/, "");
    return host === "github.com" ? `github:${path}` : `git:${host}/${path}`;
  }
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed);
  if (url) {
    const host = url[1]!.replace(/:\d+$/, "");
    const path = url[2]!.replace(/^\/+/, "");
    return host === "github.com" ? `github:${path}` : `git:${host}/${path}`;
  }
  return `git:${trimmed}`;
};

export const parseGitHubIdentity = (
  identity: string,
): { owner: string; repo: string } | null => {
  const m = /^github:([^/]+)\/([^/]+)$/.exec(identity);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
};
