import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceStore, Device } from '../ports/index.js';

export class FileDeviceStore implements DeviceStore {
  constructor(private file: string) {}
  private read(): Device[] {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return []; }
  }
  private write(rows: Device[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2));
  }
  async list() { return this.read(); }
  async findByToken(token: string) { return this.read().find(d => d.token === token) ?? null; }
  async put(device: Device) {
    const rows = this.read().filter(d => d.id !== device.id);
    rows.push(device);
    this.write(rows);
  }
  async touch(id: string, now: number) {
    const rows = this.read();
    const d = rows.find(r => r.id === id);
    if (d) { d.lastSeenAt = now; this.write(rows); }
  }
  async remove(id: string) { this.write(this.read().filter(d => d.id !== id)); }
}
