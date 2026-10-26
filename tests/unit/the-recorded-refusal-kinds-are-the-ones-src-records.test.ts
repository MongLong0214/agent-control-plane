import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, it } from "vitest";

import { RECORDED_REFUSAL_KINDS } from "../../src/db/audit.ts";

/**
 * #1213 — the audit log has no declared registry of its kinds (`AuditRecord.kind` is a string), so the
 * refusal kinds ACP records are derived here from the emitters: every literal `_REFUSED` kind of an object
 * the type checker types as an `AuditRecord` in src. `RECORDED_REFUSAL_KINDS` must be exactly that set, so
 * it can neither name a kind nothing records nor fall behind a new emitter. A kind passed through a
 * string-typed wrapper is not seen, and so is not known: the safe side for every reader of the set.
 */
it("RECORDED_REFUSAL_KINDS is every literal _REFUSED kind an AuditRecord in src carries", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames.filter(path => path.startsWith(`${root}src/`)), parsed.options);
  const checker = program.getTypeChecker();
  const auditRecord = (type: ts.Type | undefined): boolean => type !== undefined &&
    (type.isUnion() ? type.types.some(auditRecord) : type.getSymbol()?.getName() === "AuditRecord" &&
      type.getSymbol()?.declarations?.some(declaration => declaration.getSourceFile().fileName === `${root}src/db/audit.ts`) === true);
  const literals = (type: ts.Type): string[] =>
    type.isUnion() ? type.types.flatMap(literals) : type.isStringLiteral() ? [type.value] : [];
  const derived = new Set<string>();
  for (const source of program.getSourceFiles().filter(file => file.fileName.startsWith(`${root}src/`))) {
    const visit = (node: ts.Node): void => {
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(source) === "kind" &&
        ts.isObjectLiteralExpression(node.parent) && auditRecord(checker.getContextualType(node.parent))) {
        const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
        for (const kind of literals(checker.getTypeAtLocation(value))) if (kind.endsWith("_REFUSED")) derived.add(kind);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect([...RECORDED_REFUSAL_KINDS].sort()).toEqual([...derived].sort());
});
