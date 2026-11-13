import { describe, expect, it } from "vitest";
import { cliArgs } from "./args";

describe("cliArgs", () => {
  it("drops the leading -- pnpm passes through", () => {
    expect(cliArgs(["node", "x.ts", "--", "--origin", "https://a"])).toEqual(["--origin", "https://a"]);
  });
  it("keeps arguments without it, and a later --", () => {
    expect(cliArgs(["node", "x.ts", "--origin", "https://a"])).toEqual(["--origin", "https://a"]);
    expect(cliArgs(["node", "x.ts", "--a", "--", "b"])).toEqual(["--a", "--", "b"]);
  });
});
