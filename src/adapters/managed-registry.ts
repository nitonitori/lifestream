import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ManagedRegistry, ManagedEntry } from '../ports/index.js';

export class FileManagedRegistry implements ManagedRegistry {
  constructor(private file: string) {}
  private read(): ManagedEntry[] {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return []; }
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
