#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import ts from "typescript";

const OWNER_FUNCTION = "withOperatorClient";
const CLIENT_FACTORY_FUNCTION = "getClient";
const DEFAULT_OWNER_FILE = "src/worker.ts";

// This is deliberately a structural, direct-call regression guard rather than
// a TypeScript data-flow analysis. It pins the production ownership chain
// `new Client -> getClient -> withOperatorClient` and every direct
// `.connect()` / `.end()` call in this package. Calls hidden behind aliases or
// dynamic property names are outside its model; runtime worker tests cover the
// lifetime semantics that originally regressed.

export const DEFAULT_PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

function normalizedPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isProductionTypeScript(filePath) {
  if (!/\.(?:tsx?|[mc]ts)$/.test(filePath)) return false;
  if (/\.(?:test|spec)\.(?:tsx?|[mc]ts)$/.test(filePath)) return false;
  return !/\.d\.(?:ts|mts|cts)$/.test(filePath);
}

function listProductionSources(root, relativeDirectory = "src") {
  const directory = path.join(root, relativeDirectory);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = normalizedPath(
      path.join(relativeDirectory, entry.name),
    );
    if (entry.isSymbolicLink()) {
      throw new Error(
        `operator-client-lifetime: symbolic links are unsupported: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...listProductionSources(root, relativePath));
    } else if (entry.isFile() && isProductionTypeScript(relativePath)) {
      files.push({
        path: relativePath,
        source: readFileSync(path.join(root, relativePath), "utf8"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function calledMethod(call) {
  const expression = call.expression;
  if (ts.isPropertyAccessExpression(expression)) {
    return {
      method: expression.name.text,
      receiver: expression.expression.getText(),
    };
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return {
      method: expression.argumentExpression.text,
      receiver: expression.expression.getText(),
    };
  }
  return null;
}

function enclosingTopLevelFunction(node) {
  const enclosing = enclosingFunction(node);
  return enclosing?.parent && ts.isSourceFile(enclosing.parent)
    ? enclosing
    : null;
}

function assignedVariable(call) {
  const parent = call.parent;
  if (
    !ts.isVariableDeclaration(parent) ||
    parent.initializer !== call ||
    !ts.isIdentifier(parent.name) ||
    !ts.isVariableDeclarationList(parent.parent)
  ) {
    return null;
  }
  return {
    name: parent.name.text,
    isConst: Boolean(parent.parent.flags & ts.NodeFlags.Const),
  };
}

function isDirectReturn(expression) {
  return (
    ts.isReturnStatement(expression.parent) &&
    expression.parent.expression === expression
  );
}

function isDirectPgClientImport(node) {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.moduleSpecifier.text !== "pg"
  ) {
    return false;
  }
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.some(
    (element) =>
      element.name.text === "Client" &&
      (!element.propertyName || element.propertyName.text === "Client"),
  );
}

function hasAwaitAncestor(node, boundary) {
  for (
    let current = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isAwaitExpression(current)) return true;
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function tryRole(node, boundary) {
  for (
    let current = node;
    current?.parent && current !== boundary;
    current = current.parent
  ) {
    const parent = current.parent;
    if (!ts.isTryStatement(parent)) continue;
    if (parent.tryBlock === current) return { statement: parent, role: "try" };
    if (parent.catchClause === current)
      return { statement: parent, role: "catch" };
    if (parent.finallyBlock === current)
      return { statement: parent, role: "finally" };
  }
  return null;
}

function sourcePosition(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { line: position.line + 1, column: position.character + 1 };
}

export function analyzeOperatorClientLifetimeSources(
  sources,
  { ownerFile = DEFAULT_OWNER_FILE } = {},
) {
  const normalizedOwnerFile = normalizedPath(ownerFile);
  const diagnostics = [];
  const ownerDeclarations = [];
  const clientFactoryDeclarations = [];
  const clientFactoryCalls = [];
  const clientConstructions = [];
  const pgClientImports = [];
  const lifetimeCalls = [];

  const addDiagnostic = (sourceFile, node, code, message, details = {}) => {
    const position = sourcePosition(sourceFile, node);
    diagnostics.push({
      code,
      file: normalizedPath(sourceFile.fileName),
      ...position,
      message,
      ...details,
    });
  };

  for (const source of sources) {
    const filePath = normalizedPath(source.path);
    const scriptKind = filePath.endsWith("x")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      filePath,
      source.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    for (const parseDiagnostic of sourceFile.parseDiagnostics ?? []) {
      const start = parseDiagnostic.start ?? 0;
      const node = sourceFile.getTokenAtPosition?.(start) ?? sourceFile;
      addDiagnostic(
        sourceFile,
        node,
        "parse-error",
        ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, "\n"),
      );
    }

    const visit = (node) => {
      if (filePath === normalizedOwnerFile && isDirectPgClientImport(node)) {
        pgClientImports.push({ node, sourceFile });
      }

      if (
        filePath === normalizedOwnerFile &&
        ts.isFunctionDeclaration(node) &&
        node.parent === sourceFile
      ) {
        if (node.name?.text === OWNER_FUNCTION)
          ownerDeclarations.push({ node, sourceFile });
        if (node.name?.text === CLIENT_FACTORY_FUNCTION)
          clientFactoryDeclarations.push({ node, sourceFile });
      }

      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === CLIENT_FACTORY_FUNCTION
        ) {
          clientFactoryCalls.push({
            node,
            sourceFile,
            enclosing: enclosingTopLevelFunction(node),
            assignedVariable: assignedVariable(node),
          });
        }
        const called = calledMethod(node);
        if (
          called &&
          (called.method === "connect" || called.method === "end")
        ) {
          lifetimeCalls.push({
            ...called,
            node,
            sourceFile,
            enclosing: enclosingFunction(node),
          });
        }
      }

      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Client"
      ) {
        clientConstructions.push({
          node,
          sourceFile,
          enclosing: enclosingTopLevelFunction(node),
          isDirectReturn: isDirectReturn(node),
        });
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (ownerDeclarations.length !== 1) {
    const ownerSource = sources.find(
      (source) => normalizedPath(source.path) === normalizedOwnerFile,
    );
    const sourceFile = ts.createSourceFile(
      normalizedOwnerFile,
      ownerSource?.source ?? "",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    addDiagnostic(
      sourceFile,
      sourceFile,
      "owner-count",
      `expected exactly one top-level ${OWNER_FUNCTION} declaration; found ${ownerDeclarations.length}`,
    );
    return diagnostics;
  }

  const owner = ownerDeclarations[0];
  if (pgClientImports.length !== 1) {
    addDiagnostic(
      owner.sourceFile,
      owner.node,
      "pg-client-import-count",
      `expected exactly one direct import of Client from pg in ${normalizedOwnerFile}; found ${pgClientImports.length}`,
    );
  }
  if (clientFactoryDeclarations.length !== 1) {
    addDiagnostic(
      owner.sourceFile,
      owner.node,
      "client-factory-count",
      `expected exactly one top-level ${CLIENT_FACTORY_FUNCTION} declaration in ${normalizedOwnerFile}; found ${clientFactoryDeclarations.length}`,
    );
  }
  const clientFactory = clientFactoryDeclarations[0];

  if (clientConstructions.length !== 1) {
    addDiagnostic(
      owner.sourceFile,
      owner.node,
      "client-construction-count",
      `expected exactly one direct new Client(...) construction in production sources; found ${clientConstructions.length}`,
    );
  }
  for (const construction of clientConstructions) {
    if (
      !clientFactory ||
      construction.sourceFile.fileName !== normalizedOwnerFile ||
      construction.enclosing !== clientFactory.node ||
      !construction.isDirectReturn
    ) {
      addDiagnostic(
        construction.sourceFile,
        construction.node,
        "client-construction-outside-factory",
        `new Client(...) must be returned directly by ${normalizedOwnerFile}#${CLIENT_FACTORY_FUNCTION}`,
      );
    }
  }

  if (clientFactoryCalls.length !== 1) {
    addDiagnostic(
      owner.sourceFile,
      owner.node,
      "client-factory-call-count",
      `${OWNER_FUNCTION} must be the sole direct caller of ${CLIENT_FACTORY_FUNCTION}(env); found ${clientFactoryCalls.length}`,
    );
  }
  for (const call of clientFactoryCalls) {
    if (
      call.sourceFile.fileName !== normalizedOwnerFile ||
      call.enclosing !== owner.node
    ) {
      addDiagnostic(
        call.sourceFile,
        call.node,
        "client-factory-call-outside-owner",
        `${CLIENT_FACTORY_FUNCTION}(...) must be called only by ${normalizedOwnerFile}#${OWNER_FUNCTION}`,
      );
    }
    if (
      call.assignedVariable?.name !== "client" ||
      !call.assignedVariable.isConst ||
      call.node.arguments.length !== 1 ||
      call.node.arguments[0].getText() !== "env"
    ) {
      addDiagnostic(
        call.sourceFile,
        call.node,
        "client-factory-owner-chain",
        `${OWNER_FUNCTION} must bind const client = ${CLIENT_FACTORY_FUNCTION}(env) directly`,
      );
    }
  }

  const allowedCalls = [];
  for (const call of lifetimeCalls) {
    if (
      call.sourceFile.fileName !== normalizedOwnerFile ||
      call.enclosing !== owner.node
    ) {
      addDiagnostic(
        call.sourceFile,
        call.node,
        "lifetime-call-outside-owner",
        `${call.receiver}.${call.method}() must be owned by ${normalizedOwnerFile}#${OWNER_FUNCTION}`,
        { method: call.method },
      );
      continue;
    }
    allowedCalls.push(call);
  }

  const connectCalls = allowedCalls.filter((call) => call.method === "connect");
  const endCalls = allowedCalls.filter((call) => call.method === "end");
  for (const [method, calls] of [
    ["connect", connectCalls],
    ["end", endCalls],
  ]) {
    if (calls.length !== 1) {
      addDiagnostic(
        owner.sourceFile,
        owner.node,
        "owner-call-count",
        `${OWNER_FUNCTION} must contain exactly one awaited client.${method}() call; found ${calls.length}`,
        { method },
      );
    }
    for (const call of calls) {
      if (call.receiver !== "client") {
        addDiagnostic(
          call.sourceFile,
          call.node,
          "owner-receiver",
          `${OWNER_FUNCTION} must use its local client for ${method}(); found ${call.receiver}.${method}()`,
          { method },
        );
      }
      if (!hasAwaitAncestor(call.node, owner.node)) {
        addDiagnostic(
          call.sourceFile,
          call.node,
          "unawaited-lifetime-call",
          `${call.receiver}.${method}() must be awaited inside ${OWNER_FUNCTION}`,
          { method },
        );
      }
    }
  }

  const operationCalls = [];
  const visitOwner = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "operation"
    ) {
      operationCalls.push(node);
    }
    ts.forEachChild(node, visitOwner);
  };
  visitOwner(owner.node.body);

  if (operationCalls.length !== 1) {
    addDiagnostic(
      owner.sourceFile,
      owner.node,
      "operation-call-count",
      `${OWNER_FUNCTION} must invoke operation(client) exactly once; found ${operationCalls.length}`,
    );
  }
  for (const call of operationCalls) {
    if (enclosingFunction(call) !== owner.node) {
      addDiagnostic(
        owner.sourceFile,
        call,
        "operation-call-outside-owner",
        `${OWNER_FUNCTION} must invoke operation(client) directly, not from a nested function`,
      );
    }
    if (!hasAwaitAncestor(call, owner.node)) {
      addDiagnostic(
        owner.sourceFile,
        call,
        "unawaited-operation",
        `${OWNER_FUNCTION} must await operation(client) before ending the PG client`,
      );
    }
    if (
      call.arguments.length !== 1 ||
      call.arguments[0].getText() !== "client"
    ) {
      addDiagnostic(
        owner.sourceFile,
        call,
        "operation-client-argument",
        `${OWNER_FUNCTION} must invoke operation with its local client`,
      );
    }
  }

  if (
    connectCalls.length === 1 &&
    endCalls.length === 1 &&
    operationCalls.length === 1
  ) {
    const connectRole = tryRole(connectCalls[0].node, owner.node);
    const operationRole = tryRole(operationCalls[0], owner.node);
    const endRole = tryRole(endCalls[0].node, owner.node);
    if (
      connectRole?.role !== "try" ||
      operationRole?.role !== "try" ||
      endRole?.role !== "finally" ||
      connectRole.statement !== operationRole.statement ||
      connectRole.statement !== endRole.statement
    ) {
      addDiagnostic(
        owner.sourceFile,
        owner.node,
        "owner-try-finally-shape",
        `${OWNER_FUNCTION} must connect and await operation(client) in one try, then await client.end() in its finally`,
      );
    }
  }

  return diagnostics.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.code.localeCompare(right.code),
  );
}

export function checkOperatorClientLifetimePackage(
  packageRoot = DEFAULT_PACKAGE_ROOT,
) {
  return analyzeOperatorClientLifetimeSources(
    listProductionSources(packageRoot),
  );
}

function formatDiagnostic(diagnostic) {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
}

function runCli() {
  const diagnostics = checkOperatorClientLifetimePackage();
  if (diagnostics.length > 0) {
    console.error(
      `::error::feature-flag operator PG direct-call lifetime regression guard RED: ${diagnostics.length} violation(s).`,
    );
    for (const diagnostic of diagnostics)
      console.error(`  - ${formatDiagnostic(diagnostic)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `feature-flag operator PG direct-call lifetime regression guard: PASS (` +
      `${DEFAULT_OWNER_FILE} pins new Client -> ${CLIENT_FACTORY_FUNCTION} -> ${OWNER_FUNCTION}; ` +
      `${OWNER_FUNCTION} is the sole direct connect/end owner).`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
