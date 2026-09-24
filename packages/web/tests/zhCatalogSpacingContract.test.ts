import assert from "node:assert/strict";
import test from "node:test";

import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// ZH CATALOG MIXED-SCRIPT SPACING CONTRACT — 盘古之白, the syntactic half (task #61).
//
// @artin made CJK/ASCII mixed-script spacing a typography red line on
// 2026-08-03. @AngLee + @Wug ruled the shape: in zh catalog values, a CJK char
// directly adjacent to an ASCII letter or digit is RED. The full-catalog scan
// is 0 today (reproduces @沈括's independent audit), so this is an
// anti-regression line: any NEW value that puts CJK against ASCII letters or
// digits fails here.
//
// Deliberate scope (ruled, not an accident):
//   * `{…}` is an OPAQUE UNIT. Never inspect its interior (the letters in
//     `{changes}` are not mixed script). Its BOUNDARY with CJK is ALSO excluded
//     from this guard: a boundary can be correct without a space when the token
//     renders Chinese (`请填写{label}` -> 请填写名称), and the render type is
//     invisible in the string — it lives at the call site. The 14 known
//     boundary entries were hand-reviewed against their call sites; the one
//     genuine defect found (machine.detail.offlineAdminOnly) is fixed, the rest
//     are documented compliant. Put token boundaries in this guard and you bolt
//     exemptions onto a mostly-false-positive line — the exemption list becomes
//     the new blind spot.
//   * `#` next to CJK is only a spacing question INSIDE an ICU arm
//     (`{# 个}` renders "5 个"), where `#` is the number placeholder. A bare
//     literal like `#未知` (search.unknownSource) is a tag marker, not a number,
//     and is out of scope.
//
// This file deliberately has no fixture-based self-check: the scanned data IS
// the live catalog, and the mutation receipts (insert a digit-CJK value / strip
// an ICU arm space -> both RED) were taken against the real catalog in PR
// #… and are recorded there. A fixture would only test the scanner against a
// copy of its own assumption.

const zh = zhMessages as Record<string, string>;

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const ASCII_LETTER_OR_DIGIT = /[A-Za-z0-9]/;

function offender(id: string, value: string, left: string, right: string): string {
  return `${id}: ${JSON.stringify(left)}|${JSON.stringify(right)} in ${JSON.stringify(value)}`;
}

test("no zh value puts a CJK char directly against an ASCII letter or digit", () => {
  const offenders: string[] = [];
  for (const [id, value] of Object.entries(zh)) {
    // {…} is opaque and its boundary is excluded by ruling — scan the literal
    // text around the placeholders only.
    const literal = value.replace(/\{[^{}]*\}/g, "");
    for (let i = 0; i < literal.length - 1; i++) {
      const a = literal[i];
      const b = literal[i + 1];
      if (
        (CJK.test(a) && ASCII_LETTER_OR_DIGIT.test(b)) ||
        (ASCII_LETTER_OR_DIGIT.test(a) && CJK.test(b))
      ) {
        offenders.push(offender(id, value, a, b));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("ICU number placeholder `#` never sits against CJK inside an arm (renders digit-CJK)", () => {
  const offenders: string[] = [];
  for (const [id, value] of Object.entries(zh)) {
    // Only `#` inside {…} is the ICU number placeholder. A bare `#` (e.g.
    // search.unknownSource "#未知") is a literal tag marker — not a number, and
    // a space would corrupt it.
    for (const arm of value.matchAll(/\{[^{}]*\}/g)) {
      const body = arm[0];
      for (let i = 0; i < body.length - 1; i++) {
        if (body[i] !== "#") continue;
        const b = body[i + 1];
        if (CJK.test(b)) offenders.push(offender(id, value, "#", b));
      }
      for (let i = 1; i < body.length; i++) {
        if (body[i] !== "#") continue;
        const a = body[i - 1];
        if (CJK.test(a)) offenders.push(offender(id, value, a, "#"));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
