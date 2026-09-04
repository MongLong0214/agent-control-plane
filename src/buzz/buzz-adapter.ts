import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { Clock } from "../core/clock.ts";
import { type Decision, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { RoleBinding } from "../domain/types.ts";
import type { OutboxMessage } from "../outbox/outbox.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

const exec = promisify(execFile);

/**
 * What the relay says it did with one send (#760).
 *
 * `mentionPubkeys` is the relay's own resolution, not an echo of what was asked for. That
 * distinction is the whole point: a `@name` in the body may be presentation-only text the
 * relay never resolved to a member, and reading the body cannot tell the two apart. The relay
 * already answers the question; before this it was discarded at the `stdio` boundary.
 */
export interface BuzzSendReceipt {
  eventId: string;
  mentionPubkeys: readonly string[];
}

/** Transport seam so delivery can be exercised without a live relay. */
export interface BuzzTransport {
  /** Resolve or create the address a session is reachable at. */
  openChannel(purpose: string): Promise<string>;
  /**
   * `recipients` are Buzz channel identities that must be notified by this message.
   *
   * A required argument rather than an option, because the defect being closed is a send
   * that addressed nobody and reported success. There is no shape of this call that omits
   * the recipients and still compiles, which is the only version of the rule that survives
   * a caller who has not read #760.
   */
  send(
    channel: string,
    content: string,
    recipients: readonly string[],
  ): Promise<BuzzSendReceipt>;
  /**
   * Whether this transport can actually be used. Given a purpose it must answer for that
   * purpose — "the binary runs" and "the relay has rooms" are not the same question, and
   * answering the easier one is how #423 shipped.
   */
  available(purpose?: string): Promise<boolean>;
}

/**
 * A channel as the installed CLI reports it. `buzz channels list` and `buzz channels get`
 * both key the identity as `channel_id`; there is no `id` field. Captured from the
 * installed CLI against the live relay — see `tests/fixtures/buzz-cli/`.
 */
interface BuzzCliChannel {
  channel_id: string;
  name?: string;
  description?: string;
  created_at?: number;
}

/** A message as `buzz messages get` reports it. There is no `messages list` subcommand. */
export interface BuzzCliMessage {
  id: string;
  content: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}

/**
 * The CLI writes errors as JSON on stderr and exits non-zero, so a non-zero exit is already
 * an exception here. This guards the other direction: a zero exit whose stdout is not the
 * payload we expect must not be read as an empty channel list, which `available()` would
 * then report as a healthy-but-empty relay.
 */
const parseJson = (stdout: string, what: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`buzz ${what} returned unparseable output: ${stdout.trim().slice(0, 200)}`);
  }
};

/**
 * A channel is only a channel once it carries the identity this adapter will send to.
 *
 * Parsing to `as BuzzCliChannel` was a cast, not a check: a row that matched by name while
 * omitting `channel_id` produced `undefined`, `available()` reported the transport usable,
 * and the undefined address reached delivery — which is #423's original defect wearing the
 * new field name. Validating here is what makes the cast honest.
 */
const asChannel = (value: unknown, what: string): BuzzCliChannel => {
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { channel_id?: unknown }).channel_id !== "string" ||
    (value as { channel_id: string }).channel_id.length === 0
  ) {
    throw new Error(`buzz ${what} returned a channel without a channel_id`);
  }
  return value as BuzzCliChannel;
};

const asChannelList = (value: unknown, what: string): BuzzCliChannel[] => {
  if (!Array.isArray(value)) throw new Error(`buzz ${what} did not return a list of channels`);
  return value.map((entry) => asChannel(entry, what));
};

/**
 * The subject of a purpose: the last `:` segment. A purpose is `role:subject` — the callers
 * build `primary-cto:${projectId}` (`cto-lifecycle.ts:852`), `continuity:${role}`, and so
 * on — so the subject is the part that could name a room, and the role prefix never is.
 *
 * Two narrower rules than the obvious one, both for the same reason. Substring matching was
 * tried and dropped: on a shared relay `commitlore-x` contains `commitlore`, so a purpose
 * could resolve to somebody else's room. Matching *any* segment was then tried and dropped
 * too: `primary-cto:prj_7` would match a room literally named `primary-cto`, which is a
 * plausible room name on a relay whose members talk about their agents, and every project
 * would deliver into it.
 */
const purposeSubject = (purpose: string): string | null => {
  const segments = purpose.split(":").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : null;
};

/**
 * Real transport over the `buzz` CLI.
 *
 * The relay credential lives in the daemon's environment and is never forwarded to an
 * agent session or a verification subprocess (§33.3).
 *
 * Every argv here is pinned by `tests/unit/buzz-cli-surface.test.ts` against the surface
 * the installed CLI actually exposes. The previous implementation passed `--json` to
 * `channels list`, which that CLI rejects outright, and read `id` from a payload that
 * carries `channel_id` — neither of which any modelled test could see, because the tests
 * replace this class with a double.
 */
export class BuzzCliTransport implements BuzzTransport {
  constructor(
    private readonly binary = "buzz",
    private readonly defaultChannel: string | null = null,
  ) {}

  /**
   * Proves this transport can open the channel it is about to use — not that the binary is
   * installed, and not that the relay has rooms in it.
   *
   * `--help` succeeds with no relay, no credential and no network, which is how the old
   * check reported a healthy channel right up until the first `openChannel` failed at
   * dispatch time. Answering "some channel exists" has the same defect in a new form: no
   * production purpose is named after a room — they are all `role:projectId` — so a relay
   * full of other people's rooms would still report healthy and still fail at connect.
   *
   * So `available` asks the same question `openChannel` will, for the same purpose. Called
   * without one it can only prove the authenticated round-trip, and it says so by requiring
   * a bound `defaultChannel` before claiming more.
   */
  async available(purpose?: string): Promise<boolean> {
    if (!process.env["BUZZ_PRIVATE_KEY"]) return false;
    try {
      if (purpose !== undefined) {
        await this.openChannel(purpose);
        return true;
      }
      if (this.defaultChannel) {
        await this.#requireChannel(this.defaultChannel);
        return true;
      }
      // No purpose and no bound channel: nothing here can name a channel to open, so
      // claiming the transport is usable would be the #423 defect again.
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the channel a purpose is reachable at, refusing rather than guessing.
   *
   * A configured `defaultChannel` is verified to exist before it is returned: an address
   * that does not resolve is a connect-time failure, not a delivery-time one.
   */
  async openChannel(purpose: string): Promise<string> {
    if (this.defaultChannel) return (await this.#requireChannel(this.defaultChannel)).channel_id;

    const channels = await this.#listChannels();
    const subject = purposeSubject(purpose);
    const match = subject === null
      ? undefined
      : channels.find((c) => c.name === subject);
    // Falling back to `channels[0]` was tried and dropped: an unmatched purpose would
    // deliver a fenced envelope into whichever room the relay happened to list first.
    //
    // Name resolution is a convenience for a relay whose rooms are named after projects.
    // Production purposes carry a project *id* (`cto:prj_…`, `cto-lifecycle.ts:852`), which
    // will not match a human room name — so a deployment binds `ACP_BUZZ_CHANNEL` and takes
    // the verified default-channel path above. Refusing here is what makes that visible at
    // connect time instead of delivering somewhere arbitrary.
    if (!match) {
      throw new Error(
        `no buzz channel matches purpose ${purpose}` +
          ` (available: ${channels.map((c) => c.name ?? "?").join(", ")};` +
          ` set ACP_BUZZ_CHANNEL to bind one explicitly)`,
      );
    }
    return match.channel_id;
  }

  /** `messages get` — the CLI has no `messages list`. Used to read a delivery back. */
  async readBack(channel: string, limit = 10): Promise<BuzzCliMessage[]> {
    const { stdout } = await exec(
      this.binary,
      BUZZ_CLI_INVOCATIONS.messagesGet(channel, limit),
      { encoding: "utf8", timeout: 30_000 },
    );
    const messages = parseJson(stdout, "messages get");
    if (!Array.isArray(messages)) throw new Error("buzz messages get did not return a list");
    return messages as BuzzCliMessage[];
  }

  async #listChannels(): Promise<BuzzCliChannel[]> {
    // No `--json`: the installed CLI rejects the flag and already emits JSON without it.
    const { stdout } = await exec(this.binary, BUZZ_CLI_INVOCATIONS.channelsList(), {
      encoding: "utf8",
      timeout: 30_000,
    });
    return asChannelList(parseJson(stdout, "channels list"), "channels list");
  }

  /**
   * Resolves a channel id and proves the relay answered about *that* channel.
   *
   * The identity check is the point: `channels get` takes a `--channel` argument the relay
   * is free to interpret, and a configured value that resolves to a different room must be
   * a refusal rather than a silent redirect of every envelope this daemon sends.
   */
  async #requireChannel(channelId: string): Promise<BuzzCliChannel> {
    const { stdout } = await exec(this.binary, BUZZ_CLI_INVOCATIONS.channelsGet(channelId), {
      encoding: "utf8",
      timeout: 30_000,
    });
    const channel = asChannel(parseJson(stdout, "channels get"), "channels get");
    if (channel.channel_id !== channelId) {
      throw new Error(`buzz channel ${channelId} resolved to ${channel.channel_id}`);
    }
    return channel;
  }

  async send(
    channel: string,
    content: string,
    recipients: readonly string[],
  ): Promise<BuzzSendReceipt> {
    const named = normaliseRecipients(recipients);
    // Before the spawn, not after it. A send that addresses nobody has nothing to gain from
    // being transmitted, and transmitting it is what produces the `accepted: true` that reads
    // as success afterwards.
    if (named.length === 0) {
      throw acpError(
        ReasonCode.BUZZ_SEND_UNADDRESSED,
        `buzz send to ${channel} named no recipient`,
        { channel },
      );
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.binary,
        BUZZ_CLI_INVOCATIONS.messagesSend(channel, named),
        // stdout was `ignore` here, which is where the relay's answer about who it notified
        // was being thrown away.
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let settled = false;
      let stderr = "";
      let out = "";
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error("buzz send timed out after 60000ms"));
      }, 60_000);

      child.once("error", (error) => finish(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        out = `${out}${chunk.toString("utf8")}`.slice(-64_000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
      });
      child.once("close", (code, signal) => {
        if (code === 0) finish(undefined, out);
        else {
          finish(
            new Error(
              `buzz send failed${signal ? ` (${signal})` : ""}${stderr ? `: ${stderr.trim()}` : ""}`,
            ),
          );
        }
      });
      child.stdin?.once("error", (error) => finish(error));
      child.stdin?.end(content, "utf8");
    });

    const receipt = asSendReceipt(stdout);
    const unresolved = named.filter((pubkey) => !receipt.mentionPubkeys.includes(pubkey));
    // Exit 0 is the relay saying it stored the event. It is not the relay saying it notified
    // the identities this message named, and those are the two facts #760 stopped conflating.
    if (unresolved.length > 0) {
      throw acpError(
        ReasonCode.BUZZ_MENTION_NOT_RESOLVED,
        `buzz relay did not resolve ${unresolved.length} recipient(s) on ${channel}`,
        { channel, unresolved, resolved: receipt.mentionPubkeys, eventId: receipt.eventId },
      );
    }
    return receipt;
  }
}

/** Recipients, trimmed and de-duplicated, preserving the caller's order. */
const normaliseRecipients = (recipients: readonly string[]): string[] => [
  ...new Set(recipients.map((pubkey) => pubkey.trim()).filter((pubkey) => pubkey.length > 0)),
];

/**
 * Reads the send result the CLI prints.
 *
 * A missing or unparseable `mention_pubkeys` is an error rather than an empty list: treating
 * "the relay did not say" as "the relay notified nobody" would be a guess, and treating it as
 * success would restore exactly the hole this closes. Both readings are wrong, so neither is
 * taken.
 */
const asSendReceipt = (stdout: string): BuzzSendReceipt => {
  const parsed = parseJson(stdout, "messages send");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("buzz messages send did not return an object");
  }
  const record = parsed as Record<string, unknown>;
  const mentions = record.mention_pubkeys;
  if (!Array.isArray(mentions) || mentions.some((value) => typeof value !== "string")) {
    throw new Error("buzz messages send did not report mention_pubkeys");
  }
  const eventId = record.event_id;
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new Error("buzz messages send did not report an event_id");
  }
  return { eventId, mentionPubkeys: (mentions as string[]).map((pubkey) => pubkey.trim()) };
};

/** In-memory transport for scenario tests; records what would have been delivered. */
export class InMemoryBuzzTransport implements BuzzTransport {
  readonly sent: Array<{ channel: string; content: string; recipients: readonly string[] }> = [];
  #available = true;
  #nextEventId = 0;
  #unresolvable = new Set<string>();

  /** Makes the fake relay decline to resolve a pubkey, the way a non-member is declined. */
  setUnresolvable(pubkeys: readonly string[]): void {
    this.#unresolvable = new Set(pubkeys);
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  async available(_purpose?: string): Promise<boolean> {
    return this.#available;
  }

  async openChannel(purpose: string): Promise<string> {
    if (!this.#available) throw new Error("buzz transport unavailable");
    return `channel:${purpose}`;
  }

  async send(
    channel: string,
    content: string,
    recipients: readonly string[],
  ): Promise<BuzzSendReceipt> {
    // The same two refusals as the real transport, in the same order. A fake that accepts
    // what production rejects makes every scenario test a statement about the fake.
    const named = normaliseRecipients(recipients);
    if (named.length === 0) {
      throw acpError(
        ReasonCode.BUZZ_SEND_UNADDRESSED,
        `buzz send to ${channel} named no recipient`,
        { channel },
      );
    }
    if (!this.#available) throw new Error("buzz transport unavailable");
    const receipt: BuzzSendReceipt = {
      eventId: `event:${(this.#nextEventId += 1)}`,
      mentionPubkeys: named.filter((pubkey) => !this.#unresolvable.has(pubkey)),
    };
    const unresolved = named.filter((pubkey) => !receipt.mentionPubkeys.includes(pubkey));
    if (unresolved.length > 0) {
      throw acpError(
        ReasonCode.BUZZ_MENTION_NOT_RESOLVED,
        `buzz relay did not resolve ${unresolved.length} recipient(s) on ${channel}`,
        { channel, unresolved, resolved: receipt.mentionPubkeys, eventId: receipt.eventId },
      );
    }
    this.sent.push({ channel, content, recipients: named });
    return receipt;
  }
}

/**
 * PRD §27.2, §27.5.
 *
 * Buzz is a transport, not an authority. An inbound Buzz channel identity is mapped to an *active
 * role binding* before it can act; a display name grants nothing. Outbound delivery
 * only ever carries fenced envelopes whose generation is still current.
 */
/**
 * Every buzz CLI invocation this adapter makes, in one place (#520).
 *
 * The CLI has no `--version`, so a contract mismatch cannot be detected at startup — it surfaces
 * as an argument-parse error inside whatever operation was running. #423 was exactly that. These
 * are named here so `scripts/verify-buzz-cli-contract.mjs` can check each one against the
 * installed CLI's declared options rather than against someone's memory of them.
 *
 * The builders return the real argv the adapter passes, so the check exercises the same values
 * the transport does. A table that merely described the calls would drift from them silently,
 * which is the failure this exists to prevent.
 */
export const BUZZ_CLI_INVOCATIONS = {
  channelsList: () => ["channels", "list"],
  channelsGet: (channelId: string) => ["channels", "get", "--channel", channelId],
  messagesGet: (channel: string, limit: number) =>
    ["messages", "get", "--channel", channel, "--limit", String(limit)],
  messagesSend: (channel: string, recipients: readonly string[]) => [
    "messages",
    "send",
    "--channel",
    channel,
    // stdin, never an argv-borne body: a shell that eats a backtick in the content still
    // produces exit 0 and an accepted event, so the argument form has no failure mode a
    // caller can see.
    "--content",
    "-",
    ...recipients.flatMap((pubkey) => ["--mention", pubkey]),
  ],
} as const;

export class BuzzAdapter {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly transport: BuzzTransport,
  ) {}

  async connect(sessionId: string, purpose: string): Promise<Decision<string>> {
    if (!(await this.transport.available(purpose))) {
      return deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", { sessionId, purpose });
    }
    try {
      const address = await this.transport.openChannel(purpose);
      this.sessions.setBuzzAddress(sessionId, address);
      this.audit.record({
        kind: "BUZZ_CONNECTED",
        sessionId,
        evidence: { purpose, address },
      });
      return allow(ReasonCode.OK, address);
    } catch (err) {
      return deny(ReasonCode.PROBE_FAILED, `buzz connect failed: ${(err as Error).message}`, {
        sessionId,
        purpose,
      });
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    this.sessions.setBuzzAddress(sessionId, null);
  }

  /**
   * §27.2 — resolve an inbound Buzz channel identity to the role it currently holds.
   *
   * Resolution goes through `sessions.buzz_actor_id`, which only an authenticated writer can
   * set (`SessionRegistry.bindBuzzActor`). A delivery channel or display name is never
   * consulted: it is a shared routing address, not proof of a sender's identity. An actor
   * with no such binding, whose session is not live, or whose session holds no active role
   * resolves to null — granting nothing is the only safe default.
   */
  resolveActor(buzzActorId: string): RoleBinding | null {
    const session = this.db.get<{ session_id: string }>(
      `SELECT session_id FROM sessions
        WHERE buzz_actor_id = ? AND lifecycle IN ('READY','DRAINING')`,
      [buzzActorId],
    );
    if (!session) return null;
    return this.bindings.bySession(session.session_id).find((b) => b.status === "ACTIVE") ?? null;
  }

  /**
   * Deliver everything currently deliverable. `claimDeliverable` already filters to the
   * generation that is active, so a message addressed to a revoked binding is never
   * transmitted (§27.5).
   */
  async deliverPending(limit = 25): Promise<{ delivered: string[]; failed: string[] }> {
    const delivered: string[] = [];
    const failed: string[] = [];

    for (const message of this.outbox.claimDeliverable(limit)) {
      const session = this.sessions.get(message.targetSessionId);
      const channel = session?.buzzAddress;
      if (!channel) {
        this.outbox.markAttemptFailed(
          message.messageId,
          message.claimToken,
          {
            failureClass: "contract",
            retryable: false,
            error: "target session has no buzz address",
          },
        );
        failed.push(message.messageId);
        continue;
      }
      // #760 — the recipient is not new information. `sessions.buzz_actor_id` is the same
      // column `resolveActor` reads inbound, written only by an authenticated
      // `bindBuzzActor`; the channel says which room, and this says who in it. A target with
      // no bound identity cannot be addressed, and the answer to that is to refuse the
      // delivery rather than to send an unaddressed message into the room and call it sent.
      const recipient = session?.buzzActorId;
      if (!recipient) {
        this.outbox.markAttemptFailed(
          message.messageId,
          message.claimToken,
          {
            failureClass: "contract",
            retryable: false,
            error: "target session has no bound buzz channel identity to address",
          },
        );
        failed.push(message.messageId);
        continue;
      }
      try {
        await this.transport.send(channel, render(message), [recipient]);
        // Completing the delivery is a compare-and-set on the claim: if the claim was
        // reclaimed or the message retargeted while we were sending, this fails and the
        // message stays eligible rather than being marked sent to a revoked session.
        const completed = this.outbox.markSent(message.messageId, message.claimToken);
        if (completed.allowed) delivered.push(message.messageId);
        else failed.push(message.messageId);
      } catch (err) {
        this.outbox.markAttemptFailed(
          message.messageId,
          message.claimToken,
          classifyTransportFailure(err),
        );
        failed.push(message.messageId);
      }
    }

    if (delivered.length > 0 || failed.length > 0) {
      this.audit.record({
        kind: "BUZZ_DELIVERY",
        evidence: { delivered: delivered.length, failed: failed.length, at: this.clock.nowIso() },
      });
    }
    return { delivered, failed };
  }
}

/**
 * The wire form carries the fence explicitly, so a receiving session can reject a
 * message that does not match the generation it believes it holds.
 */
const render = (message: OutboxMessage): string =>
  [
    `<acp-envelope roleKey="${message.roleKey}" bindingGeneration="${message.bindingGeneration}"`,
    ` targetSessionId="${message.targetSessionId}" runId="${message.runId ?? ""}"`,
    ` messageId="${message.messageId}"`,
    ` payloadDigest="${message.payloadDigest}" expiresAt="${message.expiresAt}">`,
    `\n${message.kind}\n`,
    JSON.stringify(message.payload, null, 2),
    "\n</acp-envelope>",
  ].join("");

const classifyTransportFailure = (error: unknown): {
  failureClass: "transient" | "contract" | "security" | "unknown_observed";
  retryable: boolean;
  error: string;
} => {
  const message = error instanceof Error ? error.message : String(error);
  // #760 — matched by type, above the regexes. These two carry a reason code, and keying them
  // on their wording would make a reworded message silently reclassify itself; every pattern
  // below is a guess about a string some other program produced, which is why they are guesses
  // and these are not. Both are `contract`: an unaddressed message and a recipient the relay
  // does not consider a member are facts about this message, not about the network, and
  // sending it again unchanged reproduces them exactly.
  if (
    isAcpError(error) &&
    (error.reasonCode === ReasonCode.BUZZ_SEND_UNADDRESSED ||
      error.reasonCode === ReasonCode.BUZZ_MENTION_NOT_RESOLVED)
  ) {
    return { failureClass: "contract", retryable: false, error: message };
  }
  // #451 — a timeout is the one transport failure where the outcome is genuinely unknown. The
  // frame may already be at the far end: `send` returning late says nothing about whether it
  // arrived. Retrying then delivers the same envelope twice, which is the destination
  // exactly-once gap this issue names.
  //
  // The other patterns here are different in kind. A refused connection, an unresolved host or
  // an unavailable service failed *before* anything left, so retrying is safe. Grouping the
  // timeout with them collapsed "I do not know" into "it did not happen" — the same fold as
  // A1 (#448), where an unknown is reported as a definite answer.
  //
  // `unknown_observed` already existed for exactly this and the timeout was not in it.
  if (/timed out|timeout|etimedout/i.test(message)) {
    return { failureClass: "unknown_observed", retryable: false, error: message };
  }
  if (/econn|enotfound|network|temporar|unavailable/i.test(message)) {
    return { failureClass: "transient", retryable: true, error: message };
  }
  if (/auth|permission|forbidden|credential/i.test(message)) {
    return { failureClass: "security", retryable: false, error: message };
  }
  if (/channel|target|invalid|not found/i.test(message)) {
    return { failureClass: "contract", retryable: false, error: message };
  }
  return { failureClass: "unknown_observed", retryable: false, error: message };
};
