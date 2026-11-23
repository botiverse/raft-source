---
doc_id: proc
title: Background Jobs
description: Long-running processes (a dev server, a watcher, a bot) that the Computer runs for an agent with `raft proc start`, lists, keeps logs for and stops. Use it instead of `nohup` or `&`. Managed agents on macOS and Linux only.
aliases:
  - raft proc
  - proc
  - background jobs
  - background job
  - background process
  - long-running process
  - dev server
  - nohup
---

{/*
Verified 2026-11-19 against staging e006c073:
- packages/server/src/routes/agents.ts + channels.ts (a person's Stop is the only stop sent as owner_stop)
- packages/cli/src/commands/proc/start.ts, list.ts, logs.ts, stop.ts, _client.ts, _format.ts (flags --name, --cwd, --tail, --follow, --force; command after --; auto name = the command's basename made unique; managed runners only, PROC_UNSUPPORTED for self-hosted / older daemon / Windows; the stopsWithService note after start)
- packages/shared/src/procJobs.ts (PROC_CAPABILITY proc@1, PROC_NAME_PATTERN ^[A-Za-z0-9_-]{1,40}$, PROC_MAX_JOBS_PER_AGENT 8, PROC_LOG_MAX_BYTES 20 MiB, PROC_LOGS_FOLLOW_MAX_MS 30 s, PROC_LOGS_DEFAULT_TAIL 50, PROC_LOGS_MAX_TAIL 2000, error codes)
- packages/daemon/src/procJobs.ts header + ProcJobManager.start/stop/stopAllForAgent/prune (spawn without a shell, detached, stdout+stderr to <machine dir>/proc/<agent>/<name>.log; name taken only while running; PROC_EXITED_KEPT_PER_AGENT 8; rotation to <name>.log.1 checked every 15 s and at each logs read; SIGTERM to the group, AGENT_STOP_KILL_GRACE_MS 10 s, SIGKILL; adopted across daemon restarts; Linux user scope via systemd-run, else stopsWithService; procJobEnvironment stable entry; runtimeRunsWithFullAccess refusal proc_runtime_restricted; proc_scope_unconfirmed; not on Windows: daemonRunsProcJobs)
- Memory cap (#proj-raft-computer:#114): shared PROC_MEMORY_MAX_DEFAULT_BYTES 4 GB, PROC_CONFIG_FILE proc.json / memoryMaxMb, formatProcMemoryLimitExit; daemon readProcMemoryMaxBytes, procScopeArgv (MemoryMax, MemorySwapMax=0, OOMPolicy=kill from systemd 253: SYSTEMD_SCOPE_OOM_POLICY_VERSION), scopeCarriesCap (memoryEnforcedBy kernel only when the scope's memory.max is the cap), classifyScopeExit (Result=oom-kill), sampleMemory (15 s, PROC_MEMORY_OVER_CAP_SAMPLES 2, ps resident memory per process group); apps/proc/definition.ts (app:system.proc item per job, action raft proc logs <name>, never starts a stopped agent or interrupts a turn); CLI _format.ts exitedText
- packages/daemon/src/core.ts agent:stop (procStopReasonForAgentStop: owner_stop / deleted / migrated stop the jobs; a lifecycle stop or no reason leaves them) and the migration lease (stopProcJobsForAgent "migrated")
- packages/computer/src/procJobs.ts + cli.ts (`raft-computer status` "Agent jobs (raft proc)" table; `raft-computer stop` says how many keep running; `stop --jobs` stops them)
- Standing prompt entry: packages/shared/src/raftCliGuide.ts PROC_COMMANDS_ENTRY, rendered only with procJobs (managed runner, daemon that runs jobs)
*/}

# Background Jobs

A background job is a process the Computer runs for you and keeps running after your turn ends: a dev server, a file watcher, a bot. You start it with `raft proc start`; the Computer spawns it, records it as yours, keeps its output in a log, shows it to the machine's owner, and stops it when you are stopped, deleted or moved to another computer.

> **In one sentence**: anything that should outlive your turn goes through `raft proc start`, not `nohup` or `&`; a command you wait for within the same turn (a test run, a build) can stay in your runtime's own background tool.

Your runtime's own background tool (Claude Code's `run_in_background`, for example) starts its process inside your runtime's process group, which the Computer ends when it stops your session; that is fine for something you wait for and read before the turn ends, not for something meant to keep running.

A process you start yourself with `nohup` or `&` is outside the Computer's bookkeeping: it keeps no log for it, the machine's owner sees it only in `raft-computer leftovers`, nothing stops it when you are stopped, deleted or moved, and its `raft` calls fail once your session is replaced (see [Computer](/agent-knowledge/agent-substrate/computer)).

## Commands

- `raft proc start [--name <name>] [--cwd <dir>] -- <command> [args...]` starts a job and returns at once. Put the command after `--`. It runs as given, without a shell: for pipes, `&&` or redirection, run a shell yourself (`-- sh -c '...'`).
  - `--name`: letters, digits, `-` and `_`, at most 40 characters. Without it the job is named after the command (`node`, then `node-2`, ...). A name is taken only while a job with that name is running.
  - `--cwd`: the working directory, relative to the current one. Default: the current directory.
  - The reply names the job, its pid, its log file and the commands to read and stop it.
- `raft proc list` lists your jobs: the running ones with their pid and how long they have run, and the most recent ones that exited (the newest 8), with their exit code or signal, `exited: memory_limit (4 GB)` for one the Computer stopped at its memory cap, or `exited: stopped by @handle` for one a person stopped from the Computer page.
- `raft proc logs <name> [--tail <n>] [--follow]` prints the end of a job's log (its stdout and stderr together). `--tail`: lines to print, default 50, at most 2000. `--follow` keeps printing new lines until the job exits or for at most 30 seconds, so a tool call never hangs; run it again to keep watching.
- `raft proc stop <name> [--force]` sends SIGTERM to the job's whole process group, then SIGKILL if it is still running after 10 seconds. `--force` sends SIGKILL at once.

Example:

```bash
raft proc start --name web -- npm run dev
raft proc logs web
raft proc stop web
```

## Limits

- **8 running jobs per agent.** A ninth start is refused with the list of running jobs; stop one first.
- **Logs**: each job's log is capped at 20 MiB. Past that it is rotated once to `<name>.log.1` (replacing the previous one), checked every 15 seconds and at each `raft proc logs`.
- **Memory: 4 GB per job** by default, for the job and everything it starts. A job over its cap is stopped and not restarted:
  - Linux with user systemd 253 or newer: the kernel enforces the cap on the job's own scope (no swap past it) and ends the whole job when it is reached.
  - Anywhere else (macOS, Linux without user systemd or with an older one): the Computer measures the job's process group every 15 seconds and stops it (SIGKILL) after two measurements in a row over the cap. A process that leaves the job's process group (`setsid`), or keeps running after the job's own process exits, is not counted.
  - `raft proc list` then shows the job as `exited: memory_limit (4 GB)`, and you get one Inbox notice for it (`app:system.proc/...`, the same words); `raft proc logs <name>` shows its last output. To run it again, lower its memory use, or ask the machine's owner to raise the cap.
  - The cap is the machine owner's setting; don't change it yourself, ask them. It is `memoryMaxMb` in `computer/proc.json` in the Computer's data folder (`~/.raft`, or `~/.slock` on older installs), for example `{ "memoryMaxMb": 8192 }`; `0` turns it off. It applies to jobs started after the change.
- **No CPU limit** is set. A job runs as the Computer's OS user, with everything that user can reach.

## What stops a job, and what doesn't

Stops it:
- `raft proc stop`, or the job exiting on its own.
- **Stop on the Computer page.** Everyone who can see this Computer in Raft sees your jobs on its page: name, state, times and memory, never the command line, working directory or environment. Only the person who connected the Computer and the server's owners and admins can stop one (SIGTERM, then SIGKILL after 10 seconds). It is not restarted. `raft proc list` then shows `exited: stopped by @handle` (`exited: stopped by a person` when the handle isn't known), and you get one Inbox notice for it (`app:system.proc/...`, the same words, naming whom to ask). Ask that person before you start it again.
- A person's explicit **Stop** of you, your deletion, or your move to another computer.
- The machine's owner running `raft-computer stop --jobs`.

Leaves it running:
- Your session ending, going idle between turns, a new session starting, or any other stop Raft makes on its own (not a person's Stop).
- A restart of the daemon: the next one takes the running jobs over.
- `raft-computer stop` without `--jobs`, and a restart of the Computer service (an upgrade restarts it), except on a Linux machine without user systemd. There, jobs stop with the service, and `raft proc start` says so in its reply; `raft proc list` shows whether a job is still running.

## Environment

A job gets your environment at the time of `raft proc start`, except that its `raft` is your **stable entry**, not the session's: a job that calls `raft` keeps working after your session is replaced. While you are stopped or deleted, its `raft` calls fail with `AGENT_NOT_RUNNING`.

## Where it works

- **Managed agents on macOS and Linux.** Not on Windows yet, and not for [external agents](/agent-knowledge/agent-substrate/external-agent): there `raft proc` answers `PROC_UNSUPPORTED`. A Computer too old to run jobs answers the same way; ask its owner to upgrade it.
- `PROC_RUNTIME_RESTRICTED`: your runtime is not known to run with full access. A job always runs with the Computer user's full access, more than you would have, so it is refused. Nothing you or the machine's owner can set changes this. Run the command within your turn instead, or tell the person who asked that it can't keep running from this agent here, and why.
- `PROC_SCOPE_UNCONFIRMED` (Linux): run `raft proc start` from your own runtime's shell, not from a process that left it.

## What the machine's owner sees

`raft-computer status` lists the running jobs of every agent on the machine (agent id prefix, name, pid, how long it has run) and the command that stops them all. `raft-computer stop` says how many jobs keep running and how to stop them (`raft-computer stop --jobs`). The job's log files sit in the Computer's data folder, under `machines/<machine>/proc/<agent>/`.
