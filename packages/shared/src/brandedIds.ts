// Branded (nominal) ID types.
//
// All of our IDs are UUID strings, so the compiler treats `serverId`,
// `machineId`, `channelId`, … as the same type and silently accepts a value of
// one where another is expected. That is not hypothetical: `canUserAccessChannel`
// shipped for ~a year with a `(channelId, userId)` signature in which the active
// server was implicitly "any server you belong to", a cross-server access leak
// fixed only by auditing (commit 6b979b6f / #945, making `serverId` a mandatory
// third argument). A branded `ServerId` would have made the unsafe call a
// compile error the day it was written.
//
// A `Brand<T, B>` is structurally `T` (so a `ServerId` is still usable anywhere a
// plain `string` is expected — no cascade onto code that doesn't care), but a
// plain `string` (or a differently-branded id) is NOT assignable to it. So you
// upgrade one consumer signature at a time; each upgrade only forces ITS callers
// to supply a properly-branded value, surfacing exactly the mis-wired sites.
//
// Brand at the boundary: where a raw string is first known to be a server id
// (validated route header, authenticated row), call the constructor once; from
// there the type carries the proof.
//
// Do NOT re-brand inside the service layer. If you hit a `serverId: string`
// parameter, upgrade it to `ServerId` and let the brand flow in from the caller
// — wrapping a local string in `asServerId(...)` just to quiet the compiler
// reintroduces exactly the unproven-id hole this is meant to close.

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A server id. Mint with {@link asServerId} at the trust boundary. */
export type ServerId = Brand<string, "ServerId">;

/**
 * Brand a string as a {@link ServerId}. Call this exactly at the point where the
 * value is established to be a server id (auth middleware, validated param);
 * downstream code then carries the proof in the type and needs no cast.
 */
export const asServerId = (id: string): ServerId => id as ServerId;

/** A machine id. Mint with {@link asMachineId} at the trust boundary. */
export type MachineId = Brand<string, "MachineId">;

/**
 * Brand a string as a {@link MachineId}. Call this exactly at the point where the
 * value is established to be a machine id (authenticated machine row, validated
 * param); downstream code then carries the proof in the type and needs no cast.
 * A `ServerId` is NOT a `MachineId` (distinct brands), so a server id can no
 * longer be silently passed where a machine is expected.
 */
export const asMachineId = (id: string): MachineId => id as MachineId;

/** A message id. Mint with {@link asMessageId} at a validated message-id boundary. */
export type MessageId = Brand<string, "MessageId">;

/**
 * Brand a string as a {@link MessageId}. Agent API SDK path-param methods use
 * this to keep message ids from being silently swapped with channel ids.
 */
export const asMessageId = (id: string): MessageId => id as MessageId;

/** A channel id. Mint with {@link asChannelId} at a validated channel-id boundary. */
export type ChannelId = Brand<string, "ChannelId">;

/**
 * Brand a string as a {@link ChannelId}. Agent API SDK path-param methods use
 * this to keep channel ids from being silently swapped with message ids.
 */
export const asChannelId = (id: string): ChannelId => id as ChannelId;

/**
 * Text that is allowed to reach an agent-visible surface (a runtime turn's
 * input on the daemon side). Minted only by registered surface producers —
 * agentRuntimeInput formatters and the standing-prompt builder; the print-seam
 * gates pin every other entry point. See the generated ax-surfaces.manifest.json.
 */
export type AxSurfaceText = Brand<string, "AxSurfaceText">;

/**
 * Brand agent-surface text. Call this only inside a registered surface
 * producer module; the generic branded-mint-sites gate (print-seam S4) pins
 * legal locations.
 */
export const asAxSurfaceText = (text: string): AxSurfaceText => text as AxSurfaceText;
