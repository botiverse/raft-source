import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function source(name: string): ts.SourceFile {
  const url = new URL(name, import.meta.url);
  return ts.createSourceFile(
    name,
    readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function propertyReferences(file: ts.SourceFile, owner: string, property: string): ts.PropertyAccessExpression[] {
  const references: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && node.name.text === property
      && node.expression.getText(file) === owner
    ) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}

function directCall(reference: ts.PropertyAccessExpression): ts.CallExpression | null {
  return ts.isCallExpression(reference.parent) && reference.parent.expression === reference
    ? reference.parent
    : null;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function functionName(node: ts.Node): string {
  const fn = enclosingFunction(node);
  if (!fn || !("name" in fn) || !fn.name) return "<anonymous>";
  return fn.name.getText();
}

function isInsideTryBlock(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTryStatement(current) && current.tryBlock.pos <= node.pos && node.end <= current.tryBlock.end) {
      return true;
    }
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function isAsyncFunction(node: ts.Node): boolean {
  const fn = enclosingFunction(node);
  return fn !== null
    && ts.canHaveModifiers(fn)
    && ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function productionProgram(): { program: ts.Program; sourceRoot: string } {
  const sourceRoot = path.dirname(fileURLToPath(new URL("agentProcessManager.ts", import.meta.url)));
  const rootNames: string[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        rootNames.push(entryPath);
      }
    }
  };
  collect(sourceRoot);
  return {
    sourceRoot,
    program: ts.createProgram({
      rootNames,
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        skipLibCheck: true,
      },
    }),
  };
}

function canonicalClassProperty(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
  className: string,
  propertyName: string,
): ts.Symbol {
  const declaration = file.statements
    .filter(ts.isClassDeclaration)
    .find((candidate) => candidate.name?.text === className)
    ?.members
    .filter(ts.isPropertyDeclaration)
    .find((candidate) => candidate.name?.getText(file) === propertyName);
  assert.ok(declaration?.name, `HARNESS-BROKEN: ${className}.${propertyName} declaration disappeared`);
  const symbol = checker.getSymbolAtLocation(declaration.name);
  assert.ok(symbol, `HARNESS-BROKEN: ${className}.${propertyName} has no TypeScript symbol`);
  return symbol;
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

type CapabilityReference = ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.BindingElement;

function capabilityReferences(
  program: ts.Program,
  canonical: ts.Symbol,
  propertyName: string,
): CapabilityReference[] {
  const checker = program.getTypeChecker();
  const references: CapabilityReference[] = [];
  const resolvesToCanonical = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    if (resolvedSymbol(checker, node) === canonical) return true;
    if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression
      && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
      && node.argumentExpression.text === propertyName
    ) {
      return checker.getTypeAtLocation(node.expression).getProperty(propertyName) === canonical;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && resolvesToCanonical(node)
    ) {
      references.push(node);
    }
    if (ts.isBindingElement(node)) {
      const pattern = node.parent;
      const declaration = ts.isObjectBindingPattern(pattern) ? pattern.parent : undefined;
      const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      const nameNode = node.propertyName ?? node.name;
      const name = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)
        ? nameNode.text
        : undefined;
      if (
        initializer
        && name === propertyName
        && checker.getTypeAtLocation(initializer).getProperty(propertyName) === canonical
      ) {
        references.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile && !sourceFile.fileName.endsWith(".test.ts")) visit(sourceFile);
  }
  return references;
}

function directCapabilityCall(reference: CapabilityReference): ts.CallExpression | null {
  if (ts.isBindingElement(reference)) return null;
  return ts.isCallExpression(reference.parent) && reference.parent.expression === reference
    ? reference.parent
    : null;
}

function isAllowedCapabilityNonCall(reference: CapabilityReference): boolean {
  if (ts.isBindingElement(reference)) return false;
  const parent = reference.parent;
  return (
    ts.isBinaryExpression(parent)
    && parent.left === reference
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) || (
    ts.isPrefixUnaryExpression(parent)
    && parent.operator === ts.SyntaxKind.ExclamationToken
  );
}

function inspectCapability(
  program: ts.Program,
  sourceFileName: string,
  className: string,
  propertyName: string,
): {
  calls: ts.CallExpression[];
  escapes: CapabilityReference[];
} {
  const manager = program.getSourceFile(sourceFileName);
  assert.ok(manager, `HARNESS-BROKEN: ${sourceFileName} disappeared from the TypeScript program`);
  const canonical = canonicalClassProperty(
    program.getTypeChecker(),
    manager,
    className,
    propertyName,
  );
  const references = capabilityReferences(program, canonical, propertyName);
  return {
    calls: references.flatMap((reference) => directCapabilityCall(reference) ?? []),
    escapes: references.filter((reference) => !directCapabilityCall(reference) && !isAllowedCapabilityNonCall(reference)),
  };
}

function directEvalCalls(file: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "eval"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

test("Reminder App Inbox routes remain a closed set with caught failure boundaries", () => {
  const core = source("core.ts");
  const reminder = source("apps/reminder/runtime.ts");

  const coreReferences = propertyReferences(core, "this", "getAgentAppInbox");
  const coreCalls = coreReferences.flatMap((reference) => directCall(reference) ?? []);
  assert.equal(coreCalls.length >= 2, true, "HARNESS-BROKEN: canonical App Inbox roots disappeared");
  assert.equal(
    coreReferences.length,
    coreCalls.length,
    "getAgentAppInbox must not escape its inspected adapter call sites",
  );
  const rootBindings = coreCalls.map((call) => {
    for (let current = call.parent; current; current = current.parent) {
      if (ts.isPropertyAssignment(current)) return current.name.getText();
      if (ts.isStatement(current)) break;
    }
    return "<unbound>";
  }).sort();
  for (const required of ["appInboxForAgent", "getInbox"]) {
    assert.equal(rootBindings.includes(required), true, `HARNESS-BROKEN: ${required} App Inbox root disappeared`);
  }
  assert.deepEqual(
    rootBindings,
    ["appInboxForAgent", "getInbox"],
    "every getAgentAppInbox production route must be a canonical inspected adapter root",
  );

  const { program, sourceRoot } = productionProgram();
  const managerPath = path.join(sourceRoot, "agentProcessManager.ts");
  const { calls: managerCalls, escapes: managerEscapes } = inspectCapability(
    program,
    managerPath,
    "AgentProcessManager",
    "#appInboxForAgent",
  );
  const managerCallNames = managerCalls.map(functionName).sort();
  for (const required of ["drainAppInboxAfterIdleTransition", "notifyAgentAppInbox", "startAgentNow"]) {
    assert.equal(managerCallNames.includes(required), true, `HARNESS-BROKEN: ${required} App Inbox route disappeared`);
  }
  assert.deepEqual(
    managerCallNames,
    ["drainAppInboxAfterIdleTransition", "notifyAgentAppInbox", "startAgentNow"],
    "all AgentProcessManager App Inbox calls must remain in the enumerated caught routes",
  );
  assert.deepEqual(
    managerEscapes.map((reference) => `${path.basename(reference.getSourceFile().fileName)}:${reference.getStart()}`),
    [],
    "appInboxForAgent must not escape through an uninspected value reference",
  );
  const manager = program.getSourceFile(managerPath);
  assert.ok(manager, "HARNESS-BROKEN: AgentProcessManager source disappeared");
  assert.deepEqual(
    directEvalCalls(manager).map((call) => `${path.basename(call.getSourceFile().fileName)}:${call.getStart()}`),
    [],
    "AgentProcessManager must not use direct eval that can access private capability brands",
  );
  for (const call of managerCalls) {
    const owner = functionName(call);
    if (owner === "drainAppInboxAfterIdleTransition") {
      assert.equal(isInsideTryBlock(call), true, "idle runtime-event App Inbox read must stay inside its catch boundary");
    } else {
      assert.equal(isAsyncFunction(call), true, `${owner} App Inbox failure must project as a caught Promise rejection`);
    }
  }

  const reminderReferences = propertyReferences(reminder, "options", "getInbox");
  const reminderCalls = reminderReferences.flatMap((reference) => directCall(reference) ?? []);
  assert.equal(reminderCalls.length >= 1, true, "HARNESS-BROKEN: Reminder Inbox materialization route disappeared");
  assert.deepEqual(
    reminderCalls.map(functionName),
    ["materializeFire"],
    "Reminder Inbox materialization must remain on the one budgeted async route",
  );
  assert.equal(
    reminderReferences.length,
    reminderCalls.length,
    "Reminder getInbox capability must not escape its inspected materialization call",
  );
  assert.equal(isAsyncFunction(reminderCalls[0]!), true, "Reminder getInbox throw must reject into ReminderCache retry handling");
});

test("App Inbox route gate rejects destructured, computed, and aliased capability escapes", () => {
  const fileName = "/capability-escape-fixture.ts";
  const text = `
    class AgentProcessManager {
      private readonly appInboxForAgent: ((agentId: string) => { list(): unknown[] }) | null = null;
      reviewerSurvivor(agentId: string): void {
        const { appInboxForAgent } = this;
        appInboxForAgent?.(agentId).list();
      }
      computedEscape(): void {
        const escaped = this["appInboxForAgent"];
        void escaped;
      }
      aliasedEscape(): void {
        const escaped = this.appInboxForAgent;
        void escaped;
      }
    }
  `;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost({ noLib: true });
  host.fileExists = (candidate) => candidate === fileName;
  host.readFile = (candidate) => candidate === fileName ? text : undefined;
  host.getSourceFile = (candidate) => candidate === fileName ? sourceFile : undefined;
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { noLib: true, target: ts.ScriptTarget.ES2022 },
    host,
  });
  const { escapes } = inspectCapability(
    program,
    fileName,
    "AgentProcessManager",
    "appInboxForAgent",
  );
  assert.deepEqual(
    escapes.map((reference) => functionName(reference)).sort(),
    ["aliasedEscape", "computedEscape", "reviewerSurvivor"],
    "all capability value escapes, including the reviewer survivor, must fail closed",
  );
});

test("private App Inbox capability cannot be reached through reflection", () => {
  const sentinel = (): string => "private-capability";
  class PrivateCapabilityFixture {
    readonly #appInboxForAgent = sentinel;

    reflectLegacyName(): unknown {
      return Reflect.get(this, "appInboxForAgent");
    }

    reflectPrivateSpelling(): unknown {
      return Reflect.get(this, "#appInboxForAgent");
    }

    direct(): () => string {
      return this.#appInboxForAgent;
    }
  }

  const fixture = new PrivateCapabilityFixture();
  assert.equal(fixture.reflectLegacyName(), undefined);
  assert.equal(fixture.reflectPrivateSpelling(), undefined);
  assert.equal(fixture.direct(), sentinel);
});

test("direct-eval ban detects lexical private-brand access", () => {
  const file = ts.createSourceFile(
    "/private-brand-eval-fixture.ts",
    `
      class AgentProcessManager {
        readonly #appInboxForAgent = () => "private-capability";
        escaped(): unknown {
          return eval("this.#appInboxForAgent");
        }
      }
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  assert.deepEqual(
    directEvalCalls(file).map(functionName),
    ["escaped"],
    "direct eval must remain mechanically visible as the private-brand lexical escape",
  );
});
