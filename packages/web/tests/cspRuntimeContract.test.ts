import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The hosted CSP forbids inline script but still grants 'unsafe-eval' because
// the activity ingress compiles its JSON-schema validators with Ajv at runtime
// (Ajv emits `new Function`). Removing the grant without precompiling those
// validators (ajv standalone) breaks activity sync on every host, and header
// tests alone cannot see that. Whichever side changes must change the other.
const hosts = ["public/_headers", "public/_worker.js", "nginx.conf", "vercel.json"];

describe("CSP runtime contract", () => {
  it("keeps 'unsafe-eval' exactly as long as the ingress compiles validators at runtime", () => {
    const ingress = readFileSync(new URL("../src/store/activityPanel/ingress.ts", import.meta.url), "utf8");
    const compilesAtRuntime = /from "ajv\/dist\/2020\.js"/u.test(ingress) && /new Ajv\(/u.test(ingress);
    for (const host of hosts) {
      const config = readFileSync(new URL(`../${host}`, import.meta.url), "utf8");
      const scriptSrc = config.match(/script-src ([^;"]+)/u)?.[1] ?? "";
      expect(scriptSrc, host).not.toBe("");
      expect(scriptSrc.includes("'unsafe-eval'"), `${host}: ${scriptSrc}`).toBe(compilesAtRuntime);
      expect(scriptSrc.includes("'unsafe-inline'"), host).toBe(false);
    }
  });
});
