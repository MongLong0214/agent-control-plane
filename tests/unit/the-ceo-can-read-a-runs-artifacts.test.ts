import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { digestArtifactContent, type StoredArtifact } from "../../src/db/artifacts.ts";
import type { ArtifactKind } from "../../src/domain/types.ts";
import { ARTIFACT_GET_MAX_CHARS, type ArtifactPart, createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { verificationOutputCapture, type VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { driveToReviewedCandidate, makeHarness, type Harness } from "../helpers/harness.ts";

/**
 * The CEO reads, through acp-ceo's `artifact_get`, the stored content of the evidence it approves: a run's
 * VERIFICATION, BLIND_REVIEW and PRODUCTION_READY_PACKET, in parts when one is over the answer bound. The
 * run is driven through the harness's real pipeline with its scripted reviewer: these are scripted results.
 */

type Answer = { ok: true; value: ArtifactPart } | { ok: false; reasonCode: string };

let h: Harness;
let runId: string;
let client: Client;
let closeChannel: () => Promise<void>;

const artifactGet = async (args: Record<string, unknown>): Promise<Answer> =>
  (await client.callTool({ name: "artifact_get", arguments: args })).structuredContent as Answer;

/** Every part from offset 0 until one reaches the end, each a successful answer. */
const readWhole = async (id: string, artifactId: string, limit?: number): Promise<ArtifactPart[]> => {
  const parts: ArtifactPart[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const answer = await artifactGet({ runId: id, artifactId, offset, ...(limit === undefined ? {} : { limit }) });
    if (!answer.ok) throw new Error(`artifact_get refused: ${answer.reasonCode}`);
    expect(answer.value.offset).toBe(offset);
    parts.push(answer.value);
    offset = answer.value.nextOffset;
  }
  return parts;
};

/** The parts joined parse to the content the stored digest addresses. */
const expectStoredBytes = (parts: ArtifactPart[], stored: StoredArtifact): string => {
  const joined = parts.map((part) => part.contentJson).join("");
  const raw = h.cp.db.get<{ content_json: string }>(
    "SELECT content_json FROM run_artifacts WHERE artifact_id = ?", [stored.artifactId],
  )!.content_json;
  expect(joined).toBe(raw);
  expect(parts.every((part) => part.totalChars === raw.length)).toBe(true);
  expect(parts.at(-1)).toMatchObject({ truncated: false, nextOffset: null });
  expect(parts.slice(0, -1).every((part) => part.truncated)).toBe(true);
  expect(digestArtifactContent(stored.kind, JSON.parse(joined) as unknown, stored.candidateSnapshotDigest)).toBe(stored.digest);
  return joined;
};

beforeAll(async () => {
  h = makeHarness();
  const driven = await driveToReviewedCandidate(h);
  runId = driven.runId;
  await h.cp.continuity.evaluate("artifact_get fixture packet");
  const packet = h.cp.ceo.buildPacket({
    runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "candidate verified",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: h.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);

  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: "operator" }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "ceo-artifact-get", version: "1" });
  await client.connect(clientTransport);
  closeChannel = async () => {
    await client.close();
    await server.close();
  };
}, 120_000);

afterAll(async () => {
  await closeChannel?.();
  h?.cp.close();
  cleanupTempDirs();
});

describe("artifact_get", () => {
  it("is listed on the acp-ceo server", async () => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("artifact_get");
  });

  it.each(["VERIFICATION", "BLIND_REVIEW", "PRODUCTION_READY_PACKET"] as const)(
    "returns a run's %s as stored, under the stored digest, by the id run_get lists",
    async (kind: ArtifactKind) => {
      const stored = h.cp.artifacts.latest(runId, kind)!;
      expect(stored).not.toBeNull();
      const runGet = (await client.callTool({ name: "run_get", arguments: { runId } })).structuredContent as {
        value: { evidence: Array<{ artifactId: string; kind: string; digest: string }> };
      };
      expect(runGet.value.evidence).toContainEqual(expect.objectContaining({ artifactId: stored.artifactId, kind, digest: stored.digest }));

      const parts = await readWhole(runId, stored.artifactId);
      expect(parts[0]).toMatchObject({
        artifactId: stored.artifactId, runId, kind, digest: stored.digest,
        candidateSnapshotDigest: stored.candidateSnapshotDigest, producedBy: stored.producedBy,
        createdAt: stored.createdAt, superseded: stored.superseded,
      });
      expectStoredBytes(parts, stored);
    },
  );

  it("gives NOT_FOUND for another run's artifact id and for an id no run holds, never another artifact", async () => {
    const other = h.cp.runs.create({
      projectId: null,
      executionMode: "SIMPLE",
      contract: { goal: "another run", why: "a second run's artifacts", scope: [], nonGoals: [], acceptance: ["exists"], priority: "NORMAL", humanGate: [], references: [] },
      repositories: [],
    } as Parameters<typeof h.cp.runs.create>[0]);
    if (!other.allowed) throw new Error(other.message);
    const foreign = h.cp.artifacts.list(other.value.runId)[0];
    expect(foreign, "the other run stores no artifact").toBeDefined();
    // The id is real and readable under its own run, so the refusal is the run binding's.
    expect(await artifactGet({ runId: other.value.runId, artifactId: foreign!.artifactId })).toMatchObject({ ok: true });

    expect(await artifactGet({ runId, artifactId: foreign!.artifactId })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(await artifactGet({ runId, artifactId: "art_absent" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
  });

  it("returns a v2 capture over the answer bound in parts that rejoin to the stored text exactly", async () => {
    const stored = h.cp.artifacts.latest<VerificationReport>(runId, "VERIFICATION")!;
    const first = stored.content.results[0]!;
    const line = (i: number) => `ok ${i} the candidate's check passes \u{1F600}\n`;
    const stdout = Array.from({ length: 16_000 }, (_, i) => line(i)).join("");
    const capturedOutput = verificationOutputCapture({
      candidateSnapshotDigest: stored.content.candidateSnapshotDigest,
      contractDigest: stored.content.contractDigest,
      commandId: first.commandId,
      exactHead: first.exactHead,
      outputDigest: first.outputDigest,
      maxOutputBytes: 4 * 1024 * 1024,
    }, stdout, "", false);
    const large = h.cp.artifacts.putEvidence(
      h.cp.evidenceWritersForTests().VERIFICATION, runId, "VERIFICATION",
      { ...stored.content, results: [{ ...first, capturedOutput }, ...stored.content.results.slice(1)] },
      stored.candidateSnapshotDigest!,
    );

    const parts = await readWhole(runId, large.artifactId);
    expect(parts[0]!.totalChars).toBeGreaterThan(2 * ARTIFACT_GET_MAX_CHARS);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.every((part) => part.contentJson.length <= ARTIFACT_GET_MAX_CHARS)).toBe(true);
    const joined = expectStoredBytes(parts, large);
    const parsed = JSON.parse(joined) as VerificationReport;
    expect(parsed.results[0]!.capturedOutput).toMatchObject({ schema: "acp.verification-output.v2", stdout: capturedOutput.stdout });

    // A caller's own smaller limit reads the same text in more parts.
    const small = await readWhole(runId, large.artifactId, 77_777);
    expect(small.length).toBeGreaterThan(parts.length);
    expect(expectStoredBytes(small, large)).toBe(joined);
  });
});
