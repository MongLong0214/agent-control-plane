import type { Socket } from "node:net";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

export const CTO_REFRESH_HOLD_METHOD = "ctoRefresh.hold";

/**
 * At most one `agentctl cto relaunch <project> --fresh --apply` per project, so a second concurrent run cannot exist. The hold
 * is the connection that asked for it: the daemon answers and keeps that socket open, and the hold ends when the socket closes,
 * ends or errors, which is the kernel's word that the holder is gone. It is in memory only: no file, no token, no stale lock to
 * take over, and a daemon restart releases every hold (the holder sees its connection close and stops before its next change).
 */
export const createCtoRefreshHolds = () => {
  const held = new Map<string, { socket: Socket; holderPid: number | null }>();
  return {
    /** `holderPid` is what the holder says of itself, for the refusal's message only; nothing is decided by it. */
    acquire: (projectId: string, socket: Socket, holderPid: number | null): Decision<{ projectId: string }> => {
      const current = held.get(projectId);
      if (current !== undefined && !current.socket.destroyed) {
        return deny(ReasonCode.CTO_REFRESH_IN_PROGRESS,
          `another cto relaunch --fresh holds project ${projectId}${current.holderPid === null ? "" : ` (pid ${current.holderPid})`}; nothing was changed`,
          { projectId, holderPid: current.holderPid });
      }
      held.set(projectId, { socket, holderPid });
      const release = (): void => { if (held.get(projectId)?.socket === socket) held.delete(projectId); };
      for (const event of ["close", "end", "error"] as const) socket.once(event, release);
      return allow(ReasonCode.OK, { projectId });
    },
  };
};
