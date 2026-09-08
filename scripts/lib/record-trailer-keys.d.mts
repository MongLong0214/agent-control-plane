/**
 * Types for a script module a `.ts` test imports directly.
 *
 * Hand-written for the same reason as `collapse-trailer-paragraphs.d.mts`: the scripts are plain
 * `.mjs` so `node` can run them with no build, and `tsc` refuses such an import without a
 * declaration. Loosening `noImplicitAny` instead would turn off the check that catches this.
 */
export declare const RECORD_TRAILER_KEYS: readonly string[];
export declare const RECORD_TRAILER_KEY_PATTERN: RegExp;
