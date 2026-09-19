import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { isDigest } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * The CEO role stands empty and nobody has to type anything to fill it.
 *
 * Measured on this deployment 2026-09-20: `ACTIVE assignments` 0 rows for two days, and the only
 * door that fills the CEO role is `bootstrap.hermes` on the bearer-authenticated operator socket.
 * The daemon already *holds* the bootstrap authority — `agentcpd` constructs it and then hands it
 * to the operator socket without ever calling it — so the human in that loop was carrying values,
 * not a decision. Every remaining blocker downstream (the Buzz project room, #246, #512,
 * repo-factory#19) waits on that one binding.
 *
 * ## The pin, and why it is not asserted from the subject
 *
 * `expectedLineageRootDigest` is what ACP *claims* about the Hermes side, and Hermes refuses with
 * `PREFLIGHT_CONFLICT` when its own lineage disagrees. A daemon that asked Hermes for the value
 * and handed it straight back would be letting the subject decide the claim about itself, which is
 * the defect class this repository keeps removing.
 *
 * So the pin is trust-on-first-use and durable: the first automatic bootstrap records what the
 * receipt carried, and every later one sends the recorded value as its expectation. Nobody types
 * it, and a Hermes lineage that *changes* is still refused. What is given up is a human reading
 * the digest once — which is exactly the step the owner ruled out.
 */
export interface CeoSelfBootstrapDescriptor {
  readonly targetBindExecutable: string;
  readonly hermesProfile: string;
  readonly hermesHome: string;
  readonly executorRuntimeIdentity: string;
  readonly command: readonly string[];
}

/** What the first successful bootstrap teaches this deployment about its Hermes side. */
export interface CeoLineagePin {
  readonly lineageRootDigest: string;
  readonly executorRuntimeIdentity: string;
  readonly recordedAt: string;
}

export const CEO_SELF_BOOTSTRAP_VARS = [
  "ACP_HERMES_TARGET_BIND_EXECUTABLE",
  "ACP_HERMES_PROFILE",
  "ACP_HERMES_HOME",
  "ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY",
  "ACP_HERMES_RUNTIME_COMMAND",
] as const;

const PIN_FILE = "hermes-ceo-lineage.json";

/** `ACP_HERMES_RUNTIME_COMMAND` is one shell-free argv, tab-separated so a path may hold spaces. */
export const parseRuntimeCommand = (value: string): readonly string[] =>
  value.split("\t").map((part) => part.trim()).filter((part) => part.length > 0);

/**
 * All declared, or none. The same shape `ACP_CANONICAL_*` uses, for the same reason: a partial
 * group is a deployment that means to enable this and has not, and treating it as "disabled"
 * hides the misconfiguration behind a feature that silently does nothing.
 */
export const resolveCeoSelfBootstrapDescriptor = (
  environment: Record<string, string | undefined>,
): Decision<CeoSelfBootstrapDescriptor | null> => {
  const values = CEO_SELF_BOOTSTRAP_VARS.map((name) => (environment[name] ?? "").trim());
  const declared = values.filter((value) => value.length > 0).length;
  if (declared === 0) return allow(ReasonCode.OK, null);
  if (declared !== CEO_SELF_BOOTSTRAP_VARS.length) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      "CEO self-bootstrap needs every variable of its group or none of them",
      {
        missing: CEO_SELF_BOOTSTRAP_VARS.filter(
          (name) => (environment[name] ?? "").trim() === "",
        ),
      },
    );
  }
  const [targetBindExecutable, hermesProfile, hermesHome, executorRuntimeIdentity, rawCommand] =
    values as [string, string, string, string, string];
  const command = parseRuntimeCommand(rawCommand);
  if (command.length === 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "ACP_HERMES_RUNTIME_COMMAND named no command", {});
  }
  return allow(ReasonCode.OK, {
    targetBindExecutable,
    hermesProfile,
    hermesHome,
    executorRuntimeIdentity,
    command,
  });
};

/**
 * The recorded pin, or null when this deployment has never bound a CEO automatically.
 *
 * A pin file that exists and does not parse is **not** treated as absent: that would silently
 * re-establish trust on the next boot, which is the one thing a first-use pin must never do.
 */
export const readCeoLineagePin = (stateDir: string): Decision<CeoLineagePin | null> => {
  const path = join(stateDir, PIN_FILE);
  if (!existsSync(path)) return allow(ReasonCode.OK, null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the recorded Hermes lineage pin is unreadable", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const record = parsed as Partial<CeoLineagePin> | null;
  if (
    !record ||
    typeof record.lineageRootDigest !== "string" ||
    !isDigest(record.lineageRootDigest) ||
    typeof record.executorRuntimeIdentity !== "string" ||
    record.executorRuntimeIdentity.trim() === ""
  ) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the recorded Hermes lineage pin is not a pin", { path });
  }
  return allow(ReasonCode.OK, {
    lineageRootDigest: record.lineageRootDigest,
    executorRuntimeIdentity: record.executorRuntimeIdentity,
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : "",
  });
};

/** Written once, after the receipt that established it. Never overwritten by a later disagreement. */
export const recordCeoLineagePin = (stateDir: string, pin: CeoLineagePin): Decision<void> => {
  const path = join(stateDir, PIN_FILE);
  if (existsSync(path)) {
    return deny(ReasonCode.CONFLICT, "a Hermes lineage pin is already recorded", { path });
  }
  if (!isDigest(pin.lineageRootDigest)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "refusing to pin a value that is not a digest", { path });
  }
  writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return allow(ReasonCode.OK, undefined);
};
