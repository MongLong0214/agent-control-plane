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
 * Deliberately not mention resolution, and the finding this feeds is named accordingly
 * (`BUZZ_CHANNEL_TRAFFIC_*`, not `BUZZ_MENTIONS_*` — renamed in #710). Counting is
 * `messages get --since <baseline>` against the channel a session is bound to — every message
 * the channel received, not messages confirmed to `#p`-tag this session. A blind review of
 * #710 confirmed this isn't a gap that can be closed with what's here: the only pubkey this
 * codebase ever binds to a session (`SessionRegistry.bindBuzzActor`, `buzz_actor_id`) is an
 * *inbound* actor's identity — proof that a human controls a session — not a pubkey the relay
 * would ever put in a `p` tag to address this session as a recipient. Sessions have no such
 * outbound-addressable identity of their own, so there is no pubkey to filter `p` tags against.
 * That is a separate, larger decision (giving sessions their own relay identity) this change
 * does not make. The count stays a proxy for unacknowledged channel traffic, named as such
 * everywhere it surfaces rather than borrowing the stronger word "mention" for what was
 * actually measured.
 */
export interface BuzzMentionSource {
  /** Messages in `channel` newer than `sinceEpochSeconds`, oldest first, up to `limit`. */
  messagesSince(channel: string, sinceEpochSeconds: number, limit: number): Promise<BuzzCliMessage[]>;
}

/** One channel a session is (or was) bound to, as the daemon's periodic tick enumerates it. */
export interface WatchTarget {
  sessionId: string;
  channelId: string;
}

export interface BuzzMentionWatchRow {
  sessionId: string;
  channelId: string;
  /** The "since T" a BUZZ_CHANNEL_TRAFFIC_BEHIND finding measures against. Null only before
   * this session has ever been ticked once. */
  baselineAt: number | null;
  latestEventId: string | null;
  latestSeenAt: number | null;
  pendingCount: number;
  /** Set when the last successful tick's read hit `MAX_MESSAGES_PER_TICK` — `pendingCount` is
   * then a floor ("at least this many"), not an exact count (#710 finding 3). */
  pendingSaturated: boolean;
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

/**
 * One more than the bound above, requested from the source so a tick can tell "exactly
 * `MAX_MESSAGES_PER_TICK`" apart from "more than that exist and the CLI's `--limit` truncated
 * them" (#710 finding 3). The CLI's `--limit` is a maximum return count, not a total — reporting
 * `messages.length` as though it were an exact count once that length pins itself at the
 * requested limit is indistinguishable from a channel that happens to have exactly that many.
 */
const OVERFETCH_LIMIT = MAX_MESSAGES_PER_TICK + 1;

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
 *
 * **Who this state belongs to.** `session_id`, not `channel_id` (#710). Production sessions can
 * share one `ACP_BUZZ_CHANNEL`; a row keyed on the channel let one session's reconnect reset a
 * baseline that another live session on the same channel had never touched. `channel_id` is
 * still what every CLI read runs against — it is carried on the row as a plain column — but the
 * identity a tick's answer is scoped to, and that `resetCursor` re-arms, is the session.
 *
 * **A stale in-flight tick cannot un-reset a reconnect.** `#tickOne` captures the `baseline_at`
 * it read at the top of the call, and its closing `UPDATE` is conditioned on that same value
 * still being current (`WHERE session_id = ? AND baseline_at = ?`). A tick whose CLI round trip
 * outlives a concurrent `resetCursor` — the daemon's mention-watch interval can be shorter than
 * the CLI's own timeout, so this is not exotic — finds its `UPDATE` matches zero rows and simply
 * does not write; the fresh reset stands. The daemon additionally serializes ticks against
 * themselves (`Daemon#runPeriodic`'s in-flight guard), so two ticks targeting one session's row
 * never race each other, but this guard is what protects against the other producer of writes
 * to this table: `resetCursor`, called from `BuzzAdapter.connect()`, an entirely different call
 * path.
 *
 * **A reset does not stand in for a check.** `resetCursor` clears `last_attempt_at` and
 * `last_success_at` along with the baseline, not only `pending_count`. Leaving a stale
 * `last_success_at` from before the reset would let Doctor read an unverified new baseline as a
 * "checked and found nothing" zero — a success that never actually happened against this
 * baseline. Clearing it means a session that reconnected but has not yet been ticked reads as
 * `BUZZ_CHANNEL_TRAFFIC_NEVER_CHECKED`, the same as a session ticked for the very first time.
 */
export class BuzzMentionWatch {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly source: BuzzMentionSource,
  ) {}

  /** One measurement pass over the given (session, channel) pairs — the daemon's periodic tick
   * calls this once per live session bound to a channel, not once per distinct channel: two
   * sessions sharing a channel get two independent measurements against two independent
   * baselines, which is the point (#710). */
  async tick(targets: readonly WatchTarget[]): Promise<void> {
    for (const target of targets) {
      await this.#tickOne(target.sessionId, target.channelId);
    }
  }

  async #tickOne(sessionId: string, channelId: string): Promise<void> {
    const now = this.clock.nowIso();
    const nowEpoch = Math.floor(this.clock.now().getTime() / 1000);
    const existing = this.#row(sessionId);
    // Established once, from "now" — not from the channel's full history, or a channel with
    // years of traffic would report its entire backlog as BUZZ_CHANNEL_TRAFFIC_BEHIND the
    // instant this watch first observes it.
    const baselineAt = existing?.baselineAt ?? nowEpoch;

    if (!existing) {
      this.db.run(
        `INSERT INTO buzz_mention_watch (session_id, channel_id, baseline_at, pending_count, last_attempt_at)
         VALUES (?, ?, ?, 0, ?)`,
        [sessionId, channelId, baselineAt, now],
      );
    } else {
      this.db.run(
        `UPDATE buzz_mention_watch SET channel_id = ?, last_attempt_at = ? WHERE session_id = ?`,
        [channelId, now, sessionId],
      );
    }

    // The read genuinely happens on the very first tick too (against `since = now`, expecting
    // nothing) rather than being skipped — that is what lets a channel this watch can never
    // reach report BUZZ_CHANNEL_TRAFFIC_WATCH_UNAVAILABLE from tick one, instead of a false
    // healthy baseline nobody ever verified.
    try {
      const messages = await this.source.messagesSince(channelId, baselineAt, OVERFETCH_LIMIT);
      const saturated = messages.length > MAX_MESSAGES_PER_TICK;
      // Oldest first, up to the (over-fetched) limit — so once saturated, the batch this tick
      // actually holds is the OLDEST slice of an unknown-sized backlog, not the newest. Claiming
      // a "latest event" out of it would misrepresent a stale message as current, so on
      // saturation `latest_event_id`/`latest_seen_at` are left exactly as they were, the same
      // "state what you don't know" treatment the catch branch below gives a failed read.
      const counted = saturated ? messages.slice(0, MAX_MESSAGES_PER_TICK) : messages;
      const newest = saturated
        ? null
        : counted.reduce<BuzzCliMessage | null>(
            (max, m) => (max === null || m.created_at > max.created_at ? m : max),
            null,
          );
      this.db.run(
        `UPDATE buzz_mention_watch
            SET pending_count = ?, pending_saturated = ?,
                latest_event_id = ?, latest_seen_at = ?,
                last_success_at = ?, last_error = NULL, last_error_at = NULL
          WHERE session_id = ? AND baseline_at = ?`,
        [
          counted.length,
          saturated ? 1 : 0,
          newest?.id ?? existing?.latestEventId ?? null,
          newest?.created_at ?? existing?.latestSeenAt ?? null,
          now,
          sessionId,
          baselineAt,
        ],
      );
    } catch (err) {
      // `pending_count`, `latest_*` and `last_success_at` are left exactly as they were: the
      // last confirmed-good measurement stays on record, and Doctor tells the difference between
      // that and "this failed" from `last_error_at` alone, not from a count that would otherwise
      // silently go stale while still being reported as current.
      this.db.run(
        `UPDATE buzz_mention_watch SET last_error = ?, last_error_at = ? WHERE session_id = ? AND baseline_at = ?`,
        [safeErrorMessage(err), now, sessionId, baselineAt],
      );
    }
  }

  /**
   * The cursor's one way back — see the class docstring. Idempotent and safe to call on every
   * connect, not only the first: reconnecting while already caught up simply re-arms the same
   * "watching from now" baseline.
   */
  resetCursor(sessionId: string, channelId: string): void {
    const nowEpoch = Math.floor(this.clock.now().getTime() / 1000);
    this.db.run(
      `INSERT INTO buzz_mention_watch (session_id, channel_id, baseline_at, pending_count)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         baseline_at = excluded.baseline_at, pending_count = 0, pending_saturated = 0,
         latest_event_id = NULL, latest_seen_at = NULL,
         last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL`,
      [sessionId, channelId, nowEpoch],
    );
    this.audit.record({
      kind: "BUZZ_MENTION_WATCH_RESET",
      evidence: { sessionId, channel: channelId, at: this.clock.nowIso() },
    });
  }

  #row(sessionId: string): BuzzMentionWatchRow | null {
    const row = this.db.get<{
      session_id: string;
      channel_id: string;
      baseline_at: number | null;
      latest_event_id: string | null;
      latest_seen_at: number | null;
      pending_count: number;
      pending_saturated: number;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      last_error_at: string | null;
    }>(`SELECT * FROM buzz_mention_watch WHERE session_id = ?`, [sessionId]);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      channelId: row.channel_id,
      baselineAt: row.baseline_at,
      latestEventId: row.latest_event_id,
      latestSeenAt: row.latest_seen_at,
      pendingCount: row.pending_count,
      pendingSaturated: row.pending_saturated === 1,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
    };
  }
}
