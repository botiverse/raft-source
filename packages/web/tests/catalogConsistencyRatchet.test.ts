import assert from "node:assert/strict";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// CATALOG CONSISTENCY RATCHET — same English, different Chinese.
//
// Found by auditing the catalogs while the billing lane was in review: 51
// English strings render as MORE THAN ONE Chinese string depending on which
// surface you are looking at. `Computers` is both "Computers" and "计算机";
// `Activity` is both "动态" and "活动". That is not duplication to be collapsed
// — it is the same product saying two different things to the same user.
//
// Crucially, NOT ALL OF IT IS A BUG. Some pairs are genuinely distinct senses
// that happen to share an English word:
//   "Back" -> 上一步 (wizard step) vs 返回 (navigate back)
//   "Read" -> 已读 (read state)    vs 读取 (read permission)
// Collapsing those would be a regression, so nothing here is auto-merged. Every
// row needs @AngLee's per-row verdict, which is pending.
//
// WHY A RATCHET INSTEAD OF A FIX: the verdicts are a human copy decision with no
// deadline, and meanwhile every new migration adds ids. Without this, the list
// grows while we wait — each author picking whichever Chinese reads right to
// them, exactly how these 51 accumulated. This freezes the known set and makes
// any NEW divergence fail, so the problem can only shrink.
//
// TWO DIRECTIONS, both enforced:
//   1. A new drifting string fails -> no growth.
//   2. A row that no longer drifts must be DELETED from the list -> the list
//      cannot rot into a stale exemption nobody rechecks. (Same reasoning as the
//      billing verbatim check: an exemption list is read as "someone thought
//      about this", so it has to stay true.)
//
// DO NOT add a row here to make a red build green. A new entry means you shipped
// a second Chinese translation of an existing English string; fix the string, or
// if the two senses really are different, say so in the PR and get it ruled on.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

/**
 * English -> every distinct Chinese it currently renders as.
 *
 * Frozen 2026-08-01 with 51 rows. @AngLee ruled on all of them the same day
 * (#proj-i18n:ea47a2f4): 38 converged to a single translation and 13 were ruled
 * to STAY different, because the shared English word carries genuinely different
 * senses — `Read` is 已读 (state) vs 读取 (permission), `Private` is 私密
 * (channel visibility) vs 私有 (app distribution), and so on.
 *
 * That 38/13 is a DATED FACT about one ruling, not a description of this table.
 * The table itself is deliberately described without a count: every row below is
 * ruled-permanent, and rows can be added by a later verdict (see `Complete`) or
 * removed when a divergence is genuinely fixed. A count in this comment would go
 * stale the first time either happens — which it did, within a day: the first
 * version of this header said "these 13" and the very next ruling made it 14.
 *
 * So this is not a backlog awaiting a decision; it is the ruled-permanent set. A
 * new entry still means someone introduced an inconsistency, and it still needs a
 * verdict rather than an append.
 *
 * `Complete` (added 2026-08-01) is the worked example of how a row is SUPPOSED to
 * arrive here. #5808 converged it to 已完成 under the general "Complete -> 已完成"
 * ruling. It then turned out that `settings.connectedApps.editor.status.complete`
 * is a form-completeness state whose opposite is `needsDetails` = 「待补充」 — a
 * different sense from `agent.detail.migrationComplete`, which really is task
 * completion. @AngLee reviewed that evidence and ruled the two must stay
 * distinct, so the value went back to 已完善 and the row was added HERE. The
 * ratchet was never silenced to make the build green; it went red, a copy owner
 * ruled, and the ruling is what opened the table.
 */
const KNOWN_DRIFT: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Back", ["上一步", "返回"]],
  // @artin/@AngLee 2026-08-04 ruled REVERSAL: reasoning-effort VALUES are model
  // parameter enums and stay English (Low/Medium/...), reversing the F1
  // translation (低/中/...). "Medium" now diverges: effort value -> Medium
  // (English, by reversal ruling) vs font-size option -> 中 (translated).
  ["Medium", ["Medium", "中"]],
  // @AngLee batch F (wiki, reviewed in-PR): wiki "Setup" button -> 设置 vs app
  // status "Setup" -> 待配置; wiki "Started" timestamp prefix -> 开始于 vs
  // activity-log status "Started" -> 已启动. Ruled-permanent divergences.
  ["Setup", ["待配置", "设置"]],
  ["Started", ["已启动", "开始于"]],
  // @AngLee 2026-08-04 (batch F): wiki status "Active" -> 已启用, vs agent
  // status "Active" -> 活跃 (agent.detail.active). Ruled-permanent divergence.
  ["Active", ["已启用", "活跃"]],
  // @AngLee 2026-08-04 (batch F): the agent reset DIALOG actions diverge from the
  // machine BULK actions by ruling — 重新启动/完全重置并重启 (agent dialog) vs
  // 重启/完整重置并重启 (machine list bulk actions). Ruled-permanent.
  ["Restart", ["重启", "重新启动"]],
  ["Full Reset & Restart", ["完全重置并重启", "完整重置并重启"]],
  ["Clear All", ["清空选择", "清除筛选"]],
  ["Complete", ["已完善", "已完成"]],
  ["From", ["发送者", "来自"]],
  ["Open", ["开放", "打开"]],
  ["Private", ["私密", "私有"]],
  ["Read", ["已读", "读取"]],
  ["Recent", ["最新", "最近"]],
  ["Working…", ["处理中…", "工作中…"]],
  ["Workspace", ["工作区", "工作空间"]],
  ["active", ["active", "已连接"]],
  ["{count} new", ["{count} 条新回复", "{count} 条新消息"]],
  ["{count} selected", ["已选 {count} 个", "已选 {count} 条"]],
];

/** English strings used by >1 id across >1 namespace, whose zh values disagree. */
function currentDrift(): Map<string, string[]> {
  const byEnglish = new Map<string, string[]>();
  for (const [id, text] of Object.entries(en)) {
    byEnglish.set(text, [...(byEnglish.get(text) ?? []), id]);
  }
  const drift = new Map<string, string[]>();
  for (const [text, ids] of byEnglish) {
    if (ids.length < 2) continue;
    // Same-namespace duplicates are a narrower problem (usually one surface
    // reusing a label); this ratchet is about CROSS-surface disagreement.
    if (new Set(ids.map((i) => i.split(".")[0])).size < 2) continue;
    const zhValues = new Set(ids.map((i) => zh[i]));
    if (zhValues.size > 1) drift.set(text, [...zhValues].sort());
  }
  return drift;
}

test("no NEW English string renders as two different Chinese strings", () => {
  const drift = currentDrift();
  const known = new Set(KNOWN_DRIFT.map(([text]) => text));
  const added = [...drift.keys()].filter((t) => !known.has(t)).sort();
  assert.deepEqual(
    added, [],
    "These English strings now render as more than one Chinese string:\n"
      + added.map((t) => `  ${JSON.stringify(t)} -> ${drift.get(t)!.join(" / ")}`).join("\n")
      + "\n\nPick one translation. Do NOT add them to KNOWN_DRIFT to go green — that list is "
      + "the backlog being worked off, not a place to park new inconsistencies.",
  );
});

test("KNOWN_DRIFT contains no rows that are already fixed", () => {
  const drift = currentDrift();
  const stale = KNOWN_DRIFT.map(([text]) => text).filter((t) => !drift.has(t)).sort();
  assert.deepEqual(
    stale, [],
    "These rows no longer drift — delete them from KNOWN_DRIFT:\n" + stale.join("\n")
      + "\n\nA list that keeps resolved rows stops being evidence of anything.",
  );
});

test("the recorded Chinese variants still match reality", () => {
  // If a row still drifts but the VARIANTS changed, someone edited one side.
  // Silently tolerating that would let the list describe a state that no longer
  // exists while still passing.
  const drift = currentDrift();
  for (const [text, recorded] of KNOWN_DRIFT) {
    const actual = drift.get(text);
    if (!actual) continue; // covered by the staleness test above
    assert.deepEqual(
      actual, [...recorded],
      `${JSON.stringify(text)}: the Chinese variants changed since this row was frozen`,
    );
  }
});

test("the detector actually detects — it must not silently match nothing", () => {
  // A ratchet whose query returns an empty set passes forever. Pin that the
  // frozen backlog is non-empty and that the detector still finds it.
  assert.ok(KNOWN_DRIFT.length > 0, "the frozen backlog is empty");
  assert.ok(currentDrift().size > 0, "the detector found nothing at all — it is broken");
  // And a known-good row is genuinely multi-valued.
  for (const [, variants] of KNOWN_DRIFT) {
    assert.ok(variants.length > 1, "a KNOWN_DRIFT row records fewer than two variants");
  }
});
