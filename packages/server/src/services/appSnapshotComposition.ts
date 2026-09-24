export type AppSnapshotTraceAttrs = Record<string, unknown>;

export type AppSnapshotEnvelope<T> = {
  value: T;
  traceAttrs: AppSnapshotTraceAttrs;
};

export type AppSnapshotTerminal = {
  traceAttrs: AppSnapshotTraceAttrs;
  outcome: "empty" | "snapshot_failed";
  reason: "snapshot_empty" | "snapshot_build_failed";
};

export type AppSnapshotComposition<T> = {
  envelopes: readonly AppSnapshotEnvelope<T>[];
  terminals: readonly AppSnapshotTerminal[];
};

type AppSnapshotProducer<T> = {
  build: () => Promise<readonly AppSnapshotEnvelope<T>[]>;
  snapshotTraceAttrs: AppSnapshotTraceAttrs;
};

/** Resolve app-owned snapshot producers without throwing identity through errors. */
export async function composeAppSnapshot<T>(
  producers: readonly AppSnapshotProducer<T>[],
  genericSnapshotTraceAttrs: AppSnapshotTraceAttrs,
): Promise<AppSnapshotComposition<T>> {
  const results = await Promise.all(
    producers.map(async (producer) => {
      try {
        return { envelopes: await producer.build(), terminal: null };
      } catch {
        return {
          envelopes: [],
          terminal: {
            traceAttrs: producer.snapshotTraceAttrs,
            outcome: "snapshot_failed" as const,
            reason: "snapshot_build_failed" as const,
          },
        };
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.terminal ? [result.terminal] : [],
  );
  if (failures.length > 0) return { envelopes: [], terminals: failures };

  const envelopes = results.flatMap((result) => result.envelopes);
  if (envelopes.length > 0) return { envelopes, terminals: [] };
  return {
    envelopes: [],
    terminals: [
      {
        traceAttrs:
          producers[0]?.snapshotTraceAttrs ?? genericSnapshotTraceAttrs,
        outcome: "empty",
        reason: "snapshot_empty",
      },
    ],
  };
}
