export type ArchivedChannelType = "channel" | "private" | "joint";

/**
 * The server's 409 `archived_name_collision` (create and rename): the name is
 * held by an archived channel the caller can see. Someone who cannot see it
 * gets the plain "already taken" error instead, which parses to null here
 * (#proj-chat:#19).
 */
export interface ArchivedNameCollision {
  archivedChannelId: string;
  archivedChannelName: string;
  archivedChannelType: ArchivedChannelType;
  canUnarchiveArchivedChannel: boolean;
}

const ARCHIVED_CHANNEL_TYPES: readonly ArchivedChannelType[] = ["channel", "private", "joint"];

/** The collision in an API error, or null; `types` limits it to the kinds the
 *  caller can offer (Create Channel never names an archived joint channel). */
export function parseArchivedNameCollision(
  err: unknown,
  types: readonly ArchivedChannelType[] = ARCHIVED_CHANNEL_TYPES,
): ArchivedNameCollision | null {
  const body = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  if (data.code !== "archived_name_collision") return null;
  const { archivedChannelId, archivedChannelName, archivedChannelType } = data;
  if (typeof archivedChannelId !== "string" || !archivedChannelId) return null;
  if (typeof archivedChannelName !== "string" || !archivedChannelName) return null;
  if (!types.includes(archivedChannelType as ArchivedChannelType)) return null;
  return {
    archivedChannelId,
    archivedChannelName,
    archivedChannelType: archivedChannelType as ArchivedChannelType,
    canUnarchiveArchivedChannel: data.canUnarchiveArchivedChannel === true,
  };
}
