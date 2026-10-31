/**
 * In-memory verdict cache. Two jobs: a repeated identical call must not pay for a model round-trip
 * again, and two concurrent identical calls must share one round-trip. Entries are keyed by cwd and
 * the event resources; TTL and capacity are fixed by the spec (#4).
 */

export const VERDICT_TTL_MS = 30 * 60 * 1000;
export const MAX_VERDICT_ENTRIES = 500;

export interface VerdictCacheOptions {
  /** Injectable clock, in milliseconds. Tests advance it instead of sleeping. */
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly limit?: number;
}

export interface CacheOutcome<T> {
  readonly value: T;
  /** `computed` means this call ran the producer; `cache` means it reused a stored or in-flight value. */
  readonly origin: "cache" | "computed";
}

export interface VerdictCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  getOrCompute(key: string, compute: () => Promise<T>): Promise<CacheOutcome<T>>;
  /** Drops every verdict, so the next call recomputes against the current settings. */
  clear(): void;
  readonly size: number;
}

interface StoredEntry<T> {
  readonly value: T;
  readonly storedAt: number;
}

/** A stable key: the same cwd, resources and system-context hash is the same call. */
export function verdictCacheKey(
  cwd: string,
  commands: ReadonlyArray<string>,
  systemContextHash: string | null = null,
): string {
  return JSON.stringify([cwd, commands, systemContextHash]);
}

export function createVerdictCache<T>(options: VerdictCacheOptions = {}): VerdictCache<T> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? VERDICT_TTL_MS;
  // A capacity below one would evict the entry that was just written; keep at least one slot.
  const limit = Math.max(1, options.limit ?? MAX_VERDICT_ENTRIES);
  const entries = new Map<string, StoredEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  // Bumped by `clear()`: a computation that started under an older generation belongs to the old
  // settings and must not repopulate the cache after they changed.
  let generation = 0;

  function get(key: string): T | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;

    if (now() - entry.storedAt >= ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: T): void {
    // Re-insertion keeps Map iteration order equal to write order, so eviction drops the oldest write.
    entries.delete(key);
    entries.set(key, { value, storedAt: now() });

    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  async function getOrCompute(key: string, compute: () => Promise<T>): Promise<CacheOutcome<T>> {
    const cached = get(key);
    if (cached !== undefined) return { value: cached, origin: "cache" };

    const pending = inFlight.get(key);
    if (pending !== undefined) return { value: await pending, origin: "cache" };

    const startedAt = generation;
    const promise = compute().then((value) => {
      if (startedAt === generation) set(key, value);
      return value;
    });

    inFlight.set(key, promise);
    try {
      return { value: await promise, origin: "computed" };
    } finally {
      // `clear()` already emptied the map; a newer computation may own this key by now, so only
      // remove the entry that belongs to this call.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }
  }

  function clear(): void {
    generation += 1;
    entries.clear();
    inFlight.clear();
  }

  return {
    get,
    set,
    getOrCompute,
    clear,
    get size() {
      return entries.size;
    },
  };
}
