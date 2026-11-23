# "On this computer" checks

Read-only checks shipped with the Computer: fixed `--version` commands and
declared keys of a few local config files. The server can only switch a check
on or off; it never sends commands, arguments or paths. Entry point:
`runComputerChecks` (`runner.ts`); the guarded command/file access is in
`context.ts` and `declaredFile.ts`; the wiring to the server is `service.ts`.
Wire contract and server side:
[docs/contracts/computer-checks.md](../../../../docs/contracts/computer-checks.md);
the report's types live in `@botiverse/raft-shared` (`computerChecks.ts`) and
`types.ts` re-exports them.

## Wiring

The daemon advertises `computer-checks@1`. A server sends
`computer:checks:config` (its switch per check) on `ready` and before every
`computer:checks:refresh`; a refresh before that connection's config is
ignored, so an older server never gets a report. Nothing runs on a timer.

A Computer runs one runner per server on one RAFT_HOME, and one round serves
them all (`service.ts`):

- The round runs under `computer/checks-round.lock` (a regular file): one
  round at a time; a refresh during a round in this process
  joins it. A runner waits at most 30 s (250 ms between tries) for another
  runner's round, then runs its own without the lock. A lock older than 60 s
  is moved aside and removed only if it is still the file seen stale; one
  that is not a regular file (a symlink, a directory) or cannot be removed
  counts as held. Releasing removes the lock only while it is still the file
  this runner created (device and inode, by `lstat`); a lock is never read,
  so a FIFO or a symlink swapped in at the path is left alone and cannot
  block or flood the daemon. A round in flight is given up after 60 s, so a refresh
  never joins a round that hangs.
- It runs what any runner's server enabled
  (`computer/checks-servers/<machine id>.json`, rewritten on every config
  and refresh, counted for 24 h), and is kept in `computer/checks-round.json`.
  This runner also keeps its last round in memory, so deleting the file does
  not lift the limit. A refresh within 30 s of a round's start, from any
  runner, is answered from it, unless it lacks a check this server enabled (and the owner allows): then
  a new round runs.
- Each server gets only the checks it enabled; the owner's switch is re-read
  for every answer and wins (`disabledByOwner`, no rows).

Every file the checks write under RAFT_HOME (the round, each server's
switches, the switch record) goes through `atomicFile.ts`: a temp file with
an unpredictable name opened exclusively (`wx`, 0600, never through a
planted symlink), renamed into place, removed if the rename fails.

The round file is as writable by local agents as the switch. A file read back
is used only if every row is one the checks could have produced
(`storedRows.ts`: a known key with its label, each key once per check, a
value of that key's shape as the check emits it, text the Computer's own
scrub leaves unchanged, a status the row can have, `displayText` only on the
git name row), started within the last 30 s and not in the future, with a
`checkedAt` inside that round (not before its start, not after now);
otherwise a new round runs. So a forged file can at most repeat what a check could
report, never put free text in a structured row. The server scrubs and
re-validates whatever it receives.

## Where checks look

- HOME for checks is the Computer user's own home directory,
  `os.userInfo().homedir` (passed as `homeDir` by `service.ts`), never the
  daemon's `HOME` or `os.homedir()`, which follow the environment. Commands get
  only that HOME, PATH, LANG/LC_* and fixed no-prompt switches.
- Config is read only from the default locations under that home
  (`.config/gh/hosts.yml`, `.npmrc`, `.aws/config`, `.config/gcloud/...`).
  Overrides such as `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, `AWS_CONFIG_FILE`,
  `NPM_CONFIG_USERCONFIG` or `CLOUDSDK_CONFIG` are not followed (they are not
  passed to commands either), so someone who moved their config shows "not
  found" / no account. That is expected, not a bug.
- Commands run in `<RAFT_HOME>/computer/checks-cwd`, which must be an empty
  real directory (not a symlink). If it cannot be prepared (anything in it, a
  symlink, not creatable), checks that run commands report
  `run_folder_unavailable` (error and row reason) until it is fixed: not
  `not_installed`, not `failed`.

## The owner's switch

`<RAFT_HOME>/computer/checks.json` (`{ "disabled": "all" }` or a list of ids)
wins over what the server enables. Missing: nothing off. Present but not a
small (4 KB) regular file, or not understood: everything off; it is never
waited on (a FIFO is refused, not read).

It guards against the server, not against agents on this computer: anything
running as the same user can edit or delete it. So the daemon records the
last-seen state in `computer/checks-switch-seen.json` and every report carries
`ownerSwitch` (`disabled`, and after a change `previous` and `changedAt`, the
first round that saw it), so the owner sees e.g. "switched off, back on at T".
The record is equally writable by local agents; deleting it only makes the
next round a first sighting (no change claimed).

## Untrusted text

Rows with `displayText: true` (git `user.name`) carry free text the machine
reported. The web renders them only as plain text; agents must treat them as
untrusted data, never as instructions.
