import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isTestPath } from "../scripts/testLocations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { Spinner } from "@botiverse/raft-ui";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    // Feature tests (src/features/<feature>/tests/) are not app code.
    return /\.(?:ts|tsx)$/.test(entry.name) && !isTestPath(relative(repoRoot, path)) ? [path] : [];
  });

test("Spinner exposes xs/sm/md/lg + default/inverse + pixel visual", () => {
  const xsDefault = renderToStaticMarkup(
    createElement(Spinner, { size: "xs" }),
  );
  const smDefault = renderToStaticMarkup(
    createElement(Spinner, { size: "sm" }),
  );
  const mdDefault = renderToStaticMarkup(
    createElement(Spinner, { size: "md" }),
  );
  const lgInverse = renderToStaticMarkup(
    createElement(Spinner, { size: "lg", variant: "inverse" }),
  );
  const rootClass = (html: string) =>
    html.match(/<span data-slot="spinner"[^>]*class="([^"]*)"/)?.[1] ?? "";

  // Size axis: four tiers, each a physical pixel size. Don't add intermediate
  // tiers without first checking that no existing callsite already fits an
  // existing tier.
  assert.match(rootClass(xsDefault), /\[--spinner-pixel:4px\]/);
  assert.match(rootClass(smDefault), /\[--spinner-pixel:5px\]/);
  assert.match(rootClass(mdDefault), /\[--spinner-pixel:6px\]/);
  assert.match(rootClass(lgInverse), /\[--spinner-pixel:8px\]/);
  assert.match(xsDefault, /data-size="xs"/);
  assert.match(lgInverse, /data-size="lg"/);

  // Raft DS visual: four pixels lit in turn, never a ring.
  assert.equal(mdDefault.match(/data-spinner-pixel=""/g)?.length, 4);
  assert.doesNotMatch(mdDefault, /rounded-full|animate-spin|border-t-current/);

  // Tone is owned by the RUI recipe: the pixels paint with currentColor; the
  // default inherits the surrounding text colour, inverse takes the inverse
  // foreground token.
  assert.match(rootClass(mdDefault), /(?:^|\s)text-current(?:\s|$)/);
  assert.doesNotMatch(rootClass(mdDefault), /text-foreground-inverse/);
  assert.match(rootClass(lgInverse), /(?:^|\s)text-foreground-inverse(?:\s|$)/);
  assert.match(mdDefault, /bg-current/);

  // role=status + aria-label so screen readers announce the loading state
  // (the inline div spinners this replaces had no a11y at all).
  assert.match(mdDefault, /role="status"/);
  assert.match(mdDefault, /aria-label="Loading"/);
});

test("Spinner accepts an aria-label override and merges className", () => {
  const html = renderToStaticMarkup(
    createElement(Spinner, {
      size: "sm",
      "aria-label": "Uploading",
      className: "absolute bottom-2 right-2",
    }),
  );
  assert.match(html, /aria-label="Uploading"/);
  assert.match(html, /absolute bottom-2 right-2/);
});

test("no inline ring-style `rounded-full ... animate-spin` div outside Spinner.tsx", () => {
  // Pure CSS ring spinners must go through <Spinner>. Catches the pattern
  // `<div className="... rounded-full ... animate-spin ..." />` and its
  // span equivalent. Lucide icons spinning (RefreshCw, Loader2) are a
  // different concern — handled by the next test.
  const componentsDir = resolve(repoRoot, "src");
  let hits = "";
  try {
    hits = execSync(
      `grep -RnE '<(div|span)[^>]*rounded-full[^>]*animate-spin' ${componentsDir}`,
      { encoding: "utf8" },
    );
  } catch (err: any) {
    if (err.status === 1) hits = "";
    else throw err;
  }
  // Spinner.tsx is the only file allowed to emit this pattern.
  const allowed = hits
    .split("\n")
    .filter((line) => line && !line.includes("/components/ui/Spinner.tsx"))
    .filter((line) => !isTestPath(relative(repoRoot, line.split(":")[0])))
    .join("\n");
  assert.equal(
    allowed.trim(),
    "",
    `inline ring spinners are banned — use <Spinner> instead:\n${allowed}`,
  );
});

test("no generic lucide `animate-spin` loader outside Spinner.tsx", () => {
  // Key the guard to the behavior, not whichever loader icon name happened
  // to be migrated first. A spinning refresh glyph is the affordance for its
  // own action; every other lucide spinner must use the shared <Spinner>.
  const affordanceAllowlist = new Set(["RefreshCw"]);
  const violations: string[] = [];

  for (const file of sourceFiles(resolve(repoRoot, "src"))) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lucideLocals = new Set<string>();
    sourceFile.forEachChild((node) => {
      if (
        !ts.isImportDeclaration(node)
        || !ts.isStringLiteral(node.moduleSpecifier)
        || node.moduleSpecifier.text !== "lucide-react"
        || !node.importClause?.namedBindings
        || !ts.isNamedImports(node.importClause.namedBindings)
      ) return;
      for (const specifier of node.importClause.namedBindings.elements) {
        lucideLocals.add(specifier.name.text);
      }
    });

    const inspect = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const icon = ts.isIdentifier(node.tagName) ? node.tagName.text : null;
        const spins = node.attributes.properties.some((property) => (
          ts.isJsxAttribute(property)
          && property.name.getText(sourceFile) === "className"
          && property.initializer?.getText(sourceFile).includes("animate-spin")
        ));
        if (
          icon
          && spins
          && lucideLocals.has(icon)
          && !affordanceAllowlist.has(icon)
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push(`${relative(repoRoot, file)}:${line}: <${icon}>`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }

  assert.equal(
    violations.join("\n"),
    "",
    `generic spinning lucide icons are banned — use <Spinner> instead:\n${violations.join("\n")}`,
  );
});
