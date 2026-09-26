import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createOperatorClient, dispatch, main } from "../../src/cli/agentctl.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

describe("agentctl adopt hermes", () => {
  it("sends each explicit attempt once without claiming a cached idempotency result", async () => {
    const socketPath = join(tempDir("acp-adopt-cli-"), "operator.sock");
    const requests: Record<string, unknown>[] = [];
    const server = createServer((socket) => {
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        const boundary = received.indexOf("\n");
        if (boundary === -1) return;
        requests.push(JSON.parse(received.slice(0, boundary)) as Record<string, unknown>);
        socket.end(`${JSON.stringify({ allowed: true, reasonCode: ReasonCode.OK, evidence: {}, value: {} })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const client = createOperatorClient({ socketPath, token: "operator-token" });
      expect(await dispatch(client, "adopt", ["hermes"], false)).toBe(0);
      expect(await dispatch(client, "adopt", ["hermes"], false)).toBe(0);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({ method: "hermes.adoptIncumbent", params: {} });
        expect(request).not.toHaveProperty("idempotencyKey");
      }
      expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    } finally {
      stdout.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("asks the existing operator client to adopt the incumbent without caller parameters", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn(async () => ({
      allowed: true as const,
      reasonCode: ReasonCode.OK,
      evidence: {},
      value: { binding: "adopted" },
    }));
    try {
      expect(await dispatch({ request }, "adopt", ["hermes"], false)).toBe(0);
      expect(request).toHaveBeenCalledExactlyOnceWith("hermes.adoptIncumbent", {}, undefined);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"binding": "adopted"'));
    } finally {
      stdout.mockRestore();
    }
  });

  it.each([
    ["--url", "http://127.0.0.1:1234"],
    ["--head", "abc123"],
    ["--bearer", "secret"],
    ["--actor", "ceo"],
    ["--pid", "42"],
    ["--start", "2026-09-26"],
    ["--", "hermes"],
    ["--owner"],
  ])("rejects extra arguments %j before making any request", async (...extra) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const request = vi.fn(async () => { throw new Error("must not request"); });
    try {
      expect(await dispatch({ request }, "adopt", ["hermes", ...extra], false)).toBe(2);
      expect(request).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not strip --owner into a permitted adopt command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previous = process.env["ACP_OPERATOR_SOCKET"];
    process.env["ACP_OPERATOR_SOCKET"] = join(homedir(), ".hermes/cache/scratch", `absent-${randomUUID()}.sock`);
    try {
      expect(await main(["adopt", "hermes", "--owner"])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("accepts no additional arguments"));
    } finally {
      if (previous === undefined) delete process.env["ACP_OPERATOR_SOCKET"];
      else process.env["ACP_OPERATOR_SOCKET"] = previous;
      stderr.mockRestore();
    }
  });
});
