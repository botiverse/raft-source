/** What finding a service needs from `GET /integrations` (asked with `?service=`). */
export interface IntegrationServiceDirectory<T> {
  services: readonly T[];
  /** Absent from a server older than RFC 084, and for an ambiguous name. */
  resolvedServiceId?: string | null;
}

type ListedService = { id: string; clientId: string; name: string };

/** The listed service with this id or client id; anything else needs the server (RFC 084 §4). */
export function findListedIntegrationService<T extends ListedService>(services: readonly T[], wanted: string): T | null {
  const needle = wanted.trim();
  const lower = needle.toLowerCase();
  if (!lower) return null;
  return services.find((service) => service.id === needle)
    ?? services.find((service) => service.clientId.toLowerCase() === lower)
    ?? null;
}

/**
 * The service a `--service` value names, given the list asked with
 * `?service=`: its id or client id; else the server's answer (it holds the
 * aliases, and an old id wins over a name there); else, when the server gave
 * none (an older server, an ambiguous name), the name.
 */
export function findIntegrationService<T extends ListedService>(directory: IntegrationServiceDirectory<T>, wanted: string): T | null {
  const { services, resolvedServiceId } = directory;
  const listed = findListedIntegrationService(services, wanted);
  if (listed) return listed;
  if (resolvedServiceId !== undefined) {
    return resolvedServiceId === null ? null : services.find((service) => service.id === resolvedServiceId) ?? null;
  }
  const lower = wanted.trim().toLowerCase();
  return lower ? services.find((service) => service.name.toLowerCase() === lower) ?? null : null;
}
