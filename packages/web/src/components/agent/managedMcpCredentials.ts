import type { ManagedMcpCredentialPatch } from "@botiverse/raft-shared";

export type ManagedMcpHeaderDraft = {
  id: number;
  name: string;
  value: string;
  persistedName: string | null;
};

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

export function managedMcpHeadersIncomplete(headers: ManagedMcpHeaderDraft[]): boolean {
  const names = headers.map((header) => normalizedName(header.name));
  if (names.some((name) => !name) || new Set(names).size !== names.length) return true;
  return headers.some((header) => {
    const keepsStoredValue =
      header.persistedName !== null && normalizedName(header.name) === normalizedName(header.persistedName);
    return !keepsStoredValue && !header.value.trim();
  });
}

export function managedMcpHeadersForCreate(headers: ManagedMcpHeaderDraft[]): Record<string, string> {
  return Object.fromEntries(headers.map((header) => [header.name.trim(), header.value]));
}

export function buildManagedMcpCredentialPatch(
  headers: ManagedMcpHeaderDraft[],
  persistedHeaderNames: string[],
): ManagedMcpCredentialPatch {
  const retainedNames = new Set(
    headers.flatMap((header) =>
      header.persistedName !== null && normalizedName(header.name) === normalizedName(header.persistedName)
        ? [normalizedName(header.persistedName)]
        : [],
    ),
  );
  return {
    upsertHeaders: Object.fromEntries(
      headers.flatMap((header) => (header.value.trim() ? [[header.name.trim(), header.value]] : [])),
    ),
    removeHeaderNames: persistedHeaderNames.filter((name) => !retainedNames.has(normalizedName(name))),
  };
}
