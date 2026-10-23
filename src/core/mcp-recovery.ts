/** Caller recovery rule for ambiguous MCP mutation outcomes. */
export const MCP_MUTATION_RECOVERY =
  "For MCP_REPLAY_UNVERIFIABLE or MCP_MUTATION_OUTCOME_UNKNOWN, recover a completed effect from durable state only when the durable effect matches THIS request (for PLAN, read contract_get and its tasks; the stored PLAN digest equals the digest of the PLAN this request would submit, and the tasks match this request); a mismatching or unprovable durable effect is not completion and is not proof of non-execution; " +
  "allow a new request only with proof of non-execution; keep an uncertain outcome refused, with no automatic new key; " +
  "an unclear refusal never authorizes resubmitting under a new key. Elapsed time, a missing response or an ordinary thrown error is not proof of non-execution.";
