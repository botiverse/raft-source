import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("inbox policy remains a leaf with only shared type dependencies", () => {
  const source = ts.createSourceFile(
    "agentInboxPolicy.ts",
    readFileSync(new URL("./agentInboxPolicy.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const inspect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      assert.ok(node.importClause?.isTypeOnly, "inbox policy must not load runtime dependencies");
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      assert.equal(node.moduleSpecifier.text, "@botiverse/raft-shared", "inbox policy must not depend back on server internals");
    }
    if (ts.isExportDeclaration(node)) {
      assert.ok(!node.moduleSpecifier, "inbox policy must not load dependencies through re-exports");
    }
    assert.ok(!ts.isImportEqualsDeclaration(node), "inbox policy must not load require-style imports");
    if (ts.isImportTypeNode(node)) {
      assert.ok(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal));
      assert.equal(node.argument.literal.text, "@botiverse/raft-shared");
    }
    if (ts.isCallExpression(node)) {
      assert.ok(node.expression.kind !== ts.SyntaxKind.ImportKeyword, "inbox policy must not dynamically import dependencies");
      assert.ok(!(ts.isIdentifier(node.expression) && node.expression.text === "require"), "inbox policy must not require dependencies");
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
});
