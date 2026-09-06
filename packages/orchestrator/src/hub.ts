/** Lightweight in-process pub/sub used to fan events out to SSE/UI watchers. */

export type HubListener<T> = (event: T) => void;

export class EventHub<T> {
  private readonly listeners = new Map<string, Set<HubListener<T>>>();

  /** Listen to a topic (e.g. `session:<id>`, `project:<id>`, `run:<id>`). */
  subscribe(topic: string, listener: HubListener<T>): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(topic);
    };
  }

  publish(topic: string, event: T): void {
    const set = this.listeners.get(topic);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        /* a broken watcher must not break the state machine */
      }
    }
  }
}

/** Subscribe to multiple topics at once; returns an unsubscribe-all handle. */
export function subscribeMany<T>(
  hub: EventHub<T>,
  topics: string[],
  listener: HubListener<T>,
): () => void {
  const unsubscribers = topics.map((topic) => hub.subscribe(topic, listener));
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
