import type { ExecutionMode } from "../domain/types.ts";

/** Consent is required for destructive operations, independent of the run's mode. */
export const HUMAN_GATE_TRIGGERS = [
  "irreversible production action",
  "destructive data migration or delete",
  "project decommission",
] as const;

export interface HumanGateInput {
  executionMode: ExecutionMode;
  goal: string;
  scope: readonly string[];
  declaredItems: readonly string[];
}

export interface HumanGateDefinition {
  required: boolean;
  items: string[];
}

/** Classify stated actions, rather than benign keywords or arbitrary owner questions. */
export const deriveHumanGate = (input: HumanGateInput): HumanGateDefinition => {
  const actions = [input.goal, ...input.scope, ...input.declaredItems]
    .map((text) => text.trim().toLowerCase().replace(/\s+/g, " "));
  const items = new Set<string>();
  for (const text of actions) {
    const action = text.replace(/^(?:please|can you|could you|would you)\s+/, "");
    if (/^(?:document|describe|explain|test|review|discuss|prevent|avoid)\b/.test(action) ||
        /\b(?:do not|don't|never|without)\s+(?:delete|drop|truncate|wipe|destroy|decommission|perform|execute|apply|run)\b/.test(action)) continue;
    if (/^(?:(?:perform|execute|apply|run) (?:an? )?)?irreversible (?:production )?action\b/.test(action)) {
      items.add(HUMAN_GATE_TRIGGERS[0]);
    }
    if (/^(?:(?:perform|execute|apply|run) (?:a )?)?destructive (?:data )?migration\b/.test(action) ||
        /^(?:permanently )?(?:delete|drop|truncate|wipe|destroy)\s+(?:all\s+|the\s+|production\s+|user\s+)*(?:data|database|tables?|records?|files?|repositories|repository)\b/.test(action)) {
      items.add(HUMAN_GATE_TRIGGERS[1]);
    }
    if (/^(?:decommission (?:the )?project|project decommission)\b/.test(action)) items.add(HUMAN_GATE_TRIGGERS[2]);
  }
  return { required: items.size > 0, items: [...items] };
};
