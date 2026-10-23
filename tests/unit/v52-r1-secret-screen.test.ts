import { describe, expect, it } from "vitest";
import { parseGenesis, type GenesisBundle } from "../../src/bootstrap/genesis-bundle.ts";
import { genesisBundle, genesisFile, genesisPlanFixture } from "../helpers/genesis-github.ts";

/**
 * Review V52-R1-05 — the public secret screen must refuse the Buzz identity key the resident provisioner
 * itself writes (64 hex characters in `cto-<project>.priv` and in `BUZZ_PRIVATE_KEY`), and its `nsec1`
 * encoding, in every sink that reaches the public repository: file bytes, issue bodies, milestone
 * descriptions, labels and the product intent carried into the handoff.
 */
const hexKey = "3f".repeat(32);
const nsec = "nsec1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 58);
const shapes: Record<string, string> = {
  "env assignment": `BUZZ_PRIVATE_KEY=${hexKey}`,
  "exported assignment": `export BUZZ_PRIVATE_KEY="${hexKey}"`,
  "json key": `{"buzzPrivateKey": "${hexKey}"}`,
  "yaml key": `nostr_secret_key: ${hexKey}`,
  "bech32 nsec": `identity ${nsec}`,
  "copied .priv file": `${hexKey}\n`,
};
const sinks: Record<string, (bundle: GenesisBundle, secret: string) => void> = {
  "genesis file bytes": (b, secret) => b.files.push(genesisFile("config/identity.txt", secret)),
  "issue body": (b, secret) => { b.issues[0]!.body = secret; },
  "issue title": (b, secret) => { b.issues[0]!.title = secret; },
  "milestone description": (b, secret) => { b.milestones[0]!.description = secret; },
  "label description": (b, secret) => { b.labels[0]!.description = secret; },
  "label name": (b, secret) => { b.labels[0]!.name = secret; b.issues[0]!.labels = [secret]; },
  "product intent summary": (b, secret) => { b.productIntent.summary = secret; },
  "product intent reference": (b, secret) => { b.productIntent.references.push(secret); },
  "owner instruction": (b, secret) => { b.productIntent.ownerInstructions.push(secret); },
  "commit message": (b, secret) => { b.commitMessage = secret; },
};

describe("V52-R1-05 the shared secret screen refuses Buzz private keys before any public write", () => {
  const f = genesisPlanFixture();
  const cases = Object.keys(sinks).flatMap((sink) => Object.keys(shapes).map((shape) => [sink, shape] as const));
  it.each(cases)("refuses a Buzz key in the %s (%s)", (sink, shape) => {
    const bundle = genesisBundle();
    sinks[sink]!(bundle, shapes[shape]!);
    expect(() => parseGenesis(bundle, f.manifest)).toThrow("credential-shaped");
  });

  it("still accepts the reviewed genesis, pinned action SHAs and lockfile checksums", () => {
    const bundle = genesisBundle();
    bundle.files.push(genesisFile("Cargo.lock", `[[package]]\nname = "x"\nchecksum = "${hexKey}"\n`));
    bundle.issues[0]!.body = "Configure BUZZ_PRIVATE_KEY from the host key file; never commit it.";
    expect(parseGenesis(bundle, f.manifest).files).toHaveLength(4);
  });
});
