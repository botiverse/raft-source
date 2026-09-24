import assert from "node:assert/strict";
import { test } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * §228 -- the RAP syscall fire-and-forget gate.
 *
 * INVARIANT: a RAP syscall's Promise must be joined at the current call site --
 * "is the effect awaited or handed off by the current obligation".
 * ⛔ It does NOT claim the caller branched correctly on each outcome; that needs
 * a stronger contract than this gate can carry.
 *
 * 🔴 READ THIS BEFORE TRUSTING A GREEN. A wrapper carrying the right name and the
 * right symbol, but with its declaration check DELETED from the body, must still
 * make this file all-green. Symbol identity and return shape are decidable here;
 * declaration/grant semantics and the installed -> declared -> granted ORDER are
 * NOT_COVERED and belong to task #141's behaviour teeth. See the coverage matrix
 * at the bottom of this file.
 *
 * ⛔ No ESLint, no ratchet, no string grep: `cancel(` as text reaches into
 * lib.dom.d.ts, and `resolveConversation` also names an internal registry-store
 * primitive that is NOT an execution surface. Binding is by RESOLVED SYMBOL.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.resolve(HERE, "rapRegistry.ts");
const CANONICAL = path.resolve(HERE, "rapSyscalls.ts");

// ---------------------------------------------------------------------------
// helpers -- kept pure and source-agnostic so the teeth below can drive them
// with synthetic programs and prove each arm is capable of going RED.
// ---------------------------------------------------------------------------

/**
 * Read a closed array of string literals BY NAME.
 *
 * ⚠️ By NAME, never by node class. `rapRegistry.ts` gained a second exported
 * `as const` array (`HOOKS`, task #237) after this gate was designed. A reader
 * that bound to "the exported as-const array in this file" would now silently
 * bind the wrong closed set -- which is exactly how #227's gate stayed 2/2 GREEN
 * with a real second platform root in the tree.
 */
function declaredStringArray(file: ts.SourceFile, name: string): string[] {
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  assert.ok(declaration?.initializer, `HARNESS-BROKEN: ${name} disappeared from ${path.basename(file.fileName)}`);
  let initializer: ts.Expression = declaration.initializer;
  if (ts.isAsExpression(initializer)) initializer = initializer.expression;
  assert.ok(
    ts.isArrayLiteralExpression(initializer),
    `HARNESS-BROKEN: ${name} is no longer a closed array literal`,
  );
  return initializer.elements.map((element) => {
    assert.ok(ts.isStringLiteral(element), `HARNESS-BROKEN: ${name} gained a non-literal member`);
    return element.text;
  });
}

/** Follow an import/export alias to the symbol that actually declares the thing. */
function deAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

interface Binding {
  readonly name: string;
  readonly symbol: ts.Symbol;
  readonly thenable: boolean;
  readonly where: string;
}

/**
 * ④ coverage equality: each canonical name must resolve to EXACTLY ONE public
 * symbol in the canonical module. Fewer or more ⇒ RED.
 *
 * ⚠️ EXACT name equality, never substring. `rapSyscalls.ts` publicly exports
 * `createNotifyForTests`, `createResolveConversationForTests` and
 * `createRapTimersForTests`; measured on the tip, a substring match selects 14
 * exports instead of 4 and would report RED for entirely the wrong reason.
 */
function bindCanonical(
  checker: ts.TypeChecker,
  moduleFile: ts.SourceFile,
  names: readonly string[],
): { bindings: Binding[]; failures: string[] } {
  const moduleSymbol = checker.getSymbolAtLocation(moduleFile);
  assert.ok(moduleSymbol, `HARNESS-BROKEN: ${path.basename(moduleFile.fileName)} has no module symbol`);
  const exported = checker.getExportsOfModule(moduleSymbol);

  const bindings: Binding[] = [];
  const failures: string[] = [];
  for (const name of names) {
    const matches = exported.filter((candidate) => candidate.getName() === name);
    if (matches.length !== 1) {
      failures.push(
        `${name}: canonical module exports ${matches.length} symbols with this exact name, expected exactly 1`,
      );
      continue;
    }
    const symbol = deAlias(checker, matches[0]!);
    const declarations = symbol.declarations ?? [];
    const declaration = declarations[0];
    if (!declaration) {
      failures.push(`${name}: resolved to a symbol with no declaration (unresolved ⇒ fail closed)`);
      continue;
    }

    /**
     * 🔴 The resolved symbol must be DECLARED IN the canonical module.
     *
     * `deAlias` deliberately follows re-exports, so without this check a line
     * like `export { resolveConversation } from "./rapRegistryStore.js"` would
     * bind the internal registry-store primitive -- which never consults
     * `manifestPermitsSyscall` -- and this arm would sign it as an execution
     * surface, thenable and green. That is the exact error this gate exists to
     * stop: a name match is not an execution surface.
     */
    const foreign = declarations.filter((each) => each.getSourceFile() !== moduleFile);
    if (foreign.length > 0) {
      failures.push(
        `${name}: resolves to a symbol declared outside the canonical module `
        + `(${[...new Set(foreign.map((each) => path.basename(each.getSourceFile().fileName)))].join(", ")}) `
        + `-- a re-exported name is not an execution surface`,
      );
      continue;
    }

    /**
     * Count IMPLEMENTATIONS, not symbols. TypeScript merges same-named
     * declarations into a single symbol, so a symbol count can never see a
     * duplicate -- measured: the first version of this arm stayed green under a
     * duplicated export, the #227 failure mode exactly.
     */
    const implementations = declarations.filter(
      (each) => (ts.isFunctionDeclaration(each) || ts.isMethodDeclaration(each)) && each.body !== undefined,
    );
    const ambient = declarations.filter((each) => ts.isFunctionDeclaration(each) && each.body === undefined);
    if (implementations.length > 1) {
      failures.push(`${name}: ${implementations.length} implementations under one canonical name, expected exactly 1`);
      continue;
    }
    if (implementations.length === 0 && ambient.length > 1) {
      failures.push(`${name}: ${ambient.length} ambient declarations under one canonical name, expected exactly 1`);
      continue;
    }

    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const signatures = type.getCallSignatures();
    if (signatures.length === 0) {
      failures.push(`${name}: resolved symbol is not callable`);
      continue;
    }
    // EVERY signature, not just the first: an overload set that returns a
    // thenable on one signature and void on another must not pass on signature 0.
    const returns = signatures.map((signature) => checker.getReturnTypeOfSignature(signature));
    const notThenable = returns.filter((returnType) => returnType.getProperty("then") === undefined);
    const thenable = notThenable.length === 0;
    if (!thenable) {
      failures.push(
        `${name}: ${notThenable.length}/${returns.length} call signatures return a non-thenable `
        + `(${notThenable.map((each) => checker.typeToString(each)).join(", ")})`,
      );
    }
    const source = declaration.getSourceFile();
    bindings.push({
      name,
      symbol,
      thenable,
      where: `${path.basename(source.fileName)}:${source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1}`,
    });
  }
  return { bindings, failures };
}

type Join = "joined" | "detached" | "unclassified";

/**
 * ② ALLOW  await f() · return f() · concise arrow body · a Promise combinator
 *          that is itself joined · a .then/.catch chain that is itself joined
 * ③ DENY   bare call · void f() · assigning the unsettled Promise then leaving
 *          · detached .then/.catch
 *
 * Anything this function does not recognise returns "unclassified", which the
 * arm below treats as RED. ⛔ An unrecognised shape must never be read as allowed:
 * the whole failure mode this gate exists to stop is a promise going unnoticed.
 *
 * ⚠️ KNOWN CONSERVATIVE EDGE: `const p = f(); await p;` is genuinely joined but
 * classifies as "detached", because proving it needs dataflow this gate does not
 * do. That is a false RED, never a false GREEN, and it explains itself when it
 * fires. Zero such sites exist on the tip; if one is written, split it or await
 * in place.
 */
function classifyJoin(call: ts.CallExpression): Join {
  let node: ts.Node = call;
  let parent: ts.Node | undefined = call.parent;

  while (parent) {
    // joined: the current obligation takes the promise
    if (ts.isAwaitExpression(parent)) return "joined";
    if (ts.isReturnStatement(parent)) return "joined";
    if (ts.isArrowFunction(parent) && parent.body === node) return "joined";

    // detached: the promise is dropped, discarded, or parked
    if (ts.isExpressionStatement(parent)) return "detached";
    if (ts.isVoidExpression(parent)) return "detached";
    if (ts.isVariableDeclaration(parent)) return "detached";
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return "detached";
    }

    // transparent wrappers: keep walking outward
    if (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    ) {
      node = parent;
      parent = parent.parent;
      continue;
    }

    // f().then(...) / .catch(...) / .finally(...) -- the CHAIN inherits the obligation
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const member = parent.name.text;
      if (member === "then" || member === "catch" || member === "finally") {
        node = parent;
        parent = parent.parent;
        continue;
      }
      return "unclassified";
    }

    // element of an array handed to Promise.all/allSettled/race/any
    if (ts.isArrayLiteralExpression(parent)) {
      node = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression;
      // we are the CALLEE -- i.e. we walked onto `f().then` and this is the
      // invocation of it. The chain carries the obligation outward.
      if (callee === node) {
        node = parent;
        parent = parent.parent;
        continue;
      }
      /**
       * Element of a Promise combinator.
       *
       * 🔴 ONLY `all` and `allSettled` join. They do not settle until EVERY
       * member has settled, so awaiting/returning the combinator awaits this
       * syscall too.
       *
       * ⛔ `race` and `any` are NOT join combinators and must not be added
       * back. They settle on the FIRST member, so
       *   await Promise.race([schedule(...), Promise.resolve()])
       * resolves immediately via the second element and abandons the syscall's
       * promise — the exact fire-and-forget this gate exists to reject. Caught
       * by @Stone's reviewer mutation on task #250; the earlier draft listed all
       * four together because "the Promise combinators" felt like one category.
       * The frozen §228 contract names only `Promise.all` / `Promise.allSettled`.
       */
      if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === "Promise"
      ) {
        const combinator = callee.name.text;
        if (combinator === "all" || combinator === "allSettled") {
          node = parent;
          parent = parent.parent;
          continue;
        }
        if (combinator === "race" || combinator === "any") return "detached";
        return "unclassified";
      }
      // passed as an argument somewhere else: the obligation left this call site
      return "unclassified";
    }

    return "unclassified";
  }
  return "unclassified";
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly join: Join;
  readonly isTest: boolean;
  readonly text: string;
}

/**
 * 🔒 THE FROZEN CENSUS SCOPE (@XX): #228 covers the **non-test production TS**
 * of `packages/server/src`, and nothing else.
 *
 * ⛔ Test files are OUT OF BOUNDS. An earlier draft of this gate walked every
 * non-declaration source file, so a detached call written into
 * `rapSyscalls.test.ts` drove it RED -- which looked like the mutation biting,
 * and was actually the scanner reaching outside its own boundary. A gate that
 * polices test code is not this gate, and its census number is not comparable
 * to the contract's.
 *
 * Measured on the tip: 691 .ts under src, of which 399 are `*.test.ts`,
 * 4 live under `src/test/`, and the rest of the exclusions are fixture dirs.
 */
function isProductionFile(fileName: string): boolean {
  if (!fileName.includes(`${path.sep}packages${path.sep}server${path.sep}src${path.sep}`)) return false;
  if (fileName.endsWith(".d.ts")) return false;
  if (/\.test\.ts$/.test(fileName)) return false;
  if (fileName.includes(`${path.sep}src${path.sep}test${path.sep}`)) return false;
  if (fileName.includes(`${path.sep}fixtures${path.sep}`)) return false;
  return fileName.endsWith(".ts");
}

/** The trailing identifier of a callee: `notify` and `surface.notify` both give "notify". */
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

interface Collected {
  readonly sites: Site[];
  /**
   * 🔴 Calls that WEAR a canonical name but whose symbol would not resolve.
   *
   * ⛔ These must never be silently skipped. A dependency-less tree makes every
   * external symbol unresolvable -- that is how a probe of mine once reported a
   * clean `<unresolved>` that was purely my own missing node_modules. A gate that
   * skips what it cannot resolve reports green precisely when it is blindest.
   */
  readonly unresolved: string[];
}

function collectSites(
  program: ts.Program,
  checker: ts.TypeChecker,
  bindings: Binding[],
  inScope: (fileName: string) => boolean,
): Collected {
  const targets = new Map<ts.Symbol, string>(bindings.map((binding) => [binding.symbol, binding.name]));
  const canonicalNames = new Set(bindings.map((binding) => binding.name));
  const sites: Site[] = [];
  const unresolved: string[] = [];

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    if (!inScope(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const raw = checker.getSymbolAtLocation(node.expression);
        const symbol = raw ? deAlias(checker, raw) : undefined;
        const name = symbol ? targets.get(symbol) : undefined;
        const where = `${path.basename(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

        if (name) {
          sites.push({
            file: file.fileName,
            line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            name,
            join: classifyJoin(node),
            isTest: /\.test\.ts$/.test(file.fileName),
            text: node.getText().replace(/\s+/g, " ").slice(0, 90),
          });
        } else if (!symbol) {
          // fail closed: unresolvable AND wearing a canonical name
          const worn = calleeName(node.expression);
          if (worn && canonicalNames.has(worn)) {
            unresolved.push(`${where} ${worn}(...) -- callee symbol did not resolve`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { sites, unresolved };
}

// ---------------------------------------------------------------------------
// the real program, built once and shared
// ---------------------------------------------------------------------------

let cached: { program: ts.Program; checker: ts.TypeChecker } | undefined;
function realProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  if (cached) return cached;
  const configPath = path.resolve(HERE, "../../tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.ok(!raw.error, "HARNESS-BROKEN: cannot read packages/server/tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  assert.equal(parsed.errors.length, 0, "HARNESS-BROKEN: tsconfig did not parse cleanly");
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  cached = { program, checker: program.getTypeChecker() };
  return cached;
}

function realCanonicalSet(): { names: string[]; bindings: Binding[]; failures: string[] } {
  const { program, checker } = realProgram();
  const registry = program.getSourceFile(REGISTRY);
  assert.ok(registry, "HARNESS-BROKEN: rapRegistry.ts is not in the program");
  const canonical = program.getSourceFile(CANONICAL);
  assert.ok(canonical, "HARNESS-BROKEN: rapSyscalls.ts is not in the program");
  const names = declaredStringArray(registry, "SYSCALLS");
  return { names, ...bindCanonical(checker, canonical, names) };
}

// ---------------------------------------------------------------------------
// ① the canonical set is the single declared closed set
// ---------------------------------------------------------------------------

test("§228 ①: the canonical syscall set is read by name from rapRegistry.SYSCALLS", () => {
  const { program } = realProgram();
  const registry = program.getSourceFile(REGISTRY)!;
  const syscalls = declaredStringArray(registry, "SYSCALLS");
  assert.ok(syscalls.length > 0, "HARNESS-BROKEN: the closed syscall set is empty");
  assert.equal(new Set(syscalls).size, syscalls.length, "SYSCALLS contains a duplicate member");

  // the set this gate must NOT bind to -- same file, same `as const` array shape
  const hooks = declaredStringArray(registry, "HOOKS");
  for (const hook of hooks) {
    assert.equal(
      syscalls.includes(hook),
      false,
      `the hook ${hook} leaked into the syscall set -- this gate bound the wrong closed set`,
    );
  }
});

// ---------------------------------------------------------------------------
// ④ coverage equality: exactly one public symbol per canonical name, thenable
// ---------------------------------------------------------------------------

test("§228 ④: every canonical name resolves to exactly one thenable public symbol", () => {
  const { names, bindings, failures } = realCanonicalSet();
  assert.deepEqual(failures, [], `coverage equality failed:\n  ${failures.join("\n  ")}`);
  assert.equal(
    bindings.length,
    names.length,
    `HARNESS-BROKEN: ${names.length} canonical names but ${bindings.length} bindings`,
  );
  for (const binding of bindings) {
    assert.equal(binding.thenable, true, `${binding.name} at ${binding.where} does not return a thenable`);
  }
});

// ---------------------------------------------------------------------------
// the invariant itself
// ---------------------------------------------------------------------------

test("§228: every canonical syscall call site joins its promise", () => {
  const { program, checker } = realProgram();
  const { bindings } = realCanonicalSet();
  const { sites, unresolved } = collectSites(program, checker, bindings, isProductionFile);

  // fail closed BEFORE reporting anything about joins: an unresolvable callee
  // wearing a canonical name means this gate cannot see what it claims to see.
  assert.deepEqual(
    unresolved,
    [],
    "a call wearing a canonical syscall name did not resolve -- the gate is blind here, ⛔ not clean",
  );

  const bad = sites.filter((site) => site.join !== "joined");
  assert.deepEqual(
    bad.map((site) => `${path.basename(site.file)}:${site.line} ${site.name} [${site.join}] ${site.text}`),
    [],
    "a RAP syscall promise is not joined at its call site",
  );

  // census scope, rendered as a computed line so the boundary is auditable on
  // every run rather than asserted in a comment
  const scanned = program.getSourceFiles().filter((f) => !f.isDeclarationFile && isProductionFile(f.fileName)).length;
  const perName = bindings
    .map((binding) => `${binding.name}=${sites.filter((s) => s.name === binding.name).length}`)
    .join(" ");
  assert.equal(sites.every((site) => !site.isTest), true, "HARNESS-BROKEN: a test file entered the production census");

  console.log(
    `§228 census: ${scanned} non-test production TS files in packages/server/src; `
    + `${sites.length} canonical call sites -- ${perName}`,
  );
  // ⚠️ THE ONLY CLAIM THIS GREEN LICENSES (@XX, frozen wording).
  console.log(
    sites.length === 0
      ? "§228 ⚠️ 0 production call sites ⇒ this green says ONLY: no violation found under 0 production "
        + "call sites, and the coverage + parser contract holds. ⛔ It does NOT say the join invariant "
        + "has been observed to hold in practice."
      : "§228 ⚠️ this green covers the production census above ONLY; it is not a statement about test code.",
  );
});

// ---------------------------------------------------------------------------
// TEETH -- each arm must be shown capable of going RED before its green counts.
// Synthetic programs, so a tooth cannot be satisfied by the real tree happening
// to be correct today.
// ---------------------------------------------------------------------------

function syntheticProgram(files: Record<string, string>): { program: ts.Program; checker: ts.TypeChecker } {
  const root = "/synthetic";
  const sources = new Map<string, ts.SourceFile>();
  for (const [name, text] of Object.entries(files)) {
    sources.set(
      `${root}/${name}`,
      ts.createSourceFile(`${root}/${name}`, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
    );
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => sources.get(fileName),
    getDefaultLibFileName: () => "/synthetic/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getDirectories: () => [],
    fileExists: (fileName) => sources.has(fileName),
    readFile: (fileName) => files[path.basename(fileName)],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });
  return { program, checker: program.getTypeChecker() };
}

const SYNTHETIC_CANONICAL = `
export interface Thenable<T> { then(onfulfilled: (value: T) => unknown): Thenable<T>; }
export declare function notify(): Thenable<string>;
export declare function schedule(): Thenable<string>;
export declare function createNotifyForTests(): Thenable<string>;
`;

test("§228 TOOTH: adding a second real export of a canonical name goes RED", () => {
  const clean = syntheticProgram({ "canonical.ts": SYNTHETIC_CANONICAL });
  const cleanFile = clean.program.getSourceFile("/synthetic/canonical.ts")!;
  const before = bindCanonical(clean.checker, cleanFile, ["notify", "schedule"]);
  assert.deepEqual(before.failures, [], "control: the clean synthetic surface must bind cleanly");

  // the mutation: a second real export under the same canonical name
  const mutated = syntheticProgram({
    "canonical.ts": `${SYNTHETIC_CANONICAL}\nexport declare function notify(extra: number): Thenable<string>;\n`,
  });
  const mutatedFile = mutated.program.getSourceFile("/synthetic/canonical.ts")!;
  const after = bindCanonical(mutated.checker, mutatedFile, ["notify", "schedule"]);
  assert.notDeepEqual(after.failures, [], "a duplicated canonical export MUST fail coverage equality");
});

test("§228 TOOTH: a canonical name re-exported from another module goes RED", () => {
  // The live hazard, not a hypothetical: `resolveConversation` also names an
  // internal primitive in rapRegistryStore.ts that never checks
  // manifestPermitsSyscall. If the canonical module ever re-exported it, the
  // alias would resolve, return a Promise, and look exactly like a syscall.
  const { program, checker } = syntheticProgram({
    "store.ts": `
export interface Thenable<T> { then(onfulfilled: (value: T) => unknown): Thenable<T>; }
export declare function notify(): Thenable<string>;
`,
    "canonical.ts": `export { notify } from "./store.js";\n`,
  });
  const file = program.getSourceFile("/synthetic/canonical.ts")!;
  const { failures } = bindCanonical(checker, file, ["notify"]);
  assert.match(
    failures.join(" "),
    /declared outside the canonical module/,
    "a re-exported primitive must NOT be signed as an execution surface",
  );
});

test("§228 TOOTH: a missing canonical member is HARNESS-BROKEN, never green", () => {
  const { program } = syntheticProgram({ "registry.ts": `export const SYSCALLS = ["notify"] as const;\n` });
  const file = program.getSourceFile("/synthetic/registry.ts")!;
  assert.deepEqual(declaredStringArray(file, "SYSCALLS"), ["notify"], "control: the array reads back");
  assert.throws(
    () => declaredStringArray(file, "SYSCALLS_RENAMED_BY_A_REFACTOR"),
    /HARNESS-BROKEN/,
    "a vanished canonical array must be HARNESS-BROKEN, ⛔ not an empty set that trivially passes",
  );
});

test("§228 TOOTH: the reader binds by NAME, not by node class", () => {
  // rapRegistry.ts really does hold two exported `as const` arrays since #237.
  const { program } = syntheticProgram({
    "registry.ts": `
export const HOOKS = ["onInstall", "onDue"] as const;
export const SYSCALLS = ["notify", "schedule"] as const;
`,
  });
  const file = program.getSourceFile("/synthetic/registry.ts")!;
  assert.deepEqual(declaredStringArray(file, "SYSCALLS"), ["notify", "schedule"]);
  assert.deepEqual(declaredStringArray(file, "HOOKS"), ["onInstall", "onDue"]);

  // and adding a THIRD unrelated closed set must not perturb the syscall read
  const grown = syntheticProgram({
    "registry.ts": `
export const HOOKS = ["onInstall", "onDue"] as const;
export const CLASSES = ["a.b", "c.d"] as const;
export const SYSCALLS = ["notify", "schedule"] as const;
`,
  });
  assert.deepEqual(
    declaredStringArray(grown.program.getSourceFile("/synthetic/registry.ts")!, "SYSCALLS"),
    ["notify", "schedule"],
    "a new closed set in the same file must not change what the syscall reader sees",
  );
});

test("§228 TOOTH: exact-name binding ignores factories whose names embed a canonical name", () => {
  const { program, checker } = syntheticProgram({ "canonical.ts": SYNTHETIC_CANONICAL });
  const file = program.getSourceFile("/synthetic/canonical.ts")!;
  const { bindings, failures } = bindCanonical(checker, file, ["notify"]);
  assert.deepEqual(failures, []);
  assert.equal(bindings.length, 1, "createNotifyForTests must NOT be counted as a second binding for notify");
});

test("§228 TOOTH: a non-thenable return is caught", () => {
  const { program, checker } = syntheticProgram({
    "canonical.ts": `export declare function notify(): void;\n`,
  });
  const file = program.getSourceFile("/synthetic/canonical.ts")!;
  const { failures } = bindCanonical(checker, file, ["notify"]);
  assert.match(failures.join(" "), /non-thenable/, "a syscall that returns void must fail ④");
});

test("§228 TOOTH: the join classifier answers correctly on every contract shape", () => {
  const shapes: ReadonlyArray<readonly [string, Join, string]> = [
    ["await f();", "joined", "② await"],
    ["const a = await f();", "joined", "② await into a binding"],
    ["return f();", "joined", "② return"],
    ["const g = () => f();", "joined", "② concise arrow body hands the promise on"],
    ["await Promise.all([f(), f()]);", "joined", "② awaited combinator"],
    ["return Promise.allSettled([f()]);", "joined", "② returned combinator"],
    // 🔴 race/any settle on the FIRST member ⇒ they abandon the syscall promise.
    // Awaiting them is NOT joining. Found by @Stone's mutation on task #250.
    ["await Promise.race([f(), Promise.resolve()]);", "detached", "③ awaited race abandons the syscall"],
    ["await Promise.any([f(), Promise.resolve()]);", "detached", "③ awaited any abandons the syscall"],
    ["return Promise.race([f()]);", "detached", "③ returned race is still not a join"],
    ["return Promise.any([f()]);", "detached", "③ returned any is still not a join"],
    ["await Promise.allSomethingNew([f()]);", "unclassified", "an unknown Promise combinator fails closed"],
    ["await f().then(x => x);", "joined", "② an awaited .then chain is joined"],
    ["f();", "detached", "③ bare call"],
    ["void f();", "detached", "③ void"],
    ["const p = f();", "detached", "③ assigned and left unsettled"],
    ["f().then(x => x);", "detached", "③ detached .then"],
    ["f().catch(() => {});", "detached", "③ detached .catch"],
    ["Promise.all([f(), f()]);", "detached", "③ combinator that is itself dropped"],
  ];

  for (const [snippet, expected, why] of shapes) {
    const wrapped = `declare function f(): Promise<number>;\nasync function host() { ${snippet} }\n`;
    const file = ts.createSourceFile("/s/shape.ts", wrapped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "f") {
        found ??= node;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(found, `HARNESS-BROKEN: no call to f() parsed out of ${snippet}`);
    assert.equal(classifyJoin(found), expected, `${why} -- ${snippet}`);
  }
});

test("§228 TOOTH: an unrecognised shape fails closed, it is never treated as joined", () => {
  const wrapped = `declare function f(): Promise<number>;\ndeclare function sink(p: unknown): void;\n`
    + `async function host() { sink(f()); }\n`;
  const file = ts.createSourceFile("/s/odd.ts", wrapped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "f") found ??= node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(classifyJoin(found!), "unclassified", "handing the promise to an arbitrary sink must not read as joined");
});

test("§228 TOOTH: a call wearing a canonical name that will not resolve is RED, not skipped", () => {
  const { program, checker } = syntheticProgram({
    "canonical.ts": SYNTHETIC_CANONICAL,
    // `notify` here is a free identifier: no import, no declaration in scope.
    // This is the shape a dependency-less tree produces for EVERY external symbol.
    "caller.ts": `export function host(): void { notify(); }\n`,
  });
  const canonical = program.getSourceFile("/synthetic/canonical.ts")!;
  const { bindings } = bindCanonical(checker, canonical, ["notify"]);
  assert.equal(bindings.length, 1, "control: the canonical binding must exist for this tooth to mean anything");

  const { unresolved } = collectSites(program, checker, bindings, () => true);
  assert.equal(unresolved.length, 1, "an unresolvable call wearing a canonical name must be reported, ⛔ never skipped");
  assert.match(unresolved[0]!, /caller\.ts:1 notify\(\.\.\.\) -- callee symbol did not resolve/);
});

// ---------------------------------------------------------------------------
// 🔒 COVERAGE MATRIX -- frozen format (msg 530fca6e). Delegation and disclaimer
// are different TYPES here on purpose: writing ③④ as "behavior + owner" reads as
// "#228 asserts this and someone else tests it", when the truth is "#228 makes
// no claim here."
//
// ① thenable return              assertion_kind=symbol   behavior_semantics=NOT_COVERED  no tooth owed
//    symbol_only? Y -- a body with the auth check deleted still returns a Promise and still passes.
// ② wrapper identity             assertion_kind=symbol   behavior_semantics=NOT_COVERED  no tooth owed
//    symbol_only? Y -- right identity with a wrong body still passes.
// ③ declaration/grant semantics  assertion_kind=out_of_scope_behavior  evidence_ceiling=NONE  external_owner=#141
// ④ order installed→declared→granted  assertion_kind=out_of_scope_behavior  evidence_ceiling=NONE  external_owner=#141
//
// cells_rendered = 4 = stores(1 canonical module) × dimensions(4)  ✅ arithmetic, not judgement
// ---------------------------------------------------------------------------
