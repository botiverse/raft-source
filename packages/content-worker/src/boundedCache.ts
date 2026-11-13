/**
 * A per-isolate cache bounded by weight (an isolate's 128 MB is shared by
 * every artifact it serves): the least recently used entries go first, and
 * an entry heavier than `maxEntry` is never kept.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private weight = 0;
  constructor(private readonly max: number, private readonly maxEntry: number) {}
  get(key: string): V | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    this.entries.delete(key);
    this.entries.set(key, found);
    return found.value;
  }
  set(key: string, value: V, weight: number): V {
    if (weight > this.maxEntry) return value;
    const old = this.entries.get(key);
    if (old) this.weight -= old.weight;
    this.entries.delete(key);
    while (this.entries.size && this.weight + weight > this.max) {
      const [oldest, entry] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.weight -= entry.weight;
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
    return value;
  }
}
