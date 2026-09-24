import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Paperclip } from "lucide-react";
import EmptyState from "../src/components/ui/EmptyState";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

/**
 * Per #proj-uiux:4e20fa91 (task #246, 2026-05-15) — cindyz raised the
 * mid-thread "this is standard?" screenshot; Joy + 跳虎 + Bugen aligned on:
 *
 *   B. **Drop the soft-gray icon frame.** Previously a wrapper
 *      `<EmptyStateIconFrame>` rendered `border-2 border-black/30 bg-black/5
 *      text-black/45` — a three-layer-transparency box that read as OS
 *      placeholder default, visually jarring next to brutal-bordered sibling
 *      surfaces. Removed. Icons render directly inside a `text-black/40`
 *      wrapper, letting empty state recede as a quiet info hint.
 *
 *   C. **Sentence-case title.** `EmptyState` previously forced
 *      `uppercase tracking-tight` on the title CSS even though every callsite
 *      passed sentence-case strings ("No replies yet", "No files yet", …).
 *      CLAUDE.md "Text Styles" reserves `uppercase` for section labels (12px)
 *      and dialog titles; empty-state titles are informational hints, neither
 *      category. Drop the CSS override and render the literal callsite string.
 *
 * Joy also requested: icon size = 36 (bump from 28) since the frame removal
 * costs visual mass — `text-black/40` carries the muted weight without
 * needing a box to anchor the icon.
 *
 * Per #proj-uiux task #283 (2026-05-21): the "No …" title line is empty-state
 * body copy and should be dimmed, not pure black.
 */

test("EmptyState renders sentence-case title and frameless icon (B + C contract)", () => {
  const html = renderToStaticMarkup(
    createElement(EmptyState, {
      icon: createElement(Paperclip, { size: 36 }),
      title: "No files yet",
      description: "Attach files in Chat.",
      action: createElement("button", { type: "button" }, "Add file"),
    }),
  );

  // Title is rendered as-passed (sentence case from the callsite). No
  // `uppercase` / `tracking-tight` CSS override.
  assert.match(html, /No files yet/);
  assert.match(html, /text-lg font-display font-semibold text-black\/60/);
  assert.doesNotMatch(html, /text-lg font-display font-semibold text-black"/);
  assert.doesNotMatch(html, /uppercase/);
  assert.doesNotMatch(html, /tracking-tight/);

  // Icon wrapper is the new frameless, muted container — no border, no
  // bg-black/5, no 30%-opacity black border. Just `text-black/40` to
  // propagate to currentColor-aware lucide icons.
  assert.match(html, /mb-4 inline-flex items-center justify-center text-black\/40/);
  assert.doesNotMatch(html, /border-black\/30/);
  assert.doesNotMatch(html, /bg-black\/5/);
  assert.doesNotMatch(html, /text-black\/45/);

  // Description + action slots still work.
  assert.match(html, /mx-auto max-w-\[32ch\] text-sm leading-relaxed text-black\/60/);
  assert.match(html, /Attach files in Chat\./);
  assert.match(html, /Add file/);
});

test("full-panel empty states reuse the shared EmptyState primitive", () => {
  const files = [
    "src/components/message/ChannelFilesPanel.tsx",
    "src/components/ui/NotificationCenter.tsx",
    "src/components/saved/SavedPanel.tsx",
    "src/components/thread/ThreadsInbox.tsx",
    "src/components/task/TasksPanel.tsx",
    "src/components/message/ChatPanel.tsx",
    "src/components/message/ThreadPanel.tsx",
    "src/components/machine/MobileComputersPanel.tsx",
    "src/components/agent/AgentActivityLog.tsx",
    "src/components/agent/AgentDetailPanel.tsx",
    "src/components/agent/AgentRemindersSection.tsx",
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /<EmptyState\b/, `${file} should render EmptyState`);
  }
});

/**
 * Empty-state title templates (locked 2026-05-15 #proj-uiux:ce50bf6b, task #246):
 *
 *   1. Base empty:           "No {object} yet"
 *   2. Filter empty:         "No {object} match this filter"
 *   3. Product noun special: "{ProductNoun} is empty"
 *   4. Status-type empty:    "No {state}"        (no "yet" — state is binary, not progressive)
 *
 * Sentence case throughout, no trailing period. CLAUDE.md "Empty-state title
 * templates" is the canonical doctrine — this test pins the templates to the
 * actual callsite literals so any drift trips CI.
 */

const TEMPLATE_PATTERNS = [
  // Rule 1: "No {object} yet" — object can be multi-word (e.g. "agent-to-agent DMs",
  // "saved messages"). Lowercase first letter (sentence case after "No ").
  /^No [a-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)* yet$/,
  // Rule 2: "No {object} match this filter".
  /^No [a-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)* match this filter$/,
  // Rule 3: "{ProductNoun} is empty" — single capitalized product noun.
  /^[A-Z][a-z]+ is empty$/,
  // Rule 4: "No {state}" — status-type, no "yet" suffix. Object is a state
  // (unread / archived / muted) optionally followed by a noun ("unread chats").
  /^No (?:unread|archived|muted)(?: [a-z][a-z]*)?$/,
];

function matchesTemplate(title: string): boolean {
  return TEMPLATE_PATTERNS.some((pattern) => pattern.test(title));
}

test("template patterns themselves accept canonical examples and reject offenders", () => {
  // Positive: every documented example must match.
  const positive = [
    // Rule 1
    "No messages yet",
    "No replies yet",
    "No files yet",
    "No tasks yet",
    "No saved messages yet",
    "No activity yet",
    "No chats yet",
    "No agent-to-agent DMs yet",
    "No computers yet",
    "No reminders yet",
    "No mentions yet",
    // Rule 2
    "No tasks match this filter",
    // Rule 3
    "Activity is empty",
    "Inbox is empty",
    // Rule 4
    "No unread chats",
    "No archived chats",
    "No muted chats",
    "No unread",
  ];
  for (const title of positive) {
    assert.equal(matchesTemplate(title), true, `template should accept "${title}"`);
  }

  // Negative: classic free-style offenders the doctrine bans.
  const negative = [
    "Nothing here yet",          // not "No {object}" — vague
    "no messages yet",            // lowercase "No"
    "No messages yet.",           // trailing period
    "NO MESSAGES YET",            // uppercase
    "No messages",                // missing "yet" + not status-type
    "Empty",                      // no template
    "Inbox empty",                // missing "is"
    "The inbox is empty",         // article — must be bare product noun
    "No tasks matching this filter", // wrong verb form ("matching" vs "match")
  ];
  for (const title of negative) {
    assert.equal(matchesTemplate(title), false, `template should reject "${title}"`);
  }
});

test("EmptyState callsite titles match doctrine templates", () => {
  // Each callsite's expected literal title strings, drawn directly from source.
  // If a callsite changes its title text, this list must be updated and the
  // new text must still match TEMPLATE_PATTERNS — otherwise the doctrine in
  // CLAUDE.md is violated.
  const callsites: Array<{ file: string; titles: string[] }> = [
    // All tracked empty-state titles are migrated to react-intl (ThreadsInbox +
    // B2a ChatPanel + B2b ThreadPanel + the emptyState.* horizontal sweep across
    // agent/machine/message/task/saved panels). They now live in the en catalog;
    // the doctrine still applies to the en source-of-truth values, checked here.
    {
      file: "src/i18n/messages/en.ts",
      titles: [
        "No mentions yet", "No unread chats", "Activity is empty", "No messages yet", "No replies yet",
        "No activity yet", "No chats yet", "No channels yet", "No agent-to-agent DMs yet",
        "No managed MCP servers yet", "No reminders yet", "No computers yet", "No files yet",
        "No saved messages yet", "No tasks yet", "No tasks match this filter",
      ],
    },
  ];

  for (const { file, titles } of callsites) {
    const source = read(file);
    for (const title of titles) {
      // 1. Title literal must actually appear in the source — guard against
      //    silent rename drift.
      assert.ok(
        source.includes(`"${title}"`),
        `${file} should contain literal title "${title}" (callsite drift?)`,
      );
      // 2. Title must match one of the four canonical templates.
      assert.equal(
        matchesTemplate(title),
        true,
        `${file} title "${title}" must match one of the empty-state title templates (CLAUDE.md "Empty-state title templates")`,
      );
    }
  }
});
