import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParsedSourceMap, SourceMapRegistry, classifySourceBucket, cleanSourcePath } from "./sourceMap";

describe("ParsedSourceMap", () => {
  // Standard VLQ test map:
  // Generated line 0:
  //   col 0  -> src 0, line 9 (10 in 1-based), col 2 (3 in 1-based), name 0 ("renderRow")  => "AASA" (0, 0, +9, +2? wait: A=0, A=0, S=+9, E=+2, A=0 => "AASEA")
  //   col 14 -> src 0, line 11 (12 in 1-based), col 6 (7 in 1-based), name 1 ("formatTime") => c=+14, A=0, E=+2, I=+4, C=+1 => "cAEIC"
  // Generated line 1:
  //   col 4  -> src 1, line 3 (4 in 1-based), col 0 (1 in 1-based), no name => I=+4, C=+1, P=-7? (-8 is R: 8<<1|1=17='R'; 9-8=1; wait -6 is N: 6<<1|1=13='N' -> 11-6=5 -> 6 in 1-based), N=-6 (col 6-6=0) => "ICNN"
  const sampleMap = {
    version: 3,
    sources: [
      "../../src/features/messages/MessageList.tsx",
      "../../node_modules/.pnpm/react-markdown@10.1.0/node_modules/react-markdown/index.js",
    ],
    names: ["renderRow", "formatTime"],
    mappings: "AASEA,cAEIC;ICNN",
  };

  it("resolves 0-based and 1-based positions to original source, 1-based line/column, symbol name, and bucket", () => {
    const map = new ParsedSourceMap(sampleMap, "/repo/packages/web/dist/assets/index-abc123.js.map");

    const hit1 = map.resolveZeroBased(0, 5);
    expect(hit1).toEqual({
      source: "packages/web/src/features/messages/MessageList.tsx",
      line: 10,
      column: 3,
      name: "renderRow",
      bucket: "app",
    });

    const hit2 = map.resolveZeroBased(0, 18);
    expect(hit2).toEqual({
      source: "packages/web/src/features/messages/MessageList.tsx",
      line: 12,
      column: 7,
      name: "formatTime",
      bucket: "app",
    });

    const hit3 = map.resolveOneBased(2, 5);
    expect(hit3).toEqual({
      source: "node_modules/react-markdown/index.js",
      line: 6,
      column: 1,
      name: null,
      bucket: "markdown",
    });
  });

  it("supports indexed sourcemaps (sections)", () => {
    const indexed = new ParsedSourceMap({
      version: 3,
      sections: [
        {
          offset: { line: 2, column: 10 },
          map: {
            version: 3,
            sources: ["packages/web/src/App.tsx"],
            names: ["App"],
            mappings: "AAAAA",
          },
        },
      ],
    });
    expect(indexed.resolveZeroBased(2, 12)).toEqual({
      source: "packages/web/src/App.tsx",
      line: 1,
      column: 1,
      name: "App",
      bucket: "app",
    });
    // Column before the first mapped segment on line 2 (col 5 < offset col 10) is unmapped preamble -> null
    expect(indexed.resolveZeroBased(2, 5)).toBeNull();
    // External section URL that cannot be loaded throws explicitly instead of silently swallowing
    expect(() =>
      new ParsedSourceMap({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, url: "missing-chunk.js.map" }],
      }),
    ).toThrow(/external url "missing-chunk\.js\.map"/);
  });

  it("recovers function declaration symbol names when V8 reports the '(' column right after the identifier segment on the same line", () => {
    // Generated line 0:
    //   col 9  -> src 0, line 4 (5 in 1-based), col 16, name 0 ("MessageItem"): S=+9, A=0, I=+4, gB=+16, A=0 => "SAIgBA"
    //   col 11 -> src 0, line 4 (same origLine!), col 27, NO name (`(` parameter list): E=+2, A=0, A=0, W=+11 => "EAAW"
    const fnMap = new ParsedSourceMap({
      version: 3,
      sources: ["packages/web/src/MessageItem.tsx"],
      names: ["MessageItem"],
      mappings: "SAIgBA,EAAW",
    });
    expect(fnMap.resolveZeroBased(0, 11)).toEqual({
      source: "packages/web/src/MessageItem.tsx",
      line: 5,
      column: 28,
      name: "MessageItem",
      bucket: "app",
    });
    // Before col 9 -> unmapped `function ` keyword -> null
    expect(fnMap.resolveZeroBased(0, 0)).toBeNull();
  });
});

describe("SourceMapRegistry and bucket classification", () => {
  it("loads .js.map files lazily by deployed bundle URL basename", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "raft-perf-map-"));
    try {
      writeFileSync(
        path.join(tmp, "index-XyZ999.js.map"),
        JSON.stringify({
          version: 3,
          sources: ["packages/web/src/boot.ts"],
          names: ["bootApp"],
          mappings: "AAAAA",
        }),
      );
      const registry = SourceMapRegistry.fromDirectory(tmp);
      expect(registry.mapCount).toBe(1);
      expect(registry.resolveZeroBased("https://raft-app-staging.botiverse.dev/assets/index-XyZ999.js?v=1", 0, 0)).toEqual({
        source: "packages/web/src/boot.ts",
        line: 1,
        column: 1,
        name: "bootApp",
        bucket: "app",
      });
      expect(registry.resolveZeroBased("https://raft-app-staging.botiverse.dev/assets/missing.js", 0, 0)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies subsystem buckets across pnpm virtual store paths and runtime frames", () => {
    expect(classifySourceBucket("node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/cjs/react-dom.production.js")).toBe("react");
    expect(classifySourceBucket("node_modules/.pnpm/shiki@4.5.0/node_modules/shiki/dist/index.mjs")).toBe("rich-content");
    expect(classifySourceBucket("node_modules/.pnpm/@botiverse+raft-ui@0.102.3/node_modules/@botiverse/raft-ui/dist/index.js")).toBe("ui");
    expect(classifySourceBucket("node_modules/.pnpm/zustand@5.0.15/node_modules/zustand/esm/index.mjs")).toBe("state-network");
    expect(classifySourceBucket("https://app.raft.build/assets/index-123.js")).toBe("bundle-unmapped");
    expect(classifySourceBucket("", "(garbage collector)")).toBe("runtime");
    expect(cleanSourcePath("vite:///packages/web/src/main.tsx?import")).toBe("packages/web/src/main.tsx");
  });
});
