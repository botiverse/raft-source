# Incident repairs

Keep incident-specific commands and their private helpers together, outside
normal server services. These are manual operational tools, not startup hooks
or migrations to replay automatically.

| Directory | Scope | Existing safety boundary |
| --- | --- | --- |
| `task-39/` | John agent migration completion repair and its private service. | Preview by default; apply requires the task-specific confirmation and preview prestate SHA-256, then checks target and receipt invariants. |
| `task-87/` | Backfill Inbox facts for known missed task-body messages. | Dry run by default; writing requires `--commit`; default message sequences remain incident-specific. |

Execution receipts proving these repairs are no longer needed were not available
in the repository during the cleanup. Retain them until the incident owner
confirms closure and records the evidence; do not interpret relocation as
permission to execute them. Inspect `DATABASE_URL` and the selected targets
before any authorized use.

Existing John repair unit and real-Postgres tests remain under
`src/services/agentMigrationLegacyRepairService*.test.ts` so the server test
runner and shard placement keep their coverage.
