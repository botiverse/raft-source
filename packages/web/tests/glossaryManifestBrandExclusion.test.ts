import assert from "node:assert/strict";
import test from "node:test";

import { assign, displayText, parseCatalog, stripBrand } from "../scripts/build-glossary-manifest.mjs";

// @沈括's ask: the brand exclusion must not be able to regress silently. The
// first manifest had no exclusion, counted `Raft Server` as the common noun,
// over-counted batch B by 13, and would have shipped `Raft 服务器`.
//
// The generator is checked in precisely so this rule has somewhere to be
// enforced — before, it existed only in a shell command, so nothing could stop
// the next regeneration from folding brand values back in.

test("a brand-only value never enters B-server", () => {
  const catalog = parseCatalog(
    '  "a": "配置此 Raft Server 的 MCP 目录、凭据和 provider 连接。"\n'
    + '  "b": "Raft Server 负责身份验证、刷新和远程 MCP 请求。"\n',
  );
  const { owner } = assign(catalog);
  assert.equal(owner.b, undefined, "a value whose only English is `Raft Server` must not be batched");
  // `a` still qualifies — but via provider (batch A), not via the brand Server.
  assert.equal(owner.a, "A-runtime-provider");
});

test("a bare server still lands in B-server", () => {
  const { owner } = assign(parseCatalog('  "c": "未找到可用于完成设置的 active server。"\n'));
  assert.equal(owner.c, "B-server", "the common noun must still be caught");
});

test("stripBrand removes only the brand form", () => {
  assert.equal(stripBrand("Raft Server 与 server"), " 与 server");
  assert.equal(stripBrand("Raft Computer 与 computer"), " 与 computer");
});

test("a value whose only server is inside a CLI command stays out of B-server", () => {
  // `agent.scopes.row.serverRead` is exactly this shape — the sole "server" is
  // in the `slock server info` command reference, which is code-like and stays
  // English. Without the CODE_LIKE exclusion the manifest can never reach 0
  // for batch B (same failure as the missing brand tooth).
  const { owner } = assign(parseCatalog('  "cmdOnly": "列出频道、成员（slock server info）。"\n'));
  assert.equal(owner.cmdOnly, undefined);
});

test("a real server next to a command reference still lands in B-server", () => {
  const { owner } = assign(parseCatalog('  "cmdAndReal": "运行 slock server info 查看此 server 的角色。"\n'));
  assert.equal(owner.cmdAndReal, "B-server");
});

test("kept-English Server forms never enter B-server", () => {
  // @AngLee 2026-08-03: feature proper nouns and out-of-glossary technical
  // compounds stay English — these two values are ruled no-change (or change
  // only the non-kept part) and must not pin batch B at non-zero forever.
  const { owner } = assign(parseCatalog(
    '  "a": "需先开启 Server Labs 访问权限"\n'
    + '  "b": "创建 Server attestation 失败"\n',
  ));
  assert.equal(owner.a, undefined);
  assert.equal(owner.b, undefined);
});

test("a bare server still lands in B-server even beside a kept form", () => {
  const { owner } = assign(parseCatalog('  "c": "创建 Server attestation 失败，请检查此 server 状态。"\n'));
  assert.equal(owner.c, "B-server");
});


// @Wug's blocker on 98e50715b. The first version of the placeholder fix masked
// `{...}` with a regex, which strips plural/select ARM BODIES as well as
// argument names — silently hiding real candidates that render to the user.
// Today's catalog happened to contain none, so nothing was missed; the rule was
// still wrong, and would have hidden the next one.
test("term matching sees plural/select arm text but not argument names", () => {
  const { owner } = assign(parseCatalog(
    '  "placeholderOnly": "{provider} 登录"\n'
    + '  "pluralAgent": "{count, plural, other {# 个 agent}}"\n'
    + '  "selectServer": "{k, select, other {连接到 server}}"\n'
    + '  "plain": "编辑 daemon 配置"\n',
  ));
  assert.equal(owner.placeholderOnly, undefined, "an argument NAME is an identifier, never a candidate");
  assert.equal(owner.pluralAgent, "D-agent-case", "a plural arm body renders to the user and must be matched");
  assert.equal(owner.selectServer, "B-server", "a select arm body renders to the user and must be matched");
  assert.equal(owner.plain, "C-daemon");
});

test("displayText keeps arm bodies and drops argument names", () => {
  assert.equal(displayText("{provider} 登录"), " 登录");
  // The `#` is an ICU pound node, not literal text, so it is dropped. Harmless
  // here: term matching cares about words, and no glossary term is "#".
  assert.equal(displayText("{count, plural, other {# 个 agent}}"), " 个 agent");
});
