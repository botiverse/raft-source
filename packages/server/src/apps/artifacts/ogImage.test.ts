import assert from "node:assert/strict";
import sharp from "sharp";
import { describe, test } from "vitest";
import {
  ARTIFACT_OG_IMAGE_HEIGHT,
  ARTIFACT_OG_IMAGE_WIDTH,
  artifactOgImageSvg,
  clearArtifactOgImageCacheForTests,
  renderArtifactOgImagePng,
  renderArtifactOgImagePngCached,
  sanitizeOgCardText,
  wrapCardLines,
} from "./ogImage";

describe("public Artifact OG card image (1200x630)", () => {
  test("wraps English and CJK text into at most two lines with ellipsis on overflow and enforces CJK kinsoku", () => {
    assert.deepEqual(wrapCardLines("Short title", 28, 2), ["Short title"]);
    const wrappedEn = wrapCardLines("A very long quarterly performance report covering frontend main-thread startup optimization across desktop and mobile", 28, 2);
    assert.equal(wrappedEn.length, 2);
    assert.ok(wrappedEn[1]!.endsWith("…"));

    const wrappedZh = wrapCardLines("顶栏规格：标题按钮区与头部同色，按钮保持系统原生，窄窗口下怎样处理不同平台的边距与对齐", 28, 2);
    assert.equal(wrappedZh.length, 2);
    assert.ok(wrappedZh[1]!.endsWith("…"));
    assert.ok(!/^[，。、：；！？）」』》…,.!?;:)]/.test(wrappedZh[1]!), `line 2 must not start with punctuation: ${wrappedZh[1]}`);

    // Exact boundary test: 17 CJK chars (27.2 units) followed by a comma (1.6 units > 28) must not push the comma to line 2.
    const boundary = wrapCardLines("一二三四五六七八九十一二三四五六七，后面还有更多中文标题内容用于测试", 28, 2);
    assert.equal(boundary.length, 2);
    assert.ok(!boundary[1]!.startsWith("，"), `line 2 must not open with CJK comma: ${boundary[1]}`);
  });

  test("strips XML-forbidden control characters and emoji before wrapping and rasterizing", async () => {
    assert.equal(sanitizeOgCardText("🚀 Launch\u0000 Plan \u0007 📊 v2\u001B"), "Launch Plan v2");
    const svg = artifactOgImageSvg({
      title: "🚀 \u0000\u0007\u001F Quarterly Review 📊",
      description: "🎉 Clean\u000B summary\u0008 without tofu",
      pageOrigin: "https://app.raft.build",
    });
    assert.ok(!svg.includes("🚀"));
    assert.ok(!svg.includes("📊"));
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(svg));
    // Must rasterize cleanly without throwing XML parse errors in librsvg.
    const png = await renderArtifactOgImagePng({
      title: "🚀 \u0000\u0007\u001F Quarterly Review 📊",
      description: "🎉 Clean\u000B summary\u0008 without tofu",
      pageOrigin: "https://app.raft.build",
    });
    assert.ok(png.byteLength > 1000);
  });

  test("escapes hostile XML/HTML payloads in title, description and origin", () => {
    const svg = artifactOgImageSvg({
      title: `</text><script>alert(1)</script>"'&`,
      description: `"><image href="http://evil.invalid/x.svg"/>`,
      pageOrigin: "https://app.raft.build",
    });
    assert.ok(!svg.includes("<script>"));
    assert.ok(!svg.includes("<image "));
    assert.ok(svg.includes("&lt;/text&gt;&lt;script&gt;"));
    assert.ok(svg.includes("Raft Artifact"));
    assert.ok(svg.includes("app.raft.build"));
  });

  test("rasterizes to a valid 1200x630 PNG and serves identical cached buffers on repeat calls", async () => {
    clearArtifactOgImageCacheForTests();
    const input = {
      cacheKey: "pt_test:1:title:desc",
      title: "顶栏规格：标题按钮区与头部同色",
      description: "标题按钮区和头部同一个面，和头部一样高，按钮保持系统原生。",
      pageOrigin: "https://app.raft.build",
    };
    const first = await renderArtifactOgImagePngCached(input);
    const second = await renderArtifactOgImagePngCached(input);
    assert.equal(first, second, "cache hit returns exact same Buffer without re-rasterizing");
    assert.ok(first.byteLength > 1000, "PNG should contain real rendered bytes");
    assert.deepEqual([...first.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const meta = await sharp(first).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, ARTIFACT_OG_IMAGE_WIDTH);
    assert.equal(meta.height, ARTIFACT_OG_IMAGE_HEIGHT);
  });
});
