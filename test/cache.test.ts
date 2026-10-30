import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerdictCache, MAX_VERDICT_ENTRIES, VERDICT_TTL_MS, verdictCacheKey } from "../src/cache.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("the key is cwd plus the ordered command list", () => {
  assert.equal(verdictCacheKey("/w", ["ls", "git status"]), verdictCacheKey("/w", ["ls", "git status"]));
  assert.notEqual(verdictCacheKey("/w", ["ls"]), verdictCacheKey("/w", ["ls "]));
  assert.notEqual(verdictCacheKey("/w", ["ls"]), verdictCacheKey("/other", ["ls"]));
  assert.notEqual(verdictCacheKey("/w", ["ls", "pwd"]), verdictCacheKey("/w", ["pwd", "ls"]));
});

test("cached values live for 30 minutes and then expire", () => {
  let clock = 1_000;
  const cache = createVerdictCache<number>({ now: () => clock });
  cache.set("k", 7);

  clock += VERDICT_TTL_MS - 1;
  assert.equal(cache.get("k"), 7);

  clock += 1;
  assert.equal(cache.get("k"), undefined);
  assert.equal(cache.size, 0);
});

test("the cache evicts the oldest write above 500 entries", () => {
  let clock = 0;
  const cache = createVerdictCache<number>({ now: () => ++clock });

  for (let index = 0; index <= MAX_VERDICT_ENTRIES; index += 1) cache.set(`k${index}`, index);

  assert.equal(cache.size, MAX_VERDICT_ENTRIES);
  assert.equal(cache.get("k0"), undefined);
  assert.equal(cache.get("k1"), 1);
  assert.equal(cache.get(`k${MAX_VERDICT_ENTRIES}`), MAX_VERDICT_ENTRIES);
});

test("rewriting a key refreshes its value and its place in write order", () => {
  let clock = 0;
  const cache = createVerdictCache<number>({ now: () => ++clock, limit: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 3);
  cache.set("c", 4);

  assert.equal(cache.get("a"), 3);
  assert.equal(cache.get("b"), undefined);
});

test("a second getOrCompute reuses the stored value without running the producer", async () => {
  const cache = createVerdictCache<number>();
  let produced = 0;
  const first = await cache.getOrCompute("k", async () => {
    produced += 1;
    return 42;
  });
  const second = await cache.getOrCompute("k", async () => {
    produced += 1;
    return 99;
  });

  assert.deepEqual(first, { value: 42, origin: "computed" });
  assert.deepEqual(second, { value: 42, origin: "cache" });
  assert.equal(produced, 1);
});

test("concurrent identical calls share one producer", async () => {
  const cache = createVerdictCache<number>();
  const gate = deferred<number>();
  let produced = 0;

  const first = cache.getOrCompute("k", async () => {
    produced += 1;
    return gate.promise;
  });
  const second = cache.getOrCompute("k", async () => {
    produced += 1;
    return gate.promise;
  });

  gate.resolve(5);
  const outcomes = await Promise.all([first, second]);

  assert.equal(produced, 1);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.value),
    [5, 5],
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.origin),
    ["computed", "cache"],
  );
});

test("a failed producer is not cached and the next call retries", async () => {
  const cache = createVerdictCache<number>();
  let produced = 0;

  await assert.rejects(
    cache.getOrCompute("k", async () => {
      produced += 1;
      throw new Error("model down");
    }),
  );
  assert.equal(cache.get("k"), undefined, "failed computations must not leave a stored entry");

  const outcome = await cache.getOrCompute("k", async () => {
    produced += 1;
    return 1;
  });

  assert.equal(produced, 2);
  assert.equal(outcome.origin, "computed");
  assert.equal(cache.get("k"), 1);
});
