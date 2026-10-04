import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boundedSpawnSync } from "./bounded-sync-child.ts";

/**
 * Whether macOS seatbelt can apply a confining profile on this host — measured, not assumed.
 *
 * `sandbox-exec` can be present and still refuse: inside another sandbox it fails with
 * `sandbox_apply: Operation not permitted` (exit 71). A test that claims confinement and treats that
 * refusal as a denial would pass with nothing confined (#1070 round 1), so confinement tests ask
 * this first.
 *
 * The probe has to carry a deny rule. Measured on this host: inside an outer sandbox, a bare
 * `(allow default)` profile still applies, while any profile with a `deny` in it is refused — so a
 * probe without one says "applies" exactly where every real profile cannot. The probe therefore
 * proves both halves: an allowed read runs under the profile, and the denied read is refused by it.
 */
export type SeatbeltStatus = { applies: true } | { applies: false; reason: string };

let measured: SeatbeltStatus | undefined;

const probe = (): SeatbeltStatus => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-seatbelt-probe-")));
  try {
    const allowed = join(dir, "allowed");
    const denied = join(dir, "denied");
    writeFileSync(allowed, "seatbelt-probe-allowed");
    writeFileSync(denied, "seatbelt-probe-denied");
    const profile = `(version 1)\n(allow default)\n(deny file-read-data (literal ${JSON.stringify(denied)}))`;
    const run = (target: string) =>
      boundedSpawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", target], { encoding: "utf8" });
    const control = run(allowed);
    if (control.status !== 0 || !String(control.stdout ?? "").includes("seatbelt-probe-allowed")) {
      return {
        applies: false,
        reason: `sandbox-exec cannot apply a confining profile here (exit ${String(control.status)}): ` +
          String(control.stderr ?? "").trim().slice(0, 200),
      };
    }
    const refused = run(denied);
    if (refused.status === 0 || String(refused.stdout ?? "").includes("seatbelt-probe-denied")) {
      return { applies: false, reason: "sandbox-exec applied a profile whose deny rule did not bite" };
    }
    return { applies: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const seatbeltStatus = (): SeatbeltStatus => {
  if (measured) return measured;
  if (process.env["ACP_SEATBELT_UNAVAILABLE_FOR_TEST"] === "1") {
    // Lets a run show what these tests do on a host that cannot confine, such as inside another sandbox.
    measured = { applies: false, reason: "simulated by ACP_SEATBELT_UNAVAILABLE_FOR_TEST" };
  } else if (process.platform !== "darwin") {
    measured = { applies: false, reason: `platform ${process.platform} has no seatbelt` };
  } else if (!existsSync("/usr/bin/sandbox-exec")) {
    measured = { applies: false, reason: "/usr/bin/sandbox-exec is absent" };
  } else {
    measured = probe();
  }
  return measured;
};

/**
 * A test that claims seatbelt confinement calls this first. Where the seatbelt cannot apply, the test
 * is skipped loudly, naming why — or fails, when `ACP_REQUIRE_SEATBELT=1` says this host must confine.
 * It never passes unconfined.
 */
export const requireSeatbelt = (context: { skip: (note?: string) => never }): void => {
  const status = seatbeltStatus();
  if (status.applies) return;
  if (process.env["ACP_REQUIRE_SEATBELT"] === "1") {
    throw new Error(`seatbelt confinement is required on this host and cannot apply: ${status.reason}`);
  }
  context.skip(`seatbelt confinement not verified: ${status.reason}`);
};

/**
 * Throws when a `sandbox-exec` child never ran under its profile. A refusal is only evidence of
 * confinement when the profile applied; `sandbox_apply` failing (exit 71) also "refuses" everything.
 */
export const assertSeatbeltApplied = (result: { status: number | null; stderr?: string | Buffer | null }): void => {
  const stderr = String(result.stderr ?? "");
  if (result.status === 71 || stderr.includes("sandbox_apply")) {
    throw new Error(`sandbox-exec did not apply the profile, so this refusal proves nothing: ${stderr.trim().slice(0, 200)}`);
  }
};
