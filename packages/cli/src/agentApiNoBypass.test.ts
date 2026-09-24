import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { agentApiContract, daemonApiContract } from "@botiverse/raft-shared";

const sourceRoot = import.meta.dirname;
const commandsRoot = join(sourceRoot, "commands");

function walk(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathTemplateToPattern(path: string): string {
  const paramPattern = /:([A-Za-z][A-Za-z0-9_]*)/g;
  let lastIndex = 0;
  let pattern = "";
  for (const match of path.matchAll(paramPattern)) {
    pattern += escapeRegExp(path.slice(lastIndex, match.index));
    pattern += `[^"'\\\`\\n/]+`;
    lastIndex = match.index + match[0].length;
  }
  pattern += escapeRegExp(path.slice(lastIndex));
  return pattern;
}

function pathTemplateToSource(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, key: string) => `\${${key}}`);
}

function sourceStringForPath(path: string): string {
  return path.includes(":")
    ? `\`${pathTemplateToSource(path)}\``
    : `"${path}"`;
}

const protectedRoutes = [
  ...Object.values(agentApiContract),
  // Daemon/proxy-owned routes need the same command-layer protection: command
  // sources should call typed clients, not handwrite id-less compatibility
  // paths that silently bypass request/response validation.
  ...Object.values(daemonApiContract),
]
  .map((route) => ({
    key: route.key,
    method: route.method,
    path: route.path,
    fullPath: route.fullPath,
  }))
  .sort((a, b) => b.path.length - a.path.length);

function findBypassViolations(sources: Array<{ label: string; source: string }>): string[] {
  const violations: string[] = [];

  for (const { label, source: rawSource } of sources) {
    const source = stripComments(rawSource);
    for (const route of protectedRoutes) {
      const idlessPattern = new RegExp(
        `\\.request(?:<[^>\\n]*>)?\\s*\\(\\s*["']${route.method}["']\\s*,\\s*["'\\\`]${pathTemplateToPattern(route.fullPath)}(?:[?"'\\\`]|$)`,
      );
      if (idlessPattern.test(source)) {
        violations.push(`${label}: handwritten id-less ${route.fullPath} for ${route.key}`);
      }

      const legacyPattern = new RegExp(
        `\\.request(?:<[^>\\n]*>)?\\s*\\(\\s*["']${route.method}["']\\s*,\\s*["'\\\`]/internal/agent/[^"'\\\`\\n/]+${pathTemplateToPattern(route.path)}(?:[?"'\\\`]|$)`,
      );
      if (legacyPattern.test(source)) {
        violations.push(`${label}: handwritten legacy ${route.path} for ${route.key}`);
      }
    }
  }

  return violations;
}

function violationRouteKeys(violations: string[], label: string): string[] {
  return violations
    .filter((violation) => violation.startsWith(`${label}:`))
    .map((violation) => {
      const match = / for ([^ ]+)$/.exec(violation);
      assert.ok(match, `violation should end with route key: ${violation}`);
      return match[1]!;
    })
    .sort();
}

test("CLI command call sites use generated client bindings for migrated agent-api and daemon-api routes", () => {
  const sources = walk(commandsRoot).map((file) => ({
    label: relative(sourceRoot, file),
    source: readFileSync(file, "utf8"),
  }));

  const violations = findBypassViolations(sources);
  assert.deepEqual(violations, []);
});

test("CLI command call sites use the id-less surface client for migrated agent-api routes", () => {
  const violations = walk(commandsRoot).flatMap((file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    return /\bcreateAgentApiClient\b/.test(source)
      ? [`${relative(sourceRoot, file)}: imports legacy-prefixed createAgentApiClient`]
      : [];
  });

  assert.deepEqual(violations, []);
});

test("no-bypass guard rejects synthetic id-less and legacy calls for every migrated route", () => {
  const sources = protectedRoutes.flatMap((route) => [
    {
      label: `idless-${route.key}.ts`,
      source: `await client.request("${route.method}", ${sourceStringForPath(route.fullPath)});`,
    },
    {
      label: `legacy-${route.key}.ts`,
      source: `await client.request("${route.method}", \`/internal/agent/\${agentId}${pathTemplateToSource(route.path)}\`);`,
    },
  ]);

  const violations = findBypassViolations(sources);

  for (const route of protectedRoutes) {
    const expectedIdlessKeys = protectedRoutes
      .filter((candidate) => candidate.method === route.method && candidate.fullPath === route.fullPath)
      .map((candidate) => candidate.key)
      .sort();
    const expectedLegacyKeys = protectedRoutes
      .filter((candidate) => candidate.method === route.method && candidate.path === route.path)
      .map((candidate) => candidate.key)
      .sort();

    assert.deepEqual(
      violationRouteKeys(violations, `idless-${route.key}.ts`),
      expectedIdlessKeys,
      `${route.key} id-less bypass fixture must reject only the exact route path`,
    );
    assert.deepEqual(
      violationRouteKeys(violations, `legacy-${route.key}.ts`),
      expectedLegacyKeys,
      `${route.key} legacy bypass fixture must reject only the exact route path`,
    );
  }
});

test("no-bypass guard ignores comments and non-migrated legacy routes", () => {
  const violations = findBypassViolations([{
    label: "safe.ts",
    source: `
      // ${protectedRoutes[0]?.fullPath}
      /* /internal/agent/\${agentId}${protectedRoutes[0]?.path} */
      await client.request("GET", \`/internal/agent/\${agentId}/legacy-only\`);
    `,
  }]);

  assert.deepEqual(violations, []);
});

test("no-bypass guard binds both HTTP method and exact route segments", () => {
  const violations = findBypassViolations([
    {
      label: "server-mutation.ts",
      source: `await client.request("PATCH", \`/internal/agent/\${agentId}/server\`);`,
    },
    {
      label: "nested-search.ts",
      source: `await client.request("GET", \`/internal/agent/\${agentId}/knowledge/search\`);`,
    },
  ]);

  assert.deepEqual(violationRouteKeys(violations, "server-mutation.ts"), ["serverUpdate"]);
  assert.deepEqual(violationRouteKeys(violations, "nested-search.ts"), ["knowledgeSearch"]);
});
