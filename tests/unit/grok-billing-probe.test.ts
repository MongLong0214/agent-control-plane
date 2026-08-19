import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { FetchGrokBillingProbe } from "../../src/capacity/usage-collectors.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * These are the first tests to run the shipped probe rather than a stand-in. Every earlier
 * Grok test injected a fake, so the class that actually carries a subscription bearer over the
 * network had never been exercised by anything.
 */
const BEARER = "a".repeat(64);

const authFile = (): string => {
  const dir = tempDir("grok-billing");
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "https://auth.x.ai::client-a": { key: BEARER } }), { mode: 0o600 });
  return path;
};

interface Call {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
let calls: Call[] = [];

const respondWith = (body: string, init: { status?: number; contentType?: string; url?: string } = {}): void => {
  globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      url: init.url ?? String(url),
      headers: new Headers({ "content-type": init.contentType ?? "application/json" }),
      text: async () => body,
    };
  }) as unknown as typeof fetch;
};

beforeEach(() => {
  calls = [];
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
                      "all_proxy", "NODE_USE_ENV_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
    delete process.env[name];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

afterAll(() => cleanupTempDirs());

describe("Grok billing probe transport", () => {
  it("reads the billing document when the transport is what it expects", async () => {
    respondWith(JSON.stringify({ config: { creditUsagePercent: 10 } }));

    const read = await new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() });

    expect(read).toEqual({ config: { creditUsagePercent: 10 } });
    expect(calls).toHaveLength(1);
  });

  it("refuses to follow a redirect, because the bearer would travel to the next host", async () => {
    respondWith(JSON.stringify({ config: {} }));

    await new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() });

    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("will not send the credential while a proxy is configured", async () => {
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:8080";
    respondWith(JSON.stringify({ config: {} }));

    await expect(new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() }))
      .rejects.toThrow(/HTTPS_PROXY/);
    expect(calls, "the refusal must happen before the request, not after").toHaveLength(0);
  });

  it("will not send the credential while certificate verification is off", async () => {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    respondWith(JSON.stringify({ config: {} }));

    await expect(new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() }))
      .rejects.toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an answer from an origin that is not the billing host", async () => {
    respondWith(JSON.stringify({ config: {} }), { url: "https://elsewhere.example/v1/billing" });

    await expect(new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() }))
      .rejects.toThrow(/unexpected origin/);
  });

  it("refuses a body that is not json rather than parsing whatever arrived", async () => {
    respondWith("<html>login</html>", { contentType: "text/html" });

    await expect(new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() }))
      .rejects.toThrow(/content type/);
  });

  it("refuses a body larger than a billing document could be", async () => {
    respondWith(JSON.stringify({ pad: "x".repeat(300_000) }));

    await expect(new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() }))
      .rejects.toThrow(/more than this reader will hold/);
  });

  it("never repeats the credential into the error it raises", async () => {
    // `fetch` quotes an invalid header value back, and this string is recorded in the reading,
    // mirrored to disk and served over the operator socket.
    globalThis.fetch = (async () => {
      throw new TypeError(`Cannot parse header value: Bearer ${BEARER}`);
    }) as unknown as typeof fetch;

    const failure = await new FetchGrokBillingProbe()
      .read({ timeoutMs: 5_000, authPath: authFile() })
      .catch((error: unknown) => String(error));

    expect(failure).not.toContain(BEARER);
    expect(failure).toContain("grok billing request failed");
  });

  it("says the credential expired rather than that something went wrong", async () => {
    respondWith("{}", { status: 401 });

    await expect(new FetchGrokBillingProbe().read({ timeoutMs: 5_000, authPath: authFile() }))
      .rejects.toThrow(/expired and only the CLI can renew it/);
  });
});
