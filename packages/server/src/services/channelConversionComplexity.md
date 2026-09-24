# Channel Conversion Complexity Memo

## Scope

This branch implements the first v0 slice for converting an existing public or
private local channel into the host projection of a private joint channel. The
contract is history-preserving: newly invited servers can read pre-conversion
parent messages and historical thread replies after they accept an invite.

## Line Count

- `channelConversionService.ts`: 629 lines for the durable job state machine,
  phase runner, conversion phases, retry handling, and identity-shape helper.
- `channelConversionService.test.ts`: 368 lines covering route conversion,
  invite-accept readback, phase-failure retry convergence, and task blocking.
- `routes/channels.ts`: 55 added lines for the admin-only conversion endpoint.
- `schema.ts`: 41 added lines for `channel_conversion_jobs`.
- `drizzle/0136_fantastic_may_parker.sql`: 28 lines for the generated table and
  indexes.

## Hardest Phase

`prepare_threads` is the riskiest phase. Existing ordinary threads already own
the `channels.parent_message_id` unique slot, but joint-channel semantics require
that slot to move to a canonical storage thread while the old thread id becomes
the host local projection. The implementation clears the old local thread's
`parent_message_id`, creates the canonical thread row, creates its
`joint_channels` authority row, and maps the old local thread id as the host
projection in one transaction. The later `move_thread_messages` phase then moves
replies to canonical storage using that projection map.

## Retry Oracle

The test oracle creates a normal joint channel through the existing direct
creation path, seeds the same logical parent/thread history, normalizes away ids
and timestamps, then compares the direct joint identity shape to converted
channels. The retry matrix injects a failure before each phase and requires the
retried final shape to match the direct-created joint shape.

## Outside V0

- Background worker polling and automatic expired-lease recovery.
- Progress UI beyond the route returning the durable job row.
- Cancel/rollback after any data-moving phase.
- Channels with active task messages.
- Non-admin self-service conversion.
- Drop-history conversion mode.
