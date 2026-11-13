/**
 * Task #708 (Artea): an @mention must sit on the same text baseline as the
 * message text around it, in light and in dark mode.
 *
 * raft-ui 0.5.16 (#319) already aligns message reference chips to the body
 * baseline. A slock-local `align-middle` override on MentionLink (#8532,
 * written against 0.5.15's `align-bottom` and merged after the 0.5.16 bump)
 * sank every @mention 1.3px below the text. This pins the
 * visible fact in a real browser, where layout exists: the bottom of the
 * mention's own text box versus the bottom of the neighbouring CJK text box,
 * same font size, so equal bottoms mean equal baselines.
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertApiOk } from "../fixtures/apiResponse";
import { test } from "../fixtures/scenario";

const MODES = ["light", "dark"] as const;
const BODY_MARKER = "用简洁明了的语言陈述一遍";
/** Sub-pixel tolerance: 0.5 CSS px is below what anti-aliasing can show. */
const MAX_BASELINE_OFFSET_PX = 0.5;

async function mentionBaselineOffsets(page: Page) {
  return page.evaluate((marker) => {
    const textBox = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects()[0] ?? null;
    };
    const holder = [...document.querySelectorAll("*")]
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes(marker)))
      .pop();
    if (!holder) return null;
    const bodyNode = [...holder.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes(marker));
    const body = bodyNode ? textBox(bodyNode) : null;
    if (!body) return null;
    const offsets: Array<{ label: string; offset: number; fontSize: string }> = [];
    for (const el of holder.querySelectorAll("*")) {
      const textNode = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim().startsWith("@"));
      if (!textNode) continue;
      const box = textBox(textNode);
      if (!box) continue;
      offsets.push({
        label: textNode.textContent!.trim(),
        offset: Number((box.bottom - body.bottom).toFixed(2)),
        fontSize: getComputedStyle(el).fontSize,
      });
    }
    return { bodyFontSize: getComputedStyle(holder).fontSize, offsets };
  }, BODY_MARKER);
}

for (const mode of MODES) {
  test(`@mentions sit on the message text baseline (${mode})`, async ({ page, request, scenario }) => {
    const { seed, login, peer } = scenario;
    const sent = await request.post(`${seed.urls.api}/api/v2/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seed.server.id },
      data: { channelId: seed.channel.id, content: `@${peer.name} ${BODY_MARKER} 根因和修法 @${seed.user.name} 自己` },
    });
    await assertApiOk(sent, "POST /api/v2/messages (mentions)");

    await page.addInitScript((nextMode) => {
      localStorage.setItem("slock-theme-preferences-v2", JSON.stringify({ mode: nextMode }));
    }, mode);
    await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}`);
    await expect(page.getByText(BODY_MARKER).last()).toBeVisible();
    await expect(page.locator("html")).toHaveClass(new RegExp(`(^|\\s)${mode}(\\s|$)`));

    const measured = await mentionBaselineOffsets(page);
    expect(measured, "the message body must render").not.toBeNull();
    // Both the other-human (underlined) and the self (highlighted) mention.
    expect(measured!.offsets.map((o) => o.label)).toEqual(
      expect.arrayContaining([expect.stringContaining(peer.name), expect.stringContaining(seed.user.name)]),
    );
    // A mention of the person reading is the yellow sticker, a chip set at
    // 0.875em of the sentence like every chip in running text (raft-ui 0.22,
    // message-item.md "Chips in running text"); another person's mention is
    // inline text at the body size. Both sit on the body's baseline.
    const bodyPx = Number.parseFloat(measured!.bodyFontSize);
    for (const { label, offset, fontSize } of measured!.offsets) {
      const chip = label === `@${seed.user.name}`;
      expect(fontSize, `${label} ${chip ? "is a chip at 0.875em of" : "uses"} the body font size`).toBe(`${chip ? bodyPx * 0.875 : bodyPx}px`);
      expect(Math.abs(offset), `${label} baseline offset vs body text (px)`).toBeLessThanOrEqual(MAX_BASELINE_OFFSET_PX);
    }
  });
}
