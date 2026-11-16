/**
 * The schema names of the two HANDOFF artifacts a CTO's review evidence is kept in (staged, then attached).
 * Continuity's hold snapshot (`RunEngine.#holdSnapshot`) reads them from here, so it need not load the evidence module.
 */
export const STANDARD_REVIEW_EVIDENCE_CANDIDATE_SCHEMA = "acp.standard-review-evidence-candidate.v1";
export const STANDARD_REVIEW_EVIDENCE_ATTACHED_SCHEMA = "acp.standard-review-evidence-attached.v1";
