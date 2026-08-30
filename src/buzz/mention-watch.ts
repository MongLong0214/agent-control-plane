import type { Clock } from "../core/clock.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { BuzzCliMessage } from "./buzz-adapter.ts";

/**
 * The read side of Buzz this daemon is missing (#674).
 *
 * `#674` measured a session's ad hoc, session-local poll dying silently three separate ways —
 * each time indistinguishable from "no new messages", because nothing durable recorded that a
 * check had even been attempted. This closes that gap without delivering content or adding a
 * resident process of its own: it counts, and it durably records the count and whether the
 * last attempt to take it even succeeded, so Doctor can say "N behind since T" instead of the
 * silence a dead poller leaves in its place.
 *
 * Deliberately not mention resolution. Counting is `messages get --since <baseline>` against
 * the channel a session is bound to — every message the channel received, not messages
 * confirmed to `#p`-tag this session. No `#p` matching exists anywhere in this codebase (#674's
 * own audit: `grep -rn "\.tags\b" src/` outside tests found nothing), and building that mapping
 * is a separate, larger decision this change does not make. The count is a proxy for
 * unacknowledged channel traffic, and the finding this feeds says so in its evidence rather
 * than borrowing the stronger word "mention" for what was actually measured.
 */
export interface BuzzMentionSource {
  /** Messages in `channel` newer than `sinceEpochSeconds`, oldest first, up to `limit`. */
  messagesSince(channel: string, sinceEpochSeconds: number, limit: number): Promise<BuzzCliMessage[]>;
}

export interface BuzzMentionWatchRow {
  channelId: string;
  /** The "since T" a BUZZ_MENTIONS_BEHIND finding measures against. Null only before this
   * channel has ever been ticked once. */
  baselineAt: number | null;
  latestEventId: string | null;
  latestSeenAt: number | null;
  pendingCount: number;
  /** Every tick attempt touches this, success or failure — it is what tells "never checked"
   * apart from "checked and failed". */
  lastAttemptAt: string | null;
  /** Only a successful read moves this. */
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** A bound on one tick's read, not a pagination contract — this is a count, not a feed. */
const MAX_MESSAGES_PER_TICK = 200;

const safeErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
};

/**
 * PRD-adjacent (#674 Option C). Read-only for Doctor: this class owns every write, `Doctor`
 * only ever selects from `buzz_mention_watch`.
 *
 * ## The cursor's lifecycle, traced end to end
 *
 * **Who writes it.** Only this class, via `tick` (the periodic measurement) and `resetCursor`
 * (the acknowledgment). Nothing else touches `buzz_mention_watch`.
 *
 * **Who advances the baseline.** Never `tick`. A tick recomputes `pending_count` fresh from the
 * *same* `baseline_at` every time — it counts, it never consumes. Only `resetCursor` moves the
 * baseline, and it is called from exactly one production site: `BuzzAdapter.connect()`, the
 * moment a session is (re)confirmed alive and bound to a channel. That is deliberate: the
 * question this answers is "has anything arrived since this session was last known to be
 * watching", and reconnecting after a harness restart — precisely #674's incident — is the
 * event that answers "yes, it's watching again".
 *
 * **What a crash between reading and persisting loses.** Nothing, and nothing is double
 * counted either. `pending_count` is never incremented — it is overwritten each successful tick
 * with a fresh count derived from `--since baseline_at`. If the process dies after the CLI
 * answers but before the `UPDATE` commits, the row simply keeps its previous (still correct)
 * value, and the next tick re-asks the same question against the same durable baseline and
 * writes the same answer it would have written anyway. A flag that could move without a way
 * back, or that trusted an in-flight count instead of a durable baseline, is the shape that has
 * broken this repository twice before; this has neither.
 */
export class BuzzMentionWatch {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly source: BuzzMentionSource,
  ) {}

  /** One measurement pass over the given channels — the daemon's periodic tick calls this. */
  async tick(channels: readonly string[]): Promise<void> {
    for (const channelId of channels) {
      await this.#tickOne(channelId);
    }
  }

  async #tickOne(channelId: string): Promise<void> {
    const now = this.clock.nowIso();
    const nowEpoch = Math.floor(this.clock.now().getTime() / 1000);
    const existing = this.#row(channelId);
    // Established once, from "now" — not from the channel's full history, or a channel with
    // years of traffic would report its entire backlog as BUZZ_MENTIONS_BEHIND the instant this
    // watch first observes it.
    const baselineAt = existing?.baselineAt ?? nowEpoch;

    if (!existing) {
      this.db.run(
        `INSERT INTO buzz_mention_watch (channel_id, baseline_at, pending_count, last_attempt_at)
         VALUES (?, ?, 0, ?)`,
        [channelId, baselineAt, now],
      );
    } else {
      this.db.run(`UPDATE buzz_mention_watch SET last_attempt_at = ? WHERE channel_id = ?`, [now, channelId]);
    }

    // The read genuinely happens on the very first tick too (against `since = now`, expecting
    // nothing) rather than being skipped — that is what lets a channel this watch can never
    // reach report BUZZ_MENTIONS_WATCH_UNAVAILABLE from tick one, instead of a false healthy
    // baseline nobody ever verified.
    try {
      const messages = await this.source.messagesSince(channelId, baselineAt, MAX_MESSAGES_PER_TICK);
      const newest = messages.reduce<BuzzCliMessage | null>(
        (max, m) => (max === null || m.created_at > max.created_at ? m : max),
        null,
      );
      this.db.run(
        `UPDATE buzz_mention_watch
            SET pending_count = ?, latest_event_id = ?, latest_seen_at = ?,
                last_success_at = ?, last_error = NULL, last_error_at = NULL
          WHERE channel_id = ?`,
        [
          messages.length,
          newest?.id ?? existing?.latestEventId ?? null,
          newest?.created_at ?? existing?.latestSeenAt ?? null,
          now,
          channelId,
        ],
      );
    } catch (err) {
      // `pending_count`, `latest_*` and `last_success_at` are left exactly as they were: the
      // last confirmed-good measurement stays on record, and Doctor tells the difference between
      // that and "this failed" from `last_error_at` alone, not from a count that would otherwise
      // silently go stale while still being reported as current.
      this.db.run(
        `UPDATE buzz_mention_watch SET last_error = ?, last_error_at = ? WHERE channel_id = ?`,
        [safeErrorMessage(err), now, channelId],
      );
    }
  }

  /**
   * The cursor's one way back — see the class docstring. Idempotent and safe to call on every
   * connect, not only the first: reconnecting while already caught up simply re-arms the same
   * "watching from now" baseline.
   */
  resetCursor(channelId: string): void {
    const nowEpoch = Math.floor(this.clock.now().getTime() / 1000);
    this.db.run(
      `INSERT INTO buzz_mention_watch (channel_id, baseline_at, pending_count)
       VALUES (?, ?, 0)
       ON CONFLICT(channel_id) DO UPDATE SET
         baseline_at = excluded.baseline_at, pending_count = 0,
         latest_event_id = NULL, latest_seen_at = NULL`,
      [channelId, nowEpoch],
    );
    this.audit.record({
      kind: "BUZZ_MENTION_WATCH_RESET",
      evidence: { channel: channelId, at: this.clock.nowIso() },
    });
  }

  #row(channelId: string): BuzzMentionWatchRow | null {
    const row = this.db.get<{
      channel_id: string;
      baseline_at: number | null;
      latest_event_id: string | null;
      latest_seen_at: number | null;
      pending_count: number;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      last_error_at: string | null;
    }>(`SELECT * FROM buzz_mention_watch WHERE channel_id = ?`, [channelId]);
    if (!row) return null;
    return {
      channelId: row.channel_id,
      baselineAt: row.baseline_at,
      latestEventId: row.latest_event_id,
      latestSeenAt: row.latest_seen_at,
      pendingCount: row.pending_count,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
    };
  }
}
