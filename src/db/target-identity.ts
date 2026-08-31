import { realpathSync, statSync } from "node:fs";

/**
 * Which database a capability is about (#747).
 *
 * An approval is a capability over one specific file, and a capability that names no target is
 * spent by whatever arrives first. Measured: two v11 databases in one private directory, an
 * approval taken on A, a start opened on B — B was migrated using A's approval, and A's backup
 * became the recovery point for a file it was never an image of. The approved target, the
 * mutated target and the recovery target split three ways.
 *
 * The identity is the canonical path together with the device and inode, which is the same
 * identity `Db` already keys its once-per-database capabilities by, for the same reason stated
 * there: the identity of a file is its (device, inode), and the path is a way to reach it.
 *
 * Why this combination survives what legitimately happens to a live database, and nothing else:
 *
 *   - SQLite writes a database *in place*. Ordinary daemon operation, WAL checkpoints, and the
 *     migration's own DDL all leave the inode alone, so an approval taken while the daemon is
 *     stopped is still about the same file when the daemon starts.
 *   - `VACUUM INTO` writes a new file elsewhere and never touches the source, so taking the
 *     approval's recovery point does not invalidate the approval it is being taken for.
 *   - A restore installs a staged image and links it into place, which changes the inode. That
 *     is the one case where a prior approval must *not* survive, because the bytes it approved
 *     are gone and the recovery point it names is an image of a database that no longer exists.
 *     Canonical path alone would survive that replacement silently.
 *   - An inode number alone can be recycled after deletion. Requiring the path as well means a
 *     recycled inode must also land at the same canonical name on the same device.
 *
 * A content digest was considered and rejected. In WAL mode the main file's bytes are not stable
 * across an open/close cycle — a checkpoint moves committed frames into it — so a digest taken
 * at approval time and re-checked at open time would refuse legitimate approvals
 * non-deterministically. That is a fragile gate on the one operation this whole mechanism exists
 * to permit. What the digest would have proven — that the backup is an image of *this* target —
 * is instead proven by recording this identity in the backup's own manifest at the moment the
 * snapshot is taken (`src/db/backup.ts`), which is a claim made by the process that had both
 * files open rather than one reconstructed afterwards.
 */
export interface TargetIdentity {
  /** The canonical path, with symbolic links collapsed. */
  path: string;
  device: number;
  inode: number;
}

export const targetIdentityOf = (databasePath: string): TargetIdentity => {
  const path = realpathSync(databasePath);
  const stat = statSync(path);
  return { path, device: stat.dev, inode: stat.ino };
};

export const isSameTarget = (left: TargetIdentity, right: TargetIdentity): boolean =>
  left.path === right.path && left.device === right.device && left.inode === right.inode;

export const isTargetIdentity = (value: unknown): value is TargetIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TargetIdentity>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    Number.isInteger(candidate.device) &&
    Number.isInteger(candidate.inode)
  );
};
