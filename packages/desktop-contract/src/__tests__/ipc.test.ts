import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type WindowBindServerOk,
  type WindowOpenServerOk,
  type WindowSetServerTitleOk,
  validateIpcRequest,
  validateIpcResponse,
  validateServerTitle,
  SERVER_TITLE_FALLBACK,
  SERVER_TITLE_MAX_UTF8_BYTES,
  SERVER_TITLE_SUFFIX,
} from "../ipc.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type BindDispositionIsClosed = Assert<
  Equal<WindowBindServerOk["result"]["disposition"], "bound" | "focusedExisting">
>;
type OpenDispositionIsClosed = Assert<
  Equal<WindowOpenServerOk["result"]["disposition"], "opened" | "focusedExisting">
>;
type SetServerTitleResultIsEmpty = Assert<
  Equal<WindowSetServerTitleOk["result"], Record<string, never>>
>;
const dispositionTypeTeeth: [
  BindDispositionIsClosed,
  OpenDispositionIsClosed,
  SetServerTitleResultIsEmpty,
] = [true, true, true];

interface NamedValue {
  name: string;
  value: unknown;
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/contract-vectors.json"), "utf8"),
) as {
  ipc: { valid: NamedValue[]; invalid: NamedValue[] };
  ipcResponses: { valid: NamedValue[]; invalid: NamedValue[] };
};

describe("shared IPC contract vectors", () => {
  it("keeps bind and open dispositions statically disjoint", () => {
    expect(dispositionTypeTeeth).toEqual([true, true, true]);
  });
  for (const vector of vectors.ipc.valid) {
    it(`accepts ${vector.name}`, () => {
      expect(validateIpcRequest(vector.value)).toBe(true);
    });
  }

  for (const vector of vectors.ipc.invalid) {
    it(`rejects ${vector.name}`, () => {
      expect(validateIpcRequest(vector.value)).toBe(false);
    });
  }
});

describe("shared IPC response contract vectors", () => {
  it("keeps one runtime mutation killer for each cross-command disposition", () => {
    const relaxedValidator = (value: unknown, method: string, disposition: string) => {
      const response = value as {
        method?: unknown;
        status?: unknown;
        result?: { disposition?: unknown };
      };
      return (
        validateIpcResponse(value) ||
        (response.method === method &&
          response.status === "ok" &&
          response.result?.disposition === disposition)
      );
    };

    expect(
      vectors.ipcResponses.invalid
        .filter((vector) =>
          relaxedValidator(vector.value, "window.bindServer", "opened"),
        )
        .map((vector) => vector.name),
    ).toEqual(["bind-server-opened-disposition"]);
    expect(
      vectors.ipcResponses.invalid
        .filter((vector) =>
          relaxedValidator(vector.value, "window.openServer", "bound"),
        )
        .map((vector) => vector.name),
    ).toEqual(["open-server-bound-disposition"]);
  });

  for (const vector of vectors.ipcResponses.valid) {
    it(`accepts ${vector.name}`, () => {
      expect(validateIpcResponse(vector.value)).toBe(true);
    });
  }

  for (const vector of vectors.ipcResponses.invalid) {
    it(`rejects ${vector.name}`, () => {
      expect(validateIpcResponse(vector.value)).toBe(false);
    });
  }
});

describe("shared server title validator", () => {
  it("accepts the bare fallback and a non-empty visible prefix + suffix", () => {
    expect(validateServerTitle(SERVER_TITLE_FALLBACK)).toBe(true);
    expect(validateServerTitle(`My Server${SERVER_TITLE_SUFFIX}`)).toBe(true);
    expect(validateServerTitle(`团队 Server${SERVER_TITLE_SUFFIX}`)).toBe(true);
  });

  it("rejects titles that are not already trimmed", () => {
    expect(validateServerTitle(" Raft")).toBe(false);
    expect(validateServerTitle("Raft ")).toBe(false);
    expect(validateServerTitle(` My Server${SERVER_TITLE_SUFFIX}`)).toBe(false);
  });

  it("rejects an empty title and an empty visible prefix", () => {
    expect(validateServerTitle("")).toBe(false);
    expect(validateServerTitle(SERVER_TITLE_SUFFIX)).toBe(false);
    expect(validateServerTitle(`   ${SERVER_TITLE_SUFFIX}`)).toBe(false);
  });

  it("rejects titles that are neither the fallback nor suffixed", () => {
    expect(validateServerTitle("My Server")).toBe(false);
    expect(validateServerTitle("My Server | Other")).toBe(false);
    expect(validateServerTitle("raft")).toBe(false);
  });

  it("rejects C0/C1 control and bidi override/isolate/mark code points", () => {
    expect(validateServerTitle(`My\x01Server${SERVER_TITLE_SUFFIX}`)).toBe(false);
    expect(validateServerTitle(`My\x9fServer${SERVER_TITLE_SUFFIX}`)).toBe(false);
    expect(validateServerTitle(`My\u202eServer${SERVER_TITLE_SUFFIX}`)).toBe(false);
    expect(validateServerTitle(`My\u2066Server${SERVER_TITLE_SUFFIX}`)).toBe(false);
    expect(validateServerTitle(`My\u200eServer${SERVER_TITLE_SUFFIX}`)).toBe(false);
    expect(validateServerTitle(`My\u200fServer${SERVER_TITLE_SUFFIX}`)).toBe(false);
  });

  it("enforces the UTF-8 byte budget at the boundary", () => {
    const prefixMax = "A".repeat(SERVER_TITLE_MAX_UTF8_BYTES - SERVER_TITLE_SUFFIX.length);
    expect(validateServerTitle(`${prefixMax}${SERVER_TITLE_SUFFIX}`)).toBe(true);
    expect(validateServerTitle(`${prefixMax}A${SERVER_TITLE_SUFFIX}`)).toBe(false);
    // Multi-byte code points count by UTF-8 bytes, not code points.
    const cjk = "团".repeat(Math.floor((SERVER_TITLE_MAX_UTF8_BYTES - SERVER_TITLE_SUFFIX.length) / 3) + 1);
    expect(validateServerTitle(`${cjk}${SERVER_TITLE_SUFFIX}`)).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateServerTitle(undefined)).toBe(false);
    expect(validateServerTitle(null)).toBe(false);
    expect(validateServerTitle(42)).toBe(false);
    expect(validateServerTitle({})).toBe(false);
  });
});
