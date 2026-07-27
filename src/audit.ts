import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Audit {
  constructor(private file: string) {}
  record(kind: string, detail: Record<string, unknown>) {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify({ ts: Date.now(), kind, ...detail }) + '\n');
    } catch { /* audit best-effort */ }
  }
}
