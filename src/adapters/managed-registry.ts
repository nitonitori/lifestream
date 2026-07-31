import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ManagedRegistry, ManagedEntry } from '../ports/index.js';

export class FileManagedRegistry implements ManagedRegistry {
  constructor(private file: string) {}
  private read(): ManagedEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      // 旧条目没有 kernel（Task 2 之前只有 Claude），读时补默认值。
      const rows = JSON.parse(readFileSync(this.file, 'utf8')) as ManagedEntry[];
      return rows.map(r => ({ ...r, kernel: r.kernel ?? 'claude' }));
    } catch { return []; }
  }
  private write(rows: ManagedEntry[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2));
  }
  async list() { return this.read(); }
  async get(id: string) { return this.read().find(e => e.sessionId === id) ?? null; }
  async put(e: ManagedEntry) {
    const rows = this.read().filter(r => r.sessionId !== e.sessionId);
    rows.push(e);
    this.write(rows);
  }
  async remove(id: string) { this.write(this.read().filter(r => r.sessionId !== id)); }
}
