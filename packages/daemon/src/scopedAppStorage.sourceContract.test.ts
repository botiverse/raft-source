import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "vitest";
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

function propertyNames(type: ts.TypeLiteralNode): string[] {
  return type.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || !member.name) return [];
    return [member.name.getText()];
  });
}

function interfacePropertyNames(file: ts.SourceFile, name: string): string[] {
  const declaration = file.statements
    .filter(ts.isInterfaceDeclaration)
    .find((statement) => statement.name.text === name);
  assert.ok(declaration, `HARNESS-BROKEN: ${name} interface disappeared`);
  return declaration.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || !member.name) return [];
    return [member.name.getText()];
  });
}

function declaredStringSet(file: ts.SourceFile, name: string): Set<string> {
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  assert.ok(declaration?.initializer, `HARNESS-BROKEN: ${name} disappeared`);
  let initializer: ts.Expression = declaration.initializer;
  if (ts.isAsExpression(initializer)) initializer = initializer.expression;
  assert.ok(ts.isArrayLiteralExpression(initializer), `HARNESS-BROKEN: ${name} is no longer a closed array`);
  return new Set(initializer.elements.map((element) => {
    assert.ok(ts.isStringLiteral(element), `HARNESS-BROKEN: ${name} gained a non-literal member`);
    return element.text;
  }));
}

function rejectionCallSet(file: ts.SourceFile): Set<string> {
  const values = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "rejectPersistedPayload"
    ) {
      const argument = node.arguments[0];
      assert.ok(argument && ts.isStringLiteral(argument), "HARNESS-BROKEN: rejection call lost its literal member");
      assert.equal(values.has(argument.text), false, `HARNESS-BROKEN: duplicate rejection member ${argument.text}`);
      values.add(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

function identifierReferenceCount(file: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

test("persisted restore rejection unions equal the actual expected-input branches", () => {
  const cases = [
    {
      file: source("agentAppInbox.ts"),
      constant: "AGENT_APP_INBOX_PERSISTED_REJECTION_CODES",
      helpers: ["restorePersistedItem", "restoreAcknowledgedSource", "restoreAckIntent"],
    },
    {
      file: source("apps/reminder/reminderCache.ts"),
      constant: "REMINDER_PERSISTED_REJECTION_CODES",
      helpers: ["validatePersistedRecord"],
    },
  ];
  for (const subject of cases) {
    assert.deepEqual(
      [...rejectionCallSet(subject.file)].sort(),
      [...declaredStringSet(subject.file, subject.constant)].sort(),
      `${subject.constant} must exactly equal the actual expected-input rejection set`,
    );
    for (const helper of subject.helpers) {
      assert.equal(
        identifierReferenceCount(subject.file, helper),
        2,
        `${helper} must have exactly one declaration and one canonical caller`,
      );
    }
    assert.equal(
      identifierReferenceCount(subject.file, "reportDataFailure"),
      1,
      "the outer restore boundary must remain the sole data-failure reporter",
    );
  }
});

test("Agent Inbox production API cannot regain filesystem path authority", () => {
  const inbox = source("agentAppInbox.ts");
  const functionDeclarations = inbox.statements.filter(ts.isFunctionDeclaration);
  const factory = functionDeclarations.find((statement) => statement.name?.text === "createAgentAppInboxStore");
  assert.ok(factory, "HARNESS-BROKEN: createAgentAppInboxStore declaration disappeared");
  const optionsType = factory.parameters[0]?.type;
  assert.ok(
    optionsType && ts.isTypeLiteralNode(optionsType),
    "HARNESS-BROKEN: createAgentAppInboxStore options are no longer an inspectable type literal",
  );
  const names = propertyNames(optionsType);
  assert.equal(names.includes("storage"), true, "HARNESS-BROKEN: scoped storage capability disappeared");
  assert.equal(names.includes("persistencePath"), false, "Agent Inbox must not accept a raw persistencePath");

  const forbiddenImports = inbox.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
    .filter((specifier) => specifier === "node:fs" || specifier === "node:path" || specifier.endsWith("/raftHome.js"));
  assert.deepEqual(
    forbiddenImports,
    [],
    "Agent Inbox must not import filesystem/path/root constructors",
  );
});

test("DaemonCore injects scoped storage into every production Agent Inbox constructor", () => {
  const core = source("core.ts");
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "createAgentAppInboxStore"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(core);
  assert.equal(calls.length, 1, "HARNESS-BROKEN: expected exactly one production Agent Inbox constructor");
  const argument = calls[0]!.arguments[0];
  assert.ok(argument && ts.isObjectLiteralExpression(argument), "HARNESS-BROKEN: Agent Inbox options are no longer inspectable");
  const names = argument.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    return [property.name.getText()];
  });
  assert.equal(names.includes("storage"), true, "production Agent Inbox must receive scoped storage");
  assert.equal(names.includes("persistencePath"), false, "production Agent Inbox must not receive a raw path");
});

test("DaemonCore's sole scoped-storage failure hook feeds the closed observer", () => {
  const core = source("core.ts");
  const factoryCalls: ts.CallExpression[] = [];
  const observerCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "createScopedAppStorageFactory") factoryCalls.push(node);
      if (node.expression.text === "createScopedAppStorageObserver") observerCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(core);
  assert.equal(observerCalls.length, 1, "INSTRUMENT-FAILED: production observer constructor disappeared or multiplied");
  assert.equal(factoryCalls.length, 1, "HARNESS-BROKEN: production scoped-storage factory disappeared or multiplied");

  const factoryOptions = factoryCalls[0]!.arguments[0];
  assert.ok(
    factoryOptions && ts.isObjectLiteralExpression(factoryOptions),
    "HARNESS-BROKEN: scoped-storage options are no longer inspectable",
  );
  const onFailure = factoryOptions.properties.find((property) =>
    (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))
    && property.name.getText() === "onFailure"
  );
  assert.ok(onFailure, "INSTRUMENT-FAILED: scoped-storage onFailure hook disappeared");
  const callback = ts.isPropertyAssignment(onFailure) ? onFailure.initializer : onFailure;
  assert.ok(
    ts.isArrowFunction(callback)
      || ts.isFunctionExpression(callback)
      || ts.isMethodDeclaration(callback),
    "HARNESS-BROKEN: onFailure callback is no longer an inspectable function",
  );
  const parameter = callback.parameters[0]?.name;
  assert.ok(parameter && ts.isIdentifier(parameter), "HARNESS-BROKEN: onFailure event parameter is not inspectable");

  const observeCalls: ts.CallExpression[] = [];
  const visitHook = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "observe"
    ) {
      observeCalls.push(node);
    }
    ts.forEachChild(node, visitHook);
  };
  visitHook(callback);
  assert.equal(
    observeCalls.length,
    1,
    "INSTRUMENT-FAILED: every production storage failure must reach exactly one observer hook",
  );
  const observeArgument = observeCalls[0]!.arguments[0];
  assert.ok(
    observeArgument
      && ts.isIdentifier(observeArgument)
      && observeArgument.text === parameter.text,
    "INSTRUMENT-FAILED: observer hook must receive the exact storage failure event",
  );
});

test("Reminder production APIs expose scoped receipt storage and no raw persistence path", () => {
  const cacheNames = interfacePropertyNames(
    source("apps/reminder/reminderCache.ts"),
    "ReminderCacheOptions",
  );
  assert.equal(
    cacheNames.includes("storageForAgent"),
    true,
    "Reminder cache must receive an Agent-scoped storage capability",
  );
  assert.equal(
    cacheNames.includes("persistencePath"),
    false,
    "Reminder cache must not accept a raw persistencePath",
  );

  const runtimeNames = interfacePropertyNames(
    source("apps/reminder/runtime.ts"),
    "ReminderRuntimeOptions",
  );
  assert.equal(
    runtimeNames.includes("persistencePath"),
    false,
    "Reminder runtime must not accept a raw persistencePath",
  );

  const registryNames = interfacePropertyNames(
    source("registry.manifest.ts"),
    "BuiltInLocalAppRuntimeOptions",
  );
  assert.equal(
    registryNames.includes("persistencePath"),
    false,
    "built-in runtime registry must not accept a raw persistencePath",
  );
});

test("built-in registry only names the legacy Reminder mirror at the quarantine boundary", () => {
  const registry = source("registry.manifest.ts");
  const legacyPathLiterals: ts.StringLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text === "reminders/mirror.json") {
      legacyPathLiterals.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(registry);
  assert.equal(
    legacyPathLiterals.length,
    1,
    "legacy Reminder mirror path must have exactly one production reference",
  );
  const literal = legacyPathLiterals[0]!;
  assert.ok(
    ts.isCallExpression(literal.parent) && literal.parent.arguments[0] === literal,
    "legacy Reminder mirror path must be the first argument of an inspected call",
  );
  const expression = literal.parent.expression;
  assert.ok(
    ts.isPropertyAccessExpression(expression)
      && expression.name.text === "quarantineLegacyFile",
    "legacy Reminder mirror may only flow to quarantineLegacyFile",
  );
});

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
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
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
