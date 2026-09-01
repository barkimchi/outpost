// Vitest setup: extends `expect` with jest-dom's DOM matchers (`toBeInTheDocument`, etc).
// Lives under `src/` so it is part of the TS program (`tsconfig.json`'s `include: ["src"]`),
// which makes the type augmentation this import provides visible to every test file.
import '@testing-library/jest-dom/vitest';

/**
 * Node 22+'s own global `localStorage` (backed by `--localstorage-file`, unset here)
 * shadows jsdom's implementation in this environment, leaving `window.localStorage`
 * unusable ("Cannot read properties of undefined") instead of the real browser API
 * `state/persistence.ts` targets. A small in-memory `Storage`-compatible polyfill,
 * installed once before any test runs, makes the two behave identically without a CLI
 * flag. jsdom's environment makes `window === globalThis`, so defining it here covers
 * both spellings.
 */
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});
