/**
 * A wake that completes late writes nothing about a registration it did not belong to.
 *
 * The port remembers one thing about a delivery: that the endpoint refused it
 * (`LivePeer.wakeFailure`), which is the one unwakeable state no check made before connecting can
 * see. Both reviewers found the same hole in how that memory was scoped. It was keyed on the
 * endpoint string, and a completion wrote it whenever it arrived:
 *
 *   - a success completing after the holder had registered again **cleared** the newer
 *     registration's own refusal, so a holder nothing can wake was reported wakeable;
 *   - a failure completing after a successful re-registration of the **same pathname** wrote a
 *     refusal into it, because two registrations of one path compare equal as strings.
 *
 * Both are reproduced below, in both completion orders, with the two controls that say this is not
 * a rule that ignores every completion: a failure and a success under the registration in force
 * are still remembered and still forgotten.
 *
 * The boundary is controlled rather than raced. `connect` is the seam -- the only thing here that
 * is not the real port -- so a delivery completes exactly when a row says it does; everything the
 * registration path validates is real, including the socket file on disk, its parent's mode and
 * the uid that owns both.
 */
import { chmodSync } from "node:fs";
import type * as NodeNet from "node:net";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, type RoleBinding } from "../../src/domain/types.ts";
import { RoleConversationPort, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Every wake the port has dialled, in order, each one completing only when a row says so.
 *
 * Hoisted because `vi.mock`'s factory runs before this module's own bindings exist. The fake is
 * exactly the surface `wake` uses -- `setTimeout`, `once`, `end`, `destroy` -- and nothing else:
 * a fuller imitation would be a model of `net.Socket`, which is not what these rows are about.
 */
const wakes = vi.hoisted(() => {
  class PendingWake {
    readonly path: string;
    readonly listeners = new Map<string, (argument?: unknown) => void>();
    frame: string | null = null;
    destroyed = false;
    #flushed: (() => void) | null = null;

    constructor(path: string) {
      this.path = path;
    }

    setTimeout(): this {
      return this;
    }

    once(event: string, listener: (argument?: unknown) => void): this {
      this.listeners.set(event, listener);
      return this;
    }

    end(frame: string, flushed: () => void): this {
      this.frame = frame;
      this.#flushed = flushed;
      return this;
    }

    destroy(): this {
      this.destroyed = true;
      return this;
    }

    /** The connect completes and the frame is flushed: this delivery landed. */
    succeed(): void {
      this.listeners.get("connect")?.();
      this.#flushed?.();
    }

    /** The connect is refused, the way a socket file whose listener is gone refuses one. */
    refuse(): void {
      const error: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
      error.code = "ECONNREFUSED";
      this.listeners.get("error")?.(error);
    }
  }
  const dialled: PendingWake[] = [];
  return { dialled, open: (path: string) => dialled[dialled.push(new PendingWake(path)) - 1]! };
});

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeNet>()),
  connect: (path: string) => wakes.open(path),
}));

afterEach(() => {
  wakes.dialled.length = 0;
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const binding = (projectId: string): RoleBinding => ({
  assignmentId: `assignment-${projectId}`, roleKey: `PRIMARY_CTO:${projectId}`, role: Role.PRIMARY_CTO,
  projectId, runId: null, taskId: null, sessionId: `session-${projectId}`,
  sessionIncarnation: `incarnation-${projectId}`, boundSessionId: `session-${projectId}`,
  boundSessionIncarnation: `incarnation-${projectId}`, bindingGeneration: 1,
  mode: "PREFERRED", status: "ACTIVE", createdAt: "2026-09-28T00:00:00.000Z",
});

/** A live socket at `path`, so the registration path's filesystem checks answer about a real one. */
const socketAt = async (path: string): Promise<Server> => {
  const server = createServer();
  await new Promise<void>((bound, failed) => {
    server.once("error", failed);
    server.listen(path, () => {
      server.removeListener("error", failed);
      bound();
    });
  });
  return server;
};

/** Resolves once the port has dialled `count` wakes; the rows never wait on a wall clock. */
const dialled = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 1_000 && wakes.dialled.length < count; attempt += 1) {
    await new Promise((tick) => setImmediate(tick));
  }
  expect(wakes.dialled).toHaveLength(count);
};

describe("a wake belongs to the registration it began under", () => {
  const holder = binding("on-member");
  const client = { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]! };

  /** The real port, over one active binding, with one attached peer on a qualified build. */
  const attached = (stateDir: string) => {
    const port = new RoleConversationPort(
      Role.PRIMARY_CTO,
      { active: (key) => (key === holder.roleKey ? holder : null), currentCandidates: () => [holder] },
      { endpointDir: stateDir },
    );
    const server = new McpServer({ name: holder.sessionId, version: "1" });
    vi.spyOn(server.server, "getClientVersion").mockReturnValue(client);
    port.attach(server, () =>
      allow(ReasonCode.OK, {
        actor: holder.sessionId,
        sessionId: holder.sessionId,
        sessionIncarnation: holder.sessionIncarnation,
      }),
    );
    return { port, server };
  };

  const causes = (port: RoleConversationPort): readonly string[] =>
    port.unwakeableHolders().map((reported) => reported.cause);

  it("a success completing after a later registration does not erase that registration's refusal", async () => {
    // The reviewers' first reproduction. Registration A's wake is still in flight; the holder
    // registers endpoint B, whose own wake is refused, and the port correctly reports it. Then A's
    // wake -- to a socket this holder no longer names -- finally lands. Clearing on that completion
    // reports a holder nothing can wake as wakeable, and nothing observable is left to contradict
    // it until somebody tries another wake.
    const stateDir = tempDir("acp-wake-identity-erase-");
    chmodSync(stateDir, 0o700);
    const first = join(stateDir, "cto.wake.sock");
    const second = join(stateDir, "cto.wake.2.sock");
    const listeners = [await socketAt(first), await socketAt(second)];
    try {
      const { port, server } = attached(stateDir);

      // Registration A ends by sending one wake of its own, so holding that wake pending holds the
      // registration itself: this is the in-flight delivery, not a second one arranged beside it.
      const registerFirst = port.registerEndpoint(server, first);
      await dialled(1);
      expect(wakes.dialled[0]?.path).toBe(first);

      const registerSecond = port.registerEndpoint(server, second);
      await dialled(2);
      wakes.dialled[1]?.refuse();
      expect((await registerSecond).allowed).toBe(true);
      expect(causes(port)).toEqual(["registered-endpoint-refused-the-wake"]);

      // A's delivery completes, late and successfully.
      wakes.dialled[0]?.succeed();
      expect((await registerFirst).allowed).toBe(true);
      expect(wakes.dialled[0]?.frame).not.toBeNull();

      // B's refusal is still the current fact about this holder.
      expect(causes(port)).toEqual(["registered-endpoint-refused-the-wake"]);
    } finally {
      for (const listener of listeners) await new Promise<void>((closed) => listener.close(() => closed()));
    }
  });

  it("a failure completing after a later registration of the same path does not poison it", async () => {
    // The other direction, and the one an endpoint string cannot separate at all: the holder
    // rebinds the *same* pathname and registers again, so the failed delivery's endpoint and the
    // live registration's endpoint are the same string. A working registration is then reported as
    // one the endpoint refused, on the strength of a delivery to the process before it.
    const stateDir = tempDir("acp-wake-identity-poison-");
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "cto.wake.sock");
    const listener = await socketAt(path);
    try {
      const { port, server } = attached(stateDir);

      const registerFirst = port.registerEndpoint(server, path);
      await dialled(1);

      const registerAgain = port.registerEndpoint(server, path);
      await dialled(2);
      wakes.dialled[1]?.succeed();
      expect((await registerAgain).allowed).toBe(true);
      expect(causes(port)).toEqual([]);

      // The first registration's delivery is refused, after the second has already succeeded.
      wakes.dialled[0]?.refuse();
      expect((await registerFirst).allowed).toBe(true);
      expect(wakes.dialled[0]?.destroyed).toBe(true);

      expect(causes(port)).toEqual([]);
    } finally {
      await new Promise<void>((closed) => listener.close(() => closed()));
    }
  });

  it("a delivery under the registration in force is still remembered, and still forgotten", async () => {
    // The control for both rows above. Scoping the memory to a registration must not turn it off:
    // a refusal under the current registration is reported, and a success under it clears the
    // report. Without this the two rows would pass on a port that never remembered anything.
    const stateDir = tempDir("acp-wake-identity-control-");
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "cto.wake.sock");
    const listener = await socketAt(path);
    try {
      const { port, server } = attached(stateDir);

      const registering = port.registerEndpoint(server, path);
      await dialled(1);
      wakes.dialled[0]?.refuse();
      expect((await registering).allowed).toBe(true);
      expect(causes(port)).toEqual(["registered-endpoint-refused-the-wake"]);

      const waking = port.wake(holder.roleKey);
      await dialled(2);
      wakes.dialled[1]?.succeed();
      expect((await waking).allowed).toBe(true);
      expect(causes(port)).toEqual([]);
    } finally {
      await new Promise<void>((closed) => listener.close(() => closed()));
    }
  });
});
