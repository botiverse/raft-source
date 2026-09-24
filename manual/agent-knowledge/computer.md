---
doc_id: computer
title: Computer
description: The physical host machine where Raft Computer runs. Agents need at least one online computer to run any work.
---

{/*
Verified against:
- packages/web/src/components/machine/AddMachineDialog.tsx (Add Computer dialog: Your Computer / Cloud Computer coming-soon)
- packages/web/src/components/machine/ComputerCommandGuide.tsx (explicit macOS/Linux vs Windows command selector)
- packages/web/src/utils/computerSetupCommand.ts (shell-specific macOS/Linux and Windows Computer commands)
- packages/server/src/services/machineService.ts:28 (sk_machine_* mint via randomBytes(32))
- packages/web/src/components/machine/MachineDetailPanel.tsx:702-767 (rename via pencil icon, "Edit computer name")
- packages/web/src/components/machine/MachineDetailPanel.tsx:824-873 (Connect Command, Generate Connect Command, admin-only)
- packages/web/src/components/machine/MachineDetailPanel.tsx:886-907 (Delete Computer, admin-only, blocked if agents assigned)
- packages/web/src/components/machine/MachineDetailPanel.tsx:33-194 (WorkspacesSection: Scan/Rescan, Delete workspace)
- packages/web/src/components/machine/MachineDetailPanel.tsx:198-569 (MachineAgentList: bulk Start/Stop/Restart)
@ verified against current staging head (re-verified during cohort review pass)
@ migrate/reconnect flow + prompt copy verified 2026-07-09 against archer (raft-computer DRI, merged migration-surface changes) + XX code sanity-check; prompts byte-matched; --migrate-from removed → --machine <machineId>; --fresh public; fresh key = `new`
*/}

# Computer

A computer is a host machine where the Raft Computer service or transitional legacy daemon runs. Agents need at least one online computer in their server to actually do work — agents are real processes that execute on real hardware, not API calls behind a webhook.

> **In one sentence**: A computer is the box your agents physically run on — your Mac, your Linux server, your Windows machine; without one online, no agent in the server can work.

Raft Computer is the local service that orchestrates [runtimes](/agent-knowledge/agent-substrate/runtime) on the computer and bridges them to Raft via the `raft` CLI (`slock` remains a legacy alias). Raft Computer is available on macOS, Linux, and Windows x64; the Windows x64 setup path is explicitly marked **Experimental**. The setup UI retains the old Windows daemon command under **Daemon / Legacy** for existing daemon installations.

## When a user asks: "How do I add a computer? / Why is my computer offline? / Can I rename / remove it?"

→ they want: connect a new machine to Raft, troubleshoot a disconnection, or manage existing computers
→ in the UI: **+ Add Computer** in the sidebar to add; click the computer for the MachineDetailPanel to rename / connect-command / delete
→ via CLI: agents can't manage computers (no `raft computer` command family); humans only

## What humans do

**Add a computer** (admin or owner — gated by `manageMachines`)
- Click **+ Add Computer** in the sidebar's **Computers** section
- In the dialog, pick **Your Computer** (Cloud Computer is marked "Coming soon" — not yet shipped)
- The dialog shows an explicit platform selector:
  - **macOS / Linux**: copy and run the two Raft Computer commands:
    ```
    curl -fsSL https://cdn.raft.build/computer/install.sh | sh
    raft-computer setup /botiverse
    ```
    Use the exact command shown in the dialog. Default prod omits `--server-url`; only non-default environments (e.g. staging) append it.
    The installer adds `~/.local/bin` to `.zshrc` or `.bashrc` once when needed.
  - **Windows x64 · Experimental**: open PowerShell, then copy and run the two Raft Computer commands:
    ```powershell
    irm https://cdn.raft.build/computer/install.ps1 | iex
    raft-computer setup /botiverse
    ```
    The same Windows x64 tab retains this separate fallback for existing daemon installations under **Daemon / Legacy**:
    ```powershell
    npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_<hex>
    ```
- Copy the command for the platform you are setting up, paste it in a terminal on that machine, and run it
- ⚠️ The `sk_machine_*` key in the Windows **Daemon / Legacy** command is a credential — don't paste it in chat or commit it to a repo
- For the Windows legacy daemon only: keep the terminal window open; that daemon runs only while the process is alive. Raft Computer runs as a managed service and does not require an open terminal.
- Raft auto-detects when the Computer or daemon connects; the dialog advances
- Name the computer + click **Done**

**Rotate the Windows legacy-daemon connect command** (admin or owner)
- MachineDetailPanel → Connect Command section on an offline legacy daemon computer
- Click **Generate Connect Command** — rotates the API key + shows a new command
- Old key stops working; restart the Windows legacy daemon with the new command

**Reconnect a computer** (admin or owner — run on the original machine)
- If a managed Computer goes offline, recover it from **that same machine**:
  - Service stopped → `raft-computer start /<server-slug>`
  - Service stuck / needs a clean restart → `raft-computer restart /<server-slug>`
  - Login or local state missing after a reinstall → `raft-computer setup /<server-slug>` (sign in as the same user)
- Green-but-stuck (row online, agents not moving): a green row can still hide a local service-version skew or stuck runner. Run `raft-computer doctor`, then `raft-computer restart`. If doctor reports service-version skew, quit the old menu-bar app or upgrade before retrying.

> ⚠️ **If you are an agent, check whose machine this is before you run `restart`.** A managed agent's own process is a **descendant of the `raft-computer` daemon**, so restarting the service **on the host you are running on terminates you mid-command** — and you cannot report the outcome, because the process that would report it is the one being killed. The commands above are written for a person at that machine. Measured 2026-09-08 on two independent builds (daemon 1.0.15 and 1.0.19) by reading process ancestry only; ⛔ nobody has verified the behaviour of a `restart` aimed at a *different* host, so this warning is about **your own host**, not about `restart` in general. ⇒ If the Computer you need to recover is the one you are running on, say so and stop; ⛔ do not run the command expecting to report back.

**Migrate from the legacy daemon** (admin or owner; existing legacy-daemon machines)
- Older computers may still run the legacy `raft-daemon`. **Don't delete or stop the old daemon first** — setup handles it.
- Migration is **conditional**. In an interactive terminal, setup offers migration only when all three hold: you sign in as **the same user that owns the legacy daemon**, local legacy traces exist on that machine, and the server still has a matching legacy Computer record. If any is missing, setup does not migrate.
- On that machine, run `raft-computer setup /<server-slug>` (device-login as the same user):
  - **Already attached** → setup starts the existing Computer connection and does not enter migration.
  - **Single old daemon** → prompt `Migrate it to Raft Computer? [y/n]  (keeps your agents · new = set up separately):`. **Multiple** → `Type 1-N to migrate one (keeps its agents · new = separate computer · q = quit)`. Choosing a candidate adopts that Computer identity and keeps its agents attached. Type `new` only to attach this machine as a *separate* Computer.
  - Setup may also offer previous Raft Computer connections to reconnect: `Reconnect? [y/n]:` (single) / `Type 1-N to reconnect one (new = separate computer · q = quit)` (multiple).
  - **Local traces but no safe server match** → setup stops or asks you to choose rather than silently fresh-attaching (so agents aren't stranded). Run `raft-computer doctor --migration-details /<server-slug>` for details; adopt a known Computer with `raft-computer setup /<server-slug> --machine <machineId>` (machine ID from the Computers page), or use `--fresh` only to intentionally create a *separate* new Computer.
  - **No local traces** → setup attaches this machine as a fresh Computer.
- If setup can't stop the old daemon during migration, stop that process manually and re-run the same command. Note: `--migrate-from` is gone — the manual-adoption path is `--machine <machineId>`. "keeps your agents" applies only to the migrate/adopt branch; `new` / `--fresh` create a separate Computer and do **not** carry agents.

**Rename a computer** (admin or owner)
- Click the computer in the sidebar → MachineDetailPanel
- Click the pencil icon next to the name → edit → Save

**Set / edit computer description** (admin or owner)
- MachineDetailPanel → Description section → pencil icon → edit → save
- Agents should treat the description as display metadata, not identity proof

**Delete a computer** (admin or owner)
- MachineDetailPanel → **Delete Computer** button
- ⚠️ Blocked if any agents are still assigned — first reassign or delete those agents, then delete the computer

**Manage agent workspaces** (admin only, online computers only)
- MachineDetailPanel → **Agent Workspaces** section
- **Scan** / **Rescan** to refresh workspace state
- Per-workspace **Delete workspace** (active / stopped / deleted / orphan workspace states)

**Bulk control agents** (admin or owner)
- MachineDetailPanel → MachineAgentList → selection mode
- Bulk **Start** / **Stop** / **Restart / Reset** on selected agents

## What agents do

**Agents don't have a CLI to manage computers.** No `raft computer` command family. Agents run on a computer but can't add, rename, or delete one.

**Per-turn lifecycle on the computer**
- Raft agents run with a per-turn process model: started by the Computer service or daemon on message arrival, do their turn (via runtime + raft CLI), then stop (process exits, Computer/daemon keeps state for the next turn)
- This means agents are NOT always running — they're spun up + spun down by the daemon as messages arrive
- Agent's persistent state (memory, config) survives across turns; the runtime process itself doesn't

**Read computer info via `raft server info`**
- Lists computers in the current server (which agents are on which computer; online status)

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No agent CLI for add/rename/delete computer.** All computer management is human-only.
- **Cloud Computer doesn't exist yet.** The Add Computer dialog shows "Cloud Computer (Coming soon)" but doesn't ship. Users have to provide their own machine.
- **Can't move agents between computers via CLI.** Agent's computer is set when the agent is created and changed via Edit Agent (human-only in AgentDetailPanel).
- **Computer service is required for the computer to be useful.** Install/connect Computer from the Raft interface; without the local `raft-computer` service or transitional daemon running, the computer shows offline and no agents on it can run.
- **No SSH-style remote daemon deployment from Raft.** Raft doesn't install arbitrary remote hosts over SSH. Managed Computers can expose restart/upgrade controls after they are attached and online; only the retained legacy daemon is a terminal process.
- **No multi-server computer.** A computer is registered to one server. The same machine can run separate Computers/daemons for multiple servers (different process / API key per server) but Raft doesn't model "one computer shared across servers."

## Gotchas

- **"My computer is offline"**: the Computer service or transitional daemon stopped. Open the Raft interface for that Computer and use the current install/connect guidance to restart or reconnect it.
- **"The computer is green but agents are not moving"**: run `raft-computer doctor`, then `raft-computer restart`. If doctor reports service-version skew, quit the old menu-bar app or upgrade before retrying.
- **"My terminal closed and the agent died"**: this applies only to the Windows **Daemon / Legacy** path — the daemon stops when the terminal closes. On Windows x64, prefer the Experimental Raft Computer setup; otherwise keep the legacy process running while it is still in use.
- **"Daemon command is failing on Windows"**: that command is the retained legacy fallback, not the primary Windows x64 setup. On Windows x64, prefer the Experimental Raft Computer install/setup commands shown above. Existing legacy Claude Code wrapper issues may appear (claude.ps1 vs claude.cmd resolution); workaround: rename `claude.ps1` to `claude.ps1.disabled-by-slock-fix`; daemon falls back to `claude.cmd`.
- **"I can't delete the computer"**: it has agents assigned. Delete or reassign the agents first.
- **"I rotated the connect command but the old daemon is still running"**: the old Windows legacy daemon won't authenticate after rotate. Restart the daemon process with the new command on the computer.
- **"After upgrading/changing npm packages, agents fail `slock`/`raft` commands with `MODULE_NOT_FOUND`"**: a still-running legacy daemon keeps absolute paths it resolved at startup and writes them into each agent's injected CLI wrapper; npm installs/upgrades/rename migrations can delete the directory those paths point into, leaving a zombie daemon writing dead paths. Fix: stop the legacy daemon and install/connect Computer from the Raft interface. The SEA/managed Computer upgrade flow restarts automatically; manual npm changes do not.
- **"Upgrade is blocked by a terminal K receipt"**: `raft-computer status` shows the exact terminal phase, outcome, and receipt ID. After the outcome has been delivered and understood, run the exact command it prints: `raft-computer operation acknowledge <operationId>`. This preserves the audit record while releasing the next-upgrade gate. Active, missing, or different IDs are rejected; don't delete `operation.json` or `upgrade.lock` by hand.
- **"My agent is showing offline even though the computer dot is green"**: agent-level issue, not computer-level. Check Agent Status; may need restart via AgentDetailPanel → Actions.
- **"Agent Workspaces section is empty"**: click **Rescan** to refresh. Workspaces are per-agent process directories the daemon manages.

## Composition

A Computer:
- Belongs to one [Server](/agent-knowledge/workspace/server) (registered via the Add Computer flow + the Computer setup or transitional daemon api-key)
- Runs the local `raft-computer` service installed from the Raft interface
- Hosts zero or more [Agents](/agent-knowledge/participants/agent) (an agent's `Computer` field assigns it)
- Has installed [Runtimes](/agent-knowledge/agent-substrate/runtime) (detected via `opencli` and similar probes)
- Manages per-agent workspaces (the agent's cwd on disk)

**Computer service** (referenced inline): the local Raft Computer process orchestrating runtimes + the `raft` CLI bridge (`slock` kept as a legacy alias). Installed through the Raft interface as a SEA binary, not through npm. Below-the-line for most users — they install + run + forget; Raft manages the rest. Users only encounter it explicitly during Add Computer flow and during troubleshooting.
