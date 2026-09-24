#!/usr/bin/env node
/**
 * A Button inside a Banner's TEXT must use `size="inline"`.
 *
 * Why: every other Button size is a CONTROL size — `sm` is `h-7` plus horizontal
 * padding, `md` is `h-8`. Dropping one into a sentence produces a short box
 * squatting beside the text: a gap on its left, the banner inflated by ~8px, and
 * a wrap onto its own line as soon as width gets tight. Only `inline` is
 * `h-auto p-0 align-baseline leading-[inherit]` — a word in a line of text that
 * happens to be clickable.
 *
 * @cindyz reviewed the five action placements on 2026-08-29
 * (#wg-design-exp:20aaae68) and ruled that this shape "should not exist". It is
 * not a hypothetical: it is what Create Agent shipped, and it is invisible in a
 * screenshot until the viewport is narrow enough to trigger the wrap.
 *
 * An action that genuinely wants control chrome is not inline text — it belongs
 * in `<BannerAction>`, which this check deliberately does not touch.
 *
 * Scope today: `BannerDescription` exists in exactly ONE file, because Create
 * Agent is currently the only raft-ui Banner consumer — 46 other files are still
 * on the local `ui/Banner`. So this check found nothing we did not already know;
 * its three hits were the three sites in this very change. Its value is entirely
 * forward-looking: it is what stops the next migrated file from reintroducing the
 * shape, at the moment that file is written rather than in a later review.
 *
 * Heuristic: inside a `<BannerDescription>`/`<BannerTitle>` element body, any
 * `<Button>` opening tag must carry `size="inline"`. A missing `size` is also a
 * failure — the default is `md`, a control size. Static, so it cannot see a size
 * passed through a variable; that is the known limit, not a silent pass.
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
        // Scan to the tag's real end tracking brace depth. A naive `[^>]*` stops
        // at the `>` inside `onClick={() => ...}` and then reports "no size" for
        // a Button that has one — a wrong message on a real finding, which is
        // its own kind of false report.
        let depth = 0;
        let end = btn.index + btn[0].length;
        while (end < body.length) {
          const ch = body[end];
          if (ch === "{") depth += 1;
          else if (ch === "}") depth -= 1;
          else if (ch === ">" && depth === 0) break;
          end += 1;
        }
        const attrs = body.slice(btn.index + btn[0].length, end);
        const size = attrs.match(/\bsize=["{]([a-z-]+)/)?.[1];
        if (size === "inline") continue;
        const line = source.slice(0, m.index + m[0].length + btn.index).split("\n").length;
        offenders.push(
          `${file.slice(SRC.length + 1)}:${line} — <Button ${size ? `size="${size}"` : "(no size, defaults to md)"}> inside <${slot}>; use size="inline", or move it to <BannerAction>`,
        );
      }
    }
  }
}

if (offenders.length) {
  console.error("✗ control-sized Button inside Banner text:\n" + offenders.map((o) => `  ${o}`).join("\n"));
  process.exit(1);
}
console.log("✓ banner inline action check: no control-sized Button inside Banner text");
