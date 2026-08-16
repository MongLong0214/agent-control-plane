import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { OwnerAuthority } from "../../src/ceo/owner-authority.ts";
import { readOwnerIdentities } from "../../src/app/control-plane.ts";
import { acpScratchDir } from "../../src/core/scratch-root.ts";
import { makeCore } from "../helpers/fixtures.ts";

/**
 * Owner authority comes from the deployment's declaration, not from a name a caller supplies.
 *
 * The declaration is a file of `channel:actor` lines, and the chain that consumes it is
 * `readOwnerIdentities` → `OwnerAuthority` → `isAllowedActor`. Every existing test of that last
 * step supplies a **stub** — `{ isAllowedActor: () => false }` — which proves the callers respect
 * an answer and says nothing about how the answer is reached. So the file itself, the thing an
 * operator actually edits, had no test at all.
 *
 * These drive the real reader against a real file. The counterexample the predicate names is an
 * empty or absent declaration admitting anything, and it is the interesting one: `readOwnerIdentities`
 * returns `[]` for a missing file, so whether that means "nobody is authorised" or "the check is
 * vacuous" is decided entirely by `.some()` — and a change to `.every()` or a length guard would
 * invert it silently.
 */
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const declarationFile = (contents: string | null): string => {
  const dir = mkdtempSync(join(acpScratchDir("acp-owner-identity-"), "deployment"));
  scratch.push(dir);
  const file = join(dir, "owner-identities");
  if (contents !== null) writeFileSync(file, contents, { mode: 0o600 });
  return file;
};

const authorityFrom = (file: string) => new OwnerAuthority(makeCore().db, readOwnerIdentities(file));

describe("owner authority is exactly what the deployment declared (#245, P3 conjunct 1)", () => {
  it("admits a declared channel:actor and refuses one that is not declared", () => {
    const authority = authorityFrom(declarationFile("cli:isaac\ntelegram:12345\n"));

    expect(authority.isAllowedActor("cli", "isaac")).toBe(true);
    expect(authority.isAllowedActor("telegram", "12345")).toBe(true);

    expect(
      authority.isAllowedActor("cli", "someone-else"),
      "an actor the deployment never declared holds owner authority",
    ).toBe(false);
    // The channel is part of the identity, not decoration: the same actor on another channel is a
    // different principal, and matching on actor alone would admit it.
    expect(
      authority.isAllowedActor("telegram", "isaac"),
      "a declared actor was admitted on a channel it was not declared for",
    ).toBe(false);
  });

  it("authorises nobody when the declaration is empty, and the same when it is absent", () => {
    // The failure this guards is not a wrong answer but a vacuous one — a deployment that never
    // declared an owner must have no owner, rather than every caller being treated as one.
    for (const [label, file] of [
      ["empty", declarationFile("")],
      ["comments only", declarationFile("# nobody yet\n\n")],
      ["absent", declarationFile(null)],
    ] as const) {
      const authority = authorityFrom(file);
      expect(
        authority.isAllowedActor("cli", "isaac"),
        `a ${label} declaration granted owner authority`,
      ).toBe(false);
      expect(authority.isAllowedActor("telegram", "12345"), `a ${label} declaration granted owner authority`).toBe(false);
    }
  });

  it("ignores malformed lines rather than turning them into an identity", () => {
    // A line with no separator is not a channel with an empty actor, and a leading separator is not
    // an actor on an empty channel. Either reading would invent a principal the operator did not
    // write.
    const authority = authorityFrom(declarationFile("cli:isaac\nnot-a-pair\n:leading-colon\n"));

    expect(authority.isAllowedActor("cli", "isaac")).toBe(true);
    expect(authority.isAllowedActor("not-a-pair", "")).toBe(false);
    expect(authority.isAllowedActor("", "leading-colon")).toBe(false);
  });
});
