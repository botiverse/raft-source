const PRODUCER_FACT_TEXT_RE = /\bproducerFactId=([A-Za-z0-9_:/-]+)/g;
const TEXT_LINEAGE_RE = /(?:\s*\[producerFactId=[^\]]+\]|\n?Lineage: producerFactId=[^\n]+\.?)/g;
const PRODUCER_FACT_TEXT_LABEL = "producerFactId";

const PRODUCER_FACT_KEYS = new Set([
  "producerFactId",
  "producer_fact_id",
  "message_producer_fact_id",
  "apm_source_fact_id",
]);

export function collectSurfaceProducerFactIds(surface: unknown): string[] {
  const ids = new Set<string>();
  collectProducerFactIds(surface, ids, new Set<unknown>());
  return [...ids].sort();
}

export function assertSurfaceProducerFactLineage(
  surface: unknown,
  expectedProducerFactIds: string[],
  label: string,
): void {
  const expected = [...new Set(expectedProducerFactIds)].sort();
  const actual = collectSurfaceProducerFactIds(surface);
  const missing = expected.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !expected.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} producerFactId mismatch: expected ${JSON.stringify(expected)}, ` +
      `actual ${JSON.stringify(actual)}, missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
    );
  }
}

export function formatProducerFactLineageBracket(producerFactId: string | null | undefined): string {
  const id = normalizeProducerFactId(producerFactId);
  return id ? ` [${PRODUCER_FACT_TEXT_LABEL}=${id}]` : "";
}

export function formatProducerFactLineageNote(producerFactId: string | null | undefined): string {
  const id = normalizeProducerFactId(producerFactId);
  return id ? `\nLineage: ${PRODUCER_FACT_TEXT_LABEL}=${id}.` : "";
}

export function stripSurfaceProducerFactLineage<T>(surface: T): T {
  if (typeof surface === "string") {
    return surface.replace(TEXT_LINEAGE_RE, "") as T;
  }
  if (Array.isArray(surface)) {
    return surface.map((item) => stripSurfaceProducerFactLineage(item)) as T;
  }
  if (surface && typeof surface === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(surface)) {
      if (PRODUCER_FACT_KEYS.has(key)) continue;
      result[key] = stripSurfaceProducerFactLineage(value);
    }
    return result as T;
  }
  return surface;
}

function normalizeProducerFactId(producerFactId: string | null | undefined): string {
  return typeof producerFactId === "string" ? producerFactId.trim() : "";
}

function collectProducerFactIds(surface: unknown, ids: Set<string>, seen: Set<unknown>): void {
  if (typeof surface === "string") {
    for (const match of surface.matchAll(PRODUCER_FACT_TEXT_RE)) {
      const id = match[1]?.trim();
      if (id) ids.add(id);
    }
    return;
  }
  if (!surface || typeof surface !== "object") return;
  if (seen.has(surface)) return;
  seen.add(surface);

  if (Array.isArray(surface)) {
    for (const item of surface) collectProducerFactIds(item, ids, seen);
    return;
  }

  for (const [key, value] of Object.entries(surface)) {
    if (PRODUCER_FACT_KEYS.has(key) && typeof value === "string") {
      const id = value.trim();
      if (id) ids.add(id);
      continue;
    }
    collectProducerFactIds(value, ids, seen);
  }
}
