/** Where the modules live, relative to the repository root. Named once; used by every consumer. */
export const CASES_DIR: "scripts/falsifiability-cases";
export function loadFalsifiabilityCases(root: string): Promise<object[]>;
