import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Paperclip } from "lucide-react";
import EmptyState from "../src/components/ui/EmptyState";

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

  const slotClass = (slot: string) =>
    html.match(new RegExp(`data-slot="${slot}"[^>]*? class="([^"]*)"`))?.[1] ?? "";
  const titleClass = slotClass("empty-state-title");
  const iconClass = slotClass("empty-state-icon");
  const descriptionClass = slotClass("empty-state-description");

  // Title is rendered as-passed (sentence case from the callsite). No
  // `uppercase` / `tracking-tight` CSS override. It is dimmed body copy, not
  // the full-strength foreground.
  assert.match(html, /No files yet/);
  assert.match(titleClass, /(?:^|\s)text-foreground-muted(?:\s|$)/);
  assert.doesNotMatch(titleClass, /(?:^|\s)text-foreground(?:-strong)?(?:\s|$)/);
  assert.doesNotMatch(html, /text-lg font-display font-semibold text-black"/);
  assert.doesNotMatch(html, /uppercase/);
  assert.doesNotMatch(html, /tracking-tight/);

  // Icon wrapper is frameless and muted — no border, no tinted box. The muted
  // colour propagates to currentColor-aware lucide icons.
  assert.match(iconClass, /(?:^|\s)text-foreground-hint(?:\s|$)/);
  assert.doesNotMatch(iconClass, /(?:^|\s)(?:border|bg)-/);
  // The icon is decoration; the title carries the meaning (raft-ui 0.7.0).
  assert.match(html, /data-slot="empty-state-icon" aria-hidden="true"/);
  assert.doesNotMatch(html, /border-black\/30/);
  assert.doesNotMatch(html, /bg-black\/5/);
  assert.doesNotMatch(html, /text-black\/45/);

  // Description + action slots still work; the description is muted too.
  assert.match(descriptionClass, /(?:^|\s)text-foreground-hint(?:\s|$)/);
  assert.match(html, /Attach files in Chat\./);
  assert.match(html, /Add file/);
});

/**
 * Empty-state title templates. The canonical rule is raft-design
 * design/content/writing.md "Errors and empty states": the form follows why the
 * view is empty.
 *
 *   1. Nothing yet:          "No {object} yet"
 *   2. A filter hides all:   "No {object} match this filter"
 *   3. (retired) "{ProductNoun} is empty" — describes the container, not what
 *      is missing; Activity's empty title is now "No conversations".
 *   4. Handled items leave:  "No {state} {object}" / "No {object}" (no "yet" —
 *      the view empties because things were handled, not because none came)
 *
 * Sentence case throughout, no trailing period.
 */

const TEMPLATE_PATTERNS = [
  // Rule 1: "No {object} yet" — object can be multi-word (e.g. "agent-to-agent DMs",
  // "saved messages"). Lowercase first letter (sentence case after "No ").
  /^No [a-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)* yet$/,
  // Rule 2: "No {object} match this filter".
  /^No [a-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)* match this filter$/,
  // Rule 4: "No {state}" — handled items leave, no "yet" suffix. A state
  // (unread / archived / muted) optionally followed by a noun ("unread
  // conversations"), or a view whose items leave once done (mentions,
  // conversations in Activity).
  /^No (?:(?:unread|archived|muted)(?: [a-z][a-z]*)?|mentions|conversations)$/,
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
    // Rule 2
    "No tasks match this filter",
    // Rule 4
    "No unread conversations",
    "No unread chats",
    "No mentions",
    "No conversations",
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
    "Activity is empty",          // describes the container, not what is missing
  ];
  for (const title of negative) {
    assert.equal(matchesTemplate(title), false, `template should reject "${title}"`);
  }
});
