import { dirname, join } from "node:path";

/**
 * The paths a resident project's allocation names, built from the state directory or the resident
 * home and the project's id. The one source for the allocator (bootstrap/resident-project-provisioning.ts)
 * and for the check that a stored allocation's path is the one it computes (core/credential-shapes.ts).
 * Locations only: nothing here reads or writes a file.
 */
export const residentSessionSocket = (stateDir: string, projectId: string): string =>
  join(stateDir, `cc-session-${projectId}.sock`);

/** The clone of the allocation's repository under the resident home: `projects/<name>` of `<owner>/<name>`. */
export const residentClonePath = (home: string, repositoryIdentity: string): string =>
  join(home, "projects", repositoryIdentity.split("/")[1]!);

/**
 * #1227 — the checkout a resident project's worker turns use: a separate local clone of the resident's
 * clone, with its own git dir, beside it under a directory ACP names, so never the resident's cwd and
 * never inside it; on the same filesystem, so git's local clone hardlinks the objects. Named by the
 * repository's registry id, so a project provisioned again under the same name never meets an old one.
 */
export const residentWorkerCheckoutPath = (clonePath: string, repositoryId: string): string =>
  join(dirname(clonePath), ".acp-worker-checkouts", repositoryId);

/** Where the resident's Buzz identity key file is: its location, never its contents. */
export const residentPrivateKeyFile = (home: string, projectId: string): string =>
  join(home, ".hermes", "bridge", "keys", `cto-${projectId}.priv`);

export const residentBootPacket = (home: string, projectId: string): string =>
  join(home, ".claude", "watchers", "fleet", `acp-${projectId}.boot.txt`);
