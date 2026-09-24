import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function isIntlConstructor(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  return (
    ts.isPropertyAccessExpression(expression)
    && expression.expression.getText(sourceFile) === "Intl"
  );
}

function isResolvedOptionsTimezoneProbe(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const parent = node.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.name.text !== "resolvedOptions") return false;
  const grandparent = parent.parent;
  if (!ts.isCallExpression(grandparent) || grandparent.expression !== parent) return false;
  const greatGrandparent = grandparent.parent;
  return (
    ts.isPropertyAccessExpression(greatGrandparent)
    && greatGrandparent.expression === grandparent
    && greatGrandparent.name.text === "timeZone"
    && node.expression.getText(sourceFile) === "Intl.DateTimeFormat"
  );
}

function isLocaleStringCall(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression)
    && /^toLocale[A-Za-z]*String$/.test(expression.name.text)
  );
}

function hasMissingOrUndefinedFirstArg(args: ts.NodeArray<ts.Expression> | undefined): boolean {
  if (!args || args.length === 0) return true;
  const firstArg = args[0];
  return (
    (ts.isIdentifier(firstArg) && firstArg.text === "undefined")
    || ts.isVoidExpression(firstArg)
  );
}

function lineRef(sourceFile: ts.SourceFile, node: ts.Node): string {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${relative(repoRoot, sourceFile.fileName)}:${pos.line + 1}:${pos.character + 1}`;
}

function collectIntlLocaleViolations(files: string[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && isIntlConstructor(node.expression, sourceFile) && hasMissingOrUndefinedFirstArg(node.arguments)) {
        violations.push(`${lineRef(sourceFile, node)} ${node.expression.getText(sourceFile)}`);
      }
      if (
        ts.isCallExpression(node)
        && isIntlConstructor(node.expression, sourceFile)
        && hasMissingOrUndefinedFirstArg(node.arguments)
        && !isResolvedOptionsTimezoneProbe(node, sourceFile)
      ) {
        violations.push(`${lineRef(sourceFile, node)} ${node.expression.getText(sourceFile)}`);
      }
      if (ts.isCallExpression(node) && isLocaleStringCall(node.expression) && hasMissingOrUndefinedFirstArg(node.arguments)) {
        violations.push(`${lineRef(sourceFile, node)} ${node.expression.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return violations;
}

test("source Intl display formatters pass an explicit non-undefined locale argument", () => {
  const violations = collectIntlLocaleViolations(sourceFiles(srcRoot));

  assert.deepEqual(violations, []);
});

test("Intl constructor calls without new also require an explicit locale", () => {
  const sourceFile = ts.createSourceFile(
    "synthetic.ts",
    `
      Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(1.2);
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && isIntlConstructor(node.expression, sourceFile)
      && hasMissingOrUndefinedFirstArg(node.arguments)
      && !isResolvedOptionsTimezoneProbe(node, sourceFile)
    ) {
      violations.push(`${lineRef(sourceFile, node)} ${node.expression.getText(sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.deepEqual(violations, ["synthetic.ts:2:7 Intl.NumberFormat"]);
});
