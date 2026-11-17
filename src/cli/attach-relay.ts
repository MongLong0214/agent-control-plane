import { MAX_MCP_LINE_BYTES } from "../core/mcp-limits.ts";
import { execFileSync } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/**
 * The canonical CTO's attach relay: a claim client, then a byte pipe.
 *
 * Claude Code spawns this as a stdio MCP server, so it is a descendant of the canonical `claude`
 * process — which is the only thing that can pass the claim socket's kernel-peer and ancestry
 * checks (`src/daemon/canonical-self-claim-listener.ts`, `src/registry/canonical-self-claim.ts`).
 * It performs `actor.claimCanonicalCto` over that socket, keeps the receipt's `{sessionId,
 * sessionSecret}` in one local binding, connects to `cto.mcp.sock` and presents them as the
 * BOUND handshake line (`src/daemon/agentcpd.ts` `authenticateSocket` / `presentedCredential`).
 * Everything after that newline is Claude Code's own traffic, copied byte for byte in both
 * directions.
 *
 * Three properties this file exists to hold, none of which a JSON-RPC-aware relay could have:
 *
 *   - **The handshake is the first line, and nothing of the client's precedes it.** The daemon
 *     reads its first line as the credential. A single client byte ahead of that newline makes
 *     Claude Code's `initialize` the presented credential, and the socket is refused
 *     `MCP_PEER_UNAUTHENTICATED`. `io.stdin` is therefore paused until the handshake is written.
 *   - **`clientInfo` is the client's own.** There is no JSON-RPC code path here at all, so the
 *     value the daemon reads from the MCP handshake is the real process's, not one this relay could compose.
 *   - **The credential is presented once.** It is the session's own secret, whose
 *     hash is durable, so the daemon cannot tell a pre-restart plaintext from a post-restart one.
 *     "A credential taken before the ACP restart may not be reused" is enforced *here*: the
 *     process holds it only in memory, writes it exactly once, and exits when either side closes.
 *     A reconnect path would be that reuse, which is why its absence is load-bearing rather than
 *     an omission. Before a receipt there is no credential, so a claim refused for a reason that
 *     can clear by itself is asked again for a bounded window (`claimUntilAnswered`); a refused
 *     claim mints nothing, and each attempt is a new claim, not a reconnect.
 *
 * What changed with #1037 is what a *respawned* relay does. It no longer has to claim — and the
 * claim refuses a binding that is still ACTIVE — because it first asks the canonical CTO's reattach
 * socket, which admits on the process tree rather than on any credential: the connecting relay
 * descends from the very `claude` process the ACTIVE binding's runtime recorded, with the same
 * start, running the same conversation. There is nothing there to reuse, so reconnecting proves
 * exactly what a first connection does, and the reason for the rule above does not reach it. Only
 * when that socket answers that this process holds no binding does the relay claim, which is where
 * a restarted `claude` belongs: its start differs, and a new generation is what fences it. The
 * secret is still never presented on a second connection: a relay that loses its daemon comes back
 * only through that socket, and only to the binding and runtime its first admission named
 * (`relayWithReattach`).
 *
 * The secret never reaches argv, the environment, stdout, stderr or any file: `stdout` carries
 * only bytes that came off the socket after the handshake, and the `stderr` vocabulary is closed
 * to `attach: <stage> <reasonCode>` with the code copied from the daemon's own public envelope, followed for a claim
 * refusal by the branch name the daemon sent beside it (`attach: claim refused CONFLICT GENERATION_MISMATCH`).
 *
 * The adopted CEO's relay (`runAdoptedCeoAttachRelay`, #1037) is the same byte pipe with no claim
 * and no handshake in front of it, because its socket authenticates the connection itself.
 */

/**
 * The daemon's own per-line ceiling (`MAX_MCP_LINE_BYTES` in `src/core/mcp-limits.ts`).
 * A first line longer than this is not a line either side would have accepted, so the relay
 * stops rather than buffering without bound.
 */
const MAX_LINE_BYTES = MAX_MCP_LINE_BYTES;

/**
 * Must name the same method `CANONICAL_SELF_CLAIM_METHOD` does in
 * `src/daemon/canonical-self-claim-listener.ts`. Not imported from there, for the reason
 * `src/cli/agentctl.ts` gives at its own copy: this is a client, never a composition root, and
 * that module's other exports are daemon-side socket and kernel-credential machinery.
 */
const CANONICAL_SELF_CLAIM_METHOD = "actor.claimCanonicalCto";

/** Injected so the unit test drives the relay with in-process streams; the CLI passes `process`. */
export interface AttachRelayIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/**
 * `--expected-binding-generation auto`, and the default when the flag is absent: the claim pins no generation, and the
 * role's next one (its highest + 1) is read before every attempt (`AttachRelayOptions.nextGeneration`). A number pinned
 * in a relay's argv outlives the binding it named: Claude Code keeps the MCP command it started with, so after the
 * binding was lost every respawn asked for the generation the role had already used and was refused, and only an edited
 * argv and a `/mcp` reconnect brought the tools back (2026-11-16).
 */
export const AUTO_GENERATION = "auto";

/** Exactly the selectors `agentctl claim canonical-cto` takes, so the two argvs stay compatible. */
export interface AttachRelayClaim {
  claimedSessionUuid: string;
  projectId: string;
  /** A number is a pin the claim compares, as it always was; `AUTO_GENERATION` is read for each attempt. */
  expectedBindingGeneration: number | typeof AUTO_GENERATION;
}

/** The claim as it goes on the wire: the generation resolved. */
type PinnedClaim = Omit<AttachRelayClaim, "expectedBindingGeneration"> & { expectedBindingGeneration: number };

export interface AttachRelayOptions {
  claimSocketPath: string;
  mcpSocketPath: string;
  /** Resolved by the caller. Written to the handshake line and nowhere else. */
  mcpToken: string;
  claim: AttachRelayClaim;
  /**
   * The canonical CTO's reattach socket (#1037). Set, it is asked before any claim, and it is how
   * the relay comes back after the daemon's side of the connection closes: the relay outlives the
   * connection and reattaches instead of exiting (`relayWithReattach`).
   */
  reattachSocketPath?: string;
  /**
   * False when the caller already asked the reattach socket for this attach; the socket is still
   * the one the relay comes back through. Defaults to true.
   */
  initialReattach?: boolean;
  /** Bounds on waiting for a restarted daemon; see `ReattachPolicy`. */
  reattach?: Partial<ReattachPolicy>;
  claimTimeoutMs?: number;
  /** The role's next generation, read before each attempt of an `AUTO_GENERATION` claim. Required for one. */
  nextGeneration?: () => Promise<number>;
  /** Bounds on asking again after a refusal that may clear by itself; see `ClaimRetryPolicy`. */
  claimRetry?: Partial<ClaimRetryPolicy>;
  /**
   * When the admission window closes (epoch ms). `runAttachRelayCommand` sets it at relay start so its own first
   * reattach spends from the same window; absent, it is `claimRetry.maxWaitMs` from this call.
   */
  admissionDeadline?: number;
}

/**
 * How long a relay that lost its daemon waits for it, and how often it asks.
 *
 * It waits only while nobody answers on the reattach socket — a daemon that is down or still
 * starting — or while an admitted connection has not finished being restored. Any answer ends the
 * wait: admitted and restored, it carries on; refused, it exits. So does the client ending the
 * session. By default nothing else ends it: a daemon restart measured at 5m47s outlasted the
 * five-minute deadline this wait used to have, and a relay that gives up is not respawned by
 * Claude Code, so its role finds no peer. The asking stays bounded instead:
 * one attempt at a time, each at most `attemptTimeoutMs`, with a backoff capped at `maxDelayMs`.
 * A finite `maxWaitMs` is one absolute deadline, taken when the connection is lost, over every
 * admission and every restore of that wait (review PR1051-R2); `attemptTimeoutMs` bounds each step
 * inside it and never extends it. `flushTimeoutMs` bounds how long an exiting relay waits for a
 * client that stopped reading (PR1051-R4).
 */
export interface ReattachPolicy {
  maxWaitMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  attemptTimeoutMs: number;
  flushTimeoutMs: number;
}

export const DEFAULT_REATTACH_POLICY: ReattachPolicy = {
  maxWaitMs: Number.POSITIVE_INFINITY,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  attemptTimeoutMs: 35_000,
  flushTimeoutMs: 5_000,
};

/**
 * How long a relay that has not been admitted yet keeps asking. Before the first receipt there is no credential to
 * reuse, so asking again is a new claim, not a reconnect; a refused claim mints nothing. It asks again only after an
 * answer that can clear by itself (`retriesAfter`), and everything it does before a receipt — every reattach, generation
 * read and claim, not only the choice to ask again — ends `maxWaitMs` after relay start: Claude Code gives a stdio MCP
 * server 30 s to answer `initialize` (measured in its own log, "Starting connection with timeout of 30000ms") and does
 * not respawn one that missed it, so waiting past that buys nothing.
 */
export interface ClaimRetryPolicy {
  maxWaitMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_CLAIM_RETRY_POLICY: ClaimRetryPolicy = {
  maxWaitMs: 25_000,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
};

/**
 * The refusals a later attempt can pass with nothing changed by anyone: the daemon has not finished starting, the
 * previous runtime of this same conversation is still exiting, a probe or a Buzz room open failed this once, the entitlement moved during the claim, a new
 * conversation's transcript or host registry entry is not written yet, a write failed. Names of `SelfClaimRefusal` in
 * `src/registry/canonical-self-claim.ts`, copied for the reason the method names above are. Everything else — another
 * conversation holding the role, a session that is not entitled, a fenced or changed one — exits on the first answer.
 */
const RETRIED_REFUSALS: ReadonlySet<string> = new Set([
  "PREDECESSOR_RUNTIME_ALIVE",
  "PREDECESSOR_STILL_SETTLING",
  "DEAD_PREDECESSOR_UNRELEASED",
  "ENTITLEMENT_CHANGED",
  "BUZZ_ROOM_UNRESOLVED",
  "HOST_SESSION_REGISTRY_UNVERIFIED",
  "HOST_SESSION_REGISTRY_UNIDENTIFIED",
  "ANCESTOR_START_UNKNOWN",
  "ANCESTOR_CWD_UNREADABLE",
  "TRANSCRIPT_NOT_FOUND",
  "AUDIT_WRITE_FAILED",
  "DAEMON_STARTING",
]);

/** Reason codes that say the daemon could not decide this time, whatever the branch: it is restarting or busy. */
const RETRIED_REASON_CODES: ReadonlySet<string> = new Set(["DAEMON_LOCK_LOST", "OPERATOR_REQUEST_TIMEOUT", "PROBE_FAILED"]);

/** A refusal's branch name as the daemon wrote it, or null for anything that is not one. Never daemon prose on stderr. */
const REFUSAL_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Whether `refusal` can clear by itself. A generation that moved is one only for a claim that pins none: it is read
 * again for the next attempt, where a pinned one would be refused the same way forever.
 */
const retriesAfter = (refusal: { reasonCode: string; reason: string | null }, auto: boolean): boolean => {
  if (RETRIED_REASON_CODES.has(refusal.reasonCode)) return true;
  if (refusal.reason === null) return false;
  if (refusal.reason === "GENERATION_MISMATCH") return auto;
  return RETRIED_REFUSALS.has(refusal.reason);
};

/** Exported for the test that holds the copied names to the registry's. */
export const RETRIED_CLAIM_REFUSALS: readonly string[] = [...RETRIED_REFUSALS, "GENERATION_MISMATCH"];

/**
 * The most client requests the relay lets wait on the daemon at once. Past it the client's stdin is
 * paused until answers come back, so the in-flight table is bounded by this and not by how fast the
 * client writes (PR1051-R4).
 */
const MAX_PENDING_REQUESTS = 1_024;

/**
 * The JSON-RPC error a client receives for a request the relay could not carry: sent while the
 * relay was reattaching, or in flight when the daemon's side closed. In the implementation-defined
 * server-error range; the message says which of the two it was.
 */
export const RELAY_REATTACHING_ERROR = -32001;

export const ATTACH_EXIT = {
  OK: 0,
  USAGE: 2,
  CLAIM_REFUSED: 3,
  HANDSHAKE_REFUSED: 4,
  STREAM_CLOSED: 5,
  PROTOCOL: 6,
  UNAVAILABLE: 7,
} as const;

/**
 * Strictly greater than the claim listener's own 30 s request budget, for the reason
 * `DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS` gives in `src/cli/agentctl.ts`: the daemon's typed refusal
 * should win the race, so the operator reads why the claim failed rather than that the client
 * gave up.
 */
const DEFAULT_CLAIM_TIMEOUT_MS = 180_000;

/**
 * The binding and runtime one admission named (PR1051-R1): the assignment and its generation, the
 * session and its incarnation. The reattach door's acknowledgement carries it, and so does a claim
 * receipt's `binding`. A relay keeps the one its first admission named and refuses a reconnect that
 * names any other, so coming back after a restart can never adopt a binding or session that
 * replaced its own — but for the one binding a committed capacity restore announced to it
 * (`successionRefusal`, review S2B-R1-01). With `Admission.roleKey`, must have the members
 * `CanonicalCtoAdmittedTuple` has in `src/daemon/canonical-self-claim-listener.ts`, which is not
 * imported for the reason given above.
 */
interface AdmittedTuple {
  assignmentId: string;
  bindingGeneration: number;
  sessionId: string;
  sessionIncarnation: string;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The tuple `value` names, or null when it names none completely. */
const parseAdmittedTuple = (value: unknown): AdmittedTuple | null => {
  if (typeof value !== "object") return null;
  if (value === null) return null;
  const named = value as Partial<Record<keyof AdmittedTuple, unknown>>;
  if (!nonEmptyString(named.assignmentId)) return null;
  if (!Number.isSafeInteger(named.bindingGeneration)) return null;
  if (!nonEmptyString(named.sessionId)) return null;
  if (!nonEmptyString(named.sessionIncarnation)) return null;
  return {
    assignmentId: named.assignmentId,
    bindingGeneration: named.bindingGeneration as number,
    sessionId: named.sessionId,
    sessionIncarnation: named.sessionIncarnation,
  };
};

const sameTuple = (left: AdmittedTuple, right: AdmittedTuple): boolean => {
  if (left.assignmentId !== right.assignmentId) return false;
  if (left.bindingGeneration !== right.bindingGeneration) return false;
  if (left.sessionId !== right.sessionId) return false;
  return left.sessionIncarnation === right.sessionIncarnation;
};

/**
 * Review S2B-R2-01 — what one admission named: its tuple and the role the daemon authenticated that
 * connection as. The reattach door's acknowledgement names `roleKey` beside the tuple, read from the
 * binding row the process tree proved (`CanonicalCtoAdmittedTuple`), so it is the role this relay is
 * actually admitted as whatever its own `--project` says; nothing here derives a role from the
 * relay's arguments. `roleKey` is null for an admission that named none — a claim's connection, or an
 * acknowledgement without one — and a connection admitted under no role takes no succession.
 */
interface Admission extends AdmittedTuple {
  roleKey: string | null;
}

/** The admission a reattach acknowledgement's `admitted` names, or null when it names no complete tuple. */
const parseAdmission = (value: unknown): Admission | null => {
  const tuple = parseAdmittedTuple(value);
  if (tuple === null) return null;
  const roleKey = (value as { roleKey?: unknown }).roleKey;
  return { ...tuple, roleKey: nonEmptyString(roleKey) ? roleKey : null };
};

/**
 * Review S2B-R1-01 — `CANONICAL_CTO_RESTORE_SUCCESSION_METHOD` and
 * `CANONICAL_CTO_RESTORE_CHALLENGE_PREFIX` in `src/daemon/agentcpd.ts`, copied for the reason the
 * method names above are. Exported so a witness holds the two in step.
 */
export const RESTORE_SUCCESSION_METHOD = "notifications/acp/canonical-cto-restore-succession";
export const RESTORE_CHALLENGE_PREFIX = "acp-restore-challenge:";

/**
 * The id prefix of the `ping` a relay asks last when it restores a link, copied from
 * `CANONICAL_CTO_RESTORED_PING_PREFIX` in `src/daemon/agentcpd.ts` for the same reason. Its answer is
 * when the daemon tells the client its tool list may have changed.
 */
export const RESTORED_PING_PREFIX = "acp-relay-restored";

/** #1106 — one binding as a capacity restore's succession names it: always with its role. */
interface SuccessionBinding extends AdmittedTuple {
  roleKey: string;
}

/**
 * Review S2B-R1-01 — one committed capacity restore, as the daemon announces it on the connection it
 * challenged (`CanonicalCtoRestoreSuccession` in `src/continuity/continuity-kernel.ts`): the binding
 * that connection was admitted under, the binding the restore committed, and the challenge it was
 * proven by.
 */
interface RestoreSuccession {
  from: SuccessionBinding;
  to: SuccessionBinding;
  challengeId: string;
}

const parseSuccessionBinding = (value: unknown): SuccessionBinding | null => {
  const tuple = parseAdmittedTuple(value);
  if (tuple === null) return null;
  const roleKey = (value as { roleKey?: unknown }).roleKey;
  if (!nonEmptyString(roleKey)) return null;
  return { ...tuple, roleKey };
};

/** The succession `params` names, or null when it names none completely. */
const parseRestoreSuccession = (params: unknown): RestoreSuccession | null => {
  if (typeof params !== "object") return null;
  if (params === null) return null;
  const named = params as { from?: unknown; to?: unknown; challengeId?: unknown };
  const from = parseSuccessionBinding(named.from);
  if (from === null) return null;
  const to = parseSuccessionBinding(named.to);
  if (to === null) return null;
  if (!nonEmptyString(named.challengeId)) return null;
  return { from, to, challengeId: named.challengeId };
};

/**
 * Review S2B-R1-01, S2B-R2-01 — why a succession announced on a link is not one this relay adopts, or
 * null when it is. `admitted` is what that link's own admission named — the tuple and the role the
 * reattach door authenticated that very connection as, never a role this relay derived and never
 * one a later admission names — `answeredChallenge` the restore challenge that link carried to the
 * client and the client answered with a result, and `waiting` whether a succession is already held
 * for the next reconnect. Each refusal is its own statement.
 *
 * What it proves together: the restore was of exactly the role, assignment, generation, session and
 * incarnation this connection was admitted under; it was proven over this very connection, by the
 * challenge this relay passed to its client and passed the answer back; and what it committed is
 * that same role on that same runtime row at the next generation. One, and only once.
 */
const successionRefusal = (
  succession: RestoreSuccession,
  admitted: Admission,
  answeredChallenge: string | null,
  waiting: boolean,
): string | null => {
  if (waiting) return "a succession is already held";
  if (admitted.roleKey === null) return "this connection was admitted under no role";
  if (succession.from.roleKey !== admitted.roleKey) return "it restores another role";
  if (succession.to.roleKey !== admitted.roleKey) return "it changes the role";
  if (!sameTuple(succession.from, admitted)) return "it restores another binding";
  if (succession.challengeId !== answeredChallenge) return "this connection did not answer its challenge";
  if (succession.to.sessionId !== admitted.sessionId) return "it moves the session";
  if (succession.to.sessionIncarnation !== admitted.sessionIncarnation) return "it moves the incarnation";
  if (succession.to.bindingGeneration !== admitted.bindingGeneration + 1) return "it skips a generation";
  if (succession.to.assignmentId === admitted.assignmentId) return "it names the same assignment";
  return null;
};

/**
 * Review S2B-R1-01, S2B-R2-01 — what a reconnect whose acknowledgement named `named` is admitted
 * under, or null, which refuses the reconnect as PR1051-R1 does. Either the binding the relay holds,
 * named again under the role a door admission already named for it (a claim's binding has none yet,
 * so its first door admission names it), or exactly the binding and role a succession this relay
 * took announced.
 */
const readmitted = (named: Admission, held: Admission, proven: SuccessionBinding | null): Admission | null => {
  if (sameTuple(named, held)) {
    if (held.roleKey === null) return named;
    if (named.roleKey !== held.roleKey) return null;
    return named;
  }
  if (proven === null) return null;
  if (!sameTuple(named, proven)) return null;
  if (named.roleKey !== proven.roleKey) return null;
  return named;
};

type ClaimOutcome =
  | { kind: "receipt"; sessionId: string; sessionSecret: string; tuple: AdmittedTuple | null }
  | { kind: "unavailable" }
  | { kind: "refused"; reasonCode: string; reason: string | null }
  | { kind: "malformed" };

/**
 * One line out, one line back, on the token-less claim socket.
 *
 * Written here rather than through `agentctl`'s shared `exchangeOneLineRequest` because that
 * helper collapses a transport failure, a client-side timeout and a malformed body onto
 * synthesized `Decision` reason codes the claim listener also emits for real denials
 * (`DAEMON_LOCK_LOST`, `OPERATOR_REQUEST_TIMEOUT`, `INTERNAL_ERROR`). The relay has to tell those
 * apart — a server denial keeps its own reason code on `stderr`, a local failure must not borrow
 * one — so the outcome is discriminated at the source instead of guessed from the code.
 */
const performClaim = (
  socketPath: string,
  claim: PinnedClaim,
  timeoutMs: number,
): Promise<ClaimOutcome> =>
  new Promise<ClaimOutcome>((resolveClaim) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => finish({ kind: "unavailable" }), timeoutMs);
    timer.unref();
    const finish = (outcome: ClaimOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveClaim(outcome);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ method: CANONICAL_SELF_CLAIM_METHOD, params: claim })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf(0x0a);
      if (boundary === -1) {
        if (received.length > MAX_LINE_BYTES) finish({ kind: "malformed" });
        return;
      }
      if (boundary > MAX_LINE_BYTES) return finish({ kind: "malformed" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, boundary).toString("utf8")) as unknown;
      } catch {
        return finish({ kind: "malformed" });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return finish({ kind: "malformed" });
      }
      const response = parsed as { allowed?: unknown; reasonCode?: unknown; reason?: unknown; value?: unknown };
      if (response.allowed !== true) {
        // A denial with no stable code is not a denial this relay can report, and inventing one
        // would put a reason code on stderr that no catalogue declares. The branch name beside it is
        // kept only when it has the shape of one; a daemon that sends none leaves it null.
        const reason = typeof response.reason === "string" && REFUSAL_NAME.test(response.reason) ? response.reason : null;
        return typeof response.reasonCode === "string" && response.reasonCode.length > 0
          ? finish({ kind: "refused", reasonCode: response.reasonCode, reason })
          : finish({ kind: "malformed" });
      }
      const value = response.value as { sessionId?: unknown; sessionSecret?: unknown; binding?: unknown } | undefined;
      if (!value || typeof value !== "object") return finish({ kind: "malformed" });
      if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
        return finish({ kind: "malformed" });
      }
      // The creation response is the only time a runtime ever receives its session secret
      // (`src/session/session-registry.ts`). A receipt without one leaves nothing to present on
      // the BOUND handshake, so it is a protocol failure rather than something to work around.
      if (typeof value.sessionSecret !== "string" || value.sessionSecret.length === 0) {
        return finish({ kind: "malformed" });
      }
      finish({
        kind: "receipt",
        sessionId: value.sessionId,
        sessionSecret: value.sessionSecret,
        tuple: parseAdmittedTuple(value.binding),
      });
    });
    socket.once("error", () => finish({ kind: "unavailable" }));
    socket.once("close", () => finish({ kind: "unavailable" }));
  });

type ReattachOutcome =
  | { kind: "admitted"; socket: Socket; tuple: Admission | null }
  | { kind: "unbound" }
  | { kind: "unavailable" }
  | { kind: "refused"; reasonCode: string }
  | { kind: "malformed" };

/**
 * The daemon's one "this process holds no binding" answer on the reattach socket
 * (`ReasonCode.CTO_REATTACH_UNBOUND`). Copied rather than imported for the reason the method names
 * above are: this is a client.
 */
const CTO_REATTACH_UNBOUND = "CTO_REATTACH_UNBOUND";

/**
 * Asks the reattach socket, and reads its one answer line before a byte of the client's is sent.
 *
 * `{ok:true}` hands back the connected socket, paused, for the byte pipe, with the tuple the
 * acknowledgement named (null when it named none). `CTO_REATTACH_UNBOUND`, a socket that is not
 * there (an older daemon) or one that never answers sends the caller to the claim. Any other
 * refusal is the daemon's answer about this process and ends the attach. An aborted attempt
 * destroys its socket and answers `unavailable`, so nothing it opened outlives it.
 */
const attemptReattach = (socketPath: string, timeoutMs: number, signal?: AbortSignal): Promise<ReattachOutcome> =>
  new Promise<ReattachOutcome>((resolveReattach) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => finish({ kind: "unavailable" }), timeoutMs);
    timer.unref();
    const abandon = (): void => finish({ kind: "unavailable" });
    const finish = (outcome: ReattachOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      socket.removeListener("data", answer);
      if (outcome.kind === "admitted") socket.pause();
      else socket.destroy();
      resolveReattach(outcome);
    };
    if (signal?.aborted === true) return abandon();
    signal?.addEventListener("abort", abandon, { once: true });
    const answer = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf(0x0a);
      if (boundary === -1) {
        if (received.length > MAX_LINE_BYTES) finish({ kind: "malformed" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, boundary).toString("utf8")) as unknown;
      } catch {
        return finish({ kind: "malformed" });
      }
      const reply = (parsed ?? {}) as { ok?: unknown; reasonCode?: unknown; admitted?: unknown };
      if (reply.ok === true) {
        // The daemon writes nothing after its acknowledgement until the client speaks; anything
        // already here belongs to the pipe, not to this reader.
        const rest = received.subarray(boundary + 1);
        if (rest.length > 0) socket.unshift(rest);
        return finish({ kind: "admitted", socket, tuple: parseAdmission(reply.admitted) });
      }
      if (typeof reply.reasonCode !== "string") return finish({ kind: "malformed" });
      if (reply.reasonCode === CTO_REATTACH_UNBOUND) return finish({ kind: "unbound" });
      finish({ kind: "refused", reasonCode: reply.reasonCode });
    };
    socket.on("data", answer);
    socket.once("error", () => finish({ kind: "unavailable" }));
    socket.once("close", () => finish({ kind: "unavailable" }));
  });

type HandshakeReply =
  | { kind: "refusal"; reasonCode: string }
  | { kind: "malformed" }
  | { kind: "traffic" };

/**
 * Classifies the daemon's *first* line, which is the answer to this relay's own handshake and
 * nothing of the client's.
 *
 * On success the daemon writes no acknowledgement at all, so the first line is already the
 * client's JSON-RPC. On refusal it writes `{"ok":false,"reasonCode":…}` and ends the socket. The
 * two are told apart by `ok === false` with no `jsonrpc` member; anything else is traffic and is
 * forwarded unread. This is the only inspection the relay ever performs, and it stops after the
 * first line.
 */
const classifyFirstLine = (line: string): HandshakeReply => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { kind: "traffic" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "traffic" };
  if ("jsonrpc" in parsed) return { kind: "traffic" };
  const body = parsed as { ok?: unknown; reasonCode?: unknown };
  if (body.ok !== false) return { kind: "traffic" };
  return typeof body.reasonCode === "string" && body.reasonCode.length > 0
    ? { kind: "refusal", reasonCode: body.reasonCode }
    : { kind: "malformed" };
};

/** How long the Keychain lookup may take at most (#859), inside the admission window when that is shorter. */
const KEYCHAIN_TIMEOUT_MS = 10_000;

/**
 * The deployment token, read from the same Keychain item the launchd launcher reads
 * (`deploy/install-launchd.sh`), with `execFileSync` and no shell.
 *
 * **Module-private on purpose, and that is the boundary, not the file name.** It used to live in
 * `src/cli/agentctl.ts`, in the same module scope as `createOperatorClient` and `dispatch` — one
 * identifier away from every operator code path in the CLI. Nothing there called it, but nothing
 * structural stopped the next line from doing so. Here it is reachable only from
 * `runAttachRelayCommand` below, and it is not exported, so no operator path in any module can
 * name it. `tests/unit/operator-socket.test.ts` asserts both halves: that the operator client
 * cannot acquire a credential by any route, and that this function is not exported.
 *
 * It is deliberately not a selector and not production configuration: a command line is
 * world-readable through `ps`, and the MCP server entry the owner writes for the canonical session
 * sets no environment at all, so `ps -E` on the relay shows no ACP secret either. `ACP_MCP_TOKEN`
 * in the environment is honoured only so a test can hand a spawned relay a synthetic token — the
 * same boundary the Keychain has for a same-uid reader.
 *
 * Written with `??` rather than `&&` deliberately: `scripts/verify-refusal-operands-are-watched.mjs`
 * counts every `&&`/`||` operand in this file and asks for a witness or a stated reason for each,
 * and a nullish default carries neither an unwatched decision nor a debt.
 */
const resolveMcpToken = (timeoutMs: number = KEYCHAIN_TIMEOUT_MS): string | null => {
  const fromEnv = process.env["ACP_MCP_TOKEN"] ?? "";
  if (fromEnv.length > 0) return fromEnv;
  const service = process.env["ACP_KEYCHAIN_SERVICE"] ?? "com.agentcontrolplane.agentcpd";
  try {
    const found = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", service, "-a", "ACP_MCP_TOKEN"],
      // stderr is discarded rather than inherited: this command's failure prose is not something
      // to put on the stderr of a process whose stderr is Claude Code's MCP server log.
      //
      // Bounded: `security` can wait on a keychain the user has not unlocked, and this runs inside
      // an MCP server's startup where a wait is indistinguishable from a hang (#859). The catch
      // below already reads a failure as "no token", which is the fail-closed direction.
      // The relay passes what is left of its admission window when that is less (`runAttachRelayCommand`).
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs },
    ).replace(/\n+$/, "");
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
};

/** Everything the CLI knows about an attach. Deliberately no token field: see `resolveMcpToken`. */
export interface AttachRelayCommandOptions {
  claimSocketPath: string;
  mcpSocketPath: string;
  claim: AttachRelayClaim;
  reattachSocketPath?: string;
  reattach?: Partial<ReattachPolicy>;
  /** See `AttachRelayOptions.nextGeneration`. */
  nextGeneration?: () => Promise<number>;
  /** See `AttachRelayOptions.claimRetry`. */
  claimRetry?: Partial<ClaimRetryPolicy>;
}

/**
 * The `agentctl attach canonical-cto` entry.
 *
 * It exists so the CLI can start a relay without naming the deployment token — the caller passes
 * socket paths and claim selectors, and the credential is acquired here and goes straight into
 * `runAttachRelay`, which still takes it explicitly so a test can drive the relay with a synthetic
 * one.
 */
export const runAttachRelayCommand = async (
  options: AttachRelayCommandOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // The reattach is tokenless, so it is asked before the deployment credential is: a live
  // claimant whose Keychain is locked or unreadable still reaches its own tools (review
  // PR1046-R2). Resolving the token first was dropped rather than kept: it made the one door that
  // needs no credential unreachable without one. The token is acquired only for the fallback,
  // which presents it on `cto.mcp.sock`.
  io.stdin.pause();
  return await attachCommand({ ...options }, io);
};

/** The rest of `runAttachRelayCommand`. */
const attachCommand = async (
  options: AttachRelayCommandOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // The admission window starts here, at relay start, and every step before a receipt spends from it.
  const admissionDeadline = admissionDeadlineOf(options);
  const reattached = await reattachFirst(
    options.reattachSocketPath,
    boundedBy(admissionDeadline, DEFAULT_CLAIM_TIMEOUT_MS),
    options.reattach,
    io,
  );
  if (reattached !== CLAIM) return reattached;
  // The Keychain lookup spends from the same window: a door that took all of it leaves none for a Keychain slow to
  // unlock, and 25 s of a silent door plus a 6 s Keychain exited at 31.4 s, past Claude Code's 30 s. Nothing has
  // refused this attach yet, so the step that ran out of time is the one named.
  if (Date.now() >= admissionDeadline) {
    io.stderr.write("attach: reattach socket unavailable\n");
    return ATTACH_EXIT.UNAVAILABLE;
  }
  const mcpToken = resolveMcpToken(boundedBy(admissionDeadline, KEYCHAIN_TIMEOUT_MS));
  if (mcpToken === null) {
    io.stderr.write("attach: mcp token unavailable\n");
    return ATTACH_EXIT.UNAVAILABLE;
  }
  // The configured door is kept whatever it answered just now (review PR1051-R5): a door that did
  // not answer may belong to a daemon that opened its claim socket and has not yet opened this one.
  return runAttachRelay({ ...options, initialReattach: false, mcpToken, admissionDeadline }, io);
};

/** `reattachFirst`'s answer when the reattach did not decide the attach and the claim must. */
const CLAIM = "claim";

/**
 * Asks the reattach socket when there is one. Resolves to the relay's exit code when the reattach
 * decided the attach — admitted and relayed, or refused — and otherwise to `CLAIM`: the door
 * answered that this process holds no binding, or there is no door, or it did not answer.
 *
 * An acknowledgement that names no binding tuple (a daemon older than PR1051) leaves nothing to
 * compare a reconnect against, so that attach keeps the byte pipe that exits with its connection.
 */
const reattachFirst = async (
  reattachSocketPath: string | undefined,
  timeoutMs: number,
  policy: Partial<ReattachPolicy> | undefined,
  io: AttachRelayIo,
): Promise<number | typeof CLAIM> => {
  if (reattachSocketPath === undefined) return CLAIM;
  const reattached = await attemptReattach(reattachSocketPath, timeoutMs);
  if (reattached.kind === "admitted") {
    if (reattached.tuple === null) return pipeStdioToSocket(reattached.socket, io, NO_HANDSHAKE);
    return relayWithReattach(
      reattached.socket,
      NO_HANDSHAKE,
      true,
      reattached.tuple,
      reattachSocketPath,
      policy,
      io,
    );
  }
  if (reattached.kind === "refused") {
    io.stderr.write(`attach: reattach refused ${reattached.reasonCode}\n`);
    return ATTACH_EXIT.HANDSHAKE_REFUSED;
  }
  if (reattached.kind === "malformed") {
    io.stderr.write("attach: reattach reply malformed\n");
    return ATTACH_EXIT.PROTOCOL;
  }
  return CLAIM;
};

type Receipt = Extract<ClaimOutcome, { kind: "receipt" }>;

/** When the admission window of `options` closes, as an epoch-ms instant: the one it was given, or `maxWaitMs` from now. */
const admissionDeadlineOf = (options: { admissionDeadline?: number; claimRetry?: Partial<ClaimRetryPolicy> }): number =>
  options.admissionDeadline ?? Date.now() + ({ ...DEFAULT_CLAIM_RETRY_POLICY, ...options.claimRetry }).maxWaitMs;

/** A step's own timeout, cut to what is left of the window; at least 1 ms, so a timer is always set. */
const boundedBy = (deadline: number, ownTimeoutMs: number): number => Math.max(1, Math.min(ownTimeoutMs, deadline - Date.now()));

const WINDOW_CLOSED = Symbol("window closed");

/** `promise`, or `WINDOW_CLOSED` when the window closes first. The promise is not cancelled; its answer is ignored. */
const beforeDeadline = <T>(promise: Promise<T>, deadline: number): Promise<T | typeof WINDOW_CLOSED> =>
  new Promise((resolveRace, rejectRace) => {
    const timer = setTimeout(() => resolveRace(WINDOW_CLOSED), boundedBy(deadline, Number.MAX_SAFE_INTEGER));
    promise.then(
      (value) => { clearTimeout(timer); resolveRace(value); },
      (error: unknown) => { clearTimeout(timer); rejectRace(error); },
    );
  });

/**
 * The claim, asked until it is answered for good: a receipt, a refusal that cannot clear by itself (`retriesAfter`),
 * or the end of the admission window. Resolves to the receipt, or to the exit code the relay leaves with.
 *
 * The window is one deadline (`admissionDeadline`, set at relay start) and it bounds every step, not only the decision
 * to ask again: the reattach door, the generation read and the claim socket each get their own timeout or what is left
 * of the window, whichever is less. Checked only between attempts, it did not: a DAEMON_STARTING refusal followed by a
 * claim the daemon never answered left the relay waiting out the claim's own 180 s, past Claude Code's 30 s, and the
 * owner had to reconnect by hand again. When the window closes the relay exits with the last refusal it was given, so
 * the line says why it was still asking, not only that time ran out.
 *
 * Each attempt after the first asks the reattach door again first, when there is one. A claim whose answer was lost
 * (the daemon went away mid-reply) may have been admitted, and its binding is then ACTIVE on this process tree: the
 * door admits that, where a second claim would be refused for it. A door that refuses ends the attach as it does at
 * start, so this never claims after a refused reattach.
 *
 * Every attempt that does not end the attach writes `attach: claim refused <reasonCode> <reason>; retrying` (or
 * `attach: claim socket unavailable; retrying`); the last line is the same without the suffix. `<reason>` is the
 * branch name the daemon sent, and is left out when it sent none.
 */
const claimUntilAnswered = async (options: AttachRelayOptions, deadline: number, io: AttachRelayIo): Promise<Receipt | number> => {
  const policy: ClaimRetryPolicy = { ...DEFAULT_CLAIM_RETRY_POLICY, ...options.claimRetry };
  const timeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const pinned = options.claim.expectedBindingGeneration;
  let lastRefusal: string | null = null;
  const exitWith = (line: string, code: number): number => {
    io.stderr.write(`${line}\n`);
    return code;
  };
  /** The window closed: the last refusal is the answer, or, with none, what this step could not get. */
  const windowClosed = (line: string, code: number): number =>
    lastRefusal === null ? exitWith(line, code) : exitWith(lastRefusal, ATTACH_EXIT.CLAIM_REFUSED);
  let delay = policy.initialDelayMs;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const reattached = await reattachFirst(options.reattachSocketPath, boundedBy(deadline, timeoutMs), options.reattach, io);
      if (reattached !== CLAIM) return reattached;
    }
    if (Date.now() >= deadline) return windowClosed("attach: claim socket unavailable", ATTACH_EXIT.UNAVAILABLE);
    let expectedBindingGeneration: number;
    if (pinned !== AUTO_GENERATION) {
      expectedBindingGeneration = pinned;
    } else {
      const read = options.nextGeneration === undefined ? null : await beforeDeadline(options.nextGeneration(), deadline).catch(() => null);
      if (read === WINDOW_CLOSED) return windowClosed("attach: claim generation unreadable", ATTACH_EXIT.UNAVAILABLE);
      // Unreadable is not something a wait repairs (no database, or a runtime that cannot open it), and guessing a
      // generation would only be refused, so the attach ends here and says which step it could not take.
      if (read === null || !Number.isSafeInteger(read) || read <= 0) return exitWith("attach: claim generation unreadable", ATTACH_EXIT.UNAVAILABLE);
      expectedBindingGeneration = read;
    }
    const claimed = await performClaim(options.claimSocketPath, { ...options.claim, expectedBindingGeneration }, boundedBy(deadline, timeoutMs));
    if (claimed.kind === "receipt") return claimed;
    if (claimed.kind === "malformed") return exitWith("attach: claim receipt malformed", ATTACH_EXIT.PROTOCOL);
    const line = claimed.kind === "unavailable"
      ? "attach: claim socket unavailable"
      : `attach: claim refused ${claimed.reasonCode}${claimed.reason === null ? "" : ` ${claimed.reason}`}`;
    const code = claimed.kind === "unavailable" ? ATTACH_EXIT.UNAVAILABLE : ATTACH_EXIT.CLAIM_REFUSED;
    if (claimed.kind === "refused") lastRefusal = line;
    // A daemon that is not listening yet — restarting, or not started — is asked again like any answer that can clear.
    const again = claimed.kind === "unavailable" || retriesAfter(claimed, pinned === AUTO_GENERATION);
    if (!again) return exitWith(line, code);
    const wait = Math.min(delay, deadline - Date.now());
    if (wait <= 0) return windowClosed(line, code);
    io.stderr.write(`${line}; retrying\n`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, wait));
    delay = Math.min(delay * 2, policy.maxDelayMs);
  }
};

export const runAttachRelay = async (
  options: AttachRelayOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // Nothing of Claude Code's moves until the handshake newline is on the wire.
  io.stdin.pause();

  const deadline = admissionDeadlineOf(options);
  // Unbound, or no reattach socket that answered: the claim decides, as it always has.
  if (options.initialReattach !== false) {
    const reattached = await reattachFirst(
      options.reattachSocketPath,
      boundedBy(deadline, options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS),
      options.reattach,
      io,
    );
    if (reattached !== CLAIM) return reattached;
  }

  const claimed = await claimUntilAnswered(options, deadline, io);
  if (typeof claimed === "number") return claimed;

  const connection = {
    handshake: (socket: Socket) => {
      // One write, one string, one reference. The order is the whole correctness argument: this
      // newline is what makes the client's first message the *second* line on this socket.
      socket.write(
        `${JSON.stringify({
          token: options.mcpToken,
          sessionId: claimed.sessionId,
          sessionSecret: claimed.sessionSecret,
        })}\n`,
      );
    },
  };
  const first = createConnection(options.mcpSocketPath);
  // With a reattach socket configured, losing this connection is not the end of the attach,
  // whether or not that socket answered at start (PR1051-R5); the secret above is presented on
  // this one connection and never again. A receipt naming no binding leaves nothing to compare a
  // reconnect against, so that attach keeps the byte pipe.
  const door = options.reattachSocketPath;
  if (door === undefined) return pipeStdioToSocket(first, io, connection);
  if (claimed.tuple === null) return pipeStdioToSocket(first, io, connection);
  // Review S2B-R2-01 — the claim's connection is admitted under no role: only the reattach door's
  // acknowledgement names one, and only a connection it admitted takes a succession.
  const held: Admission = { ...claimed.tuple, roleKey: null };
  return relayWithReattach(first, connection, false, held, door, options.reattach, io);
};

/**
 * The adopted CEO's relay (#1037): no claim, no token, no handshake.
 *
 * The adopted CEO tool socket authenticates the connection itself — the kernel's peer, which is
 * this process, descending from the adopted Gateway that spawned it — so there is nothing for this
 * relay to obtain first and nothing for it to present. The first byte on the socket is the
 * client's own. A refusal is the daemon's one `{ok:false,reasonCode}` line, read here exactly as a
 * handshake refusal is above.
 *
 * It still never reconnects, but for a different reason than the CTO relay: there is no
 * credential to reuse. A respawn is simply a new connection, admitted or refused on the same facts
 * as the first one, and Hermes is what respawns it. Only the **first** connect waits
 * (`connectWhenReady`), because Hermes respawns the relay on the CEO's next tool call and retries
 * that call once: a call that lands while the daemon restarts would otherwise fail outright.
 */
export const runAdoptedCeoAttachRelay = async (
  options: { toolSocketPath: string; initialConnect?: Partial<InitialConnectPolicy> },
  io: AttachRelayIo,
): Promise<number> => {
  const policy: InitialConnectPolicy = { ...ADOPTED_CEO_INITIAL_CONNECT, ...options.initialConnect };
  const ready = await connectWhenReady(options.toolSocketPath, policy, io);
  if ("exit" in ready) return ready.exit;
  return pipeStdioToSocket(ready.socket, io, NO_HANDSHAKE);
};

/**
 * How long, and how many times, the adopted CEO's relay tries its first connection while the tool
 * socket is not there yet. Both bounds hold; whichever is reached first ends the wait with
 * `UNAVAILABLE`, which is what the first failure meant before there was a wait.
 */
export interface InitialConnectPolicy {
  maxWaitMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export const ADOPTED_CEO_INITIAL_CONNECT: InitialConnectPolicy = {
  maxWaitMs: 10_000,
  maxAttempts: 40,
  retryDelayMs: 250,
};

/**
 * The only connect errors that mean "not there yet": no socket at the path (`ENOENT`), or a path
 * nothing listens on (`ECONNREFUSED`) — a daemon that is restarting. Anything else, a permission
 * error above all, is final at once and is never waited out.
 */
const NOT_YET_LISTENING = new Set(["ENOENT", "ECONNREFUSED"]);

/**
 * Connects to `path`, retrying only while it is not yet listening, within `policy`.
 *
 * The client's stdin is read while this waits, so its end is seen: a client that goes away ends
 * the wait with `OK` and nothing connects afterwards. What it wrote is held and put back in front
 * of stdin, in order, before the connected socket is handed to the pipe, so no byte is lost. Past
 * the daemon's own line ceiling stdin is paused instead of held, which bounds the buffer.
 */
const connectWhenReady = (
  path: string,
  policy: InitialConnectPolicy,
  io: AttachRelayIo,
): Promise<{ socket: Socket } | { exit: number }> =>
  new Promise((resolve) => {
    const deadline = performance.now() + policy.maxWaitMs;
    const held: Buffer[] = [];
    let heldBytes = 0;
    let attempts = 0;
    let waiting = false;
    let done = false;
    let attempt: Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    const hold = (chunk: Buffer): void => {
      held.push(chunk);
      heldBytes += chunk.length;
      if (heldBytes > MAX_LINE_BYTES) io.stdin.pause();
    };
    const ended = (): void => stop({ exit: ATTACH_EXIT.OK });
    const broken = (): void => stop({ exit: ATTACH_EXIT.STREAM_CLOSED });
    const stop = (outcome: { socket: Socket } | { exit: number }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      io.stdin.removeListener("data", hold);
      io.stdin.removeListener("end", ended);
      io.stdin.removeListener("error", broken);
      io.stdin.removeListener("close", broken);
      io.stdin.pause();
      if ("socket" in outcome) {
        if (held.length > 0) io.stdin.unshift(Buffer.concat(held));
      } else {
        attempt?.destroy();
      }
      resolve(outcome);
    };
    // Checked before every attempt, before every retry is scheduled, and once more after a connect
    // succeeds: a timer or a connect completion can run late, and a connection made past the
    // deadline is refused here, before any held byte is written to it.
    const expired = (): boolean => attempts >= policy.maxAttempts || performance.now() > deadline;
    const unavailable = (): void => {
      io.stderr.write("attach: mcp socket unavailable\n");
      stop({ exit: ATTACH_EXIT.UNAVAILABLE });
    };
    const connect = (): void => {
      if (expired()) return unavailable();
      attempts += 1;
      const socket = createConnection(path);
      attempt = socket;
      const failed = (error: NodeJS.ErrnoException): void => {
        if (done) return;
        if (!NOT_YET_LISTENING.has(error.code ?? "") || expired()) return unavailable();
        if (!waiting) {
          waiting = true;
          io.stderr.write("attach: mcp socket waiting\n");
        }
        timer = setTimeout(connect, Math.min(policy.retryDelayMs, Math.max(0, deadline - performance.now())));
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.removeListener("error", failed);
        if (performance.now() > deadline) return unavailable();
        stop({ socket });
      });
    };
    io.stdin.on("data", hold);
    io.stdin.once("end", ended);
    io.stdin.once("error", broken);
    io.stdin.once("close", broken);
    connect();
  });

/**
 * The byte pipe every relay shares: once `socket` is connected — now, or when it connects — let
 * `handshake` write first, then carry stdin to the socket and the socket to stdout, inspecting only
 * the daemon's first line for a refusal.
 */
const pipeStdioToSocket = (
  socket: Socket,
  io: AttachRelayIo,
  connection: { handshake(socket: Socket): void },
): Promise<number> =>
  new Promise<number>((resolveRelay) => {
    let settled = false;
    let resolved = false;
    let connected = false;
    let stdinEnded = false;
    let stdoutFailed = false;
    let peeked = Buffer.alloc(0);
    const settle = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolveRelay(code);
    };
    /**
     * Resolving is the last thing that happens, and it may not happen until stdout has flushed.
     *
     * The CLI turns this promise's value into `process.exit`, and stdout is a **pipe** under Claude
     * Code, not a TTY. `process.exit` keeps only what the kernel has already accepted and discards
     * whatever is still in Node's userspace write buffer — measured on this host at 34 470 of
     * 100 006 bytes lost — so resolving while a write is outstanding truncates the daemon's own MCP
     * stream and hands Claude Code a JSON-RPC line that stops mid-token. `writableEnded` is not the
     * condition to wait on: `socket.pipe` has usually already called `end` by this point, and the
     * bytes are still queued. `writableFinished` / the `finish` event is the one that means flushed.
     *
     * `stdin` is unpiped and paused first, so this wait is never a wait on the *other* direction:
     * the socket is destroyed, and leaving the client's stdin flowing into it would trade a
     * truncation for a hang, which is not a repair.
     */
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      io.stdin.unpipe(socket);
      io.stdin.pause();
      if (stdoutFailed || io.stdout.writableFinished) return settle(code);
      io.stdout.once("finish", () => settle(code));
      if (!io.stdout.writableEnded) io.stdout.end();
    };
    const protocolFailure = (): void => {
      io.stderr.write("attach: handshake reply malformed\n");
      finish(ATTACH_EXIT.PROTOCOL);
    };
    const peek = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const boundary = peeked.indexOf(0x0a);
      if (boundary === -1) {
        if (peeked.length > MAX_LINE_BYTES) protocolFailure();
        return;
      }
      if (boundary > MAX_LINE_BYTES) return protocolFailure();
      const reply = classifyFirstLine(peeked.subarray(0, boundary).toString("utf8"));
      if (reply.kind === "malformed") return protocolFailure();
      if (reply.kind === "refusal") {
        // The reason code, and only the reason code. It never reaches stdout, which is Claude
        // Code's MCP input and admits nothing that is not JSON-RPC.
        io.stderr.write(`attach: handshake refused ${reply.reasonCode}\n`);
        return finish(ATTACH_EXIT.HANDSHAKE_REFUSED);
      }
      // Past this point the relay never inspects another byte in either direction.
      socket.removeListener("data", peek);
      io.stdout.write(peeked);
      socket.pipe(io.stdout);
    };

    io.stdin.once("end", () => {
      stdinEnded = true;
    });
    io.stdin.once("error", () => finish(ATTACH_EXIT.STREAM_CLOSED));
    io.stdout.once("error", () => {
      // A stdout that errors will never emit `finish`, so the flush above has to stop waiting on
      // it. This is the reader having gone away — there is nothing left to deliver to.
      stdoutFailed = true;
      if (settled) settle(ATTACH_EXIT.STREAM_CLOSED);
      else finish(ATTACH_EXIT.STREAM_CLOSED);
    });
    const onConnected = (): void => {
      connected = true;
      // Whatever the handshake writes is on the wire before the client's first byte, because
      // stdin is piped only after it returns.
      connection.handshake(socket);
      socket.on("data", peek);
      // A socket the reattach reader paused stays paused under a new `data` listener; one that
      // was never paused is already flowing and this changes nothing.
      socket.resume();
      io.stdin.pipe(socket);
    };
    if (socket.pending) socket.once("connect", onConnected);
    else onConnected();
    socket.once("error", () => {
      if (!connected) {
        io.stderr.write("attach: mcp socket unavailable\n");
        finish(ATTACH_EXIT.UNAVAILABLE);
        return;
      }
      finish(ATTACH_EXIT.STREAM_CLOSED);
    });
    // EOF and ECONNRESET are the same event to this relay, and a daemon restart produces one of
    // them. There is deliberately no branch here that opens a second connection.
    socket.once("close", () => finish(stdinEnded ? ATTACH_EXIT.OK : ATTACH_EXIT.STREAM_CLOSED));
  });

const NO_HANDSHAKE = { handshake: (): void => undefined };

/** One JSON-RPC message as the relay needs to see it: whether it is a request, and its id. */
interface RelayedMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const parseRelayed = (line: string): RelayedMessage | null => {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object") return null;
  if (value === null) return null;
  if (Array.isArray(value)) return null;
  return value as RelayedMessage;
};

/** A request's id, or undefined for a notification or a response. */
const requestIdOf = (message: RelayedMessage): unknown => {
  if (typeof message.method !== "string") return undefined;
  return message.id;
};

/** A response's id, or undefined for anything that is not a response. */
const responseIdOf = (message: RelayedMessage): unknown => {
  if (message.method !== undefined) return undefined;
  return message.id;
};

const idKey = (id: unknown): string => JSON.stringify(id) ?? "undefined";

/** Splits a byte stream into lines; anything left unterminated past the line bound is refused. */
const lineSplitter = (onLine: (line: string) => void, onOverflow: () => void): ((chunk: Buffer) => void) => {
  let held = Buffer.alloc(0);
  return (chunk) => {
    held = Buffer.concat([held, chunk]);
    for (let boundary = held.indexOf(0x0a); boundary !== -1; boundary = held.indexOf(0x0a)) {
      const line = held.subarray(0, boundary).toString("utf8");
      held = held.subarray(boundary + 1);
      onLine(line);
    }
    if (held.length > MAX_LINE_BYTES) onOverflow();
  };
};

/** A client request in flight, under the id the client gave it. */
interface InFlightRequest {
  client: unknown;
}

/** A request of the client's as it arrived: the line, byte for byte, and what it parsed to. */
interface ClientRequest {
  message: RelayedMessage;
  line: string;
}

/** One daemon connection, and everything that belongs to it and to no other (review PR1051-R2). */
interface Link {
  socket: Socket;
  /**
   * Review S2B-R2-01 — what this connection's own admission named: the tuple, and the role the
   * reattach door's acknowledgement authenticated this connection as (null on a claim's connection,
   * or when the acknowledgement named none). Fixed when the link opens; the one predecessor a
   * succession announced on this link may name.
   */
  admitted: Admission;
  /** Known at once for a reattach; for a claim's handshake, after the first line that is not a refusal. */
  accepted: boolean;
  closed: boolean;
  /** The client's requests written on this link and not yet answered, keyed by their own ids. */
  inFlight: Map<string, InFlightRequest>;
  /** The relay's own requests on this link, each answered by this link and by no other. */
  waiters: Map<string, (message: RelayedMessage | null) => void>;
  /** Replayable requests written on this link, remembered only once the daemon answers them with success. */
  initializes: Map<string, ClientRequest>;
  /**
   * Review S2B-R1-01 — the id of the last capacity-restore challenge the daemon sent the client on
   * this link, and the same id once the client answered it with a result while this link was
   * current. One each, so nothing here grows; the daemon has one challenge open per connection.
   */
  challenge: string | null;
  answeredChallenge: string | null;
}

const succeeded = (message: RelayedMessage): boolean => {
  if (message.error !== undefined) return false;
  return message.result !== undefined;
};

/**
 * The canonical CTO's relay when it has a reattach socket to come back through (#1037).
 *
 * The byte pipe above exits when the daemon's side closes, and that was the whole of a daemon
 * restart for a canonical CTO: the relay died, Claude Code does not respawn a dead stdio MCP
 * server, and the binding stayed ACTIVE with no tools until someone restarted the
 * session. This relay outlives the connection instead:
 *
 *   - **The client's stdio is never closed for it.** A request that arrives while the relay is
 *     reattaching is answered at once with `RELAY_REATTACHING_ERROR`, and a request that was in
 *     flight when the daemon's side closed is answered with the same code and an "outcome unknown"
 *     message. Holding requests until the daemon returns was rejected rather than bounded: nothing
 *     is held for later, so nothing is buffered without bound.
 *   - **It comes back only by reattach, and only to what it left.** The secret a claim returned was
 *     presented on the first connection and is never presented again; the reattach admits on the
 *     process tree, so a reconnect proves what a first connection does and reuses nothing. It never
 *     claims: a refusal — this process holds no binding, the binding was revoked, the ancestry does
 *     not match — ends the relay rather than falling back to a claim. An admission that names a
 *     binding or runtime other than `initial`, the one the first admission named, ends it too
 *     (review PR1051-R1): a reconnect never adopts a binding that replaced its own. A higher
 *     generation on the same session is not an exception (review S2B-R1-01): a release and rebind,
 *     another holder in between, or another project's role all name one. The one binding a
 *     reconnect adopts in place of its own is the one a committed capacity restore (#1106)
 *     announced on the connection it challenged (`RESTORE_SUCCESSION_METHOD`), taken only when
 *     `successionRefusal` finds nothing — exactly the role and binding that connection's own
 *     admission named restored, proven by the challenge this link carried both ways, to the same
 *     role and runtime at the next generation — and adopted only by the next admission, which must
 *     name exactly it, role included (`readmitted`). A succession is held for that one admission
 *     and then gone, so it is never adopted twice. The role is the one the door's acknowledgement
 *     named for that connection (review S2B-R2-01): the door admits on the process tree whatever
 *     the relay's claim selectors say, so a role taken from them would refuse the restore of the
 *     binding the relay actually serves.
 *   - **One wait at a time, one connection at a time** (PR1051-R2). Every socket is a `Link` that
 *     owns its waiters and its in-flight requests, and only the current link's lines reach anything.
 *     An attempt the relay gives up on is destroyed, so a late answer on it satisfies nothing; a
 *     link lost while it is being restored is retried by the wait already running, never by a
 *     second one. With a finite `maxWaitMs`, one absolute deadline from the loss governs every
 *     admission, restore and pause of the wait; by default there is none (`ReattachPolicy`).
 *   - **It restores only what a daemon confirmed** (PR1051-R3). Replay state is taken from the
 *     daemon's answers rather than from the client's requests: taken from the requests, one the
 *     client was told was not sent ran on return. A daemon serves a new connection from scratch, so
 *     the relay replays the client's own `initialize` — kept once a daemon answered it with a
 *     result — and `notifications/initialized` — kept once written on a live connection — and
 *     swallows their answers, then asks a `ping` of its own whose answer ends the restore. A request
 *     the client was told was not sent changes none of it.
 *   - **It holds nothing without bound** (PR1051-R4). The client's stdin pauses while stdout or the
 *     daemon's socket is not accepting writes, or while `MAX_PENDING_REQUESTS` requests are
 *     unanswered; the daemon's socket pauses while stdout is not accepting writes; and the exit
 *     waits for stdout to flush for at most `flushTimeoutMs`.
 *   - **A connection that closes without a refusal is not a refusal** (PR1051-R5). A claim's
 *     connection that closes before the daemon's first line is a daemon that went away, and the
 *     relay reattaches as it would after any other loss; only a refusal line ends the attach.
 *   - **Every line passes exactly as it arrived**, under the client's own id, in both directions.
 *     The relay's only requests of its own are the restore's, made on a link no client request
 *     reaches until the restore ends, so there is no id to keep apart.
 *
 * The capacity restore's challenge and succession (review S2B-R1-01) are the only reasons this
 * relay reads JSON-RPC beyond the client's `initialize`: a restore's challenge and its answer pass
 * unchanged and are only noted, and its succession is taken out of the stream.
 */
const relayWithReattach = (
  first: Socket,
  connection: { handshake(socket: Socket): void },
  firstAdmitted: boolean,
  initial: Admission,
  reattachSocketPath: string,
  policyOverrides: Partial<ReattachPolicy> | undefined,
  io: AttachRelayIo,
): Promise<number> =>
  new Promise<number>((resolveRelay) => {
    /** The binding a reconnect must name: the first admission's, or the one a restore's succession named. */
    let admittedUnder = initial;
    /**
     * Review S2B-R1-01 — the binding a committed capacity restore announced on the current link, held
     * for the next admission alone. One at a time; any admission takes it away.
     */
    let succession: SuccessionBinding | null = null;
    const policy: ReattachPolicy = { ...DEFAULT_REATTACH_POLICY, ...policyOverrides };
    let phase: "connecting" | "live" | "reattaching" | "done" = "connecting";
    /** The one link the relay serves or is restoring. Every other socket it opened is destroyed. */
    let current: Link | null = null;
    /** The wait in progress: aborting it ends its admission, its restore and its pause at once. */
    let waiting: { abort: AbortController; deadline: NodeJS.Timeout | undefined } | null = null;
    let stdinEnded = false;
    let stdoutFailed = false;
    let stdoutBlocked = false;
    let daemonBlocked = false;
    /** The client's `initialize` a daemon answered with a result, replayed as the client sent it. */
    let clientInitialize: ClientRequest | null = null;
    let clientInitialized: string | null = null;
    /** Counts the relay's own requests, whose ids are strings. */
    let internalIds = 0;
    /** Ends the relay's own requests on a live link when the relay ends. */
    const live = new AbortController();

    let resolved = false;
    const resolveOnce = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolveRelay(code);
    };

    /** Pauses whichever side is producing faster than the other consumes. */
    const flow = (): void => {
      if (phase === "done") return;
      const link = current;
      if (phase === "live") {
        if (stdoutBlocked) link?.socket.pause();
        else link?.socket.resume();
      }
      // Nothing of the client's moves before the handshake is on the wire.
      if (phase === "connecting") return;
      if (stdoutBlocked) {
        io.stdin.pause();
        return;
      }
      if (daemonBlocked) {
        io.stdin.pause();
        return;
      }
      if ((link?.inFlight.size ?? 0) >= MAX_PENDING_REQUESTS) {
        io.stdin.pause();
        return;
      }
      io.stdin.resume();
    };

    const toClient = (line: string): void => {
      if (stdoutFailed) return;
      if (io.stdout.write(`${line}\n`)) return;
      if (stdoutBlocked) return;
      stdoutBlocked = true;
      io.stdout.once("drain", () => {
        stdoutBlocked = false;
        flow();
      });
      flow();
    };
    const undelivered = (id: unknown, message: string): void => {
      toClient(JSON.stringify({ jsonrpc: "2.0", id, error: { code: RELAY_REATTACHING_ERROR, message } }));
    };

    const end = (code: number): void => {
      if (phase === "done") return;
      phase = "done";
      if (waiting !== null) {
        clearTimeout(waiting.deadline);
        waiting.abort.abort();
        waiting = null;
      }
      live.abort();
      current?.socket.destroy();
      current = null;
      first.destroy();
      io.stdin.removeListener("data", onClientData);
      io.stdin.pause();
      // Resolved once stdout has flushed, for the reason `pipeStdioToSocket` gives, but no later
      // than `flushTimeoutMs`: a client that stopped reading would otherwise hold the exit forever.
      if (stdoutFailed) return resolveOnce(code);
      if (io.stdout.writableFinished) return resolveOnce(code);
      const unflushed = setTimeout(() => resolveOnce(code), policy.flushTimeoutMs);
      io.stdout.once("finish", () => {
        clearTimeout(unflushed);
        resolveOnce(code);
      });
      if (!io.stdout.writableEnded) io.stdout.end();
    };
    const protocolFailure = (stage: string): void => {
      io.stderr.write(`attach: ${stage} malformed\n`);
      end(ATTACH_EXIT.PROTOCOL);
    };

    /** Notes a request written on `link` that a restarted daemon would be restored with, if it succeeds. */
    const noteReplayable = (link: Link, key: string, message: RelayedMessage, line: string): void => {
      if (message.method === "initialize") link.initializes.set(key, { message, line });
    };

    /**
     * Review S2B-R1-01 — notes a capacity-restore challenge the daemon sent the client on `link`. Only
     * observed: the line still passes to the client exactly as it arrived.
     */
    const noteChallenge = (link: Link, message: RelayedMessage): void => {
      if (message.method !== "ping") return;
      if (typeof message.id !== "string") return;
      if (!message.id.startsWith(RESTORE_CHALLENGE_PREFIX)) return;
      link.challenge = message.id;
      link.answeredChallenge = null;
    };

    /**
     * Review S2B-R1-01 — notes the client's answer to `link`'s challenge, when it is one with a
     * result. Only observed: the line still leaves exactly as it arrived.
     */
    const noteChallengeAnswer = (link: Link, message: RelayedMessage | null): void => {
      if (message === null) return;
      if (message.method !== undefined) return;
      if (link.challenge === null) return;
      if (message.id !== link.challenge) return;
      if (typeof message.result !== "object") return;
      if (message.result === null) return;
      link.answeredChallenge = link.challenge;
    };

    /**
     * Review S2B-R1-01 — the daemon's announcement of a committed capacity restore on `link`. Taken
     * out of the stream, never passed to the client, and held for the next admission only when
     * `successionRefusal` finds nothing; otherwise held not at all, so that admission is compared
     * with the binding the relay already holds, as at PR1051-R1.
     */
    const takeSuccession = (link: Link, message: RelayedMessage): void => {
      const announced = message.id === undefined ? parseRestoreSuccession(message.params) : null;
      if (announced === null) {
        io.stderr.write("attach: restore succession refused: malformed\n");
        return;
      }
      const refusal = successionRefusal(announced, link.admitted, link.answeredChallenge, succession !== null);
      if (refusal !== null) {
        io.stderr.write(`attach: restore succession refused: ${refusal}\n`);
        return;
      }
      succession = announced.to;
    };

    /** Keeps a replayable request now that the daemon answered it, and only if it succeeded. */
    const settleReplayable = (link: Link, key: string, message: RelayedMessage): void => {
      const initialize = link.initializes.get(key);
      if (initialize === undefined) return;
      link.initializes.delete(key);
      if (succeeded(message)) clientInitialize = initialize;
    };

    const send = (link: Link, line: string): void => {
      if (link.socket.write(`${line}\n`)) return;
      if (daemonBlocked) return;
      daemonBlocked = true;
      link.socket.once("drain", () => {
        if (current !== link) return;
        daemonBlocked = false;
        flow();
      });
    };

    /** An id for one of the relay's own requests on `link`, past any id in flight there. */
    const nextInternalId = (link: Link, prefix: string): string => {
      let id: string;
      do {
        internalIds += 1;
        id = `${prefix}-${internalIds}`;
      } while (link.inFlight.has(idKey(id)));
      return id;
    };

    const fromClient = lineSplitter((line) => {
      const message = parseRelayed(line);
      const id = message === null ? undefined : requestIdOf(message);
      const link = current;
      if (phase !== "live" || link === null) {
        // Answered at once and remembered nowhere: a request reported as not sent is never sent later.
        if (id !== undefined) undelivered(id, "agent-control-plane is reattaching; this request was not sent");
        return;
      }
      noteChallengeAnswer(link, message);
      // Every line leaves exactly as it arrived, under the client's own id.
      if (id !== undefined) {
        const key = idKey(id);
        link.inFlight.set(key, { client: id });
        noteReplayable(link, key, message as RelayedMessage, line);
      } else if (message?.method === "notifications/initialized") {
        clientInitialized = line;
      }
      send(link, line);
    }, () => protocolFailure("client line"));
    // Paused between chunks rather than inside one: a chunk is bounded by stdin's own high-water
    // mark, so what one chunk can add to stdout is bounded as well.
    const onClientData = (chunk: Buffer): void => {
      fromClient(chunk);
      flow();
    };

    const fromDaemon = (link: Link, line: string): void => {
      // An abandoned socket speaks to nobody: not to the client, and not to another link's waiters.
      if (current !== link) return;
      if (!link.accepted) {
        // A claim's handshake is answered by a refusal line or by nothing at all.
        const reply = classifyFirstLine(line);
        if (reply.kind === "malformed") return protocolFailure("handshake reply");
        if (reply.kind === "refusal") {
          io.stderr.write(`attach: handshake refused ${reply.reasonCode}\n`);
          return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
        }
        link.accepted = true;
      }
      const message = parseRelayed(line);
      if (message !== null) {
        if (message.method === RESTORE_SUCCESSION_METHOD) return takeSuccession(link, message);
        noteChallenge(link, message);
      }
      const id = message === null ? undefined : responseIdOf(message);
      if (id !== undefined) {
        const key = idKey(id);
        const waiter = link.waiters.get(key);
        if (waiter !== undefined) return waiter(message);
        if (link.inFlight.delete(key)) settleReplayable(link, key, message as RelayedMessage);
      }
      toClient(line);
    };

    const lost = (link: Link): void => {
      link.closed = true;
      for (const waiter of [...link.waiters.values()]) waiter(null);
      if (current !== link) return;
      current = null;
      daemonBlocked = false;
      if (phase === "done") return;
      const unanswered = [...link.inFlight.values()];
      link.inFlight.clear();
      for (const { client } of unanswered) {
        undelivered(client, "the agent-control-plane connection closed before this request was answered; its outcome is unknown");
      }
      // A link lost while it was being restored is noticed by that restore, through its waiters,
      // and the wait already running carries on; no second wait starts.
      if (phase === "reattaching") return flow();
      if (stdinEnded) return end(ATTACH_EXIT.OK);
      // A claim's connection that closed before its first line, with no refusal, went away like any
      // other; only a refusal line ends the attach.
      void reattach();
    };

    const open = (socket: Socket, accepted: boolean, admitted: Admission): Link => {
      const link: Link = {
        socket,
        admitted,
        accepted,
        closed: false,
        inFlight: new Map(),
        waiters: new Map(),
        initializes: new Map(),
        challenge: null,
        answeredChallenge: null,
      };
      current = link;
      daemonBlocked = false;
      const split = lineSplitter((line) => fromDaemon(link, line), () => {
        if (current === link) protocolFailure("daemon line");
      });
      socket.on("data", (chunk: Buffer) => {
        split(chunk);
        flow();
      });
      socket.on("error", () => undefined);
      socket.once("close", () => lost(link));
      socket.resume();
      return link;
    };

    const abandon = (link: Link): void => {
      if (current === link) current = null;
      link.socket.destroy();
    };

    /** One relay-originated request on `link`; null when it closes, nothing answers in time, or the wait ends. */
    const ask = (link: Link, id: unknown, line: string, deadlineAt: number, signal: AbortSignal): Promise<RelayedMessage | null> =>
      new Promise((resolveAsk) => {
        if (link.closed) return resolveAsk(null);
        if (signal.aborted) return resolveAsk(null);
        const key = idKey(id);
        let answered = false;
        const answer = (message: RelayedMessage | null): void => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", giveUp);
          link.waiters.delete(key);
          resolveAsk(message);
        };
        const giveUp = (): void => answer(null);
        const timer = setTimeout(giveUp, Math.max(0, Math.min(policy.attemptTimeoutMs, deadlineAt - Date.now())));
        signal.addEventListener("abort", giveUp, { once: true });
        link.waiters.set(key, answer);
        link.socket.write(`${line}\n`);
      });

    const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolveSleep) => {
        const wake = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          resolveSleep();
        };
        const timer = setTimeout(wake, ms);
        signal.addEventListener("abort", wake, { once: true });
      });

    /**
     * Restores a fresh link to where the lost one was; false when it closes or the wait ends meanwhile.
     *
     * The last thing asked is a `ping` under an id of the relay's own, and its answer is the point at
     * which the relay stops refusing the client: the daemon sends the client `tools/list_changed`
     * once it has answered it.
     */
    const restore = async (link: Link, deadlineAt: number, signal: AbortSignal): Promise<boolean> => {
      const initialize = clientInitialize;
      if (initialize !== null) {
        if ((await ask(link, initialize.message.id, initialize.line, deadlineAt, signal)) === null) return false;
        if (clientInitialized !== null) link.socket.write(`${clientInitialized}\n`);
        const id = nextInternalId(link, RESTORED_PING_PREFIX);
        const answer = await ask(link, id, JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }), deadlineAt, signal);
        if (answer === null) return false;
      }
      return current === link;
    };

    /** The one wait for a daemon that went away. */
    const reattach = async (): Promise<void> => {
      if (waiting !== null) return;
      phase = "reattaching";
      const abort = new AbortController();
      const deadlineAt = Date.now() + policy.maxWaitMs;
      const expire = (): void => {
        if (phase !== "reattaching") return;
        io.stderr.write("attach: daemon did not return\n");
        end(ATTACH_EXIT.UNAVAILABLE);
      };
      // An unbounded wait arms no deadline: `setTimeout` would read Infinity as an immediate one.
      const wait = { abort, deadline: Number.isFinite(policy.maxWaitMs) ? setTimeout(expire, policy.maxWaitMs) : undefined };
      waiting = wait;
      flow();
      const left = (): number => deadlineAt - Date.now();
      let delay = policy.initialDelayMs;
      for (;;) {
        if (phase !== "reattaching") return;
        if (left() <= 0) return expire();
        const outcome = await attemptReattach(reattachSocketPath, Math.min(policy.attemptTimeoutMs, left()), abort.signal);
        if (phase !== "reattaching") {
          if (outcome.kind === "admitted") outcome.socket.destroy();
          return;
        }
        if (outcome.kind === "refused") {
          io.stderr.write(`attach: reattach refused ${outcome.reasonCode}\n`);
          return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
        }
        if (outcome.kind === "malformed") return protocolFailure("reattach reply");
        if (outcome.kind === "unbound") {
          io.stderr.write(`attach: reattach refused ${CTO_REATTACH_UNBOUND}\n`);
          return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
        }
        if (outcome.kind === "admitted") {
          // An acknowledgement that names nothing cannot be compared, so it is refused rather than
          // admitted unchecked.
          if (outcome.tuple === null) {
            outcome.socket.destroy();
            return protocolFailure("reattach reply");
          }
          // Review S2B-R1-01 — a succession is this admission's to use or lose: taken away here
          // whatever the admission names, so it is never adopted by a later one.
          const proven = succession;
          succession = null;
          const next = readmitted(outcome.tuple, admittedUnder, proven);
          if (next === null) {
            outcome.socket.destroy();
            // The relay found the mismatch itself, so it writes its own stage message rather than a
            // daemon reason code it was not sent.
            io.stderr.write("attach: reattach admitted another binding\n");
            return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
          }
          // The restored binding, adopted as the one every later reconnect is compared with.
          admittedUnder = next;
          const link = open(outcome.socket, true, next);
          if (await restore(link, deadlineAt, abort.signal)) {
            clearTimeout(wait.deadline);
            waiting = null;
            phase = "live";
            flow();
            return;
          }
          if (phase !== "reattaching") return;
          abandon(link);
        }
        if (left() <= 0) return expire();
        await sleep(Math.min(delay, left()), abort.signal);
        delay = Math.min(delay * 2, policy.maxDelayMs);
      }
    };

    io.stdin.once("end", () => {
      stdinEnded = true;
      const link = current;
      // Live, the daemon's side is let finish what it owes the client; its close then ends the relay.
      if (phase === "live" && link !== null) {
        link.socket.end();
        return;
      }
      end(ATTACH_EXIT.OK);
    });
    io.stdin.once("error", () => end(ATTACH_EXIT.STREAM_CLOSED));
    io.stdout.once("error", () => {
      stdoutFailed = true;
      if (phase === "done") resolveOnce(ATTACH_EXIT.STREAM_CLOSED);
      else end(ATTACH_EXIT.STREAM_CLOSED);
    });

    const begin = (): void => {
      if (phase !== "connecting") return;
      connection.handshake(first);
      open(first, firstAdmitted, initial);
      phase = "live";
      io.stdin.on("data", onClientData);
      flow();
    };
    if (first.pending) {
      first.once("connect", begin);
      first.once("error", () => {
        if (phase !== "connecting") return;
        io.stderr.write("attach: mcp socket unavailable\n");
        end(ATTACH_EXIT.UNAVAILABLE);
      });
    } else {
      begin();
    }
  });
