/** The rows a change can break: the mutated module, its definition, its witness, and their imports. */
export const GLOBAL_SCOPE_PATHS: readonly string[];
export const GLOBAL_SCOPE_PREFIXES: readonly string[];

export interface FalsifiabilityRowRef {
  readonly id?: string;
  readonly file?: string;
  readonly definedIn?: string;
  readonly killedBy?: readonly string[] | string;
}

export type AffectedClosure<Row> =
  | { readonly kind: "FULL"; readonly reason: string }
  | { readonly kind: "SELECTED"; readonly selected: ReadonlyArray<{ readonly row: Row; readonly because: readonly string[] }> };

export function witnessFilesOf(row: FalsifiabilityRowRef): readonly string[];

export function affectedClosure<Row extends FalsifiabilityRowRef>(input: {
  readonly rows: readonly Row[];
  readonly changedFiles: readonly string[];
  readonly imports?: ReadonlyMap<string, readonly string[]>;
  readonly undecidable?: readonly string[];
}): AffectedClosure<Row>;
