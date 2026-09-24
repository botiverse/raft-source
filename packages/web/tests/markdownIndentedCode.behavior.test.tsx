import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import { TestIntlProvider } from "./helpers/intl";

const arteaFlowchart = [
  "flowchart TD",
  "    %% 样式",
  "    classDef human fill:#fff,stroke:#111",
  "",
  "    %% 外部实体",
  "    subgraph External",
  "        User[用户]",
  "    end",
].join("\n");

test("compact markdown keeps an unfenced indented flowchart out of a code block", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <MarkdownContent source={arteaFlowchart} density="compact" />
    </TestIntlProvider>,
  );

  assert.doesNotMatch(html, /<pre\b/);
  assert.match(html, /flowchart TD/);
  assert.match(html, /%% 外部实体/);
  assert.match(html, /User\[用户\]/);
});

test("compact markdown still renders explicit fences as code blocks", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <MarkdownContent
        source={["```mermaid", "flowchart TD", "    A --> B", "```"].join("\n")}
        density="compact"
      />
    </TestIntlProvider>,
  );

  assert.match(html, /<pre\b/);
  assert.match(html, /<code class="language-mermaid">/);
  assert.match(html, /flowchart TD/);
});

test("document markdown retains CommonMark indented code blocks", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <MarkdownContent
        source={["Document paragraph.", "", "    const retained = true;"].join("\n")}
        density="document"
      />
    </TestIntlProvider>,
  );

  assert.match(html, /<pre\b/);
  assert.match(html, /const retained = true;/);
});

test("compact markdown keeps four-space list continuation inside its list item", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <MarkdownContent
        source={["- first line", "    continuation line", "- second line"].join("\n")}
        density="compact"
      />
    </TestIntlProvider>,
  );

  assert.doesNotMatch(html, /<pre\b/);
  assert.match(html, /<ul\b/);
  assert.equal(html.match(/<li\b/g)?.length, 2);
  assert.match(html, /first line[\s\S]*continuation line[\s\S]*<\/li>/);
});
