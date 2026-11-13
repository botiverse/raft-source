import { readFileSync } from "node:fs";

const hosts = ["public/_headers", "public/_worker.js", "nginx.conf", "vercel.json"];

describe("CSP runtime contract", () => {
  it("rejects inline scripts and runtime code generation on every Web host", () => {
    for (const host of hosts) {
      const config = readFileSync(new URL(`../${host}`, import.meta.url), "utf8");
      const scriptSrc = config.match(/script-src ([^;"]+)/u)?.[1] ?? "";
      expect(scriptSrc, host).not.toBe("");
      expect(scriptSrc.includes("'unsafe-eval'"), host).toBe(false);
      expect(scriptSrc.includes("'unsafe-inline'"), host).toBe(false);
    }
  });
});
