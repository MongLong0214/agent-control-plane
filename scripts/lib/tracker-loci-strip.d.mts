/**
 * Types for the one script module a test imports directly.
 *
 * The scripts are plain `.mjs` on purpose — dependency-free, runnable by `node` with no build — and
 * that is fine until a `.ts` test imports one, which `tsc` refuses without a declaration. Written
 * by hand rather than by loosening `noImplicitAny`, because the check that would have to be turned
 * off is the one that catches this.
 */
export declare const blankKeepingNewlines: (match: string) => string;
export declare const stripSlashComments: (text: string) => string;
export declare const stripHashComments: (text: string) => string;
export declare const stripSqlComments: (text: string) => string;
export declare const stripStrings: (text: string) => string;
export declare const stripTemplateLiteralProse: (text: string) => string;
