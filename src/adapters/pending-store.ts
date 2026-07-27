import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PendingActionStore } from '../ports/index.js';
import type { PendingAction } from '../domain/types.js';

export class FilePendingStore implements PendingActionStore {
  constructor(private file: string) {}
  private read(): Record<string, PendingAction[]> {
    if (!existsSync(this.file)) return {};
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  private write(o: Record<string, PendingAction[]>) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(o, null, 2));
  }
  async get(c: string) { return this.read()[c] ?? []; }
  async set(c: string, a: PendingAction[]) { const o = this.read(); o[c] = a; this.write(o); }
  async clear(c: string) { const o = this.read(); delete o[c]; this.write(o); }
}
