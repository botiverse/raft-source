import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { test } from "vitest";

/**
 * An agent's stored profile (name, display name, description, avatar) is shown
 * by every open client, and clients only re-read it when the server emits
 * `agent:updated`. That emit lives in the route, after the write commits, so
 * nothing in the type system ties a write to its broadcast. This contract is
 * the tie.
 *
 * It reads the TypeScript syntax tree, not text, and it is deny-by-default:
 * a shape it does not understand is a failure, never a pass.
 *   1. Every `<x>.update(agents)` must be the receiver of `.set(<one argument>)`
 *      where the argument is an object literal made only of plainly named
 *      properties (identifier, string or shorthand keys) and conditional
 *      spreads of such literals, none of them a profile column, unless its
 *      function is a listed profile writer. A variable, an opaque spread, a
 *      computed key, a method or a detached `.set` fails.
 *   2. A listed writer may only appear as the callee `agentService.<name>(...)`,
 *      inside `typeof agentService.<name>`, or as its own declaration. Any
 *      other identifier or string naming it fails (named import, alias,
 *      destructure, element access, value reference, another namespace).
 *   3. Every such call is in `routes/`, and in its outermost enclosing
 *      function a `broadcastAgentUpdated(...)` call follows it before the next
 *      writer call, written directly in that function and not inside a nested
 *      one (a helper that is defined but never called would otherwise pass).
 *      Comments are not syntax, so a commented-out call is absent.
 *
 * What it cannot see: a write that never goes through `.update(agents)` (raw
 * SQL, or the table bound to another identifier), whether the broadcast
 * statement is reached at run time (an early return or a false condition
 * before it), whether it runs after the transaction commits, and whether it
 * reaches clients. Delivery is
 * covered by the route tests in agents.api.test.ts.
 */

const PROFILE_COLUMNS = new Set(["name", "displayName", "description", "avatarUrl"]);
/** Service functions that can change an agent's profile columns. */
const PROFILE_WRITERS = new Set([
  "updateAgent",
  "adoptOfficialOnboardingAgentIdentity",
  // An App bot's avatar IS its App's logo: every logo upload, clear and App deletion rewrites it.
  "syncAppBotAvatarsToLogo",
]);
const WRITER_DECLARATION_FILE = "services/agentService.ts";
const WRITER_NAMESPACE = "agentService";
const BROADCAST = "broadcastAgentUpdated";

interface SourceInput {
  path: string;
  source: string;
}

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Keys an object literal can write, or the reason it cannot be read. */
function literalKeys(node: ts.Expression): { keys: string[] } | { unreadable: string } {
  const literal = unwrap(node);
  if (!ts.isObjectLiteralExpression(literal)) return { unreadable: "is not an object literal" };
  const keys: string[] = [];
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text);
    } else if (ts.isPropertyAssignment(property)) {
      if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) keys.push(property.name.text);
      else return { unreadable: "has a computed or non-literal key" };
    } else if (ts.isSpreadAssignment(property)) {
      const spread = unwrap(property.expression);
      if (!ts.isConditionalExpression(spread)) return { unreadable: "spreads a value whose keys are not written out" };
      for (const branch of [spread.whenTrue, spread.whenFalse]) {
        const inner = literalKeys(branch);
        if ("unreadable" in inner) return inner;
        keys.push(...inner.keys);
      }
    } else {
      return { unreadable: "has a method or accessor" };
    }
  }
  return { keys };
}

function enclosingNamedFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  }
  return "?";
}

function nearestFunction(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) return current;
  }
  return undefined;
}

function outermostFunction(node: ts.Node): ts.Node | undefined {
  let outermost: ts.Node | undefined;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) outermost = current;
  }
  return outermost;
}

export function findContractOffenders(files: SourceInput[]): { offenders: string[]; writerCalls: number } {
  const offenders: string[] = [];
  let writerCalls = 0;

  for (const file of files) {
    const tree = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const at = (node: ts.Node) => `${file.path}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
    const calls: ts.CallExpression[] = [];
    const broadcasts: ts.CallExpression[] = [];

    const visit = (node: ts.Node): void => {
      // 1. `<x>.update(agents)`
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "update"
        && node.arguments.length === 1
        && ts.isIdentifier(node.arguments[0]!)
        && node.arguments[0].text === "agents"
      ) {
        const fn = enclosingNamedFunction(node);
        if (!PROFILE_WRITERS.has(fn)) {
          const setAccess = node.parent;
          const setCall = setAccess?.parent;
          if (
            !setAccess || !ts.isPropertyAccessExpression(setAccess) || setAccess.expression !== node || setAccess.name.text !== "set"
            || !setCall || !ts.isCallExpression(setCall) || setCall.expression !== setAccess || setCall.arguments.length !== 1
          ) {
            offenders.push(`${at(node)} (${fn}): .update(agents) is not the receiver of .set(<one argument>); the written columns cannot be read`);
          } else {
            const read = literalKeys(setCall.arguments[0]!);
            if ("unreadable" in read) {
              offenders.push(`${at(node)} (${fn}): the .set(...) argument ${read.unreadable}; the written columns cannot be read, so list the function in PROFILE_WRITERS`);
            } else {
              const profile = read.keys.filter((key) => PROFILE_COLUMNS.has(key));
              if (profile.length > 0) {
                offenders.push(`${at(node)} (${fn}): writes ${profile.join(", ")}; list the function in PROFILE_WRITERS and broadcast agent:updated from each route that calls it`);
              }
            }
          }
        }
      }

      // 2. Every mention of a writer's name.
      if (ts.isStringLiteralLike(node) && PROFILE_WRITERS.has(node.text)) {
        offenders.push(`${at(node)}: "${node.text}" names a profile writer as a string; call it as ${WRITER_NAMESPACE}.${node.text}(...)`);
      }
      if (ts.isIdentifier(node) && PROFILE_WRITERS.has(node.text)) {
        const parent = node.parent;
        const viaNamespace = ts.isPropertyAccessExpression(parent)
          && parent.name === node
          && ts.isIdentifier(parent.expression)
          && parent.expression.text === WRITER_NAMESPACE;
        const isCall = viaNamespace && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
        // `typeof agentService.<name>` is a qualified name in a type query: it names the type, nothing is called or bound.
        const isTypeQuery = ts.isQualifiedName(parent)
          && parent.right === node
          && ts.isIdentifier(parent.left)
          && parent.left.text === WRITER_NAMESPACE
          && ts.isTypeQueryNode(parent.parent);
        const isDeclaration = file.path === WRITER_DECLARATION_FILE && ts.isFunctionDeclaration(parent) && parent.name === node;
        if (isCall) calls.push(parent.parent as ts.CallExpression);
        else if (!isTypeQuery && !isDeclaration) {
          offenders.push(`${at(node)}: ${node.text} is referenced in a form the contract cannot follow; call it as ${WRITER_NAMESPACE}.${node.text}(...)`);
        }
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === BROADCAST) broadcasts.push(node);
      ts.forEachChild(node, visit);
    };
    visit(tree);

    // 3. Each writer call is in a route and has its own broadcast in the same outermost function.
    if (calls.length > 0 && !file.path.startsWith("routes/")) {
      offenders.push(`${file.path}: calls a profile writer outside a route, where no broadcast can follow the commit`);
      continue;
    }
    for (const call of calls) {
      writerCalls += 1;
      const handler = outermostFunction(call);
      const name = (call.expression as ts.PropertyAccessExpression).name.text;
      if (!handler) {
        offenders.push(`${at(call)}: ${name} is called outside any function`);
        continue;
      }
      const nextCallStart = calls
        .filter((other) => other !== call && outermostFunction(other) === handler && other.getStart(tree) > call.getStart(tree))
        .map((other) => other.getStart(tree))
        .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;
      // The broadcast must be a statement-level call of the handler itself: one inside a nested
      // function only runs if that function is called, which this contract does not try to prove.
      const own = broadcasts.some((broadcast) =>
        nearestFunction(broadcast) === handler
        && broadcast.getStart(tree) > call.getEnd()
        && broadcast.getStart(tree) < nextCallStart);
      if (!own) offenders.push(`${at(call)}: ${name} has no ${BROADCAST} of its own in the same handler`);
    }
  }
  return { offenders, writerCalls };
}

function serverSources(): SourceInput[] {
  const srcRoot = join(import.meta.dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : walk(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
  return walk(srcRoot).map((path) => ({ path: relative(srcRoot, path), source: readFileSync(path, "utf8") }));
}

test("every agent profile write in the server source is listed and followed by its own agent:updated broadcast", () => {
  const { offenders, writerCalls } = findContractOffenders(serverSources());
  assert.deepEqual(offenders, []);
  // Thirteen write sites exist today (App logo upload, logo clear and App
  // deletion, each on the web and the agent API, sync the App's bot avatars;
  // PATCH /my-assistant no longer renames, an assistant is always Ottie); zero
  // would mean the scan stopped matching anything.
  assert.equal(writerCalls, 13);
});

// The checker itself, on small sources. Each rejected shape below got past an earlier version.
const service = (body: string): SourceInput => ({
  path: WRITER_DECLARATION_FILE,
  source: `export async function updateAgent(id: string, fields: any) { const { x, ...rest } = fields; await db.update(agents).set({ ...rest }); }\n${body}`,
});
const route = (body: string, path = "routes/example.ts"): SourceInput => ({ path, source: body });
const GOOD_ROUTE = route("router.patch('/a', async (req) => {\n  await agentService.updateAgent(id, fields);\n  broadcastAgentUpdated(req, serverId, id);\n});\n");
const offendersOf = (...files: SourceInput[]) => findContractOffenders(files).offenders;

test("the checker accepts a listed writer whose route call broadcasts, and plain non-profile updates", () => {
  assert.deepEqual(findContractOffenders([service(""), GOOD_ROUTE]), { offenders: [], writerCalls: 1 });
  const harmless = service(`
    export async function touch(id: string) { await db.update(agents).set({ status: 'active', "updatedAt": now, ...(sessionId !== undefined ? { sessionId } : {}) }); }
    export async function touchChained(id: string) { const [row] = await tx.update(agents).set({ machineId, updatedAt: now }).where(eq(agents.id, id)).returning(); }
  `);
  assert.deepEqual(offendersOf(harmless, GOOD_ROUTE), []);
  const typeOnly = route("let updated: Awaited<ReturnType<typeof agentService.updateAgent>>;\n", "routes/types.ts");
  assert.deepEqual(offendersOf(service(""), GOOD_ROUTE, typeOnly), []);
});

test("the checker rejects an unlisted function that writes a profile column, however the update object is spelled", () => {
  const shapes: Record<string, string> = {
    "literal key": "await db.update(agents).set({ displayName: 'x' });",
    "shorthand key": "await db.update(agents).set({ displayName });",
    "quoted key": "await db.update(agents).set({ \"displayName\": displayName });",
    "template key": "await db.update(agents).set({ [`displayName`]: displayName });",
    "computed key": "await db.update(agents).set({ [column]: value });",
    "object in a variable": "const fields = { displayName: 'x' }; await db.update(agents).set(fields);",
    "opaque spread": "await db.update(agents).set({ updatedAt: now, ...patch });",
    "conditional spread with a profile key": "await db.update(agents).set({ updatedAt: now, ...(rename ? { avatarUrl } : {}) });",
    "conditional spread of a variable": "await db.update(agents).set({ updatedAt: now, ...(rename ? patch : {}) });",
    "cast literal": "await db.update(agents).set({ description: 'x' } as any);",
    "detached set": "const q = db.update(agents); await q.set({ avatarUrl: null });",
    "the name column": "await db.update(agents).set({ name: 'x' });",
  };
  for (const [label, body] of Object.entries(shapes)) {
    const offenders = offendersOf(service(`export async function sneaky(id: string) { ${body} }`), GOOD_ROUTE);
    assert.equal(offenders.length, 1, `${label}: ${JSON.stringify(offenders)}`);
    assert.match(offenders[0]!, /\(sneaky\)/, label);
  }
  // A top-level arrow function sitting right after a listed writer is its own scope, not part of that writer.
  const arrowAfterWriter = service("export const sneakyArrow = async (id: string, displayName: string) => db.update(agents).set({ displayName });");
  const arrowOffenders = offendersOf(arrowAfterWriter, GOOD_ROUTE);
  assert.equal(arrowOffenders.length, 1, JSON.stringify(arrowOffenders));
  assert.match(arrowOffenders[0]!, /writes displayName/);
});

test("the checker rejects a writer reached in any form other than agentService.<name>(...)", () => {
  const forms: Record<string, string> = {
    "import alias": "import { updateAgent as writeProfile } from '../services/agentService';\nrouter.post('/b', async () => { await writeProfile(id, { displayName: 'x' }); });",
    "named import": "import { updateAgent } from '../services/agentService';\nrouter.post('/b', async () => { await updateAgent(id, { displayName: 'x' }); });",
    "value reference": "router.post('/b', async () => { const write = agentService.updateAgent; await write(id, fields); });",
    "destructure": "const { adoptOfficialOnboardingAgentIdentity } = agentService;",
    "element access": "router.post('/b', async () => { await agentService['updateAgent'](id, fields); });",
    "another namespace": "import * as svc from '../services/agentService';\nrouter.post('/b', async () => { await svc.updateAgent(id, fields); });",
  };
  for (const [label, body] of Object.entries(forms)) {
    const offenders = offendersOf(service(""), GOOD_ROUTE, route(body, "routes/other.ts"));
    assert.ok(offenders.some((offender) => /cannot follow|as a string/.test(offender)), `${label}: ${JSON.stringify(offenders)}`);
  }
});

test("the checker rejects a missing, commented-out, earlier, shared or out-of-route broadcast", () => {
  const cases: Record<string, string> = {
    "missing": "router.patch('/a', async () => {\n  await agentService.updateAgent(id, fields);\n});",
    "line comment": "router.patch('/a', async (req) => {\n  await agentService.updateAgent(id, fields);\n  // broadcastAgentUpdated(req, serverId, id);\n});",
    "block comment": "router.patch('/a', async (req) => {\n  await agentService.updateAgent(id, fields);\n  /* broadcastAgentUpdated(req, serverId, id); */\n});",
    "in a string": "router.patch('/a', async (req) => {\n  await agentService.updateAgent(id, fields);\n  log('broadcastAgentUpdated(req, serverId, id)');\n});",
    "before the write": "router.patch('/a', async (req) => {\n  broadcastAgentUpdated(req, serverId, id);\n  await agentService.updateAgent(id, fields);\n});",
    "in the next handler": "router.patch('/a', async (req) => {\n  await agentService.updateAgent(a, fields);\n});\nrouter.patch('/b', async (req) => {\n  await agentService.updateAgent(b, fields);\n  broadcastAgentUpdated(req, serverId, b);\n});",
    "in a helper that is never called": "router.patch('/a', async (req) => {\n  await agentService.updateAgent(id, fields);\n  const notify = () => broadcastAgentUpdated(req, serverId, id);\n  void notify;\n});",
    "inside the transaction callback": "router.patch('/a', async (req) => {\n  await withTx(async (tx) => {\n    await agentService.updateAgent(id, fields, { executor: tx });\n    broadcastAgentUpdated(req, serverId, id);\n  });\n});",
    "one broadcast for two writes": "router.patch('/a', async (req) => {\n  await agentService.updateAgent(a, fields);\n  await agentService.updateAgent(b, fields);\n  broadcastAgentUpdated(req, serverId, b);\n});",
  };
  for (const [label, body] of Object.entries(cases)) {
    const offenders = offendersOf(service(""), route(body));
    assert.equal(offenders.filter((offender) => /has no broadcastAgentUpdated of its own/.test(offender)).length, 1, `${label}: ${JSON.stringify(offenders)}`);
  }
  const outsideRoute: SourceInput = { path: "services/other.ts", source: "export async function job() { await agentService.updateAgent(id, fields); broadcastAgentUpdated(req, s, id); }" };
  assert.match(offendersOf(service(""), outsideRoute).join("\n"), /outside a route/);
});
