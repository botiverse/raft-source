#!/usr/bin/env node
/**
 * An action inside a Banner's TEXT is a raft-ui `TextLink`, never a `Button`.
 *
 * Why: every Button size is a CONTROL size — `md` is `h-8` plus horizontal
 * padding and a 1.5px border. Dropping one into a sentence produces a short box
 * squatting beside the text: a gap on its left, the banner inflated by ~8px, and
 * a wrap onto its own line as soon as width gets tight.
 *
 * @cindyz reviewed the five action placements on 2026-08-29
 * (#wg-design-exp:20aaae68) and ruled that this shape "should not exist". It is
 * not a hypothetical: it is what Create Agent shipped, and it is invisible in a
 * screenshot until the viewport is narrow enough to trigger the wrap.
 *
 * Until raft-ui 0.7.x this check accepted `<Button size="inline">`, the size
 * that took Button's box off again. raft-ui removed it with `variant="link"`:
 * a clickable word in a sentence is `TextLink variant="strong"`, which never had
 * a box (raft-design text-link.md). So any `<Button>` in Banner text now fails.
 *
 * An action that genuinely wants control chrome is not inline text — it belongs
 * in `<BannerAction>`, which this check deliberately does not touch.
 *
 * Heuristic: inside a `<BannerDescription>`/`<BannerTitle>` element body, any
 * `<Button>` opening tag fails. Static, so it cannot see a Button passed in
 * through a variable; that is the known limit, not a silent pass.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(new URL(".", import.meta.url).pathname, "..", "src");
const TEXT_SLOTS = ["BannerDescription", "BannerTitle"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const source = readFileSync(file, "utf8");
  for (const slot of TEXT_SLOTS) {
    const open = new RegExp(`<${slot}(\\s[^>]*)?>`, "g");
    let m;
    while ((m = open.exec(source)) !== null) {
      const close = source.indexOf(`</${slot}>`, m.index);
      if (close === -1) continue;
      const body = source.slice(m.index + m[0].length, close);
      for (const btn of body.matchAll(/<Button(?=[\s/>])/g)) {
        const line = source.slice(0, m.index + m[0].length + btn.index).split("\n").length;
        offenders.push(
          `${file.slice(SRC.length + 1)}:${line} — <Button> inside <${slot}>; use <TextLink variant="strong">, or move it to <BannerAction>`,
        );
      }
    }
  }
}

if (offenders.length) {
  console.error("✗ Button inside Banner text:\n" + offenders.map((o) => `  ${o}`).join("\n"));
  process.exit(1);
}
console.log("✓ banner inline action check: no Button inside Banner text");
