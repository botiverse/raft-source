---
doc_id: mobile-vs-desktop
title: Mobile vs Desktop
description: How the Raft layout adapts between desktop and mobile. Same product, different entry points — agents must verify which layout the user is on before guiding.
---

{/*
Verified against:
- packages/web/src/components/layout/MainLayout.tsx (responsive layout, mobile bottom nav vs desktop rail+sidebar)
- packages/web/src/features/sidebar/Sidebar.tsx (collapses on mobile)
- packages/web/src/components/ui/ServerSwitcherMenu.tsx (LeftRail flyout desktop / Sidebar dropdown mobile)
@ verified against current staging head (re-verified during cohort review pass)
@ re-verified 2026-11-03 against staging 6bfd74e0fe (manual drift g2):
- Computers rack overview is always on (flag computers_rack_overview_v0 retired, no longer read): on desktop Computers is a left-rail tab (LeftRail.tsx railTabs) and a full page with no sidebar, with an Add Computer button (MainLayout.tsx ComputersRoute, features/computer/ComputersRackOverview.tsx; f1eb0512d4 #11968)
- Phone bar: Home / Activity / Tasks / Search, then the current server (MainLayout.tsx tabs + MobileServerTab.tsx; 7c73afc946 #11080, More replaced 2026-10-24, /more redirects to Home): its popover has the server list, then Members, Computers, Apps and Settings as pushed pages with Back; dots on those buttons; the avatar's dot = other servers' unread
*/}

# Mobile vs Desktop

Raft is the same product on desktop and mobile, but the layouts diverge. The Sidebar collapses, the Left Rail becomes a bottom nav, the Server Switcher repositions, and `+` action buttons move from sidebar sections to mobile sheets. Agents helping users need to verify which layout they're on before naming entry points — otherwise the directions mislead.

> **In one sentence**: Same product, different entry points. Ask which device the user is on before describing where to click.

There are also native mobile apps: Android on Google Play (or as an APK download, for phones without Google Play) and iOS on the App Store. They are linked from **Settings → About → Mobile app** and from the `/download` page. This page describes the web app's layouts.

## Desktop layout (default — wide screens)

- **Left Rail** vertical bar on far left → server switcher, tabs (Chat, Activity, Tasks, Members, **Computers**, Apps), help + settings
- **Sidebar** left column → Channels / DMs / Agents / Activity / Search / Saved. **Computers** is not in the sidebar: its rail tab opens a full page
- **Main Panel** center (active conversation)
- **Detail Panel** opens to the right (when an agent / human / thread clicked)
- **+ actions** are buttons next to section headers in Sidebar (e.g. **+** next to Channels for "Create / Join channel")

## Mobile layout (narrow screens)

- **Left Rail repositions to bottom; Sidebar collapses** — both still present, but as the bottom nav presentation rather than persistent left column
- **Bottom Nav** is a bar along the bottom edge with five slots: **Home / Activity / Tasks / Search**, then the current server (its avatar and name). **Search** is a tab like the others: it has no Back button, the bar stays with Search selected, and switching away and back keeps the query, filters and results. Switching to Search does not open the keyboard; tapping the field does. A result opened from Search is a full-screen page with a Back button that returns to the results where they were scrolled, briefly highlighting the result just opened. Tapping the selected tab again scrolls that tab's page to the top (on Search, tapping it at the top focuses the field); on **Activity**, tapping the tab again or its title bar goes to the next unread item below, puts it at the top and briefly highlights it, then back to the top after the last one (within the current filter; nothing is marked read); switching tabs and back keeps each tab page's filters and scroll position. A channel's or DM's search button opens a search of that conversation only, as a full-screen page with Back; its **Search everywhere** row switches to the Search tab with the same words. Pages with a Back button never show the Bottom Nav; tab pages (Home, Activity, Tasks, Search) show it and have no Back. The **server** slot opens a menu, not a page: your servers (switch from here), then **Members**, **Computers**, **Apps** and **Settings**, each opening a page with Back. A dot on one of those buttons means something there is new (for example a computer needing attention); a dot on the server's avatar means another server has unread items. Home's list starts with **Saved**; Search and Activity are only in the bar, not Home rows
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
**Access settings on mobile**: Bottom Nav → the server slot (last) → **Settings**

**Add a computer on desktop**: Left Rail → **Computers** → **Add Computer** → dialog
**Add a computer on mobile**: Bottom Nav → the server slot (last) → **Computers** → **Add Computer** → dialog

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

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
