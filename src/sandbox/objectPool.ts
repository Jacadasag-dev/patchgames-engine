/** Bounded engine-owned object reuse. A checked-out object belongs to its caller
 * until release; retained objects have been reset and cannot leak prior state. */
export class ObjectPool<T extends object> {
  private readonly idle: T[] = [];
  private readonly active = new Set<T>();
  private readonly maxRetained: number;
  private closed = false;
  private readonly options: {
    create(): T;
    reset(item: T): void;
    dispose?(item: T): void;
    maxRetained?: number;
  };
  constructor(options: { create(): T; reset(item: T): void; dispose?(item: T): void; maxRetained?: number }) {
    this.options = options;
    this.maxRetained = options.maxRetained ?? 64;
    if (!Number.isSafeInteger(this.maxRetained) || this.maxRetained < 0 || this.maxRetained > 65536)
      throw new Error('Object pool: maxRetained must be an integer within 0..65536.');
  }
  get activeCount(): number { return this.active.size; }
  get retainedCount(): number { return this.idle.length; }
  acquire(): T {
    if (this.closed) throw new Error('Object pool: cannot acquire after disposal.');
    const item = this.idle.pop() ?? this.options.create();
    if (!item || typeof item !== 'object' || this.active.has(item))
      throw new Error('Object pool: create must return a new object.');
    this.active.add(item);
    return item;
  }
  release(item: T): void {
    if (!this.active.delete(item)) throw new Error('Object pool: object is not checked out from this pool.');
    try { this.options.reset(item); }
    catch (error) {
      try { this.options.dispose?.(item); }
      finally { throw error; }
    }
    if (this.idle.length < this.maxRetained) this.idle.push(item);
    else this.options.dispose?.(item);
  }
  /** Release retained storage without invalidating checked-out objects. */
  clear(): void {
    const idle = this.idle.splice(0);
    this.disposeItems(idle);
  }
  /** Terminal cleanup includes objects that are still checked out. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const items = [...this.idle, ...this.active];
    this.idle.length = 0; this.active.clear();
    this.disposeItems(items);
  }
  private disposeItems(items: readonly T[]): void {
    let failed = false, firstError: unknown;
    for (const item of items) {
      try { this.options.dispose?.(item); }
      catch (error) { if (!failed) { failed = true; firstError = error; } }
    }
    if (failed) throw firstError;
  }
}
