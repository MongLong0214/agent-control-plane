#!/usr/bin/env node
/**
 * Files the open work that is *not* a review finding, so the issue tracker is the single
 * source of truth for everything left to do.
 *
 * Review findings come from `scripts/file-review-majors.mjs`. This script covers the rest:
 * the PRD §42 acceptance items that a build cannot satisfy, the deployment prerequisites
 * only the owner can supply, the Repo Factory integration that is a separate deliverable,
 * and the design trade-offs that were taken deliberately and should be revisited.
 *
 * Idempotent by `<!-- acp-work:<id> -->` marker, the same way the review filing is.
 *
 * Usage: node scripts/file-open-work.mjs [--dry-run]
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");

const gh = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout.trim());
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });

const LABELS = [
  { name: "acceptance", color: "0e8a16", description: "PRD §42 acceptance item that is not yet met" },
  { name: "prerequisite", color: "1d76db", description: "Deployment prerequisite only the owner can supply" },
  { name: "epic", color: "5319e7", description: "Separate deliverable tracked as one issue" },
  { name: "design-decision", color: "bfd4f2", description: "Deliberate trade-off recorded for revisit" },
];

const WORK = [
  {
    id: "acceptance-3-simple-guarded-real-runs",
    title: "[acceptance] Real end-to-end runs in SIMPLE and GUARDED, not only STANDARD",
    labels: ["acceptance"],
    body: `PRD §42 definition of done #3 asks for one real end-to-end run in each execution
mode. Only STANDARD has been run for real (\`evidence/e2e-real-project.json\`, 111s, real CTO
session, sandboxed verification, fresh independent reviewer, CEO confirm).

SIMPLE and GUARDED are covered by the scenario suite — including the GUARDED human gate —
but not as real runs with live model sessions.

**Done when** \`evidence/\` holds an equivalent record for a SIMPLE run and for a GUARDED run,
each with the owner decision actually recorded through an allowlisted owner identity, and
\`docs/ACCEPTANCE.md\` item 3 moves to Met.`,
  },
  {
    id: "acceptance-4-multi-repo-merge-sequence",
    title: "[acceptance] Execute a two-repository run through the full merge sequence",
    labels: ["acceptance"],
    body: `PRD §42 #4. Multi-repository freezing and staleness are proven with two real
repositories (CP-S25), \`run_repositories.merge_order\` and per-repository merge state are
implemented, and merge order is enforced by the kernel with a regression test. What has not
happened is a real two-repository run merging in declared order, including post-merge
verification of the first repository gating the second.

**Done when** a run with two participating repositories reaches merged state on both, in
order, with post-merge verification receipts for each, and item 4 moves to Met.`,
  },
  {
    id: "acceptance-7-8-9-observation-window",
    title: "[acceptance] Observation window: 3 dogfood projects, ≥30 lifecycles, five zero counts",
    labels: ["acceptance"],
    body: `PRD §42 #7, #8 and #9 cannot be satisfied by a build. They need real operating
time: at least three dogfood projects and thirty observed run or bootstrap lifecycles with
zero false completions, duplicate dispatches, accepted stale-generation results, forged
gates and unauthorised merges — plus the recorded window and duration, and zero owner
interrupts for routine technical revision.

Each mechanism already has a negative test proving the zero is enforced rather than hoped
for; what is missing is the count. The telemetry needed is already collected
(\`telemetry_metrics\`, scoped run / task / quality / capacity / graph / continuity) and
\`agentctl\` can read it back.

**Done when** the window, duration and five counts are recorded in \`docs/ACCEPTANCE.md\`
with the telemetry queries that produced them.`,
  },
  {
    id: "prerequisite-github-app-checks-write",
    title: "[prerequisite] GitHub App with checks:write, so the production gate can be published",
    labels: ["prerequisite"],
    body: `Verified directly against the live repository:

\`\`\`
$ gh api -X POST repos/MongLong0214/agent-control-plane/check-runs -f name=acp-production-gate ...
{"message":"You must authenticate via a GitHub App.","status":"403"}
\`\`\`

A personal access token cannot create check runs, so \`acp-production-gate\` — the trusted
gate PRD §24.1/§24.4 describes — cannot be published until an App installation with
\`checks:write\` exists. Until then the gate predicates are exercised against a modelled
GitHub API, including that a same-named check from any other creator is refused (CP-S35).

**Done when** the App exists, its token is installed via the trusted credential store, its
creator identity is recorded, and one real \`gate_publish\` → \`merge_execute\` sequence is
captured in \`evidence/\`.`,
  },
  {
    id: "prerequisite-buzz-live-delivery",
    title: "[prerequisite] Verify Buzz delivery against the live relay",
    labels: ["prerequisite"],
    body: `\`BUZZ_PRIVATE_KEY\` is not configured on this machine, so \`BuzzCliTransport\` has
never been exercised against the relay. Delivery, fenced envelopes and ACK handling are
covered only through \`InMemoryBuzzTransport\`.

This also affects bootstrap activation: §26.5 requires a connected route for the primary
CTO, and the doctor reports \`CTO_BUZZ_NOT_CONNECTED\` (DEGRADED) without one — as it did in
the real end-to-end run.

**Done when** a fenced envelope is delivered to a real Buzz channel and acknowledged, with
the record in \`evidence/\`, and the doctor reports HEALTHY for a project whose CTO is
connected.`,
  },
  {
    id: "prerequisite-capacity-sensor",
    title: "[prerequisite] Maintain the structured capacity file, or replace it with a real quota source",
    labels: ["prerequisite"],
    body: `Neither shipped CLI exposes a quota interface (\`claude\` has no \`usage\` subcommand,
\`codex\` has no usage command), so PRD §14.2's structured local file *is* the sensor. It fails
closed: absent, timestampless, unparsable or stale ⇒ \`sensorHealth: ERROR\` and admission
SUSPENDED, and an unprobed runtime is \`UNKNOWN\` and non-routable.

That is correct but it means routing depends on something being written. See
\`docs/capacity-source.md\`.

**Done when** either a scheduled writer keeps \`~/.agent-control-plane/capacity/<provider>.json\`
fresh (and the doctor asserts its freshness), or a provider exposes a quota API and an
adapter reads it directly.`,
  },
  {
    id: "prerequisite-owner-identities",
    title: "[prerequisite] Declare the owner identities on the deployment host",
    labels: ["prerequisite"],
    body: `Owner-only decisions — a human gate, a project suspension, a destructive repair —
require an identity listed in \`~/.agent-control-plane/owner-identities\` (one
\`channel:actor\` per line). An absent or empty file means the deployment has no owner and no
human gate can ever be satisfied, which is the safe reading of §21 rather than a permissive
one.

**Done when** the file exists on the daemon host with the owner's real \`cli\` and
\`telegram\`/\`buzz\` identities, and one owner decision has been recorded through it end to
end.`,
  },
  {
    id: "epic-repo-factory-integration",
    title: "[epic] Repo Factory ↔ Control Plane integration (REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD v1.1)",
    labels: ["epic"],
    body: `The control plane's half of the bootstrap contract exists: \`RepoFactoryResult\`
parsing with overclaim rejection, project/repository registration, bootstrap CTO binding and
promotion, the two-phase activation handoff, \`ACPBootstrapActivationResult\`, and the doctor
gate (CP-S52 and the round-2 activation regressions).

The producing side does not exist. \`docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md\`
is vendored in this repository and is the SSOT for it: plan compilation, template rendering,
GitHub provisioning, external write receipts, and the RF-S scenarios.

**Done when** a real Repo Factory run produces a \`repo-factory.result.v2\` that this control
plane activates without hand-written fixtures, and the RF-S scenarios are executable.`,
  },
  {
    id: "design-decisions-to-revisit",
    title: "[design] Deliberate trade-offs taken during hardening, recorded for revisit",
    labels: ["design-decision"],
    body: `Each of these was a decision, not an oversight. They are written down so a later
reviewer argues with the reasoning rather than rediscovering the behaviour.

1. **Sandbox read confinement is a named deny list, not a whitelist.** A blanket
   \`(deny file-read*)\` plus allow-subpath profile SIGABRTs Node — dyld needs paths that
   cannot be enumerated. So \`readConfinement: "sensitive-paths"\` denies specific secret
   locations (\`~/.ssh\`, \`~/.aws\`, \`~/.config/gh\`, \`~/.claude\`, \`~/.codex\`, keychains, …)
   rather than claiming full isolation. Revisit if a container or VM per verification becomes
   available.
2. **A DEGRADED doctor does not block bootstrap activation.** Blocking findings do, and any
   DEGRADED status forces the project's \`availability\` to DEGRADED so the activation cannot
   claim health. Revisit if a DEGRADED dimension turns out to invalidate activation facts.
3. **A bootstrap run's CEO confirmation follows its activation.** §26.3 says only the
   activation result completes the run, so the CEO gate requires a stored activation result
   and the activation itself does not fabricate a confirmation. Revisit if the PRD intends
   the reverse order.
4. **Guard grants are consumed immediately before the side effect, not held across it.**
   Consumption re-decides and requires a live claim whose lease is then extended, so a
   competing run cannot take the same branch, worktree or path mid-write. A truly
   transactional fence around an external API call is not possible in-process; the kernel's
   exact-head and payload-digest receipts are the compensating control. Round-2 \`guard#1\`
   argues this window is still a defect and is tracked separately.
5. **Reviewer isolation is enforced by binding history and withheld inputs, not by process
   sandboxing.** The reviewer runs as a headless CLI with all tools disallowed and a budget
   cap. Round-2 \`review#8\` argues for read-isolation from daemon state; tracked separately.`,
  },
];

const marker = (w) => `<!-- acp-work:${w.id} -->`;
const bodyOf = (w) => `${marker(w)}\n${w.body}\n`;

const existing = JSON.parse(
  await gh(["issue", "list", "--state", "all", "--limit", "400", "--json", "number,body"]),
);
const byMarker = new Map();
for (const issue of existing) {
  const found = /<!-- acp-work:([^\s]+) -->/.exec(issue.body ?? "");
  if (found) byMarker.set(found[1], issue.number);
}

if (!dryRun) {
  const have = new Set(
    JSON.parse(await gh(["label", "list", "--limit", "200", "--json", "name"])).map((l) => l.name),
  );
  for (const label of LABELS) {
    if (!have.has(label.name)) {
      await gh(["label", "create", label.name, "--color", label.color, "--description", label.description]);
    }
  }
}

let created = 0;
let updated = 0;
for (const work of WORK) {
  const number = byMarker.get(work.id);
  if (dryRun) {
    console.log(`${number ? `update #${number}` : "create"}  ${work.title}`);
    continue;
  }
  if (number) {
    await gh(["issue", "edit", String(number), "--title", work.title, "--body-file", "-"], bodyOf(work));
    updated += 1;
  } else {
    const url = await gh(
      [
        "issue",
        "create",
        "--title",
        work.title,
        ...work.labels.flatMap((l) => ["--label", l]),
        "--body-file",
        "-",
      ],
      bodyOf(work),
    );
    console.log(`created ${url}`);
    created += 1;
  }
}
console.log(dryRun ? `${WORK.length} work items (dry run)` : `created ${created}, updated ${updated}`);
