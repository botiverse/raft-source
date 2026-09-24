import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import ts from "typescript";

const seedSource = readFileSync(resolve(import.meta.dirname, "../../scripts/seed.ts"), "utf8");

test("dev seed creates member-role server-agent rows for each direct agent insert", () => {
  const sourceFile = ts.createSourceFile(
    "seed.ts",
    seedSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const memberships: Array<{ agentId: string; role: string }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "values"
      && ts.isCallExpression(node.expression.expression)
    ) {
      const insertCall = node.expression.expression;
      if (
        ts.isPropertyAccessExpression(insertCall.expression)
        && insertCall.expression.name.text === "insert"
        && insertCall.arguments[0]?.getText(sourceFile) === "serverAgentMembers"
        && ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const values = node.arguments[0];
        const readProperty = (name: string): ts.Expression | null => {
          const property = values.properties.find((candidate) => (
            ts.isPropertyAssignment(candidate)
            && candidate.name.getText(sourceFile) === name
          ));
          return property && ts.isPropertyAssignment(property) ? property.initializer : null;
        };
        const agentId = readProperty("agentId");
        const role = readProperty("role");
        assert.ok(agentId, "server-agent membership insert must name its agentId");
        assert.ok(role && ts.isStringLiteral(role), "server-agent membership insert must use a literal role");
        memberships.push({ agentId: agentId.getText(sourceFile), role: role.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.deepEqual(memberships, [
    { agentId: "agent.id", role: "member" },
    { agentId: "existingAgent.id", role: "member" },
  ]);
});
