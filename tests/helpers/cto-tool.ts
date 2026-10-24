import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import type { Harness } from "./harness.ts";

/** Exercise the tool boundary with the recipient identity supplied by connection authentication. */
export async function callCtoTool(
  h: Harness,
  peer: { sessionId: string; incarnation: string; binding?: { roleKey: string; bindingGeneration: number } },
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  // Legacy callers name only a session. Never choose between roles by enumeration order;
  // staging fixtures supply the exact binding explicitly, as socket authentication does.
  const held = h.cp.bindings.bySession(peer.sessionId).filter(binding => binding.status === "ACTIVE");
  const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, {
    actor: `cto:${peer.sessionId}`, sessionId: peer.sessionId, sessionIncarnation: peer.incarnation,
    binding: peer.binding ?? (held.length === 1
      ? { roleKey: held[0]!.roleKey, bindingGeneration: held[0]!.bindingGeneration } : undefined),
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "v52-resident-recipient", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}
