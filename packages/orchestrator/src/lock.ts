/** Tiny per-key async mutex used to serialize read-modify-write of one record. */

const chains = new Map<string, Promise<void>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  chains.set(key, previous.then(() => gate));
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}
