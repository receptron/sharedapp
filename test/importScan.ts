// Which modules a source file LOADS, and which names it takes from each.
//
// Two guards ask this: `test_viewSelfContained.ts` (nothing under `view/` may load anything outside
// it) and `test_coreCompat.ts` (core is reached through exactly these names). They used to ask it
// twice, in two hand-written matchers, and the two DISAGREED — which is the state where one of them
// is wrong and nothing says which.
//
// It is read off the syntax tree rather than the text, so a comment or a string that merely spells
// an import is not one, a clause broken over several lines is the same clause, and a bare
// `import "…"` or a dynamic `import()` is not invisible.
//
// THE RULE THE TEXT MATCHERS GOT WRONG: under `verbatimModuleSyntax` — which this package sets —
// only an `import type` / `export type` CLAUSE is erased. `import { type A, type B } from "m"` is
// not: it compiles to `import {} from "m"`, which still loads `m`. Compiled and checked, with the
// package's own compiler options.

import ts from "typescript";

/** One reach from a source file into another module. `runtime` is whether the module loads when
 *  the file does; `values` and `types` are the names taken from it, kept apart because only the
 *  first costs anything at run time and only the second can appear in an emitted `.d.ts`. */
export type ModuleReach = { specifier: string; runtime: boolean; values: string[]; types: string[] };

/** A dynamic `import()` whose argument is not a string literal could reach anything, so it counts
 *  as a reach of its own — a caller's pins then go red instead of the scan looking away. */
export const UNRESOLVED = "<import() of a non-literal>";

const specifierOf = (node: ts.Expression | undefined): string => (node !== undefined && ts.isStringLiteral(node) ? node.text : UNRESOLVED);

const splitNamed = (elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[], allTypes: boolean): Pick<ModuleReach, "values" | "types"> => ({
  values: elements.filter((element) => !allTypes && !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text),
  types: elements.filter((element) => allTypes || element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text),
});

const reachOf = (specifier: string, allTypes: boolean, whole: string[], named: Pick<ModuleReach, "values" | "types">): ModuleReach =>
  allTypes
    ? { specifier, runtime: false, values: [], types: [...whole, ...named.types] }
    : { specifier, runtime: true, values: [...whole, ...named.values], types: named.types };

const reachOfImport = (node: ts.ImportDeclaration): ModuleReach => {
  const specifier = specifierOf(node.moduleSpecifier);
  const clause = node.importClause;
  if (clause === undefined) return { specifier, runtime: true, values: [], types: [] };
  // `import defer` still loads its module, so only the `type` phase counts as erased.
  const typeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
  const bindings = clause.namedBindings;
  const whole = [...(clause.name === undefined ? [] : ["default"]), ...(bindings !== undefined && ts.isNamespaceImport(bindings) ? ["*"] : [])];
  return reachOf(specifier, typeOnly, whole, splitNamed(bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : [], typeOnly));
};

const reachOfExport = (node: ts.ExportDeclaration): ModuleReach => {
  const clause = node.exportClause;
  const whole = clause === undefined || ts.isNamespaceExport(clause) ? ["*"] : [];
  return reachOf(
    specifierOf(node.moduleSpecifier),
    node.isTypeOnly,
    whole,
    splitNamed(clause !== undefined && ts.isNamedExports(clause) ? clause.elements : [], node.isTypeOnly),
  );
};

/** Every module one file reaches. Callers narrow it: to the specifiers that escape a directory, or
 *  to one package's subpaths. */
export const reachesIn = (fileName: string, source: string): ModuleReach[] => {
  const found: ModuleReach[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) found.push(reachOfImport(node));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) found.push(reachOfExport(node));
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      found.push({ specifier: specifierOf(node.arguments[0]), runtime: true, values: ["*"], types: [] });
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true));
  return found;
};
