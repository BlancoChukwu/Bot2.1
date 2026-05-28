/** FIFO ring dedupe: fixed capacity, evict oldest on insert. No timers. */
export class FixedSizeDedupe {
  private readonly keys: string[] = [];
  private readonly seen = new Set<string>();

  public constructor(private readonly capacity: number) {}

  public has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Returns false if duplicate; true if newly inserted. */
  public add(key: string): boolean {
    if (this.seen.has(key)) {
      return false;
    }
    if (this.keys.length >= this.capacity) {
      const evicted = this.keys.shift();
      if (evicted !== undefined) {
        this.seen.delete(evicted);
      }
    }
    this.keys.push(key);
    this.seen.add(key);
    return true;
  }

  public clear(): void {
    this.keys.length = 0;
    this.seen.clear();
  }

  public size(): number {
    return this.seen.size;
  }
}
