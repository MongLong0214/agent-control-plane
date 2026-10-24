import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrapCodeGuarantees, bootstrapServingRuntime, recordBootstrapServingRuntime } from "../../src/bootstrap/bootstrap-runtime-observation.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
describe("ACP observed serving runtime", () => {
  it("records the real serving generation path and exact entrypoint bytes at startup, separately from guarantees", () => {
    const f = makeCore();
    try {
      const generation = "generation-" + "a".repeat(40);
      const directory = join(tempDir(), generation, "dist", "daemon"); mkdirSync(directory, { recursive: true });
      const entrypoint = join(directory, "agentcpd.js"); writeFileSync(entrypoint, "// fixture daemon runtime\n");
      const eventId = recordBootstrapServingRuntime(f.audit, pathToFileURL(entrypoint).href);
      const original = bootstrapServingRuntime(f.audit, eventId);
      expect(original).toMatchObject({ eventId, generation, runtimeSha256: digestOf([{ path: "daemon/agentcpd.js", sha256: sha256("// fixture daemon runtime\n") }]),
        entrypointSha256: sha256("// fixture daemon runtime\n"), runtimeFileCount: 1,
        entrypoint, pid: process.pid, lifecycleDigest: digestOf(bootstrapCodeGuarantees()) });
      writeFileSync(join(directory, "correction.js"), "// correction changed without changing the entrypoint\n");
      const later = bootstrapServingRuntime(f.audit, recordBootstrapServingRuntime(f.audit, pathToFileURL(entrypoint).href));
      expect(later?.entrypointSha256).toBe(original?.entrypointSha256);
      expect(later?.runtimeSha256).not.toBe(original?.runtimeSha256);
      writeFileSync(entrypoint, "// later bytes are not the startup observation\n");
      expect(bootstrapServingRuntime(f.audit, eventId)).toEqual(original);
      expect(bootstrapServingRuntime(f.audit, null)).toBeNull();
    } finally { f.db.close(); }
  });
  it("does not borrow another process's or another generation's lifecycle observation", () => {
    const f = makeCore();
    try {
      for (const evidence of [{ pid: process.pid + 1, lifecycleDigest: digestOf(bootstrapCodeGuarantees()) }, { pid: process.pid, lifecycleDigest: digestOf("other") }]) {
        const recorded = f.audit.record({ kind: "DAEMON_RUNTIME_OBSERVED", evidence });
        if (!recorded.allowed) throw new Error(recorded.message);
        expect(bootstrapServingRuntime(f.audit, recorded.value)).toBeNull();
      }
    } finally { f.db.close(); }
  });
});
