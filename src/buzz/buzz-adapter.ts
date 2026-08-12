import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { RoleBinding } from "../domain/types.ts";
import type { OutboxMessage } from "../outbox/outbox.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

const exec = promisify(execFile);

/** Transport seam so delivery can be exercised without a live relay. */
export interface BuzzTransport {
  /** Resolve or create the address a session is reachable at. */
  openChannel(purpose: string): Promise<string>;
  send(channel: string, content: string): Promise<void>;
  available(): Promise<boolean>;
}

/**
 * Real transport over the `buzz` CLI.
 *
 * The relay credential lives in the daemon's environment and is never forwarded to an
 * agent session or a verification subprocess (§33.3).
 */
export class BuzzCliTransport implements BuzzTransport {
  constructor(
    private readonly binary = "buzz",
    private readonly defaultChannel: string | null = null,
  ) {}

  async available(): Promise<boolean> {
    if (!process.env["BUZZ_PRIVATE_KEY"]) return false;
    try {
      await exec(this.binary, ["--help"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async openChannel(purpose: string): Promise<string> {
    if (this.defaultChannel) return this.defaultChannel;
    const { stdout } = await exec(this.binary, ["channels", "list", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const channels = JSON.parse(stdout) as Array<{ id: string; name?: string }>;
    const match = channels.find((c) => c.name && purpose.includes(c.name));
    const chosen = match ?? channels[0];
    if (!chosen) throw new Error("no buzz channel available");
    return chosen.id;
  }

  async send(channel: string, content: string): Promise<void> {
    await exec(this.binary, ["messages", "send", "--channel", channel, "--content", "-"], {
      encoding: "utf8",
      timeout: 60_000,
      input: content,
    } as Parameters<typeof exec>[2]);
  }
}

/** In-memory transport for scenario tests; records what would have been delivered. */
export class InMemoryBuzzTransport implements BuzzTransport {
  readonly sent: Array<{ channel: string; content: string }> = [];
  #available = true;

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  async available(): Promise<boolean> {
    return this.#available;
  }

  async openChannel(purpose: string): Promise<string> {
    if (!this.#available) throw new Error("buzz transport unavailable");
    return `channel:${purpose}`;
  }

  async send(channel: string, content: string): Promise<void> {
    if (!this.#available) throw new Error("buzz transport unavailable");
    this.sent.push({ channel, content });
  }
}

/**
 * PRD §27.2, §27.5.
 *
 * Buzz is a transport, not an authority. An inbound Buzz actor is mapped to an *active
 * role binding* before it can act; a display name grants nothing. Outbound delivery
 * only ever carries fenced envelopes whose generation is still current.
 */
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
    if (!(await this.transport.available())) {
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
   * §27.2 — resolve an inbound Buzz actor to the role it currently holds. Returns null
   * when the actor holds no active binding, which is the only safe default.
   */
  resolveActor(buzzActorId: string): RoleBinding | null {
    const session = this.db.get<{ session_id: string }>(
      `SELECT session_id FROM sessions WHERE buzz_address = ? AND lifecycle IN ('READY','DRAINING')`,
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
        this.outbox.markAttemptFailed(message.messageId, "target session has no buzz address");
        failed.push(message.messageId);
        continue;
      }
      try {
        await this.transport.send(channel, render(message));
        this.outbox.markSent(message.messageId);
        delivered.push(message.messageId);
      } catch (err) {
        this.outbox.markAttemptFailed(message.messageId, (err as Error).message);
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
    ` runId="${message.runId ?? ""}" messageId="${message.messageId}"`,
    ` payloadDigest="${message.payloadDigest}" expiresAt="${message.expiresAt}">`,
    `\n${message.kind}\n`,
    JSON.stringify(message.payload, null, 2),
    "\n</acp-envelope>",
  ].join("");
