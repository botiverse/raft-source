const RECONCILE_INTERVAL_MS = 5_000;

export async function startServiceReconcileLoop(
  reconcile: () => Promise<void>,
  schedule: (callback: () => void, intervalMs: number) => { unref(): unknown } = setInterval,
): Promise<void> {
  await reconcile();
  schedule(() => void reconcile(), RECONCILE_INTERVAL_MS).unref();
}
