import assert from "node:assert/strict";
import { z } from "zod";
import { appLinkBlockCardLayout, appLinkBlockCardPlaces, appLinkReadUrls } from "./appLinkPreview";
import {
  appLinkPreviewResponseSchema, appLinkPreviewRegistrationSchema, appLinkPreviewV2ResponseSchema, appLinkPreviewV3ResponseSchema, downgradeInlineBadgeTone, dropInvalidLinkCardBadgeColors,
  inlineBadgeDisplayTone, LINK_CARD_CAPABILITIES, LINK_CARD_INLINE_BADGE_TONES, LINK_CARD_LEGACY_INLINE_BADGE_TONES, linkCardBadgeColorsForCapabilities, linkCardInlineForCapabilities,
  linkCardInlineToneForCapabilities, linkCardExecuteActions, linkCardPlacementForCapabilities, linkCardV2Schema, matchesAppPreview, messageBareLinks, messagePreviewUrls, messageVisibleLinks,
  parseAppLinkPreviewV2, parseAppLinkPreviewV3, parseLinkCardReadAnswer, stripLinkCardActions, type AppLinkPreviewItem, type LinkCardActionTier, type LinkCardV2,
} from "./appLinkPreview";
import { parseActionCardSpec } from "./actionCardSpec";
import { parseMessageCard } from "./messageCard";

test("preview callbacks only use visible links, not code, images, unused definitions or credentials", () => {
  assert.deepEqual(messagePreviewUrls('`https://code.example/x` ![img](https://img.example/x) [PR](https://app.example/pr/1)\n\n[unused]: https://unused.example/x\n\nhttps://app.example/pr/1 https://u:p@app.example/x https://app.example/x#secret'), ['https://app.example/pr/1']);
  assert.deepEqual(messagePreviewUrls('[https://app.example/pr/2][id]\n\n[id]: https://app.example/pr/2'), ['https://app.example/pr/2']);
  const twenty = Array.from({ length: 20 }, (_, i) => `https://app.example/pr/${i}`);
  assert.equal(messagePreviewUrls(twenty.join(' ')).length, 3);
  // The batched link-card read takes ten, deduplicated in message order (addendum 2 §5).
  assert.deepEqual(messagePreviewUrls([twenty[1], twenty[0], twenty[1], 'https://app.example:443/pr/0', ...twenty.slice(2)].join(' '), 10), [twenty[1], twenty[0], ...twenty.slice(2, 10)], 'an explicit :443 is the same link');
});
// Only a bare link can become the App's chip (protocol v3.2.3 addendum 5 §1):
// a link the author gave words to is never sent to the App nor asked about.
test("preview callbacks only use bare links, whose text is their own address", () => {
  assert.deepEqual(messagePreviewUrls('[my fix](https://app.example/pr/1) and [PR][id] and [**PR**](https://app.example/pr/3)\n\n[id]: https://app.example/pr/2'), []);
  assert.deepEqual(messagePreviewUrls('<https://app.example/pr/4> [https://app.example/pr/5](https://app.example/pr/5) https://app.example/pr/6'),
    ['https://app.example/pr/4', 'https://app.example/pr/5', 'https://app.example/pr/6']);
  // Text that is another address is not bare either: it would show one link and preview another.
  assert.deepEqual(messagePreviewUrls('[https://app.example/pr/7](https://app.example/pr/8)'), []);
  // Markup in the text: the web shows the author's link, not a chip.
  assert.deepEqual(messagePreviewUrls('[<b>https://app.example/pr/9</b>](https://app.example/pr/9)'), []);
});
// The web's one extraction per message for link cards (useMessageLinkCards):
// the same visible, bare links, without the public-HTTPS filter only an App's
// callback needs, so Raft's own links on a dev or self-hosted host still count.
test("bare links: the preview rules without the public-HTTPS filter; no limit", () => {
  const text = '`https://code.example/x` ![img](https://img.example/x) [named](https://app.example/pr/1) https://app.example/pr/1 '
    + 'http://localhost:5173/artifacts/pt_dev https://raft.example.com:8443/artifacts/pt_x https://app.example:443/pr/1 mailto:x@example.com';
  assert.deepEqual(messageBareLinks(text), ['https://app.example/pr/1', 'http://localhost:5173/artifacts/pt_dev', 'https://raft.example.com:8443/artifacts/pt_x']);
  assert.deepEqual(messagePreviewUrls(text, 10), ['https://app.example/pr/1'], 'the preview read still takes only public HTTPS links');
  const twenty = Array.from({ length: 20 }, (_, i) => `https://app.example/pr/${i}`);
  assert.equal(messageBareLinks(twenty.join(' ')).length, 20);
  assert.deepEqual(messageBareLinks('[https://app.example/pr/7](https://app.example/pr/8) [<b>https://app.example/pr/9</b>](https://app.example/pr/9)'), []);
});
test("visible links (#proj-workspace:#289): bare and labelled, once each in message order, bare when written both ways; code and images don't count", () => {
  const text = '`https://code.example/x` ![img](https://img.example/x) [the plan](https://raft.example/artifacts/pt_a) https://app.example/pr/1 '
    + '[again](https://app.example/pr/1) [only words](https://raft.example/artifacts/pt_b) mailto:x@example.com';
  assert.deepEqual(messageVisibleLinks(text), [
    { href: 'https://raft.example/artifacts/pt_a', bare: false },
    { href: 'https://app.example/pr/1', bare: true },
    { href: 'https://raft.example/artifacts/pt_b', bare: false },
  ]);
  assert.deepEqual(messageBareLinks(text), ['https://app.example/pr/1'], 'the bare list is unchanged');
});
test("#triage:#351: a link whose destination isn't a URL is skipped, never thrown (a labelled one, a bare-looking one, a reference)", () => {
  // Each of these is a Markdown link node whose destination `new URL` refuses.
  const text = '[y](<https://a b>) [z][ref] [w](https://[::1) https://app.example/pr/1\n\n[ref]: <https://x y>';
  assert.doesNotThrow(() => messageVisibleLinks(text));
  assert.deepEqual(messageVisibleLinks(text), [{ href: 'https://app.example/pr/1', bare: true }]);
  assert.deepEqual(messageBareLinks(text), ['https://app.example/pr/1']);
  assert.deepEqual(messagePreviewUrls(text), ['https://app.example/pr/1']);
  assert.doesNotThrow(() => appLinkBlockCardLayout(text));
});
test("origin and segment matching cannot capture lookalike domains or sibling prefixes", () => {
  const config = appLinkPreviewRegistrationSchema.parse({ origin: 'https://app.example', endpoint: 'https://app.example/preview', paths: ['/pr'] });
  assert.ok(matchesAppPreview('https://app.example/pr/1', config));
  for (const value of ['https://app.example.evil.test/pr/1','https://app.example/private','http://app.example/pr/1']) assert.equal(matchesAppPreview(value, config), false);
  assert.equal(appLinkPreviewRegistrationSchema.safeParse({ ...config, endpoint: 'https://other.example/callback' }).success, false);
});
test("an action endpoint follows the callback's rules: same origin, public HTTPS, no query", () => {
  const base = { origin: 'https://app.example', endpoint: 'https://app.example/preview', paths: ['/pr'] };
  assert.equal(appLinkPreviewRegistrationSchema.parse({ ...base, action_endpoint: 'https://app.example/card-actions' }).action_endpoint, 'https://app.example/card-actions');
  assert.equal(appLinkPreviewRegistrationSchema.parse({ ...base, action_endpoint: null }).action_endpoint, null);
  assert.equal(appLinkPreviewRegistrationSchema.parse(base).action_endpoint, undefined);
  for (const action_endpoint of ['https://other.example/card-actions', 'http://app.example/card-actions', 'https://app.example/card-actions?x=1', 'https://app.example:8443/a', 'https://u:p@app.example/a', '']) {
    assert.equal(appLinkPreviewRegistrationSchema.safeParse({ ...base, action_endpoint }).success, false, action_endpoint);
  }
});
test("declared preview versions: only 1, 2 and 3, version 1 always among them, 3 only with 2, no repeats", () => {
  const base = { origin: 'https://app.example', endpoint: 'https://app.example/preview', paths: ['/pr'] };
  assert.equal(appLinkPreviewRegistrationSchema.parse(base).preview_versions, undefined);
  for (const preview_versions of [[1], [1, 2], [2, 1], [1, 2, 3], [3, 2, 1]]) {
    assert.deepEqual(appLinkPreviewRegistrationSchema.parse({ ...base, preview_versions }).preview_versions, preview_versions);
  }
  for (const preview_versions of [[], [0], [4], [1, 4], [2], [2, 3], [1, 3], [3, 1], [1, 1], [1, 2, 2], [1.5], ['1'], [null], null, 1, '1,2', { 0: 1 }]) {
    assert.equal(appLinkPreviewRegistrationSchema.safeParse({ ...base, preview_versions }).success, false, JSON.stringify(preview_versions));
  }
});
test("read-only catalog rejects scripts, dynamic expressions, actions and malformed trees", () => {
  const valid = { version: 1, title: '<script>literal</script>', card: { root: 'root', elements: { root: { type: 'Stack', props: {}, children: ['text'] }, text: { type: 'Text', props: { text: 'Ready' } } } } };
  assert.ok(appLinkPreviewResponseSchema.safeParse(valid).success);
  const invalid = [
    { ...valid, card: { ...valid.card, state: { secret: 'no' } } },
    { ...valid, card: { root: 'text', elements: { text: { type: 'Text', props: { text: { $state: '/secret' } } } } } },
    { ...valid, card: { root: 'text', elements: { text: { type: 'Text', props: { text: 'x' }, on: { press: { action: 'fetch' } } } } } },
    { ...valid, card: { root: 'x', elements: { x: { type: 'Stack', props: {}, children: ['x'] } } } },
    { ...valid, card: { root: 'x', elements: { x: { type: 'iframe', props: { src: 'https://evil.test' } } } } },
    { ...valid, card: { root: 'root', elements: { root: { type: 'Stack', props: {}, children: ['missing'] } } } },
  ];
  for (const value of invalid) assert.equal(appLinkPreviewResponseSchema.safeParse(value).success, false);
});

// Version 2: interactive link cards (RFC 076; protocol v3.2.3 §4.3, §4.4).
const origin = 'https://cards.example';
const v2Card = (elements: Record<string, unknown>, children = Object.keys(elements)) => ({
  version: 2, display: 'card', title: 'PR #12 is ready', card_revision: 'cr-1', business_revision: 'br-1',
  card: { root: 'root', elements: { root: { type: 'Stack', props: {}, children }, ...elements } },
});
const approve = { type: 'Button', props: { label: 'Approve', action: { kind: 'execute', action_id: 'approve', undoWindowMs: 5000 } } };
const merge = { type: 'Button', props: { label: 'Merge', action: { kind: 'execute', action_id: 'merge', confirm: 'prepare' } } };
const open = { type: 'Button', props: { label: 'Open', variant: 'ghost', action: { kind: 'navigate', url: `${origin}/pr/12` } } };
const refresh = { type: 'Button', props: { label: 'Refresh', action: { kind: 'read' } } };

test("v2 answers choose how the link shows: plain link, a connect prompt on the origin, or a card", () => {
  assert.deepEqual(parseAppLinkPreviewV2({ version: 2, display: 'link' }, origin), { version: 2, display: 'link' });
  assert.ok(parseAppLinkPreviewV2({ version: 2, display: 'connect_account', connect_url: `${origin}/s/team/auth/github` }, origin));
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'connect_account', connect_url: 'https://elsewhere.example/auth' }, origin), null);
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'connect_account', connect_url: `${origin}/auth`, title: 'Connect' }, origin), null, 'the App supplies no text');
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'link', title: 'x' }, origin), null);
  assert.equal(parseAppLinkPreviewV2({ version: 1, title: 'x' }, origin), null);
  const card = parseAppLinkPreviewV2(v2Card({ approve, merge, open, refresh, at: { type: 'RelativeTime', props: { at: '2026-10-21T08:15:30Z' } },
    ci: { type: 'Duration', props: { start: '2026-10-21T08:00:00Z' } }, state: { type: 'Badge', props: { text: 'Open' } },
    note: { type: 'Text', props: { text: 'Checks running', tone: 'warning' } } }), origin);
  assert.ok(card && card.display === 'card');
  assert.equal((card.card.elements.state as { props: { tone: string } }).props.tone, 'neutral', 'Badge tone defaults to neutral');
  assert.equal((card.card.elements.approve as { props: { variant: string } }).props.variant, 'default', 'Button variant defaults to default');
  assert.equal(parseAppLinkPreviewV2(v2Card({ open: { ...open, props: { ...open.props, action: { kind: 'navigate', url: 'https://evil.example/x' } } } }), origin), null, 'navigate stays on the origin');
});

test("v2 buttons: exactly one of confirm / undo, named ids, at most four, no inputs", () => {
  const ok = (elements: Record<string, unknown>) => appLinkPreviewV2ResponseSchema.safeParse(v2Card(elements)).success;
  assert.ok(ok({ approve, merge, open, refresh }));
  assert.equal(ok({ a: approve, b: merge, c: open, d: refresh, e: { ...open } }), false, 'at most 4 buttons');
  assert.equal(ok({ a: approve, b: { ...approve, props: { ...approve.props, label: 'Again' } } }), false, 'execute ids are unique');
  const action = (value: unknown) => ok({ x: { type: 'Button', props: { label: 'X', action: value } } });
  assert.equal(action({ kind: 'execute', action_id: 'x', confirm: 'prepare', undoWindowMs: 5000 }), false);
  assert.equal(action({ kind: 'execute', action_id: 'x' }), false);
  assert.equal(action({ kind: 'execute', action_id: 'x', undoWindowMs: 999 }), false);
  assert.equal(action({ kind: 'execute', action_id: 'x', undoWindowMs: 10001 }), false);
  assert.equal(action({ kind: 'execute', action_id: 'Merge', confirm: 'prepare' }), false);
  assert.equal(action({ kind: 'read', action_id: 'refresh' }), false, 'a refresh has no action id');
  assert.equal(action({ kind: 'navigate', url: 'http://cards.example/x' }), false);
  assert.equal(ok({ x: { type: 'Input', props: { name: 'reason' } } }), false, 'no input controls');
  assert.equal(ok({ x: { type: 'Button', props: { label: 'X', action: { kind: 'read' }, params: { a: 1 } } } }), false);
});

test("v2 text counts code points and timestamps are real RFC 3339 UTC dates", () => {
  const badge = (text: string) => appLinkPreviewV2ResponseSchema.safeParse(v2Card({ b: { type: 'Badge', props: { text } } })).success;
  assert.ok(badge('😀'.repeat(60)), '60 code points, 120 UTF-16 units');
  assert.equal(badge('😀'.repeat(61)), false);
  const at = (value: string) => appLinkPreviewV2ResponseSchema.safeParse(v2Card({ t: { type: 'RelativeTime', props: { at: value } } })).success;
  assert.ok(at('2024-02-29T23:59:59.5Z'));
  for (const bad of ['2026-02-29T00:00:00Z', '2026-10-21T08:15:30+08:00', '2026-10-21T24:00:00Z', 'yesterday']) assert.equal(at(bad), false, bad);
  const duration = (props: unknown) => appLinkPreviewV2ResponseSchema.safeParse(v2Card({ d: { type: 'Duration', props } })).success;
  assert.ok(duration({ start: '2026-10-21T08:00:00Z' }), 'still running');
  assert.ok(duration({ start: '2026-10-21T08:00:00Z', end: '2026-10-21T08:04:10Z' }));
  assert.equal(duration({ start: '2026-10-21T08:00:00Z', end: '2026-10-21T07:59:59Z' }), false, 'cannot end before it starts');
});

test("stripping: the provider's tier and the client's capabilities decide the buttons; disabled actions get no handle", () => {
  const parsed = parseAppLinkPreviewV2(v2Card({ approve, merge, open, refresh }), origin);
  assert.ok(parsed && parsed.display === 'card');
  const all = ['card.v2', 'button.v1', 'confirm.v1', 'undo.v1'];
  const ids = (card: LinkCardV2) => Object.keys(card.elements).sort();
  const strip = (tier: LinkCardActionTier, capabilities: string[]) => ids(stripLinkCardActions(parsed.card, { tier, capabilities }));
  // Addendum 4 §2: not official -> navigate only; official without an approved
  // endpoint in force, or suspended -> navigate and read; official with one -> all.
  assert.deepEqual(strip('execute', all), ['approve', 'merge', 'open', 'refresh', 'root']);
  assert.deepEqual(strip('read', all), ['open', 'refresh', 'root']);
  const navigateOnly = stripLinkCardActions(parsed.card, { tier: 'navigate', capabilities: all });
  assert.deepEqual(ids(navigateOnly), ['open', 'root'], 'even the refresh button goes (Tenny 90cf59b3 #5)');
  assert.deepEqual((navigateOnly.elements.root as { children: string[] }).children, ['open'], 'stripped buttons leave the tree');
  assert.deepEqual(strip('execute', ['card.v2', 'button.v1', 'undo.v1']), ['approve', 'open', 'refresh', 'root']);
  assert.deepEqual(strip('execute', ['card.v2', 'button.v1', 'confirm.v1']), ['merge', 'open', 'refresh', 'root']);
  for (const tier of ['navigate', 'read', 'execute'] as const) assert.deepEqual(strip(tier, ['card.v2']), ['root'], `no button.v1, no buttons (${tier})`);
  assert.ok(linkCardV2Schema.safeParse(navigateOnly).success, 'a stripped card is still a valid card');

  assert.deepEqual(linkCardExecuteActions(parsed.card).map((a) => [a.actionId, a.requiresPrepare]), [['approve', false], ['merge', true]]);
  const disabled = parseAppLinkPreviewV2(v2Card({ merge: { ...merge, props: { ...merge.props, disabledReason: 'Checks are still running' } }, approve }), origin);
  assert.ok(disabled && disabled.display === 'card');
  assert.deepEqual(linkCardExecuteActions(disabled.card).map((a) => a.actionId), ['approve'], 'a disabled action is shown but gets no handle');
  assert.deepEqual(ids(stripLinkCardActions(disabled.card, { tier: 'execute', capabilities: all })), ['approve', 'merge', 'root'], 'and it stays visible');
});

test("capabilities: four plus inline.v1, inline.tone.v2, block.v1, preview.v3, badge.color.v1 and unreviewed_app.v1; relative_time.v1 is gone (addendum 1 §2, addendum 2 §3, addenda 6 and 7, RFC 076 §15, §17)", () => {
  assert.deepEqual([...LINK_CARD_CAPABILITIES], ['card.v2', 'button.v1', 'confirm.v1', 'undo.v1', 'inline.v1', 'inline.tone.v2', 'block.v1', 'preview.v3', 'badge.color.v1', 'unreviewed_app.v1']);
});

test("placement: a card answer may ask for a block; any other value, or placement on link / connect_account, is invalid (addendum 6; RFC 076 §13)", () => {
  const placed = (value: unknown, extra: object = {}) => parseAppLinkPreviewV2({ ...v2Card({ open }), ...extra, placement: value }, origin);
  const block = placed('block');
  assert.ok(block && block.display === 'card');
  assert.equal(block.placement, 'block');
  const chip = parseAppLinkPreviewV2(v2Card({ open }), origin);
  assert.ok(chip && chip.display === 'card' && !('placement' in chip), 'absent: the inline chip, no default added');
  const both = placed('block', { inline: { title: 'o/r#1' } });
  assert.ok(both && both.display === 'card' && both.placement === 'block' && both.inline?.title === 'o/r#1', 'with an inline label too');
  // Any other value makes the whole answer invalid: the client shows the plain link.
  for (const bad of ['inline', 'chip', 'Block', 'BLOCK', ' block', 'block ', 'block.v1', '', null, true, 1, ['block'], { kind: 'block' }]) {
    assert.equal(placed(bad), null, JSON.stringify(bad));
    assert.equal(appLinkPreviewV2ResponseSchema.safeParse({ ...v2Card({ open }), placement: bad }).success, false, JSON.stringify(bad));
  }
  // Only a card answer carries one: on link or connect_account, or without the card, it is invalid.
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'link', placement: 'block' }, origin), null);
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'connect_account', connect_url: `${origin}/auth`, placement: 'block' }, origin), null);
  const { card: _card, ...noCard } = v2Card({ open });
  assert.equal(parseAppLinkPreviewV2({ ...noCard, placement: 'block' }, origin), null, 'placement alone');
  // v1 never carries it (old web clients strict-parse v1).
  assert.equal(appLinkPreviewResponseSchema.safeParse({ version: 1, title: 'x', placement: 'block' }).success, false);
  // Raft keeps it only for a client that declared block.v1.
  assert.equal(linkCardPlacementForCapabilities('block', ['card.v2', 'button.v1', 'block.v1']), 'block');
  assert.equal(linkCardPlacementForCapabilities('block', ['card.v2', 'button.v1', 'confirm.v1', 'undo.v1', 'inline.v1', 'inline.tone.v2']), undefined, 'no block.v1: no placement');
  assert.equal(linkCardPlacementForCapabilities(undefined, ['block.v1']), undefined, 'none asked for: none given');
});

test("inline: a card answer may add a strict title + badge label; nothing else may carry one (addendum 2 §2)", () => {
  const inline = (value: unknown) => parseAppLinkPreviewV2({ ...v2Card({ open }), inline: value }, origin);
  const parsed = inline({ title: 'botiverse/stamp#1497', badge: { text: 'Merged', tone: 'success' } });
  assert.ok(parsed && parsed.display === 'card');
  assert.deepEqual(parsed.inline, { title: 'botiverse/stamp#1497', badge: { text: 'Merged', tone: 'success' } });
  const defaulted = inline({ title: 'PR', badge: { text: 'Open' } });
  assert.ok(defaulted && defaulted.display === 'card');
  assert.deepEqual(defaulted.inline, { title: 'PR', badge: { text: 'Open', tone: 'neutral' } }, 'tone defaults to neutral');
  const titleOnly = inline({ title: '😀'.repeat(80) });
  assert.ok(titleOnly && titleOnly.display === 'card' && titleOnly.inline && !('badge' in titleOnly.inline), 'title 80 code points, no badge');
  assert.ok(inline({ title: 'x', badge: { text: '😀'.repeat(24) } }), 'badge text 24 code points');
  // I5 and friends: any of these makes the whole answer invalid.
  for (const [bad, why] of [
    [{ title: '' }, 'empty title'], [{ title: 'x'.repeat(81) }, 'title over 80'], [{}, 'no title'],
    [{ title: 'x', badge: { text: 'x'.repeat(25) } }, 'badge over 24'], [{ title: 'x', badge: { text: '' } }, 'empty badge'],
    [{ title: 'x', badge: { text: 'x', tone: '#ff0000' } }, 'a colour'], [{ title: 'x', badge: { text: 'x', tone: 'green' } }, 'an unknown tone'],
    [{ title: 'x', badge: { text: 'x', color: 'red' } }, 'extra badge field'], [{ title: 'x', icon: 'https://cards.example/i.png' }, 'extra field'],
    // A card Badge may carry a colour (RFC 076 §15); the inline badge may not, a valid one included.
    [{ title: 'x', badge: { text: 'x', color: '#8250df' } }, 'a colour on the inline badge'],
    [{ title: 1 }, 'a number'], [{ title: 'x', badge: { text: 3 } }, 'a number in the badge'], [{ title: 'x', badge: 'Merged' }, 'badge as a string'],
    [{ title: 'x', actions: [{ kind: 'read' }] }, 'actions'], ['title', 'not an object'], [null, 'null'],
  ] as const) assert.equal(inline(bad), null, why);
  // The badge takes the card's tones and still the first two words, success and danger.
  for (const tone of [...LINK_CARD_INLINE_BADGE_TONES]) {
    const parsed = inline({ title: 'x', badge: { text: 'x', tone } });
    assert.ok(parsed && parsed.display === 'card' && parsed.inline?.badge?.tone === tone, `inline badge tone ${tone}`);
  }
  assert.deepEqual([...LINK_CARD_INLINE_BADGE_TONES], ['neutral', 'review', 'progress', 'warning', 'action', 'done', 'closed', 'success', 'danger']);
  assert.equal(inlineBadgeDisplayTone('success'), 'done');
  assert.equal(inlineBadgeDisplayTone('danger'), 'closed');
  for (const tone of ['neutral', 'review', 'progress', 'warning', 'action', 'done', 'closed'] as const) assert.equal(inlineBadgeDisplayTone(tone), tone);
  // An older client (inline.v1 without inline.tone.v2) checks the tone against the first four, strictly:
  // what Raft hands it must pass that check, with the word it got before (by meaning).
  const olderClientInline = z.object({
    title: z.string(), badge: z.object({ text: z.string(), tone: z.enum(['neutral', 'success', 'warning', 'danger']).default('neutral') }).strict().optional(),
  }).strict();
  const byMeaning: Record<string, string> = { done: 'success', action: 'success', success: 'success', warning: 'warning', danger: 'danger', closed: 'neutral', progress: 'neutral', review: 'neutral', neutral: 'neutral' };
  for (const tone of [...LINK_CARD_INLINE_BADGE_TONES]) {
    const shown = linkCardInlineForCapabilities({ title: 'x', badge: { text: 'x', tone } }, ['card.v2', 'inline.v1']);
    assert.ok(olderClientInline.safeParse(shown).success, `an older client reads ${tone}`);
    assert.equal(shown?.badge?.tone, byMeaning[tone], `${tone} downgrades by meaning`);
    assert.equal(downgradeInlineBadgeTone(tone), byMeaning[tone]);
    assert.deepEqual(linkCardInlineForCapabilities({ title: 'x', badge: { text: 'x', tone } }, ['card.v2', 'inline.v1', 'inline.tone.v2'])?.badge?.tone, tone, `${tone} kept for inline.tone.v2`);
  }
  for (const tone of [...LINK_CARD_LEGACY_INLINE_BADGE_TONES]) assert.equal(downgradeInlineBadgeTone(tone), tone, `${tone}: an older client's word does not change`);
  assert.equal(linkCardInlineForCapabilities({ title: 'x' }, ['card.v2']), undefined, 'no inline.v1: no inline');
  assert.deepEqual(linkCardInlineForCapabilities({ title: 'x' }, ['inline.v1']), { title: 'x' }, 'no badge: unchanged');
  // I4 / I6: inline without a card, or on link / connect_account, is invalid.
  const { card: _card, ...noCard } = v2Card({ open });
  assert.equal(parseAppLinkPreviewV2({ ...noCard, inline: { title: 'x' } }, origin), null, 'inline alone');
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'link', inline: { title: 'x' } }, origin), null);
  assert.equal(parseAppLinkPreviewV2({ version: 2, display: 'connect_account', connect_url: `${origin}/auth`, inline: { title: 'x' } }, origin), null);
  // v1 never carries it (old web clients strict-parse v1).
  assert.equal(appLinkPreviewResponseSchema.safeParse({ version: 1, title: 'x', inline: { title: 'x' } }).success, false);
});

// Version 3: an ordered list of items (RFC 076 §14; protocol addendum 7).
const v3Card = (placement: unknown = 'hover', extra: object = {}) => {
  const { version: _version, display: _display, ...card } = v2Card({ open, approve });
  return { type: 'card', placement, ...card, ...extra };
};
const v3 = (...items: unknown[]) => ({ version: 3, items });

test("v3 answers: each item type is accepted, alone or together, in the App's order; [] is the plain link", () => {
  const inline = { type: 'inline', title: 'botiverse/stamp#1497', badge: { text: 'Merged', tone: 'success' } };
  const connect = { type: 'connect_account', connect_url: `${origin}/s/team/auth/github` };
  assert.deepEqual(parseAppLinkPreviewV3(v3(), origin), { version: 3, items: [] });
  assert.deepEqual(parseAppLinkPreviewV3(v3(inline), origin)?.items, [inline], 'a chip with no card: version 2 can\'t write it');
  assert.deepEqual(parseAppLinkPreviewV3(v3({ type: 'inline', title: 'PR', badge: { text: 'Open' } }), origin)?.items, [{ type: 'inline', title: 'PR', badge: { text: 'Open', tone: 'neutral' } }],
    'exactly version 2\'s inline: the tone defaults to neutral');
  assert.deepEqual(parseAppLinkPreviewV3(v3(connect), origin)?.items, [connect]);
  for (const placement of ['block', 'hover']) {
    const parsed = parseAppLinkPreviewV3(v3(inline, v3Card(placement)), origin);
    assert.ok(parsed, placement);
    assert.deepEqual(parsed.items.map((item) => item.type), ['inline', 'card']);
    const card = parsed.items[1]!;
    assert.ok(card.type === 'card');
    assert.equal(card.placement, placement);
    assert.deepEqual([card.title, card.card_revision, card.business_revision], ['PR #12 is ready', 'cr-1', 'br-1'], 'the card carries its own title and revisions');
    assert.equal((card.card.elements.approve as { props: { variant: string } }).props.variant, 'default', 'the card tree is version 2\'s, schema defaults and all');
  }
  assert.deepEqual(parseAppLinkPreviewV3(v3(v3Card('block'), inline), origin)?.items.map((item) => item.type), ['card', 'inline'], 'the App\'s order is kept');
  assert.equal(parseAppLinkPreviewV3(v3({ ...inline, title: 'x'.repeat(81) }), origin), null, 'inline: title 1-80 as in version 2');
  assert.equal(parseAppLinkPreviewV3(v3({ ...inline, badge: { text: 'x', tone: '#ff0000' } }), origin), null, 'inline: no colours');
  assert.equal(parseAppLinkPreviewV3(v3(v3Card('hover', { title: '' })), origin), null, 'card: title 1-160');
  assert.equal(parseAppLinkPreviewV3(v3(v3Card('hover', { card_revision: '' })), origin), null, 'card: a revision');
  assert.equal(parseAppLinkPreviewV3(v3(v3Card('hover', { card: { root: 'x', elements: { x: { type: 'Input', props: {} } } } })), origin), null, 'card: version 2\'s catalog');
});

test("v3 answers: a second inline or card, connect_account beside another item, a card without placement or with another value, more than 8 items, a non-object item, a bad type or an unknown field in a known item are refused", () => {
  const inline = { type: 'inline', title: 'PR' };
  const connect = { type: 'connect_account', connect_url: `${origin}/auth` };
  const refused: [unknown, string][] = [
    [v3(inline, inline), 'a second inline'], [v3(v3Card(), v3Card('block')), 'a second card'],
    [v3(connect, v3Card()), 'connect_account beside a card'], [v3(inline, connect), 'connect_account beside an inline'], [v3(connect, connect), 'two connect_account'],
    [v3((({ placement: _placement, ...card }) => card)(v3Card())), 'a card without placement'],
    ...['inline', 'chip', 'Block', 'HOVER', ' block', '', null, 1, ['block']].map((placement): [unknown, string] => [v3(v3Card(placement)), `placement ${JSON.stringify(placement)}`]),
    [v3(...Array.from({ length: 9 }, (_, i) => ({ type: `future.item_${i}` }))), 'more than 8 items, even of unknown types'],
    [v3('inline'), 'a string item'], [v3(null), 'a null item'], [v3(['inline']), 'an array item'], [v3(7), 'a number item'],
    [v3({ title: 'PR' }), 'no type'], [v3({ type: 1 }), 'a number type'], [v3({ type: '' }), 'an empty type'], [v3({ type: 'x'.repeat(33) }), 'a type over 32'],
    [v3({ type: 'Inline', title: 'PR' }), 'an upper-case type'], [v3({ type: 'future-item' }), 'a type with -'], [v3({ type: 'future item' }), 'a type with a space'],
    [v3({ ...inline, icon: `${origin}/i.png` }), 'an unknown field in inline'], [v3(v3Card('hover', { inline: { title: 'x' } })), 'an unknown field in card'],
    [v3({ ...connect, title: 'Connect' }), 'an unknown field in connect_account: the App supplies no text'],
    [v3(JSON.parse(`{"type":"inline","title":"PR","__proto__":{"x":1}}`)), 'a __proto__ key in a known item is an unknown field'],
    [{ ...v3(inline), display: 'card' }, 'an unknown top-level field'], [{ version: 3 }, 'no items'], [{ version: 3, items: {} }, 'items not a list'],
    [{ version: 2, items: [inline] }, 'version 2 with items'], [v2Card({ open }), 'a version 2 answer'],
  ];
  for (const [answer, why] of refused) {
    assert.equal(appLinkPreviewV3ResponseSchema.safeParse(answer).success, false, why);
    assert.equal(parseAppLinkPreviewV3(answer, origin), null, why);
  }
  assert.ok(parseAppLinkPreviewV3(v3(...Array.from({ length: 6 }, (_, i) => ({ type: `future.item_${i}` })), inline, v3Card()), origin), 'eight items are fine');
  // The origin check, as version 2's.
  assert.equal(parseAppLinkPreviewV3(v3({ ...connect, connect_url: 'https://elsewhere.example/auth' }), origin), null, 'connect URL off the origin');
  assert.equal(parseAppLinkPreviewV3(v3(v3Card('hover', { card: { root: 'b', elements: { b: { ...open, props: { ...open.props, action: { kind: 'navigate', url: 'https://elsewhere.example/x' } } } } } })), origin),
    null, 'navigate URL off the origin');
});

test("v3 answers: an item of an unknown type is dropped, not refused, and the rest stands", () => {
  const inline = { type: 'inline', title: 'PR' };
  const future = { type: 'future.gallery_v2', images: [{ src: 'https://elsewhere.example/a.png' }], anything: { goes: true } };
  const parsed = parseAppLinkPreviewV3(v3(future, inline, { type: 'x' }, v3Card('block'), { type: '0.9_z' }), origin);
  assert.ok(parsed);
  assert.deepEqual(parsed.items.map((item) => item.type), ['inline', 'card'], 'only the known items, in order');
  assert.deepEqual(parseAppLinkPreviewV3(v3(future), origin), { version: 3, items: [] }, 'nothing known: the plain link');
  assert.deepEqual(parseAppLinkPreviewV3(v3(future, { type: 'connect_account', connect_url: `${origin}/auth` }), origin)?.items.map((item) => item.type), ['connect_account'],
    'connect_account is the only known item');
  assert.equal(parseAppLinkPreviewV3(v3(future, inline, inline), origin), null, 'dropping one never excuses the rest');
  // Inline tones for a version 3 client: downgraded without inline.tone.v2, the item's type kept.
  const toned = { type: 'inline' as const, title: 'PR', badge: { text: 'Merged', tone: 'done' as const } };
  assert.deepEqual(linkCardInlineToneForCapabilities(toned, ['card.v2', 'preview.v3']), { ...toned, badge: { text: 'Merged', tone: 'success' } });
  assert.equal(linkCardInlineToneForCapabilities(toned, ['card.v2', 'preview.v3', 'inline.tone.v2']), toned);
  // Version 2 is unchanged: no hover placement, no items.
  assert.equal(parseAppLinkPreviewV2({ ...v2Card({ open }), placement: 'hover' }, origin), null, 'version 2 placement is still only block');
  assert.equal(parseAppLinkPreviewV2(v3(inline), origin), null);
});

// Card Badge colours (RFC 076 §15; #proj-apps:#51). Only a link card's Badge
// element takes one; the inline badge doesn't (Tenny, #51 0658886f).
const colored = (color: unknown) => ({ type: 'Badge', props: { text: 'Merged', tone: 'done', color } });

test("badge colour: #RRGGBB in either case on a link card Badge, read as lowercase, version 2 and 3; tone keeps its default; anything else is refused by the schema, and so is a colour anywhere but a card Badge", () => {
  for (const [sent, read] of [['#8250df', '#8250df'], ['#8250DF', '#8250df'], ['#AbCdEf', '#abcdef'], ['#000000', '#000000'], ['#FFFFFF', '#ffffff']] as const) {
    const v2 = parseAppLinkPreviewV2(v2Card({ state: colored(sent) }), origin);
    assert.ok(v2 && v2.display === 'card', sent);
    assert.deepEqual(v2.card.elements.state, { type: 'Badge', props: { text: 'Merged', tone: 'done', color: read } }, sent);
    const v3Answer = parseAppLinkPreviewV3(v3(v3Card('hover', { card: v2Card({ state: colored(sent) }).card })), origin);
    assert.ok(v3Answer?.items[0]?.type === 'card', sent);
    assert.deepEqual(v3Answer.items[0].card.elements.state, { type: 'Badge', props: { text: 'Merged', tone: 'done', color: read } }, `version 3 ${sent}`);
  }
  // `tone` is still the meaning and keeps its default: a colour never replaces it.
  const untoned = parseAppLinkPreviewV2(v2Card({ state: { type: 'Badge', props: { text: 'Merged', color: '#8250df' } } }), origin);
  assert.ok(untoned && untoned.display === 'card');
  assert.deepEqual(untoned.card.elements.state, { type: 'Badge', props: { text: 'Merged', tone: 'neutral', color: '#8250df' } });
  // The schema is strict, as every client that reads Raft's answer is: an invalid colour refuses it there.
  for (const bad of ['#8250d', '#8250dff', '#8250df80', '8250df', '#82 50df', ' #8250df', '#8250df ', '#GGGGGG', '#fff', 'red', 'rgb(0,0,0)', '', null, 8540383, true, ['#8250df'], { hex: '#8250df' }]) {
    assert.equal(parseAppLinkPreviewV2(v2Card({ state: colored(bad) }), origin), null, JSON.stringify(bad));
  }
  // Only a card Badge: no other element, the inline label or its badge, or a version 1 Badge.
  assert.equal(parseAppLinkPreviewV2(v2Card({ note: { type: 'Text', props: { text: 'x', color: '#8250df' } } }), origin), null, 'Text');
  assert.equal(parseAppLinkPreviewV2(v2Card({ open: { ...open, props: { ...open.props, color: '#8250df' } } }), origin), null, 'Button');
  assert.equal(parseAppLinkPreviewV2({ ...v2Card({ open }), inline: { title: 'x', badge: { text: 'Merged', color: '#8250df' } } }, origin), null, 'the inline badge');
  assert.equal(parseAppLinkPreviewV3(v3({ type: 'inline', title: 'x', badge: { text: 'Merged', color: '#8250df' } }), origin), null, 'a version 3 inline badge');
  assert.equal(appLinkPreviewResponseSchema.safeParse({ version: 1, title: 'x', card: { root: 'b', elements: { b: { type: 'Badge', props: { text: 'x', color: '#8250df' } } } } }).success, false, 'version 1');
});

test("badge colour: an invalid one is dropped from the App's answer before the schema reads it, so the card stays; valid colours, the inline badge, other elements and other errors are left alone", () => {
  const raw = v2Card({ good: colored('#8250DF'), bad: colored('purple'), worse: colored(null), plain: { type: 'Badge', props: { text: 'Open' } }, open });
  const frozen = JSON.stringify(raw);
  const { answer, dropped } = dropInvalidLinkCardBadgeColors(raw);
  assert.equal(dropped, 2);
  assert.equal(JSON.stringify(raw), frozen, 'the App\'s answer itself is not changed');
  const parsed = parseAppLinkPreviewV2(answer, origin);
  assert.ok(parsed && parsed.display === 'card', 'the card is served');
  const props = (id: string) => (parsed.card.elements[id] as { props: Record<string, unknown> }).props;
  assert.deepEqual(props('good'), { text: 'Merged', tone: 'done', color: '#8250df' }, 'a valid colour is kept (lowercased by the schema)');
  assert.deepEqual([props('bad'), props('worse')], [{ text: 'Merged', tone: 'done' }, { text: 'Merged', tone: 'done' }], 'an invalid one goes; the tone stays');
  assert.deepEqual(Object.keys(parsed.card.elements), Object.keys(raw.card.elements), 'element order kept');

  // Version 3: the card item; an unknown item is not looked at.
  const v3Raw = v3({ type: 'future.row', color: 'nope' }, v3Card('block', { card: v2Card({ state: colored(42), keep: colored('#00ff00') }).card }));
  const v3Dropped = dropInvalidLinkCardBadgeColors(v3Raw);
  assert.equal(v3Dropped.dropped, 1);
  const v3Parsed = parseAppLinkPreviewV3(v3Dropped.answer, origin);
  assert.ok(v3Parsed?.items[0]?.type === 'card');
  assert.deepEqual([v3Parsed.items[0].card.elements.state, v3Parsed.items[0].card.elements.keep],
    [{ type: 'Badge', props: { text: 'Merged', tone: 'done' } }, { type: 'Badge', props: { text: 'Merged', tone: 'done', color: '#00ff00' } }]);

  // Nothing invalid: the same object back, nothing counted.
  const clean = v2Card({ good: colored('#8250df') });
  assert.equal(dropInvalidLinkCardBadgeColors(clean).answer, clean);
  assert.equal(dropInvalidLinkCardBadgeColors(clean).dropped, 0);
  // The inline badge is not a card Badge: a colour there, invalid or not, is left for the schema to refuse, as today.
  for (const color of ['purple', '#8250df']) {
    const inline = { ...v2Card({ open }), inline: { title: 'x', badge: { text: 'Merged', color } } };
    assert.deepEqual(dropInvalidLinkCardBadgeColors(inline), { answer: inline, dropped: 0 }, color);
    assert.equal(parseAppLinkPreviewV2(inline, origin), null, color);
    const item = v3({ type: 'inline', title: 'x', badge: { text: 'Merged', color } });
    assert.deepEqual(dropInvalidLinkCardBadgeColors(item), { answer: item, dropped: 0 }, `version 3 ${color}`);
  }
  // Anything else invalid still refuses the answer.
  for (const [bad, why] of [
    [v2Card({ note: { type: 'Text', props: { text: 'x', color: 'red' } } }), 'a colour on Text'],
    [v2Card({ state: { type: 'Badge', props: { text: 'x', tone: 'purple', color: 'red' } } }), 'an unknown tone'],
    [v2Card({ state: { type: 'Badge', props: { text: 'x', color: 'red', glow: true } } }), 'another unknown prop'],
  ] as const) assert.equal(parseAppLinkPreviewV2(dropInvalidLinkCardBadgeColors(bad).answer, origin), null, why);
  const v1 = { version: 1, title: 'x', card: { root: 'b', elements: { b: { type: 'Badge', props: { text: 'x', color: 'red' } } } } };
  assert.deepEqual(dropInvalidLinkCardBadgeColors(v1), { answer: v1, dropped: 0 }, 'version 1 has no colour');
  // A shape it doesn't know is left as it is, for the schema to refuse.
  for (const odd of [{ version: 2, card: 'x' }, { version: 2, card: { elements: [] } }, { version: 3, items: 'x' }, { version: 3, items: [null, 1, 'x'] }, { version: 4, card: v2Card({ s: colored('red') }).card }]) {
    assert.deepEqual(dropInvalidLinkCardBadgeColors(odd), { answer: odd, dropped: 0 }, JSON.stringify(odd));
  }
});

test("badge colour: kept for a client that declared badge.color.v1; for any other, removed from every card Badge and counted", () => {
  const parsed = parseAppLinkPreviewV3(v3({ type: 'inline', title: 'x', badge: { text: 'Merged', tone: 'done' } },
    v3Card('hover', { card: v2Card({ a: colored('#8250df'), b: colored('#00FF00'), c: { type: 'Badge', props: { text: 'Open' } }, open }).card })), origin);
  assert.ok(parsed);
  assert.deepEqual(linkCardBadgeColorsForCapabilities(parsed.items, ['card.v2', 'badge.color.v1']), { items: parsed.items, stripped: 0 }, 'as the App sent them');
  const older = linkCardBadgeColorsForCapabilities(parsed.items, ['card.v2', 'inline.v1', 'inline.tone.v2', 'block.v1', 'preview.v3']);
  assert.equal(older.stripped, 2);
  assert.ok(!JSON.stringify(older.items).includes('color'), 'no colour key anywhere');
  const [inline, card] = older.items as [AppLinkPreviewItem, Extract<AppLinkPreviewItem, { type: 'card' }>];
  const sent = parsed.items[1] as typeof card;
  assert.equal(inline, parsed.items[0], 'the inline item is untouched');
  assert.deepEqual(card.card.elements.a, { type: 'Badge', props: { text: 'Merged', tone: 'done' } }, 'the tone stays');
  assert.equal(card.card.elements.c, sent.card.elements.c, 'an uncoloured Badge is untouched');
  assert.equal(card.card.elements.open, sent.card.elements.open);
  assert.ok(JSON.stringify(parsed.items).includes('#8250df'), 'pure: the parsed items are not changed');
  // What an older client reads: each item strictly, a Badge as { text, tone } and nothing else.
  const olderBadge = z.object({ type: z.literal('Badge'), props: z.object({ text: z.string(), tone: z.string() }).strict() }).strict();
  for (const node of Object.values(card.card.elements)) if (node.type === 'Badge') assert.ok(olderBadge.safeParse(node).success);
  // No colour, nothing to strip.
  const plain = parseAppLinkPreviewV3(v3(v3Card('hover')), origin)!;
  assert.deepEqual(linkCardBadgeColorsForCapabilities(plain.items, ['card.v2']), { items: plain.items, stripped: 0 });
});

test("badge colour is a link card's only: a card message's Badge and an action card's Badge never take one", () => {
  const badge = { type: 'Badge', props: { text: 'In review', tone: 'review', color: '#8250df' } };
  const plainBadge = { type: 'Badge', props: { text: 'In review', tone: 'review' } };
  // RFC 082 card messages: refused, so no colour can reach a card message's text for agents.
  const messageCard = (state: unknown) => ({ version: 1, root: 'root', elements: { root: { type: 'Stack', props: {}, children: ['state'] }, state } });
  assert.equal(parseMessageCard(messageCard(badge)).ok, false);
  assert.equal(parseMessageCard(messageCard(plainBadge)).ok, true);
  // Action cards: refused as a server emits them; dropped unread as a client reads them.
  const actionCard = (state: unknown) => ({ catalog: 'action-card.v1', title: { key: 'actionCard.test.msg', text: { en: 'Test' } },
    spec: { root: 'root', elements: { root: { type: 'Stack', props: {}, children: ['state'] }, state } } });
  assert.equal(parseActionCardSpec(actionCard(badge), { mode: 'emit' }).ok, false);
  assert.equal(parseActionCardSpec(actionCard(plainBadge), { mode: 'emit' }).ok, true, 'the same card without the colour emits');
  const read = parseActionCardSpec(actionCard(badge), { mode: 'read' });
  assert.ok(read.ok);
  assert.ok(!JSON.stringify(read.card).includes('color'), 'an action card read keeps no colour');
});

test("badge colour in the batched read answer: a client reads a valid colour Raft kept; an invalid one leaves only that link plain", () => {
  const app = { id: 'app-1', name: 'Cards', icon: null };
  const url = (n: number) => `${origin}/pr/${n}`;
  const v2Item = (n: number, color: string) => ({ kind: 'v2', url: url(n), app, preview: v2Card({ state: colored(color) }), ticket: null, actions: [] });
  const v3Item = (n: number, color: string) => ({ kind: 'v3', url: url(n), app, ticket: null, actions: [], preview: v3(v3Card('hover', { card: v2Card({ state: colored(color) }).card })) });
  const parsed = parseLinkCardReadAnswer({ items: [v2Item(1, '#8250df'), v2Item(2, 'red'), v3Item(3, '#00ff00'), v3Item(4, '#00ff0')] });
  assert.deepEqual(parsed.map((item) => item.url), [url(1), url(3)]);
  const [v2Read, v3Read] = parsed;
  assert.ok(v2Read?.kind === 'v2' && v2Read.preview.display === 'card');
  assert.equal((v2Read.preview.card.elements.state as { props: { color?: string } }).props.color, '#8250df');
  assert.ok(v3Read?.kind === 'v3' && v3Read.preview.items[0]?.type === 'card');
  assert.equal((v3Read.preview.items[0].card.elements.state as { props: { color?: string } }).props.color, '#00ff00');
});

test("v2 layout: a Stack is a column by default or a row that may wrap; Text can be monospace; v1 is unchanged", () => {
  const parse = (elements: Record<string, unknown>, children?: string[]) => parseAppLinkPreviewV2(v2Card(elements, children), origin);
  const card = parse({ badges: { type: 'Stack', props: { direction: 'row', wrap: true }, children: ['a', 'b'] },
    a: { type: 'Badge', props: { text: 'Open', tone: 'review' } }, b: { type: 'Badge', props: { text: 'CI failed', tone: 'warning' } },
    sha: { type: 'Text', props: { text: '3f2a1c9', mono: true } } }, ['badges', 'sha']);
  assert.ok(card && card.display === 'card');
  assert.deepEqual(card.card.elements.badges!.props, { direction: 'row', wrap: true });
  assert.deepEqual(card.card.elements.root!.props, { direction: 'column', wrap: false }, 'defaults: a column that does not wrap');
  assert.equal((card.card.elements.sha as { props: { mono: boolean } }).props.mono, true);
  const ok = (elements: Record<string, unknown>) => appLinkPreviewV2ResponseSchema.safeParse(v2Card(elements)).success;
  assert.equal(ok({ s: { type: 'Stack', props: { wrap: true }, children: [] } }), false, 'only a row can wrap');
  assert.equal(ok({ s: { type: 'Stack', props: { direction: 'grid' }, children: [] } }), false);
  assert.equal(ok({ s: { type: 'Stack', props: { gap: 8 }, children: [] } }), false, 'no spacing values');
  assert.equal(ok({ t: { type: 'Text', props: { text: 'x', mono: 'yes' } } }), false);
  assert.equal(ok({ t: { type: 'Text', props: { text: 'x', fontFamily: 'Comic Sans' } } }), false, 'no free styling');
  // v1 cards stay vertical: its Stack takes no props at all.
  assert.equal(appLinkPreviewResponseSchema.safeParse({ version: 1, title: 'x', card: { root: 'r', elements: { r: { type: 'Stack', props: { direction: 'row' } } } } }).success, false);
});

// The client's reading of POST /api/messages/:messageId/link-cards/read: one
// item per link, each strict and read on its own, so an item the client can't
// read leaves only its own link plain; fields added at the top level later are
// ignored, as with the GET's list.
test("batched read answer: strict items read one by one, a tolerant top level", () => {
  const app = { id: 'app-1', name: 'Cards', icon: null };
  const url = (n: number) => `${origin}/pr/${n}`;
  const card = (n: number, extra: object = {}) => ({ kind: 'v2', url: url(n), app, preview: { ...v2Card({ open }), ...extra }, ticket: null, actions: [] });
  const items = [
    { kind: 'v1', url: url(1), app, preview: { version: 1, title: 'One' } },
    { ...card(2, { inline: { title: 'o/r#2', badge: { text: 'Open' } }, placement: 'block' }), ticket: 't'.repeat(4096), actions: [{ action_id: 'merge', handle: 'h' }] },
    { kind: 'v2', url: url(3), app, preview: { version: 2, display: 'connect_account', connect_url: `${origin}/connect` }, ticket: null, actions: [] },
    { kind: 'rate_limited', url: url(4), retry_after: 7 },
    // Each of these is dropped alone:
    { kind: 'v4', url: url(5), app }, // a kind added later
    { ...card(6), score: 1 }, // a field added later to an item
    { kind: 'v1', url: url(7), app, preview: { version: 1, title: 'x', html: '<b>x</b>' } }, // an invalid preview
    { kind: 'v2', url: url(8), app, preview: { version: 2, display: 'connect_account', connect_url: 'https://elsewhere.example/connect' }, ticket: null, actions: [] }, // off the link's origin
    card(9, { card: { root: 'b', elements: { b: { type: 'Button', props: { label: 'Go', action: { kind: 'navigate', url: 'https://elsewhere.example/x' } } } } } }), // a navigate button off the origin
    { kind: 'v2', url: url(10), app, preview: { version: 2, display: 'link' }, ticket: null, actions: [] }, // shows only the link
    { kind: 'rate_limited', url: url(11), retry_after: -1 },
    { kind: 'v1', url: 'javascript:alert(1)', app, preview: { version: 1, title: 'x' } },
    { ...card(12), ticket: '' },
    card(13, { placement: 'inline' }), // a placement this client doesn't know
  ];
  const parsed = parseLinkCardReadAnswer({ items: items.slice(0, 4), prompts: [], later: { anything: true } });
  assert.deepEqual(parsed.map((item) => `${item.kind}:${item.url}`), ['v1:' + url(1), 'v2:' + url(2), 'v2:' + url(3), 'rate_limited:' + url(4)]);
  const v2 = parsed[1]!;
  assert.ok(v2.kind === 'v2' && v2.preview.display === 'card');
  assert.deepEqual(v2.preview.inline, { title: 'o/r#2', badge: { text: 'Open', tone: 'neutral' } });
  assert.equal(v2.preview.placement, 'block', 'a block.v1 client reads the placement Raft kept');
  assert.equal(v2.preview.card.elements.root!.type, 'Stack');
  assert.deepEqual(v2.preview.card.elements.root!.props, { direction: 'column', wrap: false }, 'schema defaults applied');
  assert.equal(v2.ticket, 't'.repeat(4096));
  for (const bad of items.slice(4)) {
    assert.deepEqual(parseLinkCardReadAnswer({ items: [items[0], bad] }).map((item) => item.url), [url(1)], JSON.stringify(bad).slice(0, 80));
  }
  for (const data of [null, 'oops', {}, { items: 'x' }, { items: {} }]) assert.deepEqual(parseLinkCardReadAnswer(data), []);
  assert.equal(parseLinkCardReadAnswer({ items: Array.from({ length: 12 }, (_, n) => ({ kind: 'rate_limited', url: url(n), retry_after: 1 })) }).length, 10, 'ten links per message');
});

test("batched read answer, v3 items (RFC 076 §14): read like v2 ones, with unknown item types skipped; [], an invalid list or a URL off the origin is no item", () => {
  const app = { id: 'app-1', name: 'Cards', icon: null };
  const url = (n: number) => `${origin}/pr/${n}`;
  const item = (n: number, items: unknown[], extra: object = {}) => ({ kind: 'v3', url: url(n), app, preview: { version: 3, items }, ticket: null, actions: [], ...extra });
  const inline = { type: 'inline', title: 'PR 1' };
  const parsed = parseLinkCardReadAnswer({ items: [
    item(1, [{ type: 'future.row' }, inline, v3Card('block')], { ticket: 't', actions: [{ action_id: 'approve', handle: 'h' }] }),
    item(2, []),
    item(3, [inline, v3Card('hover'), v3Card('block')]),
    item(4, [{ type: 'connect_account', connect_url: 'https://elsewhere.example/connect' }]),
    item(5, [inline], { preview: { version: 2, display: 'link' } }),
    item(6, [{ type: 'connect_account', connect_url: `${origin}/connect` }]),
  ] });
  assert.deepEqual(parsed.map((entry) => `${entry.kind}:${entry.url}`), [`v3:${url(1)}`, `v3:${url(6)}`]);
  const [first] = parsed;
  assert.ok(first?.kind === 'v3');
  assert.deepEqual(first.preview.items.map((entry) => entry.type), ['inline', 'card'], 'the unknown type skipped, the App\'s order kept');
  assert.equal(first.ticket, 't');
  assert.deepEqual(first.actions, [{ action_id: 'approve', handle: 'h' }]);
});

test("block card places (RFC 076 §14): bare public links in a paragraph or a list item, once each at the first such place, in order; never in a quote, a table, a heading or a footnote", () => {
  const u = (n: number) => `https://app.example/pr/${n}`;
  const content = [
    `> quoted ${u(1)}`, `| ${u(2)} |\n| --- |`, `# ${u(3)}`,
    `Text ${u(1)} and **${u(4)}** and [named](${u(5)}) and \`${u(6)}\``,
    `- item ${u(7)}\n  - nested ${u(8)}`, `again ${u(4)} and <${u(9)}> and http://localhost:3000/x`,
  ].join('\n\n');
  const places = appLinkBlockCardPlaces(content);
  assert.deepEqual(places.map((place) => place.url), [u(1), u(4), u(7), u(8), u(9)]);
  for (const place of places) {
    const at = content.slice(place.offset);
    assert.ok(at.startsWith(place.url) || at.startsWith(`<${place.url}>`), `the offset is where ${place.url} starts`);
  }
  assert.ok(places[0]!.offset > content.indexOf('Text'), 'a quoted link is no place: the first place is the paragraph\'s');
  assert.deepEqual(appLinkBlockCardPlaces('no links'), []);
  // The end: where the last paragraph a card may follow ends (a quoted or table one doesn't count).
  const text = `First ${u(1)}\n\n- item\n\n> quoted`;
  assert.equal(appLinkBlockCardLayout(text).end, text.indexOf('item') + 'item'.length);
  assert.equal(appLinkBlockCardLayout('> only quoted').end, null);
});

// Raft's own objects' links (first-party: an Artifact's, as the shared
// parseArtifactRef reads it) are not App links: left out before the limit, so
// the server's reads and the web count the same links.
test("an App link read leaves first-party object links out before the limit", () => {
  const hosts = ['app.raft.build', 'staging.raft.example'];
  const artifacts = Array.from({ length: 10 }, (_, i) => `https://app.raft.build/artifacts/pt_a${i}${i % 2 ? `/v/${i}` : ''}`);
  const appLink = 'https://app.example/pr/1';
  const content = [...artifacts, appLink].join(' ');
  assert.deepEqual(appLinkReadUrls(content, hosts, 10), [appLink], 'ten Artifact links before it: the App link is read');
  assert.deepEqual(appLinkReadUrls(content, hosts), [appLink], 'the GET\'s three too');
  assert.deepEqual(messagePreviewUrls(content, 10), artifacts, 'without the exclusion the App link would be the eleventh');
  // Every Artifact address with an id: the app host's /artifacts and /s/<slug>/artifacts, this deployment's host, the redirect host and the content origin.
  const firstParty = ['https://app.raft.build/s/team/artifacts/pt_b1', 'https://staging.raft.example/artifacts/pt_b2', 'https://artifacts.raft.build/pt_b3',
    'https://a-pt-0f0e0d0c-0b0a-4908-8706-050403020100.raftusercontent.com/index.html'];
  assert.deepEqual(appLinkReadUrls([...firstParty, appLink].join(' '), hosts, 1), [appLink]);
  // Not first-party, so they count: /artifacts on a host that isn't Raft's, a legacy link by name (only the server resolves it), a non-Artifact path on Raft's host.
  const counted = ['https://lookalike.example/artifacts/pt_c1', 'https://raft-artifacts.com/p/team/notes', 'https://app.raft.build/s/team/channel/x'];
  assert.deepEqual(appLinkReadUrls([...counted, appLink].join(' '), hosts, 10), [...counted, appLink]);
  assert.deepEqual(appLinkReadUrls([...counted, appLink].join(' '), hosts), counted, 'they take the three');
  assert.deepEqual(appLinkReadUrls('https://staging.raft.example/artifacts/pt_b2 ' + appLink, ['app.raft.build'], 1), ['https://staging.raft.example/artifacts/pt_b2'],
    'a host the caller does not name is not Raft\'s');
  // The limit still caps App links, in message order, deduplicated.
  const apps = Array.from({ length: 12 }, (_, i) => `https://app.example/pr/${i + 2}`);
  const mixed = apps.flatMap((link, i) => [artifacts[i % 10]!, link, link]).join(' ');
  assert.deepEqual(appLinkReadUrls(mixed, hosts, 10), apps.slice(0, 10));
  assert.deepEqual(appLinkReadUrls(mixed, hosts), apps.slice(0, 3));
  // Only bare, public links, as messagePreviewUrls takes them.
  assert.deepEqual(appLinkReadUrls(`[words](${appLink}) \`https://app.example/pr/9\` http://app.example/pr/8`, hosts, 10), []);
});
