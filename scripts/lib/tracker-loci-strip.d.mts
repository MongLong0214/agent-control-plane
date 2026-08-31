export function blankKeepingNewlines(match: string): string;
/**
 * @typedef {object} StringBoundaryRule
 * @property {string} form
 * @property {string} open
 * @property {string} close
 * @property {"any" | readonly string[]} backslashEscapes
 * @property {boolean} [doubledCloseEscapes]
 * @property {boolean} rawNewlineEndsSpan
 */
/**
 * Quote boundaries for the three dispatches whose review counterexamples depend on delimiter
 * width, escape syntax, and raw-newline behavior. Longest openers come first so Python's triple
 * quotes and Bash's `$'` are each one token, never a sequence of shorter quote tokens.
 *
 * `backslashEscapes` names exactly which following characters cannot act as syntax: `"any"` for
 * Python and Bash ANSI-C quotes, an empty list for Bash single quotes, and Bash's five special
 * double-quote characters for Bash double quotes. `doubledCloseEscapes` records YAML's `''`
 * escape, which is neither a backslash escape nor two boundaries. `rawNewlineEndsSpan` says
 * whether an unescaped newline ends an unterminated quoted span: Python's short strings do;
 * Python triple strings, all three Bash quote forms, and both YAML quoted scalar forms do not.
 * Python's `f`/`r` prefixes sit before these delimiters and do not change their boundary rules;
 * f-string replacement fields remain part of the blanked span.
 *
 * YAML plain scalars do not have a quote delimiter at all, so `stripYamlSource` selects the two
 * rules in `yaml` only at a YAML value start. Its indentation-delimited block scalars are handled
 * by the same walk before quote matching.
 *
 * @type {Readonly<{python: readonly StringBoundaryRule[], shell: readonly StringBoundaryRule[], yaml: readonly StringBoundaryRule[]}>}
 */
export const STRING_BOUNDARY_RULES: Readonly<{
    python: readonly StringBoundaryRule[];
    shell: readonly StringBoundaryRule[];
    yaml: readonly StringBoundaryRule[];
}>;
export function stripSlashComments(text: string): string;
export function stripHashComments(text: string): string;
export function stripSqlComments(text: string): string;
export function stripStrings(text: string, rules?: readonly StringBoundaryRule[]): string;
export function stripPythonSource(text: string, blankStrings: boolean): string;
export function stripJsSource(text: string, blankStrings: boolean): string;
export function stripTemplateLiteralProse(text: string): string;
export function stripShellSource(text: string, blankStrings: boolean): string;
export function stripYamlSource(text: string, blankStrings: boolean): string;
export function stripSqlSource(text: string, blankStrings: boolean): string;
export type StringBoundaryRule = {
    form: string;
    open: string;
    close: string;
    backslashEscapes: "any" | readonly string[];
    doubledCloseEscapes?: boolean;
    rawNewlineEndsSpan: boolean;
};
