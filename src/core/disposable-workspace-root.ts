import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * Placement facts for the one-shot disposable acceptance allocator.
 *
 * Neither value is taken from HOME, TMPDIR or cwd. `/tmp` is an OS path whose identity is resolved
 * before use, and the effective account record supplies both the live home boundary and the uid
 * that keeps different accounts out of one allocator. The caller must still establish ownership,
 * mode and separation from live ACP state before creating anything below the returned path.
 */
export const disposableWorkspaceLocation = (): {
  readonly accountHome: string;
  readonly workspaceRoot: string;
} => {
  const account = userInfo();
  const systemTemporaryRoot = realpathSync("/tmp");
  return {
    accountHome: account.homedir,
    workspaceRoot: join(
      systemTemporaryRoot,
      `.agent-control-plane-disposable-realms-${account.uid}`,
    ),
  };
};
