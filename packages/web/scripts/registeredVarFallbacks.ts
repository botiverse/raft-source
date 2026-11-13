import postcss from "postcss";
import type { AtRule } from "postcss";
import type { Plugin } from "vite";

// Chromium 111 to 118 drop a declaration that reads a REGISTERED custom
// property with an empty fallback, `var(--tw-ring-inset,)` (#triage:#322:
// measured with a production stylesheet in 112, 114 and 117; 119 reads it
// right). Tailwind writes its ring, filter, transform and font-variant-numeric
// utilities that way, the variable registered by
// `@property { syntax: "*"; inherits: false }` with no initial value. In those
// engines every `ring-*` loses its whole `box-shadow`, the shadow of the same
// element with it, and `tabular-nums`, `blur` and the like do nothing. A system
// WebView stays on such a version for years (the App embeds our pages in it),
// long after the phone's browser moved on.
//
// The same `var(--x,)` is read right there when `--x` is NOT registered. So
// these registrations, which add nothing but `inherits: false`, are kept for
// the engines that read them right, and the others get what Tailwind already
// gives an engine without `@property`: each variable reset on every element,
// so it does not inherit.

/**
 * True where a registered property is read right with an empty fallback.
 * Relative colours arrived in Chromium 119, the first version measured
 * reading it right; Safari 16.4 and Firefox 128, the first of each to
 * register properties at all, have both.
 */
export const REGISTRATION_READS_RIGHT = "(color:rgb(from red r g b))";

/** A registration that only says "does not inherit": any value, no initial one. */
function isBareRegistration(node: postcss.ChildNode): node is AtRule {
  if (node.type !== "atrule" || node.name !== "property" || !node.params.startsWith("--")) return false;
  let universal = false;
  let initial = false;
  node.each((child) => {
    if (child.type !== "decl") return;
    if (child.prop === "syntax" && /^["']\*["']$/.test(child.value.trim())) universal = true;
    if (child.prop === "initial-value") initial = true;
  });
  return universal && !initial;
}

/**
 * `css` with its top-level bare registrations made only where they are read
 * right, and the variables reset on every element elsewhere. The reset is in
 * Tailwind's `properties` layer, the first one, so a utility that sets the
 * variable still wins. A stylesheet without such a registration is returned
 * as it is.
 */
export function withRegistrationsWhereTheyReadRight(css: string): string {
  if (!css.includes("@property")) return css;
  const root = postcss.parse(css);
  const bare = root.nodes.filter(isBareRegistration);
  if (bare.length === 0) return css;
  const names = bare.map((rule) => rule.params.trim());
  const rules = bare.map((rule) => rule.toString()).join("");
  for (const rule of bare) rule.remove();
  const reset = `@layer properties{@supports not ${REGISTRATION_READS_RIGHT}{*,:before,:after,::backdrop{${names.map((name) => `${name}:initial`).join(";")}}}}`;
  // Layers are ordered by where each is first named: before the stylesheet's first layer, ours stays the first.
  const firstLayer = root.nodes.find((node) => node.type === "atrule" && node.name === "layer");
  if (firstLayer) firstLayer.before(reset);
  else root.append(reset);
  root.append(`@supports ${REGISTRATION_READS_RIGHT}{${rules}}`);
  return root.toString();
}

/**
 * The variables `css` still registers bare at its top level AND reads with an
 * empty fallback: what Chromium 111 to 118 drop. None once
 * withRegistrationsWhereTheyReadRight has run (scripts/check-registered-var-fallbacks.ts).
 */
export function bareRegistrationsReadWithEmptyFallback(css: string): string[] {
  if (!css.includes("@property")) return [];
  const bare = postcss.parse(css).nodes.filter(isBareRegistration).map((rule) => rule.params.trim());
  return bare.filter((name) => new RegExp(`var\\(\\s*${name}\\s*,\\s*\\)`).test(css));
}

/** A stylesheet module as CSS text: not one imported as a URL or as raw text, which is JavaScript by now. */
const STYLESHEET_ID = /\.css(?:\?(?!.*\b(?:raw|url)\b).*)?$/;

/**
 * Applies withRegistrationsWhereTheyReadRight to every stylesheet of the build.
 * In `transform`, after Tailwind and Vite's own CSS step have written the
 * module and before Vite collects it: the file's content hash, so its name,
 * covers the change, and a cached copy of the stylesheet without it is never
 * served under the same name. List it after `tailwindcss()`, without `enforce`.
 */
export function registeredVarFallbacksPlugin(): Plugin {
  return {
    name: "raft-registered-var-fallbacks",
    apply: "build",
    transform(code, id) {
      if (!STYLESHEET_ID.test(id)) return null;
      const next = withRegistrationsWhereTheyReadRight(code);
      return next === code ? null : { code: next, map: null };
    },
  };
}
