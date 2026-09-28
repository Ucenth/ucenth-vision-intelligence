/* In-process store for tests and single-instance local runs of the hosted edition.
 * NOT for production: Cloud Run scales to several instances and restarts them, so
 * counts kept in memory would be inconsistent. See firestore-store.js. */
export function createMemoryStore() {
  const map = new Map();
  let chain = Promise.resolve();
  return {
    kind: "memory",
    // update() is serialized so concurrent callers see each other's writes, which is
    // the same guarantee the Firestore store gives through preconditions.
    update(key, fn) {
      const run = chain.then(async () => {
        const current = map.get(key) ?? null;
        const { value, result } = await fn(current);
        if (value === null) map.delete(key);
        else map.set(key, value);
        return result;
      });
      chain = run.catch(() => {});
      return run;
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async close() {},
  };
}
