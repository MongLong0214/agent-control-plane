import { ExecutionMode, type ExecutionMode as ExecutionModeValue } from "../domain/types.ts";

/** PRD §21 — decisions that cannot be delegated to an agent role. */
export const HUMAN_GATE_TRIGGERS = [
  "irreversible production action",
  "destructive data migration or delete",
  "security or permission boundary expansion",
  "public api or protocol breaking change",
  "core product direction change",
  "significant new cost or paid plan change",
  "project decommission",
  "capacity-driven project suspend",
  "quality gate reduction exception",
  "undelegated public release",
] as const;

type HumanGateTrigger = (typeof HUMAN_GATE_TRIGGERS)[number];

export interface HumanGateInput {
  executionMode: ExecutionModeValue;
  goal: string;
  scope: readonly string[];
  declaredItems: readonly string[];
}

export interface HumanGateDefinition {
  required: boolean;
  items: string[];
}

/**
 * The task contract may add owner questions, but it may not remove a question that the
 * run's own mode, goal, or declared scope makes mandatory. These are intentionally narrow
 * textual classifiers: a control plane cannot infer an arbitrary diff, but it can recognise
 * the §21 classes it was explicitly asked to run.
 */
const TRIGGER_PHRASES: Readonly<Record<HumanGateTrigger, readonly string[]>> = {
  "irreversible production action": ["irreversible production", "irreversible action"],
  "destructive data migration or delete": ["destructive data migration", "destructive migration", "delete"],
  "security or permission boundary expansion": ["security boundary", "permission boundary", "permission expansion"],
  "public api or protocol breaking change": ["public api", "protocol breaking", "breaking change"],
  "core product direction change": ["core product direction", "product direction"],
  "significant new cost or paid plan change": ["significant new cost", "paid plan", "cost change"],
  "project decommission": ["project decommission", "decommission project"],
  "capacity-driven project suspend": ["capacity-driven project suspend", "capacity driven project suspend"],
  "quality gate reduction exception": ["quality gate reduction", "quality gate exception"],
  "undelegated public release": ["undelegated public release", "public release"],
};

const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const uniqueNonEmpty = (items: readonly string[]): string[] =>
  [...new Set(items.map((item) => item.trim()).filter(Boolean))];

const matches = (trigger: HumanGateTrigger, text: string): boolean =>
  text.includes(normalise(trigger)) || TRIGGER_PHRASES[trigger].some((phrase) => text.includes(phrase));

/**
 * Computes the gate from durable run properties. A GUARDED run with no owner item remains
 * required but intentionally has an empty item list; callers must fail it closed rather than
 * interpreting the empty declaration as an opt-out.
 */
export const deriveHumanGate = (input: HumanGateInput): HumanGateDefinition => {
  const declaredItems = uniqueNonEmpty(input.declaredItems);
  const runText = [input.goal, ...input.scope].map(normalise).filter(Boolean).join(" ");
  const triggeredItems = HUMAN_GATE_TRIGGERS.filter((trigger) => matches(trigger, runText));
  const items = uniqueNonEmpty([...triggeredItems, ...declaredItems]);

  return {
    required:
      input.executionMode === ExecutionMode.GUARDED || triggeredItems.length > 0 || declaredItems.length > 0,
    items,
  };
};
