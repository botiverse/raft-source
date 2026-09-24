import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { QUICK_REACTION_EMOJIS } from "../src/components/message/reactionConstants";
import { REACTION_SPRITE_ITEMS, REACTION_SPRITE_MANIFEST } from "../src/generated/reactionSpriteManifest";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("reaction sprite assets", () => {
  it("covers every quick reaction with a generated sprite entry", () => {
    for (const emoji of QUICK_REACTION_EMOJIS) {
      assert.ok(REACTION_SPRITE_ITEMS[emoji], `missing sprite entry for ${emoji}`);
    }
    assert.equal(REACTION_SPRITE_ITEMS["❤"].id, "heart");
  });

  it("keeps the public manifest and generated TypeScript manifest in sync", () => {
    const publicManifestPath = resolve(webRoot, "public/reactions/reaction-sprite.manifest.json");
    const publicManifest = JSON.parse(
      readFileSync(publicManifestPath, "utf8"),
    );

    assert.deepEqual(publicManifest, REACTION_SPRITE_MANIFEST);
  });

  it("generates the web sprite as the only public reaction image", () => {
    const spritePath = resolve(webRoot, `public${REACTION_SPRITE_MANIFEST.spritePath}`);
    assert.ok(existsSync(spritePath), "missing public reaction sprite");
    assert.equal(REACTION_SPRITE_MANIFEST.spritePath, "/reactions/reaction-sprite.svg");

    const spriteStats = statSync(spritePath);
    assert.ok(spriteStats.size > 1_000, "public reaction sprite is unexpectedly small");

    const publicFiles = readdirSync(resolve(webRoot, "public/reactions")).sort();
    assert.deepEqual(publicFiles, [
      "reaction-sprite.manifest.json",
      "reaction-sprite.svg",
    ]);

    for (const item of REACTION_SPRITE_MANIFEST.items) {
      assert.equal("svgPath" in item, false, `${item.id} should not expose an unused client SVG`);
      assert.equal("pngPath" in item, false, `${item.id} should not expose an unused client PNG`);
    }
  });

  it("preloads the reaction sprite from the document head", () => {
    const html = readFileSync(resolve(webRoot, "index.html"), "utf8");

    assert.match(
      html,
      new RegExp(
        `<link rel="preload" as="image" type="image/svg\\+xml" href="${REACTION_SPRITE_MANIFEST.spritePath}" />`,
      ),
    );
  });

  it("keeps a readable object-literal manifest without bare lint disables", () => {
    const generated = readFileSync(
      resolve(webRoot, "src/generated/reactionSpriteManifest.ts"),
      "utf8",
    );
    const generator = readFileSync(
      resolve(webRoot, "scripts/generate-reaction-sprites.mjs"),
      "utf8",
    );
    assert.match(generated, /as const satisfies ReactionSpriteManifest/);
    assert.doesNotMatch(generated, /JSON\.parse\s*\(/);
    assert.doesNotMatch(generated, /(?:eslint|oxlint)-disable/);
    assert.doesNotMatch(generator, /(?:eslint|oxlint)-disable/);
  });
});
