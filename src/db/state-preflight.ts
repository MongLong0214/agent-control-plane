import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type StatePathKind = "directory" | "file";

export interface StatePathInspection {
  path: string;
  kind: StatePathKind;
  expectedMode: number;
  actualMode: number | null;
  ownerUid: number | null;
  currentUid: number | null;
  secure: boolean;
  reason: string | null;
}

const currentUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

const expectedModeFor = (kind: StatePathKind): number =>
  kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;

const modeBits = (stat: Stats): number => stat.mode & 0o777;

// macOS exposes these two stable system aliases. They are not deployment-controlled state
// aliases, and rejecting them would make a secure mkdtemp() root unusable. Every other
// symlink in a configured path is refused, including an existing child below /tmp or /var.
const APPROVED_SYSTEM_ALIASES: ReadonlyMap<string, string> = new Map([
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
]);

const unsafeSymlinkAncestor = (path: string): string | null => {
  const normalized = resolve(path);
  const parts = normalized.split("/").filter(Boolean);
  let cursor = "/";
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (!stat.isSymbolicLink()) continue;
    const approvedTarget = APPROVED_SYSTEM_ALIASES.get(cursor);
    if (approvedTarget && realpathSync(cursor) === approvedTarget) continue;
    return cursor;
  }
  return null;
};

/**
 * Do not silently chmod an existing state path. A permissive or symlinked path may
 * already have exposed state, and repairing it in place would make that compromise look
 * like a normal startup. Newly-created paths are the sole exception and are created with
 * an explicit private mode below.
 */
export const inspectPrivatePath = (path: string, kind: StatePathKind): StatePathInspection => {
  const expectedMode = expectedModeFor(kind);
  const uid = currentUid();
  try {
    if (!isAbsolute(path)) {
      return {
        path,
        kind,
        expectedMode,
        actualMode: null,
        ownerUid: null,
        currentUid: uid,
        secure: false,
        reason: "path is not absolute",
      };
    }
    const symlinkAncestor = unsafeSymlinkAncestor(path);
    if (symlinkAncestor) {
      return {
        path,
        kind,
        expectedMode,
        actualMode: null,
        ownerUid: null,
        currentUid: uid,
        secure: false,
        reason: `path traverses symbolic link ${symlinkAncestor}`,
      };
    }
    if (!existsSync(path)) {
      return {
        path,
        kind,
        expectedMode,
        actualMode: null,
        ownerUid: null,
        currentUid: uid,
        secure: false,
        reason: "path does not exist",
      };
    }

    const stat = lstatSync(path);
    const actualMode = modeBits(stat);
    if (stat.isSymbolicLink()) {
      return { path, kind, expectedMode, actualMode, ownerUid: stat.uid, currentUid: uid, secure: false, reason: "path is a symbolic link" };
    }
    if ((kind === "directory" && !stat.isDirectory()) || (kind === "file" && !stat.isFile())) {
      return { path, kind, expectedMode, actualMode, ownerUid: stat.uid, currentUid: uid, secure: false, reason: `path is not a regular ${kind}` };
    }
    if (actualMode !== expectedMode) {
      return {
        path,
        kind,
        expectedMode,
        actualMode,
        ownerUid: stat.uid,
        currentUid: uid,
        secure: false,
        reason: `mode is ${actualMode.toString(8)}, expected ${expectedMode.toString(8)}`,
      };
    }
    if (uid === null || stat.uid !== uid) {
      return {
        path,
        kind,
        expectedMode,
        actualMode,
        ownerUid: stat.uid,
        currentUid: uid,
        secure: false,
        reason: uid === null ? "current UID is unavailable" : "path is not owned by the current user",
      };
    }
    return { path, kind, expectedMode, actualMode, ownerUid: stat.uid, currentUid: uid, secure: true, reason: null };
  } catch (error) {
    return {
      path,
      kind,
      expectedMode,
      actualMode: null,
      ownerUid: null,
      currentUid: uid,
      secure: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const assertPrivatePath = (path: string, kind: StatePathKind): void => {
  const inspection = inspectPrivatePath(path, kind);
  if (inspection.secure) return;
  throw acpError(
    ReasonCode.STATE_PATH_INSECURE,
    `refusing insecure state ${kind}: ${inspection.reason ?? "unknown reason"}`,
    { ...inspection },
  );
};

/**
 * Creates each previously absent component privately. The nearest existing parent may be
 * a system directory such as /tmp, so only symlink traversal is rejected there; the
 * configured state root itself is always checked as exactly 0700.
 */
export const ensurePrivateDirectory = (path: string): void => {
  if (!isAbsolute(path)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "state directory must be absolute", { path });
  }
  const symlinkAncestor = unsafeSymlinkAncestor(path);
  if (symlinkAncestor) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "state directory traverses a symbolic link", {
      path,
      symlinkAncestor,
    });
  }
  if (existsSync(path)) {
    assertPrivatePath(path, "directory");
    return;
  }

  const missing: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    missing.unshift(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "state directory has no existing parent", { path });
    }
    ancestor = parent;
  }

  const ancestorStat = lstatSync(ancestor);
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "state directory parent is not a direct directory", {
      path,
      ancestor,
    });
  }

  for (const component of missing) {
    try {
      mkdirSync(component, { mode: PRIVATE_DIRECTORY_MODE });
      chmodSync(component, PRIVATE_DIRECTORY_MODE);
    } catch (error) {
      // A concurrent creator is safe only if it supplied the same owner-only directory.
      if (!existsSync(component)) throw error;
    }
    assertPrivatePath(component, "directory");
  }
  assertPrivatePath(path, "directory");
};

export const databaseSidecarPaths = (databasePath: string): string[] => [
  `${databasePath}-wal`,
  `${databasePath}-shm`,
  `${databasePath}-journal`,
];

/** Checks a database file and every currently-materialized SQLite sidecar before use. */
export const assertPrivateDatabaseFiles = (databasePath: string): void => {
  assertPrivatePath(databasePath, "file");
  for (const sidecar of databaseSidecarPaths(databasePath)) {
    if (existsSync(sidecar)) assertPrivatePath(sidecar, "file");
  }
};

/**
 * A new SQLite file is created by SQLite itself. Tighten its mode immediately, then run
 * the same no-symlink/owner/mode check used for an existing file. Existing files are never
 * repaired here; they must already satisfy the contract before being opened.
 */
export const finalizeNewPrivateDatabaseFiles = (databasePath: string, databaseExisted: boolean): void => {
  if (!databaseExisted && existsSync(databasePath)) {
    // Do not chmod through a just-swapped symlink before reporting it as an attack.
    assertPrivateFileShape(databasePath);
    chmodSync(databasePath, PRIVATE_FILE_MODE);
  }
  for (const sidecar of databaseSidecarPaths(databasePath)) {
    if (!existsSync(sidecar)) continue;
    assertPrivateFileShape(sidecar);
    chmodSync(sidecar, PRIVATE_FILE_MODE);
  }
  assertPrivateDatabaseFiles(databasePath);
};

export const inspectDatabaseStatePaths = (databasePath: string): StatePathInspection[] => {
  const paths: Array<[string, StatePathKind]> = [[dirname(databasePath), "directory"], [databasePath, "file"]];
  for (const sidecar of databaseSidecarPaths(databasePath)) {
    if (existsSync(sidecar)) paths.push([sidecar, "file"]);
  }
  return paths.map(([path, kind]) => inspectPrivatePath(path, kind));
};

const assertPrivateFileShape = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isFile() && !stat.isSymbolicLink()) return;
  throw acpError(ReasonCode.STATE_PATH_INSECURE, "database file is not a direct regular file", { path });
};
