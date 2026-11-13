import { TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS } from "@botiverse/raft-shared";
import type { ScopeDbTraceEventProjectorClient } from "../traces/traceEventProjector";

/**
 * A scopedb 0.4 client double for raft.trace_events_v2: `catalog().get()`
 * returns `columns` as the live table definition and `append(ndjson)` calls
 * `append` with the request body and the table identifier.
 */
export function fakeScopeDbTraceEventClient(options: {
  append?: (ndjson: string, table: string) => Promise<{ num_rows_inserted: number }> | { num_rows_inserted: number };
  columns?: readonly (readonly [string, string])[];
} = {}): ScopeDbTraceEventProjectorClient {
  const columns = options.columns ?? TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS;
  const append = options.append ?? ((ndjson: string) => ({ num_rows_inserted: ndjson.split("\n").length }));
  return {
    table: (name: string, tableOptions?: { database?: string; schema?: string }) => {
      const identifier = `${tableOptions?.database ?? "scopedb"}.${tableOptions?.schema ?? "public"}.${name}`;
      return {
        catalog: () => ({
          get: async () => ({
            version: '"1"',
            definition: { name, columns: columns.map(([columnName, dataType]) => ({ name: columnName, data_type: dataType })) },
          }),
        }),
        append: async (ndjson: string) => ({ status: "succeeded", ...await append(ndjson, identifier) }),
      };
    },
  } as unknown as ScopeDbTraceEventProjectorClient;
}
