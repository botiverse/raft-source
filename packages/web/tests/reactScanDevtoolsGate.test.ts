import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = resolve(import.meta.dirname, "..");

test("React Scan devtools are switch-off by default for shared dev preview", () => {
  const mainSource = readFileSync(resolve(webRoot, "src/main.tsx"), "utf8");
  const devtoolsSource = readFileSync(resolve(webRoot, "src/devtools/localReactDevTools.ts"), "utf8");
  const envExample = readFileSync(resolve(webRoot, ".env.example"), "utf8");

  assert.match(mainSource, /if\s*\(\s*import\.meta\.env\.DEV\s*\)\s*\{/);
  assert.match(mainSource, /import\("\.\/devtools\/localReactDevTools"\)/);
  assert.doesNotMatch(
    mainSource,
    /import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_REACT_SCAN\s*===\s*"true"/,
  );

  assert.match(devtoolsSource, /import\("react-scan"\)/);
  assert.match(devtoolsSource, /initiallyEnabled\s*=\s*import\.meta\.env\.VITE_ENABLE_REACT_SCAN\s*===\s*"true"/);
  assert.match(devtoolsSource, /enabled:\s*initiallyEnabled/);
  assert.match(devtoolsSource, /showToolbar:\s*true/);
  assert.match(envExample, /VITE_ENABLE_REACT_SCAN=true/);
  assert.match(envExample, /screenshots, and screen recordings/);
});
