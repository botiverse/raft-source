const SPARSE_ANCHOR_BATCH_SIZE = 10;

/**
 * Seed the exact reply schedule used by the sparse-anchor pagination spec.
 *
 * Reply 00 establishes the thread and deterministic oldest boundary. The
 * remaining replies are independent setup writes, so they run in bounded
 * batches while returned results stay in input order.
 */
export async function seedSparseAnchorReplies<Item, Result>(
  items: readonly Item[],
  postReply: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (items.length === 0) return [];

  const oldest = await postReply(items[0]!, 0);
  const remaining: Result[] = [];
  for (let offset = 1; offset < items.length; offset += SPARSE_ANCHOR_BATCH_SIZE) {
    const batch = items.slice(offset, offset + SPARSE_ANCHOR_BATCH_SIZE);
    remaining.push(...await Promise.all(
      batch.map((item, batchIndex) => postReply(item, offset + batchIndex)),
    ));
  }

  return [oldest, ...remaining];
}
