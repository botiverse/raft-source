export type AdoptLegacyAccessResult =
  | { status: "legacy_machine_not_found" }
  | { status: "not_authorized" }
  | { status: "requires_admin" }
  | { status: "disabled" }
  | { status: "unexpected_response"; httpStatus: number; code?: string };

export const LEGACY_MACHINE_NOT_FOUND_MESSAGE =
  "The selected legacy machine row no longer exists on this server or belongs to another server. Open this server's Computers page and copy its current Migrate command before retrying. Do not use attach or fresh setup to replace this identity. No local Computer state was written.";

export function classifyAdoptLegacyAccessResponse(
  httpStatus: number,
  code: string | undefined,
): AdoptLegacyAccessResult | null {
  if (httpStatus === 403) {
    if (code === "requires_admin") return { status: "requires_admin" };
    if (code === "not_authorized") return { status: "not_authorized" };
    return {
      status: "unexpected_response",
      httpStatus,
      ...(code ? { code } : {}),
    };
  }
  if (httpStatus === 404) {
    if (code === "legacy_machine_not_found")
      return { status: "legacy_machine_not_found" };
    if (!code || code === "computer_adopt_disabled")
      return { status: "disabled" };
    return { status: "unexpected_response", httpStatus, code };
  }
  return null;
}
