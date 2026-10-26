import { join } from "node:path";

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

/** Where the resident's Buzz identity key file is: its location, never its contents. */
export const residentPrivateKeyFile = (home: string, projectId: string): string =>
  join(home, ".hermes", "bridge", "keys", `cto-${projectId}.priv`);

export const residentBootPacket = (home: string, projectId: string): string =>
  join(home, ".claude", "watchers", "fleet", `acp-${projectId}.boot.txt`);
