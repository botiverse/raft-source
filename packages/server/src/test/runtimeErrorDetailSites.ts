// #wg-rbac:#57: finds every place in packages/server/src (tests excluded) that
// reads or serializes an agent's runtime error text: the `activityDetail` and
// `lastRuntimeError` fields, the `last_runtime_error` column, and
// `agent:activity` socket emits. Each site is keyed by the file and its
// enclosing declaration (function, method, class member, route handler,
// variable, type), so runtimeErrorDetailClassification.structure.test.ts can
// require a classification for each one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const FIELD_NAMES = new Set(["activityDetail", "lastRuntimeError"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);

export const SERVER_SRC = new URL("..", import.meta.url).pathname;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "test" || entry === "node_modules" || entry === "__tests__") continue;
      listSourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function nameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
    return node.name.text;
  }
  if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node)) && node.name && ts.isIdentifier(node.name)) {
    const owner = node.parent && ts.isClassDeclaration(node.parent) && node.parent.name ? `${node.parent.name.text}.` : "";
    return `${owner}${node.name.text}`;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ROUTE_METHODS.has(node.expression.name.text)) {
    const [path] = node.arguments;
    if (path && ts.isStringLiteral(path) && ts.isIdentifier(node.expression.expression) && /Router$|^app$/.test(node.expression.expression.text)) {
      return `${node.expression.expression.text}.${node.expression.name.text.toUpperCase()} ${path.text}`;
    }
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) {
    return node.name.text;
  }
  return null;
}

function enclosing(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const name = nameOf(current);
    if (name) {
      // A route handler is named by the route, even inside a class or variable.
      return name;
    }
  }
  return "<module>";
}

function isSite(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && FIELD_NAMES.has(node.text)) return true;
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes("last_runtime_error")) return true;
  if (ts.isTemplateExpression(node) && node.getText().includes("last_runtime_error")) return true;
  if (ts.isStringLiteral(node) && node.text === "agent:activity"
    && ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === "emit") {
    return true;
  }
  return false;
}

/** `relative/file.ts#Enclosing` → number of sites in it. */
export function scanRuntimeErrorDetailSites(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const file of listSourceFiles(SERVER_SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/activityDetail|lastRuntimeError|last_runtime_error|agent:activity/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(SERVER_SRC, file).split(sep).join("/");
    const visit = (node: ts.Node): void => {
      if (isSite(node)) {
        const key = `${rel}#${enclosing(node)}`;
        sites.set(key, (sites.get(key) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}
