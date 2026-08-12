import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { RunState } from "./types.ts";

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
    RunState.COMPLETED,
    RunState.REVISION_REQUIRED,
    RunState.AWAITING_HUMAN,
  ],
  [RunState.REVISION_REQUIRED]: [RunState.ACTIVE, RunState.FAILED, RunState.CANCELLED],
  [RunState.AWAITING_HUMAN]: [RunState.ACTIVE, RunState.CANCELLED, RunState.FAILED],
  [RunState.COMPLETED]: [],
  [RunState.FAILED]: [],
  [RunState.CANCELLED]: [],
};

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  RunState.COMPLETED,
  RunState.FAILED,
  RunState.CANCELLED,
];

export const isTerminal = (state: RunState): boolean => TERMINAL_RUN_STATES.includes(state);

export const legalTargets = (from: RunState): readonly RunState[] => TRANSITIONS[from];

export const canTransition = (from: RunState, to: RunState): Decision<RunState> => {
  if (from === to) {
    return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is already ${to}`, { from, to });
  }
  if (isTerminal(from)) {
    return deny(ReasonCode.RUN_ALREADY_TERMINAL, `run is terminal in ${from}`, { from, to });
  }
  if (!TRANSITIONS[from].includes(to)) {
    return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `${from} -> ${to} is not a legal transition`, {
      from,
      to,
      legal: TRANSITIONS[from],
    });
  }
  return allow(ReasonCode.OK, to, { from, to });
};
