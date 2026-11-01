import { libraryGroupCover } from "./tauri";

export interface CoverScope {
  generation: number;
  revision: number;
}
interface Entry { value: string | null; expires: number; }

/** App-owned, bounded image cache. No old-library result can populate a new scope. */
export function createLibraryCoverCache(
  load: (hash: string) => Promise<string | null> = libraryGroupCover,
  limits = { entries: 64, characters: 4 * 1024 * 1024, concurrency: 4 },
) {
  let scope: CoverScope = { generation: -1, revision: -1 };
  let entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<string | null>>();
  const queue: { scope: CoverScope; run: () => Promise<void>; skip: () => void }[] = [];
  let running = 0;
  let characters = 0;
  const current = (value: CoverScope) => value.generation === scope.generation && value.revision === scope.revision;
  const drain = () => {
    while (running < limits.concurrency && queue.length) {
      const next = queue.shift()!;
      if (!current(next.scope)) { next.skip(); continue; }
      running++;
      void next.run().finally(() => { running--; drain(); });
    }
  };
  const store = (hash: string, value: string | null) => {
    const size = value?.length ?? 0;
    if (size > limits.characters) return;
    const previous = entries.get(hash);
    if (previous) { characters -= previous.value?.length ?? 0; entries.delete(hash); }
    entries.set(hash, { value, expires: Date.now() + (value === null ? 15_000 : 60_000) });
    characters += size;
    while (entries.size > limits.entries || characters > limits.characters) {
      const oldest = entries.keys().next().value!;
      characters -= entries.get(oldest)!.value?.length ?? 0;
      entries.delete(oldest);
    }
  };
  return {
    get(owner: CoverScope, hash: string): Promise<string | null> {
      if (owner.generation < scope.generation || (owner.generation === scope.generation && owner.revision < scope.revision)) return Promise.resolve(null);
      if (!current(owner)) {
        scope = { ...owner };
        entries = new Map();
        characters = 0;
      }
      const cached = entries.get(hash);
      if (cached && cached.expires > Date.now()) {
        entries.delete(hash); entries.set(hash, cached);
        return Promise.resolve(cached.value);
      }
      const key = JSON.stringify([owner.generation, owner.revision, hash]);
      const existing = pending.get(key);
      if (existing) return existing;
      let resolve!: (value: string | null) => void;
      let reject!: (reason: unknown) => void;
      const result = new Promise<string | null>((yes, no) => { resolve = yes; reject = no; });
      pending.set(key, result);
      queue.push({
        scope: { ...owner },
        skip: () => { pending.delete(key); resolve(null); },
        run: async () => {
          try {
            const value = await load(hash);
            if (current(owner)) store(hash, value);
            resolve(value);
          } catch (error) { reject(error); }
          finally { pending.delete(key); }
        },
      });
      drain();
      return result;
    },
  };
}

export type LibraryCoverCache = ReturnType<typeof createLibraryCoverCache>;
