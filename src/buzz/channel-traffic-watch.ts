import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { BuzzCliMessage, ChannelTrafficBindingObserver } from "./buzz-adapter.ts";

/**
 * The complete surface this watch can observe (#674): raw rows returned by
 * `buzz messages get --since` for a channel. The CLI does not expose whether a row entered the
 * mentions feed, became `needs_action`, or reached a canonical turn. Those states therefore stay
 * explicitly unmeasured in Doctor rather than being inferred from channel traffic.
 */
export interface BuzzChannelTrafficSource {
  /** Raw channel messages strictly newer than `sinceEpochSeconds`, up to `limit`. */
  messagesSince(channel: string, sinceEpochSeconds: number, limit: number): Promise<BuzzCliMessage[]>;
}

/** One production daemon target: session identity plus the channel currently bound to it. */
export interface WatchTarget {
  sessionId: string;
  channelId: string;
}

export interface BuzzChannelTrafficWatchRow {
  sessionId: string;
  channelId: string;
  cursorGeneration: string;
  /** End of the last complete watch check and start of the next window, in epoch milliseconds. */
  baselineAt: number | null;
  /** Event ids observed by completed reads since this session acquired this channel route. */
  seenEventIds: readonly string[];
  windowStartedAt: number | null;
  windowEndedAt: number | null;
  observedCount: number;
  /** The source hit its return cap, so the window could not be completed and did not advance. */
  windowIncomplete: boolean;
  lastAttemptAt: string | null;
  attemptInProgress: boolean;
  lastReadSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** A bounded observation, not a pagination claim. */
const MAX_MESSAGES_PER_CHECK = 200;

/** One over the reportable bound distinguishes a complete 200-row window from a capped read. */
const OVERFETCH_LIMIT = MAX_MESSAGES_PER_CHECK + 1;

/**
 * Buzz accepts an exclusive whole-second cursor. Overlap one second so a newly returned event with
 * a sender timestamp tied to the local baseline remains visible; durable ids remove replays.
 */
const inclusiveSince = (baselineAt: number): number =>
  Math.max(0, Math.floor(baselineAt / 1000) - 1);

/** Relay order and relay timestamps are not identity; a repeated event id is still one event. */
const uniqueByEventId = (messages: readonly BuzzCliMessage[]): BuzzCliMessage[] => {
  const unique = new Map<string, BuzzCliMessage>();
  for (const message of messages) {
    if (!unique.has(message.id)) unique.set(message.id, message);
  }
  return [...unique.values()];
};

const eventIds = (messages: readonly BuzzCliMessage[]): string[] =>
  uniqueByEventId(messages).map((message) => message.id).sort();

const safeErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
};

/**
 * Records raw Buzz event ids first observed between completed watch checks.
 *
 * Lifecycle:
 *
 * - `bindChannel` establishes scope. Repeating an identical binding is a no-op, so reconnect
 *   cannot erase evidence. A real channel change clears the old channel's measurement
 *   and mints a generation because that evidence does not describe the new channel.
 * - The first successful, uncapped tick establishes a baseline and seeds its returned event ids but
 *   reports no historical traffic.
 * - Every later successful, uncapped tick counts ids absent from every earlier completed read on
 *   this channel route, stores those ids durably, and advances the baseline to the read's local
 *   completion time. Relay timestamps only select the CLI fetch range; future, tied, or overlapping
 *   timestamps cannot make an already-seen id new again.
 * - A failed or capped read does not advance. Doctor reports unavailable or incomplete instead of
 *   treating the preserved boundary as a verified zero.
 * - If the process dies during the CLI read, the attempt timestamp remains without a completed
 *   read. Doctor reports that unfinished attempt, and the next tick reuses the durable boundary.
 * - Generation-conditioned writes prevent an old-channel read from overwriting a newer binding.
 *   Daemon also serializes this timer against itself.
 */
export class BuzzChannelTrafficWatch implements ChannelTrafficBindingObserver {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly source: BuzzChannelTrafficSource,
  ) {}

  /** Bind measurement state to the channel a session currently uses. */
  bindChannel(sessionId: string, channelId: string): void {
    const existing = this.#row(sessionId);
    if (existing?.channelId === channelId) return;

    const generation = randomUUID();
    this.db.run(
      `INSERT INTO buzz_channel_traffic_watch
         (session_id, channel_id, cursor_generation)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         cursor_generation = excluded.cursor_generation,
         baseline_at = NULL, seen_event_ids = '[]',
         window_started_at = NULL, window_ended_at = NULL,
         observed_count = 0, window_incomplete = 0,
         last_attempt_at = NULL, attempt_in_progress = 0, last_read_success_at = NULL,
         last_error = NULL, last_error_at = NULL`,
      [sessionId, channelId, generation],
    );
    this.audit.record({
      kind: "BUZZ_CHANNEL_TRAFFIC_WATCH_BOUND",
      evidence: { sessionId, channel: channelId, at: this.clock.nowIso() },
    });
  }

  /** One production measurement pass over every live session-channel pair. */
  async tick(targets: readonly WatchTarget[]): Promise<void> {
    for (const target of targets) {
      await this.#tickOne(target.sessionId, target.channelId);
    }
  }

  async #tickOne(sessionId: string, channelId: string): Promise<void> {
    let existing = this.#row(sessionId);
    if (!existing || existing.channelId !== channelId) {
      this.bindChannel(sessionId, channelId);
      existing = this.#row(sessionId);
    }
    if (!existing) return;

    if (existing.baselineAt === null) {
      await this.#establishBaseline(existing);
      return;
    }
    await this.#measureWindow(existing);
  }

  async #establishBaseline(existing: BuzzChannelTrafficWatchRow): Promise<void> {
    const attemptStartedAt = this.clock.now().getTime();
    const attemptAt = this.clock.nowIso();
    const attempt = this.db.run(
      `UPDATE buzz_channel_traffic_watch SET last_attempt_at = ?, attempt_in_progress = 1
        WHERE session_id = ? AND cursor_generation = ?`,
      [attemptAt, existing.sessionId, existing.cursorGeneration],
    );
    if (attempt.changes !== 1) return;

    try {
      const messages = await this.source.messagesSince(
        existing.channelId,
        inclusiveSince(attemptStartedAt),
        OVERFETCH_LIMIT,
      );
      const completedAt = this.clock.now().getTime();
      const readSucceededAt = this.clock.nowIso();
      const incomplete = messages.length >= OVERFETCH_LIMIT;
      this.db.run(
        `UPDATE buzz_channel_traffic_watch
            SET baseline_at = ?, seen_event_ids = ?,
                window_started_at = NULL, window_ended_at = ?,
                observed_count = 0, window_incomplete = ?,
                attempt_in_progress = 0, last_read_success_at = ?,
                last_error = NULL, last_error_at = NULL
          WHERE session_id = ? AND cursor_generation = ?`,
        [
          incomplete ? null : completedAt,
          JSON.stringify(incomplete ? [] : eventIds(messages)),
          completedAt,
          incomplete ? 1 : 0,
          readSucceededAt,
          existing.sessionId,
          existing.cursorGeneration,
        ],
      );
    } catch (err) {
      this.#recordFailure(existing, err);
    }
  }

  async #measureWindow(existing: BuzzChannelTrafficWatchRow): Promise<void> {
    const baselineAt = existing.baselineAt;
    if (baselineAt === null) return;
    const attemptAt = this.clock.nowIso();
    const attempt = this.db.run(
      `UPDATE buzz_channel_traffic_watch SET last_attempt_at = ?, attempt_in_progress = 1
        WHERE session_id = ? AND cursor_generation = ?`,
      [attemptAt, existing.sessionId, existing.cursorGeneration],
    );
    if (attempt.changes !== 1) return;

    try {
      const messages = await this.source.messagesSince(
        existing.channelId,
        inclusiveSince(baselineAt),
        OVERFETCH_LIMIT,
      );
      const completedAt = this.clock.now().getTime();
      const readSucceededAt = this.clock.nowIso();
      const incomplete = messages.length >= OVERFETCH_LIMIT;
      const seenEventIds = new Set(existing.seenEventIds);
      const uniqueMessages = uniqueByEventId(messages);
      const observed = uniqueMessages.filter((message) => !seenEventIds.has(message.id));
      const completedSeenEventIds = [
        ...new Set([...seenEventIds, ...uniqueMessages.map((message) => message.id)]),
      ].sort();

      this.db.run(
        `UPDATE buzz_channel_traffic_watch
            SET baseline_at = ?, seen_event_ids = ?,
                window_started_at = ?, window_ended_at = ?,
                observed_count = ?, window_incomplete = ?,
                attempt_in_progress = 0, last_read_success_at = ?,
                last_error = NULL, last_error_at = NULL
          WHERE session_id = ? AND cursor_generation = ?`,
        [
          incomplete ? baselineAt : completedAt,
          JSON.stringify(incomplete ? existing.seenEventIds : completedSeenEventIds),
          baselineAt,
          completedAt,
          observed.length,
          incomplete ? 1 : 0,
          readSucceededAt,
          existing.sessionId,
          existing.cursorGeneration,
        ],
      );
    } catch (err) {
      this.#recordFailure(existing, err);
    }
  }

  #recordFailure(existing: BuzzChannelTrafficWatchRow, err: unknown): void {
    this.db.run(
      `UPDATE buzz_channel_traffic_watch
          SET attempt_in_progress = 0, last_error = ?, last_error_at = ?
        WHERE session_id = ? AND cursor_generation = ?`,
      [
        safeErrorMessage(err),
        this.clock.nowIso(),
        existing.sessionId,
        existing.cursorGeneration,
      ],
    );
  }

  #row(sessionId: string): BuzzChannelTrafficWatchRow | null {
    const row = this.db.get<{
      session_id: string;
      channel_id: string;
      cursor_generation: string;
      baseline_at: number | null;
      seen_event_ids: string;
      window_started_at: number | null;
      window_ended_at: number | null;
      observed_count: number;
      window_incomplete: number;
      last_attempt_at: string | null;
      attempt_in_progress: number;
      last_read_success_at: string | null;
      last_error: string | null;
      last_error_at: string | null;
    }>(`SELECT * FROM buzz_channel_traffic_watch WHERE session_id = ?`, [sessionId]);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      channelId: row.channel_id,
      cursorGeneration: row.cursor_generation,
      baselineAt: row.baseline_at,
      seenEventIds: JSON.parse(row.seen_event_ids) as string[],
      windowStartedAt: row.window_started_at,
      windowEndedAt: row.window_ended_at,
      observedCount: row.observed_count,
      windowIncomplete: row.window_incomplete === 1,
      lastAttemptAt: row.last_attempt_at,
      attemptInProgress: row.attempt_in_progress === 1,
      lastReadSuccessAt: row.last_read_success_at,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
    };
  }
}
