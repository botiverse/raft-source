import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(repoRoot, "src");

function sourceFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const rawYellowBackground = /\b!?(?:[a-z]+:)*bg-brutal-yellow(?:\/\d+)?\b/g;

// Arbitrary-value hex color in ANY Tailwind utility (className), e.g.
// `text-[#0f8fb3]`, `bg-[#E0DED4]`, `shadow-[2px_2px_0_#111]`, `divide-[#abc]`.
// CLAUDE.md forbids hardcoded hex outside the `@theme` token block; this gate
// enforces that rule for the arbitrary-value syntax the old scan was blind to.
//
// Deliberately matches any `<utility>-[...#hex...]` rather than a list of known
// utilities: the set of utilities that accept arbitrary values is open (Tailwind
// adds more), so enumerating them leaks by construction. The concern is the hex,
// not which property it lands on.
const arbitraryHexColor =
  /\b!?(?:[a-z]+:)*[a-z][a-z-]*-\[[^\]]*#[0-9a-fA-F]{3,8}[^\]]*\]/g;

// Same violation, different syntax: `style={{ color: "#abc123" }}`. Without this
// the gate creates a reverse incentive — it pushes hex out of className (where it
// is greppable) and into inline style (where it is not), manufacturing debt that
// is harder to find than the debt it prevents.
const inlineStyleHex = /style=\{\{[^}]*#[0-9a-fA-F]{3,8}[^}]*\}\}/g;

// Top-level crash / stale-build screens render when the app has already
// thrown — possibly because styling itself failed. They must not depend on the
// design system to display an error about the design system, so their inline
// hex is intentional, not debt. (Extracted from main.tsx into focused modules.)
const INLINE_STYLE_EXEMPT = new Set([
  "src/components/errors/AppUpdateGate.tsx",
  "src/components/errors/RootErrorFallback.tsx",
]);

// Reviewed legacy exceptions, keyed by `relpath match` (line-shift robust).
// This lets the direct token lint coexist with existing debt; additions are
// review decisions governed by docs/development/review-principles.md, not evidence that a
// source count stayed below a historical number.
const HEX_EXEMPTIONS = new Set([
  "src/components/agent/AgentWorkspace.tsx bg-[#07111f]",
  "src/components/agent/AgentWorkspace.tsx text-[#f5f7ff]",
  "src/components/markdown/MarkdownContent.tsx bg-[#07111f]",
  "src/components/markdown/MarkdownContent.tsx text-[#f5f7ff]",
  "src/components/message/MessageItem.tsx text-[#1f883d]",
  "src/components/message/MessageItem.tsx text-[#cf222e]",
  "src/components/search/MessageSearchPage.tsx bg-[#fff4bf]",
  "src/components/search/MessageSearchPage.tsx bg-[#ffeefb]",
  "src/components/settings/MemberGraphSection.tsx bg-[#f8f8f0]",
  "src/components/workspace/WorkspaceGridDemo.tsx bg-[#1f2328]",
]);

const rawYellowViolations = [];
const hexViolations = [];
const inlineStyleViolations = [];

for (const file of sourceFiles(sourceRoot)) {
  const source = readFileSync(file, "utf8");
  const rel = file.slice(repoRoot.length + 1);

  for (const match of source.matchAll(rawYellowBackground)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    rawYellowViolations.push(`${rel}:${line}: ${match[0]}`);
  }

  for (const match of source.matchAll(arbitraryHexColor)) {
    // Normalize away `hover:`/`active:`/`md:`/`!` variant+important prefixes so
    // the baseline key is variant-invariant (the hex-color concern is the same).
    const bare = match[0].replace(/^!?(?:[a-z-]+:)*/, "");
    const key = `${rel} ${bare}`;
    if (HEX_EXEMPTIONS.has(key)) continue;
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    hexViolations.push(`${rel}:${line}: ${match[0]}`);
  }

  if (INLINE_STYLE_EXEMPT.has(rel)) continue;
  for (const match of source.matchAll(inlineStyleHex)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    inlineStyleViolations.push(`${rel}:${line}: ${match[0].slice(0, 72)}`);
  }
}

if (rawYellowViolations.length > 0) {
  console.error("Raw bg-brutal-yellow is not allowed in web source callsites.");
  console.error("Use a semantic token such as bg-soft-signal, or a typed primitive intent, instead.");
  console.error(rawYellowViolations.join("\n"));
  process.exitCode = 1;
}

if (hexViolations.length > 0) {
  console.error("\nHardcoded hex colors are not allowed outside the @theme token block.");
  console.error("Use a semantic token (bg-surface, text-ink, border-outline, shadow-brutal-*, ...).");
  console.error("If a callsite is a legitimate exception, migrate it to a token or extend the token layer —");
  console.error("do not add an exemption unless review establishes why a semantic token is unsuitable.");
  console.error(hexViolations.join("\n"));
  process.exitCode = 1;
}

if (inlineStyleViolations.length > 0) {
  console.error("\nHardcoded hex in an inline style prop is not allowed either.");
  console.error("Moving hex from className into style={{...}} does not pay the debt — it hides it.");
  console.error("Use a semantic token; if the surface genuinely cannot depend on the design system");
  console.error("(e.g. a crash screen), add it to INLINE_STYLE_EXEMPT with the reason.");
  console.error(inlineStyleViolations.join("\n"));
  process.exitCode = 1;
}
