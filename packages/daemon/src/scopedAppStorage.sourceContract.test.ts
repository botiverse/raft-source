import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function source(name: string): ts.SourceFile {
  const filePath = new URL(name, import.meta.url);
  return ts.createSourceFile(
    name,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

test("daemon production source has exactly one platform scoped-storage root constructor in DaemonCore", () => {
  const corePath = fileURLToPath(new URL("core.ts", import.meta.url));
  const storagePath = fileURLToPath(new URL("scopedAppStorage.ts", import.meta.url));
  const sourceRoot = path.dirname(corePath);
  const productionSourcePaths: string[] = [];
  const collectProductionSources = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        collectProductionSources(entryPath);
      } else if (
        entry.isFile()
        && entry.name.endsWith(".ts")
        && !entry.name.endsWith(".test.ts")
      ) {
        productionSourcePaths.push(entryPath);
      }
    }
  };
  collectProductionSources(sourceRoot);
  const program = ts.createProgram({
    rootNames: productionSourcePaths,
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      skipLibCheck: true,
    },
  });
  const checker = program.getTypeChecker();
  const core = program.getSourceFile(corePath);
  const storage = program.getSourceFile(storagePath);
  assert.ok(core, "HARNESS-BROKEN: core.ts disappeared from the TypeScript program");
  assert.ok(storage, "HARNESS-BROKEN: scopedAppStorage.ts disappeared from the TypeScript program");
  const factoryDeclaration = storage.statements
    .filter(ts.isFunctionDeclaration)
    .find((statement) => statement.name?.text === "createScopedAppStorageFactory");
  assert.ok(factoryDeclaration?.name, "HARNESS-BROKEN: canonical scoped-storage root factory disappeared");
  const factorySymbol = checker.getSymbolAtLocation(factoryDeclaration.name);
  assert.ok(factorySymbol, "HARNESS-BROKEN: canonical scoped-storage root factory has no symbol");

  const unexpectedValueReferences: ts.Expression[] = [];
  const resolvesDirectlyToFactory = (expression: ts.Expression): boolean => {
    let symbol = checker.getSymbolAtLocation(expression);
    if (!symbol && ts.isPropertyAccessExpression(expression)) {
      symbol = checker.getSymbolAtLocation(expression.name);
    }
    if (!symbol) return false;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol === factorySymbol;
  };
  const isTypeOnlyReference = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isTypeNode(current)) return true;
      if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
    }
    return false;
  };
  const isAllowedCallSiteReference = (expression: ts.Expression): boolean => {
    let current: ts.Expression = expression;
    while (
      current.parent
      && (
        ts.isParenthesizedExpression(current.parent)
        || ts.isAsExpression(current.parent)
        || ts.isTypeAssertionExpression(current.parent)
        || ts.isSatisfiesExpression(current.parent)
        || ts.isNonNullExpression(current.parent)
      )
      && current.parent.expression === current
    ) {
      current = current.parent;
    }
    return ts.isCallExpression(current.parent) && current.parent.expression === current;
  };

  const resolvesToFactory = (expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    let unwrapped = expression;
    while (
      ts.isParenthesizedExpression(unwrapped)
      || ts.isAsExpression(unwrapped)
      || ts.isTypeAssertionExpression(unwrapped)
      || ts.isSatisfiesExpression(unwrapped)
      || ts.isNonNullExpression(unwrapped)
    ) {
      unwrapped = unwrapped.expression;
    }
    let symbol = checker.getSymbolAtLocation(unwrapped);
    if (!symbol && ts.isPropertyAccessExpression(unwrapped)) {
      symbol = checker.getSymbolAtLocation(unwrapped.name);
    }
    if (!symbol) return false;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    if (symbol === factorySymbol) return true;
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    return symbol.declarations?.some((declaration) => (
      ts.isVariableDeclaration(declaration)
      && declaration.initializer !== undefined
      && resolvesToFactory(declaration.initializer, seen)
    )) ?? false;
  };

  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && resolvesToFactory(node.expression)
    ) {
      calls.push(node);
    }
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))
      && !(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isIdentifier(node) && (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)))
      && node !== factoryDeclaration.name
      && !isTypeOnlyReference(node)
      && resolvesDirectlyToFactory(node)
      && !isAllowedCallSiteReference(node)
    ) {
      unexpectedValueReferences.push(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const sourcePath of productionSourcePaths) {
    const sourceFile = program.getSourceFile(sourcePath);
    assert.ok(sourceFile, `HARNESS-BROKEN: ${sourcePath} disappeared from the TypeScript program`);
    visit(sourceFile);
  }
  assert.notEqual(
    calls.length,
    0,
    "HARNESS-BROKEN: production scoped-storage root constructor disappeared",
  );
  assert.equal(
    calls.length,
    1,
    "Daemon production source must have exactly one platform scoped-storage root constructor",
  );
  assert.equal(
    path.resolve(calls[0]!.getSourceFile().fileName),
    path.resolve(corePath),
    "the sole platform scoped-storage root constructor must remain in DaemonCore",
  );
  assert.deepEqual(
    unexpectedValueReferences.map((reference) => `${reference.getSourceFile().fileName}:${reference.getStart()}`),
    [],
    "the scoped-storage root factory must not escape its sole inspected Core call site",
  );
  const argument = calls[0]!.arguments[0];
  assert.ok(
    argument && ts.isObjectLiteralExpression(argument),
    "HARNESS-BROKEN: scoped-storage root options are no longer inspectable",
  );
  const names = argument.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    return [property.name.getText()];
  });
  assert.equal(names.includes("slockHome"), true, "HARNESS-BROKEN: scoped-storage root lost slockHome");
  assert.equal(names.includes("owner"), true, "HARNESS-BROKEN: scoped-storage root lost owner binding");
  assert.equal(names.includes("writerEpoch"), true, "HARNESS-BROKEN: scoped-storage root lost writer epoch");
});
