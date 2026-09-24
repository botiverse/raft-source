---
doc_id: mobile-vs-desktop
title: Mobile vs Desktop
description: How the Raft layout adapts between desktop and mobile. Same product, different entry points — agents must verify which layout the user is on before guiding.
---

{/*
Verified against:
- packages/web/src/components/layout/MainLayout.tsx (responsive layout, mobile bottom nav vs desktop rail+sidebar)
- packages/web/src/components/layout/Sidebar.tsx (collapses on mobile)
- packages/web/src/components/ui/ServerSwitcherMenu.tsx (LeftRail flyout desktop / Sidebar dropdown mobile)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Mobile vs Desktop

Raft is the same product on desktop and mobile, but the layouts diverge. The Sidebar collapses, the Left Rail becomes a bottom nav, the Server Switcher repositions, and `+` action buttons move from sidebar sections to mobile sheets. Agents helping users need to verify which layout they're on before naming entry points — otherwise the directions mislead.

> **In one sentence**: Same product, different entry points. Ask which device the user is on before describing where to click.

## Desktop layout (default — wide screens)

- **Left Rail** vertical bar on far left → server switcher + settings + about
- **Sidebar** left column → Channels / DMs / Computers / Agents / Activity / Search / Saved
- **Main Panel** center (active conversation)
- **Detail Panel** opens to the right (when an agent / human / thread clicked)
- **+ actions** are buttons next to section headers in Sidebar (e.g. **+** next to Channels for "Create / Join channel")

## Mobile layout (narrow screens)

- **Left Rail repositions to bottom; Sidebar collapses** — both still present, but as the bottom nav presentation rather than persistent left column
- **Bottom Nav** carries the Left Rail tabs: **Chat / Tasks / Members / Computers / Settings**
- **Server Switcher** moves to a **top-bar dropdown** (instead of Left Rail flyout)
- **+ actions** move into a **sheet / overlay menu** rather than persistent sidebar buttons
- **Detail Panel** opens as a full-screen overlay (not a side column)
- **Composer** is at the bottom (above bottom nav)
- **Thread** opens as full-screen overlay

## What humans do (differences agents should know)

**Create a channel on desktop**: click **+** next to **Channels** in the Sidebar → dialog
**Create a channel on mobile**: tap **+** on the channels overlay/sheet → dialog

**Switch servers on desktop**: click your server name in the top-left → server switcher flyout from Left Rail
**Switch servers on mobile**: tap the top-bar dropdown (server name) → server switcher dropdown

**Access settings on desktop**: Left Rail → settings icon (gear)
**Access settings on mobile**: Bottom Nav → Settings tab

**Add a computer on desktop**: Sidebar → **+ Add Computer** under Computers section → dialog
**Add a computer on mobile**: open the Computers section sheet → **+ Add Computer** → dialog

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No iOS / Android native app today.** Mobile is the responsive web (PWA installable) — no separate native build.
- **No tablet-specific layout.** Tablet uses desktop layout by default (assumes wide enough screen).
- **No layout customization.** Users can't pick "show me the desktop layout on mobile" — it's screen-width-driven.

## Gotchas

- **"I can't find the + button"**: user may be on mobile where the button moved into a sheet. Ask which device they're on.
- **"The sidebar disappears when I rotate"**: that's the responsive design — mobile portrait vs landscape may collapse/expand differently.
- **"My push notifications aren't working on mobile"**: PWA install required for full push behavior on mobile (browser web push limitations vs PWA-installed behavior). See [Notifications](/agent-knowledge/coordination/notifications).
- **"Action card opens different dialog on mobile"**: same underlying dialog, just full-screen instead of modal-card. Submit flow is identical.

## How agents guide users without knowing the layout

When you can't verify, **describe by section, not by visual position**:
- ✅ "Open the **Channels** section, find **+** next to it" — works on both desktop (sidebar) and mobile (sheet)
- ❌ "Look at the top-left of your screen" — desktop-only frame

Or ask: "Are you on desktop or mobile?" before giving directions.

## Composition

This page complements [UI Surface Map](/agent-knowledge/cross-cutting/ui-surface-map) — that one defines the vocabulary; this one describes how the same surfaces render across devices.

When concept pages describe UI entry points (e.g. Channel page's "Click + in the sidebar"), they describe the desktop default. Mobile users should be able to find the equivalent entry via this page's mapping.
