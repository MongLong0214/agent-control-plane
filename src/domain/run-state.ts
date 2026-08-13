import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { RunKind, RunState } from "./types.ts";

/**
 * PRD §29.2 — the complete legal transition table. Anything absent is illegal, and an
 * illegal transition is denied with RUN_TRANSITION_ILLEGAL rather than silently
 * coerced (CP-HI-08: no silent degradation).
 */
const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  [RunState.QUEUED]: [RunState.ACTIVE, RunState.CANCELLED],
  [RunState.ACTIVE]: [
    RunState.BLOCKED,
    RunState.READY_FOR_CEO_REVIEW,
    RunState.FAILED,
    RunState.CANCELLED,
    RunState.AWAITING_HUMAN,
  ],
  [RunState.BLOCKED]: [
    RunState.ACTIVE,
    RunState.FAILED,
    RunState.CANCELLED,
    RunState.AWAITING_HUMAN,
  ],
  [RunState.READY_FOR_CEO_REVIEW]: [
    RunState.CEO_APPROVED,
    RunState.REVISION_REQUIRED,
    RunState.AWAITING_HUMAN,
  ],
  // A CEO approval authorizes the daemon to begin a one-way external finalization
  // sequence. It is deliberately not completion: completion is only legal after exact
  // post-merge verification has passed.
  [RunState.CEO_APPROVED]: [RunState.MERGING],
  // There can be more than one repository. After each exact post-merge PASS the daemon
  // returns here to release the next one in mergeOrder; a partial external result has a
  // dedicated terminal state so it cannot quietly resume as ordinary work.
  [RunState.MERGING]: [RunState.POST_MERGE_VERIFYING, RunState.BLOCKED_POST_MERGE],
  [RunState.POST_MERGE_VERIFYING]: [
    RunState.MERGING,
    RunState.COMPLETED,
    RunState.BLOCKED_POST_MERGE,
  ],
  [RunState.BLOCKED_POST_MERGE]: [],
  [RunState.REVISION_REQUIRED]: [RunState.ACTIVE, RunState.FAILED, RunState.CANCELLED],
  [RunState.AWAITING_HUMAN]: [RunState.ACTIVE, RunState.CANCELLED, RunState.FAILED],
  [RunState.COMPLETED]: [],
  [RunState.FAILED]: [],
  [RunState.CANCELLED]: [],
};

// `readonly` is compile-time only. The normative §29 machine must not be reshapeable at
// runtime: pushing a target onto a returned array would make an illegal completion legal.
Object.freeze(TRANSITIONS);
for (const targets of Object.values(TRANSITIONS)) Object.freeze(targets);

export const TERMINAL_RUN_STATES: readonly RunState[] = Object.freeze([
  RunState.COMPLETED,
  RunState.BLOCKED_POST_MERGE,
  RunState.FAILED,
  RunState.CANCELLED,
]);

export const isTerminal = (state: RunState): boolean => TERMINAL_RUN_STATES.includes(state);

/** Returns a copy: callers must not be able to reach the table itself. */
export const legalTargets = (from: RunState, kind?: RunKind): readonly RunState[] =>
  kind === RunKind.PROJECT_BOOTSTRAP && from === RunState.READY_FOR_CEO_REVIEW
    ? [...TRANSITIONS[from], RunState.COMPLETED]
    : [...TRANSITIONS[from]];

export const canTransition = (from: RunState, to: RunState, kind?: RunKind): Decision<RunState> => {
  if (from === to) {
    return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is already ${to}`, { from, to });
  }
  if (isTerminal(from)) {
    return deny(ReasonCode.RUN_ALREADY_TERMINAL, `run is terminal in ${from}`, { from, to });
  }
  // A bootstrap activation has no repository merge to perform. Its CEO-confirmed activation
  // result is the distinct, capability-gated completion proof; no ordinary run gets this
  // shortcut through the finalization chain.
  const legal = legalTargets(from, kind);
  if (!legal.includes(to)) {
    return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `${from} -> ${to} is not a legal transition`, {
      from,
      to,
      kind: kind ?? null,
      legal,
    });
  }
  return allow(ReasonCode.OK, to, { from, to });
};
