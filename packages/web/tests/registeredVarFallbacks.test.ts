import assert from "node:assert/strict";
import {
  REGISTRATION_READS_RIGHT,
  bareRegistrationsReadWithEmptyFallback,
  registeredVarFallbacksPlugin,
  withRegistrationsWhereTheyReadRight,
} from "../scripts/registeredVarFallbacks";

// Chromium 111 to 118 drop a declaration that reads a registered custom
// property with an empty fallback (#triage:#322: in an old system WebView the
// ⋯ menu had no outline and no shadow). The build makes such a registration
// only where it is read right, and resets the variable on every element
// elsewhere, the way Tailwind serves an engine without `@property`.

// Tailwind's output in small: its own fallback first, a ring and a shadow, the registrations last.
const TAILWIND = [
  "/*! tailwindcss */",
  "@layer properties{@supports (-moz-orient:inline){*,:before,:after,::backdrop{--tw-ring-inset:initial;--tw-shadow:0 0 #0000}}}",
  "@layer utilities{.ring-1{--tw-ring-shadow:var(--tw-ring-inset,) 0 0 0 1px currentcolor;box-shadow:var(--tw-ring-shadow),var(--tw-shadow)}.ring-inset{--tw-ring-inset:inset}}",
  '@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}',
  '@property --tw-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}',
  '@property --tw-ring-inset{syntax:"*";inherits:false}',
  '@property --tw-blur{syntax:"*";inherits:false}',
  '@property --row-fill{syntax:"<percentage>";inherits:false;initial-value:0%}',
].join("");

const RESET = `@layer properties{@supports not ${REGISTRATION_READS_RIGHT}{*,:before,:after,::backdrop{--tw-ring-inset:initial;--tw-blur:initial}}}`;
const REGISTERED = `@supports ${REGISTRATION_READS_RIGHT}{@property --tw-ring-inset{syntax:"*";inherits:false}@property --tw-blur{syntax:"*";inherits:false}}`;

test("a registration without an initial value is made only where it is read right, and reset elsewhere", () => {
  const out = withRegistrationsWhereTheyReadRight(TAILWIND);
  assert.equal(out.includes(REGISTERED), true, "the bare registrations, inside the condition");
  assert.equal(out.endsWith(REGISTERED), true);
  assert.equal(out.replace(REGISTERED, "").includes("@property --tw-ring-inset"), false, "and nowhere else");
  assert.equal(out.includes(RESET), true, "the same variables reset where the condition does not hold");
});

test("the reset comes before the stylesheet's first layer, so a utility that sets the variable wins", () => {
  const out = withRegistrationsWhereTheyReadRight(TAILWIND);
  assert.equal(out.indexOf(RESET) < out.indexOf("@layer properties{@supports (-moz-orient:inline)"), true);
  assert.equal(out.indexOf(RESET) < out.indexOf("@layer utilities"), true);
});

test("a registration with an initial value or a typed syntax stays as it is", () => {
  const out = withRegistrationsWhereTheyReadRight(TAILWIND).replace(REGISTERED, "");
  assert.equal(out.includes('@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}'), true);
  assert.equal(out.includes('@property --tw-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}'), true);
  assert.equal(out.includes('@property --row-fill{syntax:"<percentage>";inherits:false;initial-value:0%}'), true);
  assert.equal(RESET.includes("--tw-shadow"), false);
});

test("the rules themselves are untouched", () => {
  const out = withRegistrationsWhereTheyReadRight(TAILWIND);
  assert.equal(out.includes(".ring-1{--tw-ring-shadow:var(--tw-ring-inset,) 0 0 0 1px currentcolor;box-shadow:var(--tw-ring-shadow),var(--tw-shadow)}"), true);
  assert.equal(out.includes(".ring-inset{--tw-ring-inset:inset}"), true);
});

test("a stylesheet without such a registration is returned as it is, and doing it twice changes nothing", () => {
  const plain = '.a{color:red}@property --row-fill{syntax:"<percentage>";inherits:false;initial-value:0%}';
  assert.equal(withRegistrationsWhereTheyReadRight(plain), plain);
  assert.equal(withRegistrationsWhereTheyReadRight(".a{color:red}"), ".a{color:red}");
  const once = withRegistrationsWhereTheyReadRight(TAILWIND);
  assert.equal(withRegistrationsWhereTheyReadRight(once), once);
});

test("without a layer in the stylesheet the reset still goes in the properties layer", () => {
  const out = withRegistrationsWhereTheyReadRight('.a{filter:var(--tw-blur,)}@property --tw-blur{syntax:"*";inherits:false}');
  assert.equal(out.includes(`@layer properties{@supports not ${REGISTRATION_READS_RIGHT}{*,:before,:after,::backdrop{--tw-blur:initial}}}`), true);
});

test("the build's check names what an old Chromium would drop, and nothing after the plugin ran", () => {
  assert.deepEqual(bareRegistrationsReadWithEmptyFallback(TAILWIND), ["--tw-ring-inset"], "--tw-blur is registered bare but never read with an empty fallback here");
  assert.deepEqual(bareRegistrationsReadWithEmptyFallback(withRegistrationsWhereTheyReadRight(TAILWIND)), []);
  assert.deepEqual(bareRegistrationsReadWithEmptyFallback(".a{color:red}"), []);
});

test("the plugin rewrites a stylesheet module while it is still CSS text, and leaves every other module alone", () => {
  const plugin = registeredVarFallbacksPlugin();
  const transform = plugin.transform as unknown as (code: string, id: string) => { code: string; map: null } | null;
  const expected = withRegistrationsWhereTheyReadRight(TAILWIND);
  assert.equal(plugin.apply, "build");
  // In `transform`, not at the end of the build: the file's hashed name has to cover the change.
  assert.equal(plugin.enforce, undefined);
  assert.equal(plugin.generateBundle, undefined);
  assert.deepEqual(transform(TAILWIND, "/repo/packages/web/src/index.css"), { code: expected, map: null });
  assert.deepEqual(transform(TAILWIND, "/repo/packages/web/src/index.css?direct"), { code: expected, map: null });
  assert.deepEqual(transform(TAILWIND, "/repo/packages/web/src/page.css?inline"), { code: expected, map: null });
  assert.equal(transform(".a{color:red}", "/repo/packages/web/src/plain.css"), null, "nothing to change");
  // Imported as raw text or as a URL, the module is JavaScript by now.
  assert.equal(transform(`export default ${JSON.stringify(TAILWIND)}`, "/repo/packages/web/src/index.css?raw"), null);
  assert.equal(transform(`export default "/assets/index.css"`, "/repo/packages/web/src/index.css?url"), null);
  assert.equal(transform(TAILWIND, "/repo/packages/web/src/styles.ts"), null);
  assert.equal(transform(TAILWIND, "/repo/packages/web/src/css.tsx"), null);
});
