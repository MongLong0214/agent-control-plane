import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  CEO_SELF_BOOTSTRAP_VARS,
  parseRuntimeCommand,
  readCeoLineagePin,
  recordCeoLineagePin,
  resolveCeoSelfBootstrapDescriptor,
} from "../../src/bootstrap/ceo-self-bootstrap.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

// `isDigest` requires the scheme, not 64 hex characters — measured, after this file's
// first draft pinned a bare hex string and the write was refused.
const DIGEST = `sha256:${"a".repeat(64)}`;

const complete = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ACP_HERMES_TARGET_BIND_EXECUTABLE: "/usr/local/bin/hermes",
  ACP_HERMES_PROFILE: "default",
  ACP_HERMES_HOME: "/home/isaac/.hermes",
  ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime@1",
  ACP_HERMES_RUNTIME_COMMAND: "/usr/local/bin/hermes\tacp\tserve",
  ...overrides,
});

/**
 * The CEO role stood empty for two days and the only door that fills it wanted a human to carry
 * values through a bearer-authenticated socket. The daemon already holds that authority.
 *
 * These rows are about the two halves that make filling it automatic without making the
 * attestation vacuous: a declared group that is all-or-nothing, and a first-use lineage pin that
 * a later boot cannot quietly re-establish.
 */
describe("the daemon binds the CEO itself", () => {
  it("is disabled, not misconfigured, when nothing is declared", () => {
    const resolved = resolveCeoSelfBootstrapDescriptor({});
    expect(resolved.allowed).toBe(true);
    expect(resolved.allowed && resolved.value).toBeNull();
  });

  it("refuses a partial group rather than reading it as disabled", () => {
    // A deployment that means to enable this and has not is a misconfiguration, and calling it
    // "disabled" hides it behind a feature that silently does nothing. Same shape as
    // `ACP_CANONICAL_*`, which refuses its own partial group for the same reason.
    for (const omitted of CEO_SELF_BOOTSTRAP_VARS) {
      const environment = complete({ [omitted]: "" });
      const resolved = resolveCeoSelfBootstrapDescriptor(environment);
      expect(resolved.allowed, `omitting ${omitted} was accepted`).toBe(false);
      expect(!resolved.allowed && JSON.stringify(resolved.evidence)).toContain(omitted);
    }
  });

  it("reads the runtime command as argv, so a path may hold spaces", () => {
    // Tab-separated on purpose: splitting on spaces makes `/Applications/My App/hermes` two
    // arguments, and nothing downstream would report that it had launched the wrong thing.
    expect(parseRuntimeCommand("/Applications/My App/hermes\tacp\tserve"))
      .toEqual(["/Applications/My App/hermes", "acp", "serve"]);
    expect(parseRuntimeCommand("  \t \t ")).toEqual([]);
    expect(resolveCeoSelfBootstrapDescriptor(complete({ ACP_HERMES_RUNTIME_COMMAND: "\t\t" })).allowed)
      .toBe(false);
  });

  it("has no pin before the first automatic bootstrap, and one after", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "acp-ceo-pin-"));
    expect(readCeoLineagePin(stateDir)).toMatchObject({ allowed: true, value: null });

    const recorded = recordCeoLineagePin(stateDir, {
      lineageRootDigest: DIGEST,
      executorRuntimeIdentity: "hermes-runtime@1",
      recordedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(recorded.allowed).toBe(true);
    const read = readCeoLineagePin(stateDir);
    expect(read.allowed && read.value?.lineageRootDigest).toBe(DIGEST);
  });

  it("never re-establishes trust: a second write is refused, not merged", () => {
    // The whole value of a first-use pin is that the first use is the only one. A later boot that
    // could overwrite it would turn the pin into a mirror of whatever answered this time.
    const stateDir = mkdtempSync(join(tmpdir(), "acp-ceo-pin-twice-"));
    const pin = { lineageRootDigest: DIGEST, executorRuntimeIdentity: "a", recordedAt: "" };
    expect(recordCeoLineagePin(stateDir, pin).allowed).toBe(true);

    const second = recordCeoLineagePin(stateDir, { ...pin, lineageRootDigest: `sha256:${"b".repeat(64)}` });
    expect(second.allowed).toBe(false);
    const read = readCeoLineagePin(stateDir);
    expect(read.allowed && read.value?.lineageRootDigest, "the first pin was replaced").toBe(DIGEST);
  });

  it("refuses to pin a value that is not a digest", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "acp-ceo-pin-bad-"));
    expect(recordCeoLineagePin(stateDir, {
      lineageRootDigest: "not-a-digest", executorRuntimeIdentity: "a", recordedAt: "",
    }).allowed).toBe(false);
    expect(readCeoLineagePin(stateDir)).toMatchObject({ allowed: true, value: null });
  });

  it("refuses every shape that is not a pin, one operand at a time", () => {
    // Five refusal operands, five payloads that reach exactly one of them. Written this way
    // because a single "bad shape" case leaves four of the five unkillable: the first refusal
    // short-circuits the rest, and a census that only sees the condition pass cannot tell which
    // half of it is load-bearing.
    const shapes: ReadonlyArray<readonly [string, unknown]> = [
      ["the payload is null", null],
      ["the digest is not a string", { lineageRootDigest: 7, executorRuntimeIdentity: "a" }],
      ["the digest is not a digest", { lineageRootDigest: "short", executorRuntimeIdentity: "a" }],
      ["the identity is not a string", { lineageRootDigest: DIGEST, executorRuntimeIdentity: 7 }],
      ["the identity is blank", { lineageRootDigest: DIGEST, executorRuntimeIdentity: "   " }],
    ];
    for (const [because, payload] of shapes) {
      const dir = mkdtempSync(join(tmpdir(), "acp-ceo-pin-shape-"));
      writeFileSync(join(dir, "hermes-ceo-lineage.json"), JSON.stringify(payload));
      expect(readCeoLineagePin(dir).allowed, because).toBe(false);
    }
  });

  it("calls an unreadable pin unreadable, rather than absent", () => {
    // Absent means "trust the next thing that answers". A corrupt or truncated file must never
    // take that meaning, or a single bad write silently re-opens first use.
    const stateDir = mkdtempSync(join(tmpdir(), "acp-ceo-pin-corrupt-"));
    writeFileSync(join(stateDir, "hermes-ceo-lineage.json"), "{ truncated");
    expect(readCeoLineagePin(stateDir).allowed).toBe(false);

  });
});
