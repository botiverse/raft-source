/**
 * Channel payloads carry `visitorVisible` (#wg-rbac:#51): whether signed-out
 * visitors of the server's public page may read the channel. It is stored as
 * channels.guest_visible (the Drizzle `guestVisible`), which payloads keep
 * mirroring as `guestVisible` until clients older than this field are gone.
 * Rows that do not carry `guestVisible` pass through unchanged.
 */
export function withVisitorVisible<T extends object>(channel: T): T & { visitorVisible?: boolean } {
  const guestVisible = (channel as { guestVisible?: unknown }).guestVisible;
  return typeof guestVisible === "boolean" ? { ...channel, visitorVisible: guestVisible } : channel;
}
