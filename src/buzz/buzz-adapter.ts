import { execFile, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, digestOf, sha256Hex } from "../core/digest.ts";
import { HostProvisionerError, hostObservationSchema, type HostProjectProvisioner } from "../runtime/host-project-provisioner.ts";
import { buzzPolicyHoldReason, currentCanonicalCeoBuzzRoute, daemonBuzzSigner, isBuzzRecipientRefusal, isBuzzSignerRefusal, type BuzzPolicyBinding, type BuzzPolicyIdentity, type BuzzPolicyReadiness, type CanonicalCeoBuzzRoute } from "../outbox/ceo-buzz-signer.ts";
import { MessageKind } from "../outbox/envelope.ts";

import type { Clock } from "../core/clock.ts";
import { type Decision, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { RoleBinding } from "../domain/types.ts";
import type { OutboxMessage } from "../outbox/outbox.ts";
import { hermesCanonicalRuntimeSql, liveDeliveryTarget, type Outbox } from "../outbox/outbox.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

const exec = promisify(execFile);
// Only concurrent in-process effects wait for their receipt. Durable intents suppress joins
// across restarts, while an independent later roster observation may settle a lost receipt.
const activeCeoMembershipEnsures = new WeakMap<Db, Set<string>>();

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

export interface BuzzSignerReadiness {
  signer: string;
  registered: boolean;
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
  /** Observe this transport's actual sending key in the exact room; null means unverified. */
  signerReadiness?(channel: string): Promise<BuzzSignerReadiness | null>;
  /** Fingerprint only. The wrapper remains the sole send-policy authority. */
  localSendPolicyDigest?(): string | null;
  /** Invoke the wrapper's shared evaluator without dispatching a message. */
  policyReadiness?(channel: string, content: string, recipient: string, signer: string): Promise<BuzzPolicyReadiness>;
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
  // Pin the same credential for readback and send, including across an awaited roster read.
  private readonly signingKey = process.env["BUZZ_PRIVATE_KEY"];
  #environment(): NodeJS.ProcessEnv { return { ...process.env, BUZZ_PRIVATE_KEY: this.signingKey ?? "" }; }

  async signerReadiness(channel: string): Promise<BuzzSignerReadiness | null> {
    const signer = daemonBuzzSigner(this.signingKey);
    if (!signer) return null;
    try {
      await this.#requireChannel(channel);
      // Same roster read used by host-project-provisioner; no membership mutation or probe post.
      const { stdout } = await exec(this.binary, BUZZ_CLI_INVOCATIONS.channelsMembers(channel), {
        encoding: "utf8", timeout: 30_000, env: this.#environment(),
      });
      const members = parseJson(stdout, "channels members");
      if (!Array.isArray(members) || members.some(m => !m || typeof m.pubkey !== "string" || !/^[a-f0-9]{64}$/.test(m.pubkey) ||
        !["owner", "admin", "member"].includes(m.role))) return null;
      return { signer, registered: members.some(m => m.pubkey === signer) };
    } catch { return null; }
  }

  constructor(
    private readonly binary = "buzz",
    private readonly defaultChannel: string | null = null,
    private readonly sendPolicyFile = process.env["ACP_BUZZ_SEND_POLICY_FILE"],
  ) {}

  localSendPolicyDigest(): string | null {
    if (!this.sendPolicyFile || !isAbsolute(this.sendPolicyFile)) return null;
    try { return sha256Hex(readFileSync(this.sendPolicyFile)); }
    catch { return null; }
  }

  async policyReadiness(channel: string, content: string, recipient: string, signer: string): Promise<BuzzPolicyReadiness> {
    const policyIdentity: BuzzPolicyIdentity = { configured: { file: null, digest: null }, reported: { file: null, digest: null } };
    const unknown: BuzzPolicyReadiness = { verdict: "undeterminable", policyDigest: null, signer: null, recipient: null, policyIdentity };
    const sendPolicyFile = this.sendPolicyFile;
    if (!sendPolicyFile || !isAbsolute(sendPolicyFile)) return unknown;
    try {
      // Ask the same executable used by send, never a wrapper selected by a policy copy.
      const policyFile = realpathSync(sendPolicyFile);
      policyIdentity.configured = { file: policyFile, digest: this.localSendPolicyDigest() };
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = execFile(this.binary, ["__acp_policy_check_v1__", "--channel", channel, "--content", "-", "--mention", recipient],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 16_000, env: this.#environment() }, (error, stdout) => {
          resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout });
        });
        child.stdin?.on("error", () => { /* A failed check is undeterminable, never a grant. */ });
        child.stdin?.end(content, "utf8");
      });
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      policyIdentity.reported = {
        file: typeof value.policy_file === "string" ? value.policy_file : null,
        digest: typeof value.policy_digest === "string" && /^[a-f0-9]{64}$/.test(value.policy_digest) ? value.policy_digest : null,
      };
      // Compare the evaluated identity with the configured file, including edits during the read.
      policyIdentity.configured = { file: realpathSync(sendPolicyFile), digest: this.localSendPolicyDigest() };
      if (!policyIdentity.configured.digest || policyIdentity.configured.file !== policyFile ||
        policyIdentity.reported.file !== policyIdentity.configured.file ||
        policyIdentity.reported.digest !== policyIdentity.configured.digest) return unknown;
      if (result.stdout.trim().split("\n").length !== 1 || value.protocol !== "acp.buzz-policy-check/v1" ||
        value.policy_file !== policyFile || value.channel !== channel ||
        !["allowed", "refused", "undeterminable"].includes(String(value.verdict))) return unknown;
      const expectedCode = value.verdict === "allowed" ? 0 : value.verdict === "refused" ? 1 : 2;
      if (result.code !== expectedCode || (value.policy_digest !== null &&
        (typeof value.policy_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.policy_digest)))) return unknown;
      if (value.verdict === "allowed" && (value.signer !== signer || value.recipient !== recipient ||
        typeof value.policy_digest !== "string")) return unknown;
      if (value.verdict !== "allowed" && (value.error !== "mention_policy" || value.retryable !== false ||
        typeof value.message !== "string" || value.message.length > 200)) return unknown;
      let cause: BuzzPolicyReadiness["cause"];
      if (value.verdict !== "allowed") {
        cause = typeof value.cause === "string" && ["POLICY", "ROSTER_STATE", "CREDENTIAL", "AUTHORITY", "UNKNOWN"].includes(value.cause)
          ? value.cause as BuzzPolicyReadiness["cause"] : "UNKNOWN";
        if (cause === "ROSTER_STATE" && (value.signer !== signer || value.recipient !== recipient)) cause = "UNKNOWN";
      }
      return { verdict: value.verdict as BuzzPolicyReadiness["verdict"], cause, policyDigest: value.policy_digest as string | null, policyIdentity,
        signer: typeof value.signer === "string" ? value.signer : null,
        recipient: typeof value.recipient === "string" ? value.recipient : null,
        ...(typeof value.message === "string" ? { message: value.message } : {}) };
    } catch { return unknown; }
  }

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
    if (!this.signingKey) return false;
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
      { encoding: "utf8", timeout: 30_000, env: this.#environment() },
    );
    const messages = parseJson(stdout, "messages get");
    if (!Array.isArray(messages)) throw new Error("buzz messages get did not return a list");
    return messages as BuzzCliMessage[];
  }

  async #listChannels(): Promise<BuzzCliChannel[]> {
    // No `--json`: the installed CLI rejects the flag and already emits JSON without it.
    const { stdout } = await exec(this.binary, BUZZ_CLI_INVOCATIONS.channelsList(), {
      encoding: "utf8",
      timeout: 30_000, env: this.#environment(),
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
      timeout: 30_000, env: this.#environment(),
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
        { stdio: ["pipe", "pipe", "pipe"], env: this.#environment() },
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

  async signerReadiness(_channel: string): Promise<BuzzSignerReadiness> {
    return { signer: "in-memory-signer", registered: true };
  }

  async policyReadiness(_channel: string, _content: string, recipient: string, signer: string): Promise<BuzzPolicyReadiness> {
    const digest = (this as { localSendPolicyDigest?: () => string | null }).localSendPolicyDigest?.();
    return { verdict: "allowed", policyDigest: digest ?? sha256Hex("in-memory-policy"), signer, recipient };
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
  channelsMembers: (channelId: string) => ["channels", "members", "--channel", channelId],
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
    private readonly host: HostProjectProvisioner | null = null,
  ) {}

  async #signerReadiness(channel: string): Promise<BuzzSignerReadiness | null> {
    try { return await this.transport.signerReadiness?.(channel) ?? null; }
    catch { return null; }
  }

  async #policyReadiness(message: OutboxMessage, room: string, recipient: string, signer: string): Promise<BuzzPolicyReadiness> {
    let verdict: BuzzPolicyReadiness = { verdict: "undeterminable", policyDigest: null, signer: null, recipient: null };
    try { verdict = await this.transport.policyReadiness?.(room, render(message), recipient, signer) ?? verdict; }
    catch { /* Unavailable authority cannot grant permission. */ }
    if (verdict.verdict === "allowed" && (verdict.signer !== signer || verdict.recipient !== recipient || !verdict.policyDigest)) {
      return { ...verdict, verdict: "undeterminable" };
    }
    return verdict;
  }

  #policyBinding(message: OutboxMessage, room: string, recipient: string, signer: string | null): BuzzPolicyBinding {
    let policyDigest: string | null = null;
    try { policyDigest = this.transport.localSendPolicyDigest?.() ?? null; } catch { /* Unreadable never releases a hold. */ }
    return { routeDigest: digestOf({ targetSessionId: message.targetSessionId, bindingGeneration: message.bindingGeneration,
      room, recipient, canonical: this.#currentCeoRoute(message, room, recipient) }), signer, policyDigest };
  }

  #currentCeoRoute(message: OutboxMessage, room: string, recipient: string): CanonicalCeoBuzzRoute | null {
    const route = currentCanonicalCeoBuzzRoute(this.db);
    return route && route.sessionId === message.targetSessionId && route.bindingGeneration === message.bindingGeneration &&
      route.roomId === room && route.recipient === recipient ? route : null;
  }

  #membershipAudit(kind: string, evidence: Record<string, unknown>, ready: boolean): void {
    const recorded = this.audit.record({ kind,
      reasonCode: ready ? ReasonCode.OK : ReasonCode.BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED, evidence });
    if (!recorded.allowed) throw new Error("CEO signer membership evidence was not recorded");
  }

  #readbackAudit(route: CanonicalCeoBuzzRoute, ready: BuzzSignerReadiness | null, phase: string): void {
    const evidence = { route, room: route.roomId, signer: ready?.signer ?? null,
      registered: ready?.registered ?? null, phase };
    const observationDigest = digestOf(evidence);
    if (this.db.get(`SELECT 1 FROM audit_events WHERE kind = 'CEO_BUZZ_SIGNER_READBACK'
      AND json_extract(evidence_json, '$.observationDigest') = ?`, [observationDigest])) return;
    this.#membershipAudit("CEO_BUZZ_SIGNER_READBACK", { ...evidence, observationDigest }, ready?.registered === true);
  }

  #hostGatesCeo(message: OutboxMessage): boolean {
    return this.host !== null && !!this.db.get(`SELECT 1 WHERE ${hermesCanonicalRuntimeSql("?")}`, [message.targetSessionId]);
  }

  #validatedReceipt(receipt: unknown, route: CanonicalCeoBuzzRoute, signer: string): boolean {
    const parsed = hostObservationSchema.safeParse({ ceoBuzzSigner: receipt });
    return parsed.success && !!parsed.data.ceoBuzzSigner && parsed.data.ceoBuzzSigner.signer === signer &&
      canonicalJson(parsed.data.ceoBuzzSigner.route) === canonicalJson(route);
  }

  #invalidEnsure(route: CanonicalCeoBuzzRoute | null, signer: string | null): boolean {
    // There is one systemic CEO route. Neither a new signer nor a new binding can hide its refusal.
    const history = this.db.all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events
      WHERE kind = 'CEO_BUZZ_SIGNER_ENSURE' ORDER BY rowid`);
    let invalid = false;
    for (const event of history) {
      const evidence = JSON.parse(event.evidence_json);
      if (['INVALID','REFUSED','FAILED'].includes(evidence.state)) invalid = true;
      if (evidence.state === 'SUCCEEDED') {
        if (route && signer && this.#validatedReceipt(evidence.receipt, route, signer)) invalid = false;
        else if (!this.#validatedReceipt(evidence.receipt, evidence.route, evidence.signer)) invalid = true;
      }
    }
    return invalid;
  }

  /** Read-only target lookup is separate from ensure-buzz's sole provisioning effect. */
  async #ceoSignerReadiness(message: OutboxMessage, room: string, recipient: string): Promise<BuzzSignerReadiness | null> {
    if (!this.#hostGatesCeo(message)) {
      const ready = await this.#signerReadiness(room);
      return this.#invalidEnsure(this.#currentCeoRoute(message, room, recipient), ready?.signer ?? null) ? null : ready;
    }
    const route = this.#currentCeoRoute(message, room, recipient);
    if (!route) return null;
    const stillCurrent = () => canonicalJson(this.#currentCeoRoute(message, room, recipient)) === canonicalJson(route);
    const before = await this.#signerReadiness(route.roomId);
    this.#readbackAudit(route, before, "BEFORE_ENSURE");
    if (!stillCurrent() || !before) return null;
    const ensureDigest = digestOf({ route, signer: before.signer });
    const active = activeCeoMembershipEnsures.get(this.db) ?? new Set<string>();
    activeCeoMembershipEnsures.set(this.db, active);
    if (this.#invalidEnsure(route, before.signer) || active.size > 0) return null;
    if (before.registered) return before;
    // Durable intent precedes the call. A failed/lost response never schedules another join,
    // including across overlapping sweeps, other notifications and daemon restarts.
    const ensure = this.db.tx(() => {
      if (!stillCurrent() || this.db.get(`SELECT 1 FROM audit_events WHERE kind = 'CEO_BUZZ_SIGNER_ENSURE'
        AND json_extract(evidence_json, '$.ensureDigest') = ? AND json_extract(evidence_json, '$.state') = 'INTENT'`, [ensureDigest])) return false;
      this.#membershipAudit("CEO_BUZZ_SIGNER_ENSURE", { ensureDigest, route, signer: before.signer, state: "INTENT" }, false);
      if (!this.db.get(`SELECT 1 FROM audit_events WHERE kind = 'CEO_BUZZ_SIGNER_ENSURE'
        AND json_extract(evidence_json, '$.ensureDigest') = ? AND json_extract(evidence_json, '$.state') = 'INTENT'`, [ensureDigest])) {
        throw new Error("CEO membership intent did not survive audit serialization");
      }
      return true;
    });
    if (!ensure) return before;
    active.add(ensureDigest);
    try {
      let state: "SUCCEEDED" | "INVALID" | "REFUSED" | "LOST" = "INVALID";
      let receipt: unknown;
      let refusal: { code: string; message: string } | undefined;
      try {
        // No await between the final target validation and invoking the host boundary.
        if (stillCurrent()) {
          const observed = await this.host!.invoke("ensure-buzz", { mode: "ceo-route-signer", route, signer: before.signer });
          receipt = observed.ceoBuzzSigner;
          state = this.#validatedReceipt(receipt, route, before.signer) && stillCurrent() ? "SUCCEEDED" : "INVALID";
        }
      } catch (error) {
        if (error instanceof HostProvisionerError) { state = error.outcome; refusal = error.refusal; }
      }
      const after = await this.#signerReadiness(route.roomId);
      this.#readbackAudit(route, after, "AFTER_ENSURE");
      if (state === "SUCCEEDED" && (!stillCurrent() || (after && (!after.registered || after.signer !== before.signer)))) state = "INVALID";
      this.#membershipAudit("CEO_BUZZ_SIGNER_ENSURE", { ensureDigest, route, signer: before.signer,
        state, ...(receipt ? { receipt } : {}), ...(refusal ? { refusal } : {}) }, state === "SUCCEEDED");
      if (state !== "SUCCEEDED" || !stillCurrent() || after?.signer !== before.signer) return null;
      return after;
    } finally { active.delete(ensureDigest); }
  }

  async connect(sessionId: string, purpose: string): Promise<Decision<string>> {
    if (!(await this.transport.available(purpose))) {
      return deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", { sessionId, purpose });
    }
    try {
      const address = await this.transport.openChannel(purpose);
      // The address and its audit commit together or not at all: an address the log does not record
      // is a room history nothing can prove.
      this.db.tx(() => {
        this.sessions.setBuzzAddress(sessionId, address);
        this.audit.record({
          kind: "BUZZ_CONNECTED",
          sessionId,
          evidence: { purpose, address },
        });
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
    const revalidated = new Map<string, BuzzPolicyBinding>();

    // Existing sweep/delivery triggers observe readiness; no post retry timer is scheduled.
    // Unknown/failed readback cannot re-arm a refused row. Claims still serialize overlapping calls.
    for (const message of this.outbox.pendingCeoBuzzSignerRoutes()) {
      const session = this.sessions.get(message.targetSessionId);
      if (!session?.buzzAddress || !session.buzzActorId) continue;
      // A local-policy hold does not provision membership merely because a later roster differs.
      const policyHeld = this.db.get(`SELECT 1 FROM outbox WHERE message_id = ? AND reason_code = 'BUZZ_LOCAL_SEND_POLICY_REFUSED'`,
        [message.messageId]);
      if (policyHeld) {
        const observed = await this.#signerReadiness(session.buzzAddress);
        if (!observed || !this.outbox.resumeCeoBuzzSigner(message,
          { room: session.buzzAddress, recipient: session.buzzActorId }, false,
          this.#policyBinding(message, session.buzzAddress, session.buzzActorId, observed.signer))) continue;
        if (!observed.registered && !this.#hostGatesCeo(message)) continue;
      }
      // Normalize only a proven old pre-post refusal before attempting membership repair.
      this.outbox.resumeCeoBuzzSigner(message, { room: session.buzzAddress, recipient: session.buzzActorId }, false);
      const ready = await this.#ceoSignerReadiness(message, session.buzzAddress, session.buzzActorId);
      if (!ready) continue;
      const before = this.#policyBinding(message, session.buzzAddress, session.buzzActorId, ready.signer);
      // This call also migrates a precise historical refusal before considering permission.
      if (!this.outbox.resumeCeoBuzzSigner(message,
        { room: session.buzzAddress, recipient: session.buzzActorId }, false, before)) continue;
      if (!ready.registered) continue;
      const verdict = await this.#policyReadiness(message, session.buzzAddress, session.buzzActorId, ready.signer);
      if (before.routeDigest !== this.#policyBinding(message, session.buzzAddress, session.buzzActorId, ready.signer).routeDigest) continue;
      if (this.outbox.resumeCeoBuzzSigner(message, { room: session.buzzAddress, recipient: session.buzzActorId }, true,
        { ...before, policyDigest: verdict.policyDigest, policyIdentity: verdict.policyIdentity, policyCause: verdict.cause }, verdict) && verdict.verdict === "allowed") {
        revalidated.set(message.messageId, before);
      }
    }

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
            // Nothing was sent: the route is absent, known here rather than inferred afterwards.
            routeAbsent: true,
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
            // Nothing was sent: the route is absent, known here rather than inferred afterwards.
            routeAbsent: true,
          },
        );
        failed.push(message.messageId);
        continue;
      }
      // FCR-08: the exact destination of this attempt. A row that may already be there (the relay
      // accepted it there, or a send there had an unknown outcome) is not sent there again: Buzz has
      // no same-id dedupe or receipt lookup. It is SENT again, awaiting that receiver's ACK.
      const destination = { room: channel, recipient };
      const already = this.outbox.sentTo(message.messageId, destination);
      // FCR-14: a send there still in flight (a handover took the row while it was pending) is waited
      // for, never doubled: the claim is given back and the row is judged again once that send settles.
      if (already === "IN_FLIGHT") {
        this.outbox.awaitSendInFlight(message.messageId, message.claimToken);
        continue;
      }
      if (already !== null) {
        this.outbox.markAlreadySent(message.messageId, message.claimToken, already, destination);
        continue;
      }
      // Fence this destination across the asynchronous roster read, too.
      this.outbox.recordSendInFlight(message.messageId, destination);
      const readiness = message.kind === MessageKind.CEO_NOTIFICATION ? await this.#ceoSignerReadiness(message, channel, recipient) : null;
      if ((readiness && !readiness.registered) || (message.kind === MessageKind.CEO_NOTIFICATION &&
        ((!readiness) ||
          this.#invalidEnsure(this.#currentCeoRoute(message, channel, recipient), readiness?.signer ?? null)))) {
        this.outbox.markAttemptFailed(message.messageId, message.claimToken, {
          failureClass: "repairable", retryable: false,
          error: readiness ? "Buzz roster does not include the daemon signer in the target room" : "CEO signer provisioning/readback is unverified",
          signerNotRegistered: { signer: readiness?.signer ?? null, source: "READBACK",
            reasonCode: readiness ? ReasonCode.BUZZ_SIGNER_NOT_REGISTERED : ReasonCode.BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED }, destination,
        });
        failed.push(message.messageId);
        continue;
      }
      // A holder/room change during readback must not authorize a post to the old binding.
      if (!this.db.get(`SELECT 1 FROM outbox o JOIN sessions s ON s.session_id = o.target_session_id
        WHERE o.message_id = ? AND o.status = 'IN_FLIGHT' AND o.claim_token = ?
          AND o.target_session_id = ? AND o.binding_generation = ? AND s.buzz_address = ? AND s.buzz_actor_id = ?
          AND ${liveDeliveryTarget("o")}`,
      [message.messageId, message.claimToken, message.targetSessionId, message.bindingGeneration, channel, recipient])) {
        this.outbox.markAttemptFailed(message.messageId, message.claimToken,
          { failureClass: "contract", retryable: false, error: "target changed before Buzz post", destination, routeAbsent: true });
        continue;
      }
      if (message.kind === MessageKind.CEO_NOTIFICATION && readiness) {
        const before = this.#policyBinding(message, channel, recipient, readiness.signer);
        const prior = revalidated.get(message.messageId);
        const verdict: Pick<BuzzPolicyReadiness, "verdict" | "policyDigest" | "policyIdentity" | "cause"> = prior?.routeDigest === before.routeDigest && prior.signer === readiness.signer
          ? { verdict: "allowed" as const, policyDigest: before.policyDigest }
          : await this.#policyReadiness(message, channel, recipient, readiness.signer);
        // A fresh allowance from this same sweep needs no duplicate check. Send still evaluates
        // its current policy. Re-check the route after any await; allowance cannot revive a revoke.
        if (before.routeDigest !== this.#policyBinding(message, channel, recipient, readiness.signer).routeDigest || verdict.verdict !== "allowed") {
          const reasonCode = verdict.verdict === "allowed" ? ReasonCode.BUZZ_SEND_POLICY_BINDING_UNVERIFIED : buzzPolicyHoldReason(verdict);
          this.outbox.markAttemptFailed(message.messageId, message.claimToken, {
            failureClass: "repairable", retryable: false, destination,
            error: reasonCode,
            signerNotRegistered: { signer: readiness.signer, source: "READBACK", reasonCode,
              policyBinding: { ...before, policyDigest: verdict.policyDigest, policyIdentity: verdict.policyIdentity, policyCause: verdict.cause } },
          });
          failed.push(message.messageId);
          continue;
        }
      }
      // Retain this attempt's policy identity; later bytes belong to resume, not its refusal.
      const policyBinding = message.kind === MessageKind.CEO_NOTIFICATION
        ? this.#policyBinding(message, channel, recipient, readiness?.signer ?? null) : undefined;
      try {
        await this.transport.send(channel, render(message), [recipient]);
        // Where it landed is recorded first, whatever happens to the claim next.
        this.outbox.recordAcceptedSend(message.messageId, destination);
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
          { ...classifyTransportFailure(err), destination,
            ...(message.kind === MessageKind.CEO_NOTIFICATION ? { ceoRefusal: {
              scope: isBuzzRecipientRefusal(err instanceof Error ? err.message : String(err)) ? "DESTINATION" as const : "SENDER" as const,
              targetSessionId: message.targetSessionId, bindingGeneration: message.bindingGeneration, attemptNumber: message.attempts + 1,
            } } : {}),
            ...(message.kind === MessageKind.CEO_NOTIFICATION && readiness?.registered ? { buzzSignerReady: true as const } : {}),
            ...(message.kind === MessageKind.CEO_NOTIFICATION &&
              isBuzzSignerRefusal(err instanceof Error ? err.message : String(err))
              ? { signerNotRegistered: { signer: readiness?.signer ?? null, source: "SEND_REFUSAL" as const, policyBinding, reasonCode: ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED } } : {}) },
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
