---
doc_id: computer
title: Computer
description: The physical host machine where Raft Computer runs. Agents need at least one online computer to run any work.
---

{/*
Verified against:
- packages/web/src/components/machine/AddMachineDialog.tsx (Add Computer dialog: in Raft Desktop it asks which computer first — This computer / Another computer; in a browser it opens on the command; This computer's setup progress: localComputer/AddThisComputerDialog.tsx; "Add to this server" for this computer: useAddThisComputer.ts)
- packages/web/src/components/machine/localComputer/ThisDeviceSections.tsx (Raft Desktop: This device panel, no commands; thisDeviceLogic.ts states)
- apps/desktop/src/main/computer/ (Raft Desktop drives the official install through its CLI; computerMigration.ts moves an older Desktop's embedded Computer)
- packages/web/src/components/machine/ComputerCommandGuide.tsx (explicit macOS/Linux vs Windows command selector)
- packages/web/src/utils/computerSetupCommand.ts (shell-specific macOS/Linux and Windows Computer commands)
- packages/server/src/services/machineService.ts:28 (sk_machine_* mint via randomBytes(32))
- packages/web/src/features/computer/MachineDetailPanel.tsx (rename via pencil icon, "Edit computer name")
- packages/web/src/features/computer/MachineDetailPanel.tsx (Connect Command, Generate Connect Command, admin-only)
- packages/web/src/features/computer/MachineDetailPanel.tsx + DeleteComputerDialog.tsx (Delete Computer: blocked if agents assigned; on your own computer (machine.userId is you) only your own agents block, others' agents get Notify Owner / Force Unbind and Delete)
- packages/web/src/features/computer/WorkspacesSection.tsx (WorkspacesSection: Scan/Rescan, Delete workspace)
- packages/web/src/features/computer/MachineAgentList.tsx (MachineAgentList: bulk Start/Stop/Restart)
- packages/web/src/components/agentMigration/AgentMigrationSection.tsx (moving an agent: Move to another computer, Pro upgrade dialog; an agent on no computer, or on one whose access was revoked, is placed without the Pro gate, routes/agents.ts POST /agents/:id/migrate)
- services/computerAgents.ts findAccessRevokedMachineIds + agentOrchestrator.ts isMachineAccessRevoked (reconciler step 15: no wakes or starts for an agent on a revoked computer; agent list blockedReason computer_access_revoked; re-attach makes a new machine row, computerCredentialService.attachComputer)
@ verified against current staging head (re-verified during cohort review pass)
@ migrate/reconnect flow + prompt copy verified 2026-07-09 against the merged migration-surface changes; prompts byte-matched; --migrate-from removed → --machine <machineId>; --fresh public; fresh key = `new`
@ re-verified 2026-10-28 against staging 1883339e9 (public-docs audit fixes):
- shared/agentText/server.ts + cli/commands/server/info.ts (`raft server info` lists channels/agents/humans; only the caller's own computer appears, in Current Runtime)
- computer/src/cli.ts (verbs: login/logout/attach/setup/detach/start/stop/restart/status/doctor/logs/runners/channel/versions/upgrade; no `operation` command; one service attaches to several servers, one daemon child per server)
- daemon/src/drivers/probe.ts (on Windows a resolved .ps1 falls back to .cmd/.bat/.exe automatically)
- services/machineService.ts (MACHINE_HAS_ASSIGNED_AGENTS counts non-archived agents only)
- en.ts machine.detail.migrateToComputer ("Migrate to Computer{platform}"), agent.detail.moveToAnotherComputer
- cli/package.json bin (`slock` alias still shipped)
- Setup command: the dialog adds --server-url only for non-default deployments (computerSetupCommand.ts)
- Restart-on-own-host warning: measured 2026-09-08 on daemon 1.0.15 and 1.0.19 by reading process ancestry; restart aimed at a different host not verified
Not gated: agent migration (flag agent_migration_v0 retired, no longer read); starting a migration needs Pro billing features (plan rule pro/founder/partner; server MIGRATION_PRO_PLAN_REQUIRED). Applies to Move to Another Computer.
- #11688 Computer-owner rule REVERTED by #11749 (2026-10-28: shared dev machines, no owner vs admin distinction). Admins and the agent's creator can again change env vars / launch command / local plugins and place such agents on any computer; auto-assignment is the server's first computer again. The `assign-machine` route was later retired (reconciler step 14); an agent changes computer only by Move to Another Computer. The `computer.agent_assigned` audit record now records only placing an agent that is on no computer (via `placed_without_source`).
- Server slug: web route /s/:serverSlug (App.tsx:1383), canonical host app.raft.build (artifactLinks.ts CANONICAL_APP_HOST); Settings → Server tab → Profile → Slug (features/settings/server/ServerTabContent.tsx, ProfileSection.tsx, en.ts settings.serverProfile.slugLabel); getComputerCommands puts the slug in `setup /<slug>`
@ re-verified 2026-11-03 against staging 6bfd74e0fe (manual drift g2):
- Computers rack overview is always on (flag computers_rack_overview_v0 retired, no longer read): desktop Computers is a left-rail tab and a full page with no sidebar (MainLayout.tsx ComputersRoute, features/computer/ComputersRackOverview.tsx "Add Computer", features/sidebar/computers/SidebarComputersRail.tsx comment; f1eb0512d4 #11968); phone: server tab popover → Computers (components/layout/MobileServerTab.tsx, MobileComputersPanel.tsx)
- Web Delete Computer on the viewer's own computer (a Computer whose machine row is theirs, `machines.userId`, the server's revoke gate; not computers.attachedByUserId) calls POST /machines/:id/revoke-computer-key, then DELETE (features/computer/DeleteComputerDialog.tsx). Otherwise rotate-key refuses any machine with a Computer row (servers.ts:3528-3575, ComputerKeyRotationUnsupportedError), so Generate Connect Command is no revoke path for a Raft Computer. Web path = the one-time "Revoke This Machine" link in the "You added X to Y" email to the approver (services/computerKeyRevocation.ts, emailService.ts:928-958, en.ts pages.deviceLoginRevoke.computer*); 948b88397c #12147
- services/computerDetachedNotices.ts + agentActionRequiredNoticeService.ts agentComputerDetachedNoticeText (DM notice to each live agent's human creator after a detach; the web/link paths skip the person who detached) — 9f684c80c5 #12467
- `raft-computer detach` and the setup link-and-code approval first in computer-v1.0.60 (6d2cea0006 #12137, 948b88397c #12147)
@ 2026-11-10: background processes and the stable entry: daemon/src/drivers/cliTransport.ts buildCliStableEntryDir (cli-transport/<agent>/current/, rewritten per launch, no credential of its own), daemon/src/agentProxyLaunchLifecycle.ts (launch_superseded / agent_not_running refusals), cli/src/core/apiFailure.ts localProxyLifecycleError (LAUNCH_SUPERSEDED / AGENT_NOT_RUNNING / AGENT_ID_MISMATCH)
*/}

# Computer

A computer is a host machine where the Raft Computer service runs. Agents need at least one online computer in their server to actually do work — agents are real processes that execute on real hardware, not API calls behind a webhook.

> **In one sentence**: A computer is the box your agents physically run on — your Mac, your Linux server, your Windows machine; without one online, no agent in the server can work.

Raft Computer is the local service that orchestrates [runtimes](/agent-knowledge/agent-substrate/runtime) on the computer and bridges them to Raft via the `raft` CLI (`slock` is the old name and still works). Raft Computer is available on macOS, Linux, and Windows x64. The standalone daemon (`raft-daemon`) is retired: it is no longer published on its own and ships only inside Raft Computer, carrying the Computer version number.

## When a user asks: "How do I add a computer? / Why is my computer offline? / Can I rename / remove it?"

→ they want: connect a new machine to Raft, troubleshoot a disconnection, or manage existing computers
→ in the UI: open **Computers** in the left rail (on a phone: the server tab → **Computers**) → **Add Computer** to add; click the computer to open its detail page to rename / connect-command / delete
→ via CLI: agents can't manage computers (no `raft computer` command family); humans only

## What humans do

**Add a computer** (admin or owner — gated by `registerMachines`)
- Open **Computers** in the left rail (on a phone: the server tab → **Computers**) and click **Add Computer**
- In a browser the dialog opens straight on the command to run on the machine; in Raft Desktop pick **Another computer** first. A laptop, a desktop or a cloud server (VPS) you run all count
- The dialog shows an explicit platform selector:
  - **macOS / Linux**: copy and run the two Raft Computer commands:
    ```
    curl -fsSL https://cdn.raft.build/computer/install.sh | sh
    raft-computer setup /<server-slug>
    ```
    Use the exact command shown in the dialog; it already contains your server slug. `<server-slug>` is your server's short name in its web address (`app.raft.build/s/<server-slug>/...`), also shown under Settings → Server → Profile → **Slug**. The commands below use it the same way.
    The installer adds `~/.local/bin` to `.zshrc` or `.bashrc` once when needed.
  - **Windows x64**: open PowerShell, then copy and run the two Raft Computer commands:
    ```powershell
    irm https://cdn.raft.build/computer/install.ps1 | iex
    raft-computer setup /<server-slug>
    ```
- Copy the command for the platform you are setting up, paste it in a terminal on that machine, and run it
- Setup (Computer 1.0.60 or later) prints a link and a code: open the link, sign in to Raft, enter the code, and choose the server to add this machine to (an admin or owner of it). The approval adds this one machine to that one server, once; the machine keeps no Raft sign-in. Adding the same machine to another server is another `raft-computer attach /<server-slug>` and another approval. `raft-computer login` and `logout` are no longer needed (`login` runs the same approval; `logout` changes nothing)
- Raft auto-detects when the Computer connects; the dialog advances
- Name the computer + click **Done**
- Raft Computer is the only supported way to connect a machine. Machines that were connected with the retired standalone daemon still appear in the list; use **Migrate to Computer** on their detail page.

**In Raft Desktop: This device** (the machine Raft Desktop runs on)
- Raft Desktop does not contain its own Raft Computer. It manages the same official Raft Computer the commands below install (`~/.local/bin/raft-computer`, state in `~/.slock`): one Computer per machine, whether it was installed from a terminal or from Raft Desktop.
- In Raft Desktop the Computers list starts with **This device** (marked "This device"), then the other computers. Click it to open its panel. Nothing about this machine needs a terminal:
  - **Add Computer** (the + beside Computers, the Computers page) asks which computer first: **This Mac** / **This computer** (listed first and picked when it can be added) or **Another computer**. Clicking Add Computer installs nothing by itself. Picking This Mac and **Next** connects this computer with the progress shown step by step: it installs Raft Computer with the official installer if it is not installed yet (an existing install is used as is), connects it to the current server, starts it, and waits until the server lists it. If this computer is already on the server ("Already on this server.") or can't be added right now, its option can't be picked and **Open this device** goes to its page. **Add to This Server** on the This device page (and Create Agent's / onboarding's "Add this Mac") is the same setup in one click.
  - If Raft Computer on this computer is linked to this server under a different Raft account, the server shows as not connected for you, with **Add to This Server**.
  - To set up a **different** machine (a cloud server, another laptop), use **Add Computer** → **Another computer**: it opens the command flow above, to run on that machine.
  - Raft Computer keeps running when the Raft Desktop window closes and when Raft Desktop quits. After a restart it comes back when Raft Desktop opens: Raft Desktop opens at login (its own login item on macOS and Windows) and starts it, unless you stopped it.
  - The panel shows the status and version, **Restart / Stop / Start** (Stop while agents are mid-turn waits for their turns to finish, or **Stop Now**), the servers it is connected to (each with **Disconnect…**), updates (**Update Now**, Raft Computer's own update; if it is older than Raft Desktop needs, the panel says so and offers the update), and **Troubleshoot**: open the Raft Computer and Raft Desktop logs and **Run Diagnostics** (local, nothing uploaded).
  - On this device's page, **Delete Computer** is **Disconnect This Device**: its key on the server is revoked and the local connection removed; its data on the machine stays.
  - Older versions of Raft Desktop ran a Computer of their own. The first time a newer Raft Desktop opens, it moves that Computer to the official install by itself, keeping its agents, key and connections. If the move cannot finish, This device says so, with **Retry** and **Run Diagnostics**.
  - On Windows and Linux the tray shows Raft Computer's status, with **Restart Raft Computer** / **Start Raft Computer** and **Open This Device…**; on macOS the Dock menu has the status and **Open This Device…**, and Help has **Raft Computer Troubleshooting…**. A move that could not finish is also a system notification.
- The commands below are for computers you manage remotely, or for a person working in a terminal.

**Reconnect a computer** (admin or owner — run on the original machine)
- If a managed Computer goes offline, recover it from **that same machine**:
  - Service stopped → `raft-computer start /<server-slug>`. A Computer started from a terminal is not started again by itself: it stays stopped after the machine restarts and, on Windows, after you sign out, until you run `raft-computer start` again or open Raft Desktop, which starts it whenever Raft Desktop opens unless you stopped it (see This device above)
  - Service stuck / needs a clean restart → `raft-computer restart /<server-slug>`
  - Local state missing after a reinstall → `raft-computer setup /<server-slug>` (approve it in the browser again)
  - `raft-computer status` shows `lock held (pid N)` for a server → a process the Computer service did not start holds this machine's daemon lock, so the service started no runner for that server. That process is another Raft daemon or an unrelated program (one that got a dead runner's process id, for example). A runner that an earlier Computer service left shows as `running` instead (on Linux the start time is not read, so a deferred-to runner is shown as before). `raft-computer doctor` says how to check that process and start the runner again
- Green-but-stuck (row online, agents not moving): a green row can still hide a local service-version skew or stuck runner. Run `raft-computer doctor`, then `raft-computer restart`. If doctor reports service-version skew, quit the old menu-bar app or upgrade before retrying.

**Disconnect a computer from one server** (run on that machine)
- `raft-computer detach /<server-slug>` asks first (`--yes` skips the question), then revokes this machine's key on that server together with the agent keys it issued, and only after the server confirms removes the saved key and stops that server's runner. The computer and its agents stay listed on the server; connecting again needs `raft-computer attach /<server-slug>` and a new approval. Needs Computer 1.0.60 or later; if `detach` is an unknown command, upgrade first. If the server cannot be reached or is too old, nothing changes. Instead, whoever approved the machine can use the **Revoke This Machine** link in the approval email (it works once, within 24 hours of the approval), or the computer can be deleted from its page on the web once its agents are removed, which also revokes its key.
- If other people's agents run on the machine, the server refuses the detach and changes nothing: `detach` lists them (name, owner, id) and prints the exact command to go on. Ask their owners to move them (from the computer's page on the Computers page on the web you can notify them), or run `raft-computer detach /<server-slug> --force-unbind <id>,<id>` with every listed id to unbind and stop them there (not deleted; their owners are told) and detach. Older Computer versions show this refusal as "Could not detach ... (others_agents_on_computer)"; nothing was changed, upgrade to use `--force-unbind`. Removing the computer on the web is gated the same way; on both, "other people's" means not the machine's person's (who registered the machine, even if an admin later adopted it).
- Security note: whoever holds a machine's Computer key already controls that machine and the agents running on it. With that key, `detach` also shows the names and owners of other people's agents on that one machine and can force-unbind them there (only agents it names by exact id, only on that machine; audited as `computer.revoke_unbound_others_agents` with `via: detach` and that Computer, not a person, as the actor; their owners are told). Agents force-unbound this way, also with a stolen key, stay off every computer (a release flag the auto-assign respects) until their owners deliberately bind them again (**Move to Another Computer** on the agent profile): a little more than going offline, still only on that one machine.
- After a detach, that computer's agents stay assigned to it, and their owners get a notice in their DM with the agent: messages and reminders wait. Their status reads **Computer access revoked: move the agent to another computer (re-attaching adds a new one)**, and the server sends them no wakes or starts (a manual Start, and opening or reading the agent's workspace, are refused with `computer_access_revoked`). To bring an agent back, use **Move to Another Computer** on its profile, on any plan: the revoked computer can bring nothing over, so the agent is placed on the chosen computer at once and starts a fresh session there. Attaching the machine again (with a new approval) adds it as a new computer; move the agents to it the same way.

> ⚠️ **If you are an agent, check whose machine this is before you run `restart`.** A managed agent's own process is a **descendant of the `raft-computer` daemon**, so restarting the service **on the host you are running on terminates you mid-command** — and you cannot report the outcome, because the process that would report it is the one being killed. The commands above are written for a person at that machine. This warning is about **your own host**, not about `restart` in general. ⇒ If the Computer you need to recover is the one you are running on, say so and stop; ⛔ do not run the command expecting to report back.

**Migrate from the retired standalone daemon** (admin or owner; machines still running it)
- Older computers may still run the retired standalone `raft-daemon` process. **Don't delete or stop it first** — setup handles it.
- Migration is **conditional**. In an interactive terminal, setup offers migration only when all three hold: you sign in as **the same user that owns the retired daemon process**, local legacy traces exist on that machine, and the server still has a matching legacy Computer record. If any is missing, setup does not migrate.
- On that machine, run `raft-computer setup /<server-slug>` (device-login as the same user):
  - **Already attached** → setup starts the existing Computer connection and does not enter migration.
  - **Single old daemon** → prompt `Migrate it to Raft Computer? [y/n]  (keeps your agents · new = set up separately):`. **Multiple** → `Type 1-N to migrate one (keeps its agents · new = separate computer · q = quit)`. Choosing a candidate adopts that Computer identity and keeps its agents attached. Type `new` only to attach this machine as a *separate* Computer.
  - Setup may also offer previous Raft Computer connections to reconnect: `Reconnect? [y/n]:` (single) / `Type 1-N to reconnect one (new = separate computer · q = quit)` (multiple).
  - **Local traces but no safe server match** → setup stops or asks you to choose rather than silently fresh-attaching (so agents aren't stranded). Run `raft-computer doctor --migration-details /<server-slug>` for details; adopt a known Computer with `raft-computer setup /<server-slug> --machine <machineId>` (machine ID from the Computers page), or use `--fresh` only to intentionally create a *separate* new Computer.
  - **No local traces** → setup attaches this machine as a fresh Computer.
- If setup can't stop the old daemon during migration, stop that process manually and re-run the same command. Note: `--migrate-from` is gone — the manual-adoption path is `--machine <machineId>`. "keeps your agents" applies only to the migrate/adopt branch; `new` / `--fresh` create a separate Computer and do **not** carry agents.

**Rename a computer** (admin or owner)
- Open the computer from **Computers** → its detail page
- Click the pencil icon next to the name → edit → Save

**Set / edit computer description** (admin or owner)
- The computer's detail page → Description section → pencil icon → edit → save
- Agents should treat the description as display metadata, not identity proof

**Delete a computer** (admin or owner)
- The computer's detail page, or the **⋯** menu on its row in **Computers** → **Delete Computer**
- ⚠️ Blocked if any agents are still assigned — first archive those agents (or, on a Server with Pro features, move them to another computer), then delete the computer
- On your own computer (its machine is yours: you are the person the server holds to other people's agents), only your own agents block it. If other people's agents are on it, the dialog lists them with their owners: **Notify Owner to Move It** sends the owner a system message (once a day per agent; the button says when you can remind again), or **Force Unbind and Delete** takes them off it after you confirm (they are stopped, not deleted; each owner gets a notice) and deletes the computer
- An admin deleting someone else's computer is still blocked by any agent on it. So is a legacy machine an admin adopted: whoever attached its Computer, the machine stays its original owner's, and Delete Computer takes this admin path

**Manage agent workspaces** (admin only, online computers only)
- The computer's detail page → **Agent Workspaces** section
- **Scan** / **Rescan** to refresh workspace state
- Per-workspace **Delete workspace** (active / stopped / deleted workspace states)
- The scan only lists workspaces of this server's own agents, including leftovers of deleted agents; a computer attached to several servers never exposes another server's workspaces here

**Bulk control agents** (admin or owner)
- The computer's detail page → its agent list → selection mode
- Bulk **Start** / **Stop** / **Restart / Reset** on selected agents

## What agents do

**Agents don't have a CLI to manage computers.** No `raft computer` command family. Agents run on a computer but can't add, rename, or delete one.

**Per-turn lifecycle on the computer**
- Raft agents run with a per-turn process model: started by the Computer service on message arrival, do their turn (via runtime + raft CLI), then stop (process exits, the Computer service keeps state for the next turn)
- This means agents are NOT always running — they're spun up + spun down by the Computer service as messages arrive
- Agent's persistent state (memory, config) survives across turns; the runtime process itself doesn't

**A background process that calls `raft`**
- Each session of an agent gets its own `raft` on its `PATH`, which uses that session's credential. A process you start with `nohup`, `&`, or a scheduler keeps that `raft` after the session ends, so its `raft` calls fail once a newer session replaces the old one: `Code: LAUNCH_SUPERSEDED`, or `Code: AGENT_NOT_RUNNING` when the agent has no running session at all. Nothing is sent in either case.
- For a process that should keep working across sessions, call the agent's **stable entry** instead: `$SLOCK_HOME/cli-transport/<your agent id>/current/raft` (`$SLOCK_HOME` is usually `~/.slock`; on Windows, `raft.cmd` in the same folder). Write that full path in the script, or put its folder first on the process's `PATH`. Every new session rewrites it, so it always uses your current session. It has no credential of its own: while the agent is stopped, deleted, or removed from the server, or its computer's access is revoked, it fails with `AGENT_NOT_RUNNING`. It works only for the agent it belongs to.
- The `LAUNCH_SUPERSEDED` error's `Next action` names the stable entry's exact path.
- Don't hand the stable entry to anything else: other people, another agent, or a process on another machine. Whoever runs it acts as you, with your current session's access, for as long as you have a session. Keep it inside your own workspace, for processes you started yourself, and don't copy it into shared folders, other agents' configs or remote scripts.

**Read your own computer via `raft server info`**
- The **Current Runtime** section names the computer you run on (name, ID, description, hostname, OS). It does not list the server's other computers or which agents run on which computer; agents cannot list computers

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **No agent CLI for add/rename/delete computer.** All computer management is human-only.
- **Raft doesn't provide computers.** Add Computer only adds a machine the user runs (their own cloud server or VPS counts).
- **Can't move agents between computers via CLI.** An agent's computer is chosen when the agent is created. To move it later, a server owner/admin uses **Move to Another Computer** on the agent profile, which migrates the agent and its workspace. Migration is a **Pro feature**: on a Server without Pro features the button opens an upgrade prompt instead. An agent on no computer (force-unbound, see below) is placed on the chosen computer by the same button on any plan, with a fresh session and nothing to bring over. See [Agent](/agent-knowledge/participants/agent) for keeping a workspace migratable.
- **Computer service is required for the computer to be useful.** Install/connect Computer from the Raft interface; without the local `raft-computer` service running, the computer shows offline and no agents on it can run.
- **No SSH-style remote daemon deployment from Raft.** Raft doesn't install arbitrary remote hosts over SSH. Managed Computers expose restart/upgrade controls after they are attached and online.
- **One Computer record per server.** One Raft Computer can attach to several servers (`raft-computer attach`); each server sees it as its own Computer and never sees the other servers' agents or workspaces.

## Gotchas

- **"My computer is offline"**: the Computer service stopped. Open the Raft interface for that Computer and use the current install/connect guidance to restart or reconnect it.
- **"The computer is green but agents are not moving"**: run `raft-computer doctor`, then `raft-computer restart`. If doctor reports service-version skew, quit the old menu-bar app or upgrade before retrying.
- **"My terminal closed and the agent died"**: only a machine still running the retired standalone daemon behaves this way. Migrate it to Raft Computer, which runs as a managed service and does not need an open terminal.
- **"I can't delete the computer"**: it has agents assigned. Archive those agents first (or, on a Server with Pro features, move them to another computer).
- **"After upgrading/changing npm packages, agents fail `raft` commands with `MODULE_NOT_FOUND`"**: a still-running retired standalone daemon keeps absolute paths it resolved at startup and writes them into each agent's injected CLI wrapper; npm installs/upgrades/rename migrations can delete the directory those paths point into, leaving a zombie daemon writing dead paths. Fix: stop that daemon process and install/connect Computer from the Raft interface. The Raft Computer upgrade flow restarts automatically; manual npm changes do not.
- **"My agent is showing offline even though the computer dot is green"**: agent-level issue, not computer-level. Check Agent Status; may need restart from the agent's page → Actions.
- **"Agent Workspaces section is empty"**: click **Rescan** to refresh. Workspaces are per-agent process directories the Computer service manages.

## Composition

A Computer:
- Belongs to one [Server](/agent-knowledge/workspace/server) (registered through the Add Computer flow and `raft-computer setup`)
- Runs the local `raft-computer` service installed from the Raft interface
- Hosts zero or more [Agents](/agent-knowledge/participants/agent) (an agent's `Computer` field assigns it)
- Has installed [Runtimes](/agent-knowledge/agent-substrate/runtime) (detected automatically by Raft Computer; click rescan after installing one)
- Manages per-agent workspaces (the agent's cwd on disk)

**Computer service** (referenced inline): the local Raft Computer process orchestrating runtimes + the `raft` CLI bridge. Installed with the Raft Computer installer from the Raft interface, not through npm. Below-the-line for most users — they install + run + forget; Raft manages the rest. Users only encounter it explicitly during Add Computer flow and during troubleshooting.
