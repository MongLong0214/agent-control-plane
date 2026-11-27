import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * The operator credential: `ACP_OPERATOR_TOKEN` when present (even blank), else the file named in `ACP_OPERATOR_TOKEN_FILE`.
 * Nothing is read implicitly — with neither set the token is absent and every request is refused as before — so a
 * same-user call that was refused does not start succeeding because a credential file happens to exist. A named file
 * is refused unless it is a non-empty regular file, not a symlink, that this uid owns and no group or other can read
 * or write. Shared by `agentctl` and `agentctl cto --apply`, so both accept exactly the same credential.
 */
export const readOperatorToken = (env: Readonly<Record<string, string | undefined>>): Decision<string | undefined> => {
  // Present wins even when blank: `ACP_OPERATOR_TOKEN="$(failed lookup)"` is an empty value, and falling through to a
  // file the environment still names would authenticate with a credential the caller did not pick. A blank token is
  // absent to the client, which refuses every request with OPERATOR_UNAUTHENTICATED; only an unset variable reaches here.
  const direct = env["ACP_OPERATOR_TOKEN"];
  if (direct !== undefined) return allow(ReasonCode.OK, direct.trim() || undefined);
  const path = env["ACP_OPERATOR_TOKEN_FILE"];
  if (!path) return allow(ReasonCode.OK, undefined);
  const refuse = (why: string): Decision<string | undefined> =>
    deny(ReasonCode.OPERATOR_UNAUTHENTICATED, `ACP_OPERATOR_TOKEN_FILE is refused: ${why}; nothing was sent`, { path });
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(code === "ELOOP" ? "it is a symbolic link" : `it could not be opened (${code ?? "error"})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return refuse("it is not a regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return refuse("it is owned by another user");
    if ((stat.mode & 0o077) !== 0) return refuse("it is readable or writable beyond its owner (want 0600)");
    const token = readFileSync(fd, "utf8").trim();
    return token ? allow(ReasonCode.OK, token) : refuse("it is empty");
  } finally {
    closeSync(fd);
  }
};
