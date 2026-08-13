# Run-evidence export: host-anchored v1 transport

`agentctl` exposes a read-only baseline boundary for ACP 2.0 experiments:

```text
agentctl run export <runId>
agentctl baseline export --from <ISO-8601> --to <ISO-8601>
```

The first command emits one canonical JSON `agent-control-plane.run-evidence-export.v1` bundle. The second emits a canonical JSON `agent-control-plane.baseline-export.v1` bundle containing completed runs whose `endedAt` falls in the inclusive window, plus a mechanical Gate A coverage report. The newline printed after the JSON is terminal framing and is not part of the checksum.

## Trust anchor and integrity

V1 chooses host-anchored verification (option A). The export is a transport and inspection
format. Its authoritative verification requires the durable source database that produced it;
the verifier rebuilds the expected run from that database and reconciles the run row, immutable
artifacts, baseline ledger, task graph, executions, receipts, audit decisions, and every derived
projection. `verifyRunEvidenceExport(bundle, sourceDb)` and
`verifyBaselineEvidenceExport(bundle, sourceDb)` are the authoritative APIs.

The bundle alone is reproducible, not self-proving. `reproduceRunEvidenceExport` and
`reproduceBaselineEvidenceExport` check canonical encoding, public digests, and internal
projection consistency, but a holder can edit source-like records, recompute their published
digests, reseal the envelope, and pass those reproduction checks. That is an explicit v1
boundary: the portable bytes do not prove that they came from ACP or that their claims are
immutable without the producing host's durable records. V1 makes no portable immutability claim.

Each bundle has:

- a versioned `schema` id;
- an `integrity.checksum` using `sha256` over canonical JSON with only
  `integrity.checksum` omitted; and
- every artifact descriptor's source digest, recomputed for every included artifact body; and
- every included baseline-record payload digest, recomputed against its run, kind, timestamp,
  and canonical payload.

Candidate-bound verification, review, and production-packet digests cover both the candidate
snapshot digest and their content. Those checks protect a source-backed comparison; they are not
a signature over a bundle an editor is free to rewrite.

The exporter does not write the source SQLite database or create an export artifact in it. The
source evidence remains the immutable artifact/audit record, while the bundle is a canonical,
redacted transport snapshot whose claims can be inspected offline and verified authoritatively
when the producing host is available.

## Redaction without rewriting evidence

Artifact content is never scrubbed or substituted. Each descriptor always includes its identity, kind, source digest, candidate binding, producer, timestamp, and staleness flag. Its whole `content` field is included only if it is safe and needed for offline baseline use.

If publication would expose a credential, prompt/transcript/reasoning payload, source/patch body, or a non-required operational artifact, the exporter omits the entire field. `artifactManifest.omittedFields` names the subject, field, reason, and original source digest. No `"[redacted]"` value is inserted into a digested artifact.

The same whole-field rule applies to baseline-record payloads. A malformed or non-corresponding
source artifact or baseline-ledger row causes export refusal rather than a best-effort bundle.

## Recorded v1 baseline facts

The export contains only observation and recording contracts; it does not select a model, optimize a graph, or run an experiment.

- Runtime: requested and provider-observed identity (when supplied by the adapter), model build, effort, session/incarnation, binding generation, context packet digest, and start/end/outcome. Missing observed identity is explicit and makes that invocation ineligible for qualification evidence. A requested/observed mismatch is retained as model drift.
- Usage: source (`PROVIDER_REPORTED`, `CLI_REPORTED`, `QUOTA_DELTA`, `ACP_ESTIMATED`, or `UNAVAILABLE`), token dimensions, raw-observation digest, parser/collector version, confidence, quota observations, and versioned cost conversion identifier. `UNAVAILABLE` retains null values; it never creates zero token counts.
- Graph: task/dependency structure, depth, observed parallel width, derivable critical path, plan/graph revision counts, and structural serial/parallel eligibility. Retry and repair counts are omitted until a durable source exists. No task prompt or chain-of-thought is exported.
- Quality: verification and review facts, finding categories, CEO and owner interventions, immutable GitHub receipt digests, post-merge observations, and explicit rollback/defect-escape observations (`OBSERVED`, `NOT_OBSERVED`, or `UNAVAILABLE`). A rollback *plan* is not misrepresented as a completed compensation.
- Task class: the fixed V1-BR-05 vocabulary with append-only proposed/final history and nullable confidence. The old lower-case operational category remains separate.
- Harness: binary/schema/adapter/bundle/manifest/verification/review/tool-policy pins. Values the runtime cannot prove are `null`, not guesses.

`baseline export` distinguishes production-attested records from tests and reports usage availability separately. It never declares ACP 2.0 Gate A eligible unless all stated V1-BR-10 thresholds are actually observed.

## V1-BR-08 — partial: experiment isolation preparation

This is partial by design. `validateExperimentIsolation` in `src/export/experiment-isolation.ts` is path validation only: it checks an `experimentId`, a separate experiment SQLite path, and a non-overlapping artifact root. The result is explicitly marked `NOT_AVAILABLE_IN_V1` for runtime enforcement. V1 has no experiment context or state opener, so this module enforces nothing at runtime and does not claim production-write denial, context withholding, or routing isolation.

## Migration

`src/db/migrations.ts` preserves ordered v13, `v13-finalization-state-machine`, and adds v14, `v14-baseline-evidence-ledger`, for the append-only `baseline_records` ledger. `Db` applies the ordered chain during normal construction and records the migration receipt before exposing the current schema. Fresh databases bootstrap with the v14 ledger, so the audit fallback is bounded compatibility behavior rather than a path that can block normal graph submission.
