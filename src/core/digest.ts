import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, undefined dropped, no insignificant whitespace.
 * Digests are part of the contract surface (CP-HI-06 exact evidence) so the encoding
 * has to be reproducible across processes and releases.
 */
export const canonicalJson = (value: unknown): string => {
  const encode = (node: unknown): string => {
    if (node === null) return "null";
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new TypeError("non-finite number in canonical json");
      return JSON.stringify(node);
    }
    if (typeof node === "boolean" || typeof node === "string") return JSON.stringify(node);
    if (typeof node === "bigint") return JSON.stringify(node.toString());
    if (Array.isArray(node)) return `[${node.map((item) => encode(item ?? null)).join(",")}]`;
    if (typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`).join(",")}}`;
    }
    throw new TypeError(`unsupported value in canonical json: ${typeof node}`);
  };
  return encode(value);
};

export const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

/** `sha256:<hex>` — the prefixed form used everywhere in the PRD schemas. */
export const sha256 = (input: string | Buffer): string => `sha256:${sha256Hex(input)}`;

export const digestOf = (value: unknown): string => sha256(canonicalJson(value));

/** Order-independent digest over a set of strings (e.g. covered file paths). */
export const digestOfSet = (values: readonly string[]): string =>
  sha256([...values].sort().join("\n"));

export const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
