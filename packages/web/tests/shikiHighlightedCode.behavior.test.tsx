import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { cleanup, waitFor } from "@testing-library/react";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import { renderWithIntl } from "./helpers/intl";
import {
  __getShikiHighlightRecordCountForTests,
  __resetShikiHighlightRecordsForTests,
  isTooLargeForInlineHighlight,
  MAX_SHIKI_HIGHLIGHT_CHARS,
  MAX_SHIKI_HIGHLIGHT_LINES,
} from "../src/components/markdown/ShikiHighlightedCode";
import {
  __getShikiHighlightedCodeCacheCharsForTests,
  __getShikiHighlightedCodeCacheSizeForTests,
  __resetShikiHighlightedCodeCacheForTests,
  __setShikiHighlightedCodeCacheLimitsForTests,
  getHighlightedCode,
} from "../src/components/markdown/shikiHighlighter";

beforeEach(() => {
  __resetShikiHighlightRecordsForTests();
  __resetShikiHighlightedCodeCacheForTests();
});

afterEach(() => {
  cleanup();
});

test("markdown fenced code blocks render Shiki token spans for known languages", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={[
        "```ts",
        "const value = 1;",
        "console.log(value);",
        "```",
      ].join("\n")}
      density="compact"
    />,
  );

  const code = container.querySelector("pre code.language-ts");
  assert.ok(code, "language class should stay on the code element");
  assert.match(code.textContent ?? "", /const value = 1;\nconsole\.log\(value\);/);

  await waitFor(() => {
    assert.ok(
      container.querySelector('pre code.language-ts span[style*="color"]'),
      "Shiki should render colored token spans",
    );
  });
});

test("java fenced code blocks are part of the common highlighted language set", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={[
        "```java",
        "class Main {",
        "  public static void main(String[] args) {",
        "    System.out.println(\"hello\");",
        "  }",
        "}",
        "```",
      ].join("\n")}
      density="compact"
    />,
  );

  const code = container.querySelector("pre code.language-java");
  assert.ok(code, "java class should stay on the code element");
  assert.match(code.textContent ?? "", /System\.out\.println\("hello"\);/);

  await waitFor(() => {
    assert.ok(
      container.querySelector('pre code.language-java span[style*="color"]'),
      "Java should render colored token spans",
    );
  });
});

test("warm Shiki languages render highlighted on the first frame", async () => {
  await getHighlightedCode("const warmSeed = 0;", "typescript");
  __resetShikiHighlightRecordsForTests();

  const { container } = renderWithIntl(
    <MarkdownContent
      source={[
        "```ts",
        "const warmFrameValue = 1;",
        "console.log(warmFrameValue);",
        "```",
      ].join("\n")}
      density="compact"
    />,
  );

  const code = container.querySelector("pre code.language-ts");
  assert.ok(code, "language class should stay on the code element");
  assert.match(code.textContent ?? "", /const warmFrameValue = 1;\nconsole\.log\(warmFrameValue\);/);
  assert.ok(
    container.querySelector('pre code.language-ts span[style*="color"]'),
    "warm Shiki language should render token spans without a plaintext-first frame",
  );
});

test("new mainstream language aliases normalize into highlighted languages", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={[
        "```c++",
        "#include <iostream>",
        "int main() { std::cout << \"hello\"; }",
        "```",
      ].join("\n")}
      density="compact"
    />,
  );

  const code = container.querySelector("pre code.language-c\\+\\+");
  assert.ok(code, "original language class should stay on the code element");

  await waitFor(() => {
    assert.ok(
      container.querySelector('pre code.language-c\\+\\+ span[style*="color"]'),
      "C++ alias should render colored token spans",
    );
  });
});

test("Artea-requested Clojure, Dart, and Perl fences highlight", async () => {
  const cases = [
    {
      language: "clj",
      selector: "clj",
      code: "(println \"hello\")",
    },
    {
      language: "dart",
      selector: "dart",
      code: "void main() { print('hello'); }",
    },
    {
      language: "pl",
      selector: "pl",
      code: "print \"hello\\n\";",
    },
  ];

  for (const item of cases) {
    const { container, unmount } = renderWithIntl(
      <MarkdownContent
        source={["```" + item.language, item.code, "```"].join("\n")}
        density="compact"
      />,
    );

    const code = container.querySelector(`pre code.language-${item.selector}`);
    assert.ok(code, `${item.language} class should stay on the code element`);

    await waitFor(() => {
      assert.ok(
        container.querySelector(`pre code.language-${item.selector} span[style*="color"]`),
        `${item.language} should render colored token spans`,
      );
    });

    unmount();
  }
});

test("haskell fenced code blocks are part of the highlighted language set", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={[
        "```haskell",
        "main = putStrLn \"Hello, World!\"",
        "```",
      ].join("\n")}
      density="compact"
    />,
  );

  const code = container.querySelector("pre code.language-haskell");
  assert.ok(code, "haskell class should stay on the code element");

  await waitFor(() => {
    assert.ok(
      container.querySelector('pre code.language-haskell span[style*="color"]'),
      "Haskell should render colored token spans",
    );
  });
});

test("markdown code blocks without a language remain readable plaintext", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent source={["```", "plain text", "```"].join("\n")} density="compact" />,
  );

  const code = container.querySelector("pre code");
  assert.ok(code);
  assert.equal(code.textContent, "plain text\n");
  assert.equal(container.querySelector('pre code span[style*="color"]'), null);
});

test("unknown fenced languages fall back without blanking the code block", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={["```raftlog", "feature_flag_operator=true", "```"].join("\n")}
      density="compact"
    />,
  );

  const code = container.querySelector("pre code.language-raftlog");
  assert.ok(code);
  assert.equal(code.textContent, "feature_flag_operator=true\n");
  assert.equal(container.querySelector('pre code.language-raftlog span[style*="color"]'), null);
});

test("Shiki highlight records are released when the last code block listener unmounts", async () => {
  for (const suffix of ["first", "second"]) {
    const { container, unmount } = renderWithIntl(
      <MarkdownContent
        source={["```ts", `const ${suffix}Value = 1;`, "```"].join("\n")}
        density="compact"
      />,
    );

    await waitFor(() => {
      assert.ok(
        container.querySelector('pre code.language-ts span[style*="color"]'),
        `${suffix} block should highlight before unmount`,
      );
    });
    assert.equal(__getShikiHighlightRecordCountForTests(), 1);

    unmount();
    assert.equal(
      __getShikiHighlightRecordCountForTests(),
      0,
      `${suffix} block should not leave an empty highlight record behind`,
    );
  }
});

test("shared Shiki highlight records stay alive until the final listener unmounts", async () => {
  const source = ["```ts", "const sharedValue = 1;", "```"].join("\n");
  const first = renderWithIntl(<MarkdownContent source={source} density="compact" />);
  const second = renderWithIntl(<MarkdownContent source={source} density="compact" />);

  await waitFor(() => {
    assert.ok(first.container.querySelector('pre code.language-ts span[style*="color"]'));
    assert.ok(second.container.querySelector('pre code.language-ts span[style*="color"]'));
  });
  assert.equal(__getShikiHighlightRecordCountForTests(), 1);

  first.unmount();
  assert.equal(
    __getShikiHighlightRecordCountForTests(),
    1,
    "one remaining code block listener should keep the shared record alive",
  );

  second.unmount();
  assert.equal(__getShikiHighlightRecordCountForTests(), 0);
});

test("Shiki highlight record test reset clears any retained records", async () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={["```ts", "const resetValue = 1;", "```"].join("\n")}
      density="compact"
    />,
  );

  await waitFor(() => {
    assert.ok(container.querySelector('pre code.language-ts span[style*="color"]'));
  });
  assert.equal(__getShikiHighlightRecordCountForTests(), 1);

  __resetShikiHighlightRecordsForTests();
  assert.equal(__getShikiHighlightRecordCountForTests(), 0);
});

test("Shiki token cache evicts least-recently-used entries over its cap", async () => {
  __setShikiHighlightedCodeCacheLimitsForTests({ maxEntries: 2 });

  const first = await getHighlightedCode("const firstValue = 1;", "typescript");
  const firstAgain = await getHighlightedCode("const firstValue = 1;", "typescript");
  assert.equal(firstAgain, first, "same code/language should reuse the cached token entry");

  const second = await getHighlightedCode("const secondValue = 2;", "typescript");
  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 2);

  const touchedFirst = await getHighlightedCode("const firstValue = 1;", "typescript");
  assert.equal(touchedFirst, first, "cache hit should refresh the first entry's LRU position");

  await getHighlightedCode("const thirdValue = 3;", "typescript");
  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 2);

  const reloadedSecond = await getHighlightedCode("const secondValue = 2;", "typescript");
  assert.notEqual(
    reloadedSecond,
    second,
    "the untouched token entry should be evicted once the bounded LRU exceeds the cap",
  );
  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 2);
});

test("Shiki token cache evicts over its approximate source-size cap", async () => {
  __setShikiHighlightedCodeCacheLimitsForTests({ maxEntries: 10, maxChars: 42 });

  const firstCode = "const exactFitValue = 1;";
  await getHighlightedCode(firstCode, "typescript");
  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 1);
  assert.equal(__getShikiHighlightedCodeCacheCharsForTests(), firstCode.length);

  await getHighlightedCode("const anotherFitValue = 2;", "typescript");
  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 1);
  assert.ok(
    __getShikiHighlightedCodeCacheCharsForTests() <= 42,
    "cache should trim oldest entries until retained source size is under the cap",
  );
});

test("Shiki token cache keeps entries when retained source size exactly matches the cap", async () => {
  const firstCode = "const one = 1;";
  const secondCode = "const two = 2;";
  const exactCap = firstCode.length + secondCode.length;
  __setShikiHighlightedCodeCacheLimitsForTests({ maxEntries: 10, maxChars: exactCap });

  await getHighlightedCode(firstCode, "typescript");
  await getHighlightedCode(secondCode, "typescript");

  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 2);
  assert.equal(__getShikiHighlightedCodeCacheCharsForTests(), exactCap);
});

test("oversized fenced code blocks stay plaintext and bypass Shiki work", async () => {
  const oversizedCode = Array.from(
    { length: MAX_SHIKI_HIGHLIGHT_LINES + 1 },
    (_, index) => `const value${index} = ${index};`,
  ).join("\n");
  assert.equal(isTooLargeForInlineHighlight(oversizedCode), true);

  const startedAt = performance.now();
  const { container } = renderWithIntl(
    <MarkdownContent
      source={["```ts", oversizedCode, "```"].join("\n")}
      density="compact"
    />,
  );
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  const timerDelayMs = performance.now() - startedAt;

  const code = container.querySelector("pre code.language-ts");
  assert.ok(code);
  assert.match(code.textContent ?? "", /const value500 = 500;/);
  assert.equal(container.querySelector('pre code.language-ts span[style*="color"]'), null);
  assert.equal(__getShikiHighlightRecordCountForTests(), 0);
  assert.equal(__getShikiHighlightedCodeCacheSizeForTests(), 0);
  assert.ok(
    timerDelayMs < 50,
    `oversized plaintext render should not block the next browser timer for a long task (${timerDelayMs.toFixed(1)}ms)`,
  );
});

test("Shiki cutoff keeps exact-threshold blocks eligible and blocks over-threshold input", () => {
  const exactLineThreshold = Array.from({ length: MAX_SHIKI_HIGHLIGHT_LINES }, () => "x").join("\n");
  assert.equal(isTooLargeForInlineHighlight(exactLineThreshold), false);
  assert.equal(isTooLargeForInlineHighlight(`${exactLineThreshold}\nx`), true);

  assert.equal(isTooLargeForInlineHighlight("x".repeat(MAX_SHIKI_HIGHLIGHT_CHARS)), false);
  assert.equal(isTooLargeForInlineHighlight("x".repeat(MAX_SHIKI_HIGHLIGHT_CHARS + 1)), true);
});

test("long code lines stay horizontally scrollable inside the brutal code surface", () => {
  const { container } = renderWithIntl(
    <MarkdownContent
      source={["```json", `{"veryLongField":"${"x".repeat(180)}"}`, "```"].join("\n")}
      density="compact"
    />,
  );

  const pre = container.querySelector("pre");
  assert.ok(pre);
  assert.ok(pre.className.includes("overflow-x-auto"));
  assert.ok(pre.className.includes("border-2"));
  assert.ok(pre.className.includes("bg-[#07111f]"));
});
