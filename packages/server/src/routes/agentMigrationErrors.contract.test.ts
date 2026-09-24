import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import ts from "typescript";

const routeSource = readFileSync(new URL("./agents.ts", import.meta.url), "utf8");
const migrationStart = routeSource.indexOf("// Owner-initiated no-card migration.");
const migrationEnd = routeSource.indexOf("// Start agent (routes to machine via agentOrchestrator)");

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

test("owner-facing migration errors cannot bypass the typed response helper", () => {
  assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, "migration route boundary markers must remain present");
  const file = ts.createSourceFile("agents.ts", routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const directCodeResponses: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      node.pos >= migrationStart
      && node.end <= migrationEnd
      && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "json"
      && node.arguments.length > 0
      && ts.isObjectLiteralExpression(node.arguments[0])
      && node.arguments[0].properties.some((property) => propertyName(property) === "code")
    ) {
      directCodeResponses.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  assert.deepEqual(
    directCodeResponses,
    [],
    `migration routes emitted coded JSON outside sendMigrationError at lines ${directCodeResponses.join(", ")}`,
  );
});

test("typed migration errors always publish a nonempty machine-readable cause", () => {
  const helperStart = routeSource.indexOf("function sendMigrationError(");
  const helperEnd = routeSource.indexOf("\n}\n\nfunction isoOrNull", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "sendMigrationError helper must remain present");
  const helper = routeSource.slice(helperStart, helperEnd);
  assert.match(helper, /details:\s*\{[\s\S]*failureReason:\s*code/);
});

test("Built-in migration validates and leases the target catalog before provisioning", () => {
  assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, "migration route boundary markers must remain present");
  const migration = routeSource.slice(migrationStart, migrationEnd);
  const validate = migration.indexOf("validateBuiltInPresetForMachine(");
  const acquire = migration.indexOf("acquireBuiltInCatalogAuthority(", validate);
  const provision = migration.indexOf("beginAgentMigrationProvisioning(");
  const release = migration.indexOf("releaseCatalogAuthority();", provision);

  assert.ok(validate >= 0, "Built-in migration must validate the target catalog");
  assert.ok(acquire > validate, "migration must bind validation to its connection generation");
  assert.ok(provision > acquire, "catalog authority must be held before migration state is provisioned");
  assert.ok(release > provision, "catalog authority must release from the migration finally path");
});
