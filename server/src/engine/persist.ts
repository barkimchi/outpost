import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * `data/progress.json` persistence (docs/SPEC.md section 3: "written atomically via
 * write-temp-then-rename, debounced 250ms"; section 9's progress schema). `JsonStore` is
 * a small generic write-temp-then-rename-plus-debounce mechanism so `workspace.json`
 * (Task 5) can reuse it instead of duplicating the same atomic-write logic; this task only
 * needs progress.json, so only that store is instantiated here.
 */

export interface ScenarioProgressEntry {
  solved: boolean;
  solvedAt?: string;
  runs: number;
  attempts: number;
  explanations: Array<{ at: string; rootCause: string; customerReply: string }>;
}

export interface ProgressFile {
  version: 1;
  scenarios: Record<string, ScenarioProgressEntry>;
}

export function defaultProgress(): ProgressFile {
  return { version: 1, scenarios: {} };
}

export function defaultScenarioProgressEntry(): ScenarioProgressEntry {
  return { solved: false, runs: 0, attempts: 0, explanations: [] };
}

function writeAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);
}

/** A debounced, atomically-written JSON file backing a single in-memory value of type
 *  `T`. Reads happen once, at construction; every subsequent read is served from memory. */
export class JsonStore<T> {
  private data: T;
  private readonly filePath: string;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, defaultValue: T, debounceMs = 250) {
    this.filePath = filePath;
    this.debounceMs = debounceMs;
    this.data = this.load(defaultValue);
  }

  private load(defaultValue: T): T {
    try {
      const text = readFileSync(this.filePath, 'utf8');
      return JSON.parse(text) as T;
    } catch {
      return defaultValue;
    }
  }

  get(): T {
    return this.data;
  }

  /** Mutates the in-memory value in place, then schedules a debounced atomic write. */
  update(mutate: (current: T) => void): void {
    mutate(this.data);
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      writeAtomic(this.filePath, JSON.stringify(this.data, null, 2));
    }, this.debounceMs);
  }

  /** Bypasses the debounce and writes immediately. Tests use this to observe the file
   *  without waiting out the real debounce window. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    writeAtomic(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

export function createProgressStore(filePath: string): JsonStore<ProgressFile> {
  return new JsonStore<ProgressFile>(filePath, defaultProgress());
}

const PROGRESS_FILE_PATH = join(DATA_DIR, 'progress.json');

/** The real, process-wide progress store, backed by `data/progress.json`. Production code
 *  (`engine.ts`'s default-constructed singleton) uses this. Tests that want isolation from
 *  the real data directory construct their own store via `createProgressStore(tmpPath)`
 *  and inject it into a test-local `Engine` instance instead. */
export const progressStore = createProgressStore(PROGRESS_FILE_PATH);
