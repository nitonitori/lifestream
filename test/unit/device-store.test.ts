import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileDeviceStore } from '../../src/adapters/device-store.js';
import { deriveDeviceName } from '../../src/server/devices.js';

const dev = (o = {}) => ({ id: 'd1', token: 't1', name: 'PC', createdAt: 1, lastSeenAt: 1, ...o });

describe('FileDeviceStore', () => {
  it('put / findByToken / touch / remove persist', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'lsd-')), 'devices.json');
    const s = new FileDeviceStore(f);
    await s.put(dev());
    expect((await new FileDeviceStore(f).findByToken('t1'))?.name).toBe('PC');
    await s.touch('d1', 999);
    expect((await new FileDeviceStore(f).findByToken('t1'))?.lastSeenAt).toBe(999);
    await s.remove('d1');
    expect(await new FileDeviceStore(f).findByToken('t1')).toBeNull();
  });
  it('list returns all', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'lsd-')), 'devices.json');
    const s = new FileDeviceStore(f);
    await s.put(dev({ id: 'a', token: 'ta' }));
    await s.put(dev({ id: 'b', token: 'tb' }));
    expect((await s.list()).length).toBe(2);
  });
});

describe('deriveDeviceName', () => {
  it('recognizes common platforms/browsers', () => {
    expect(deriveDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) ... Safari/604.1')).toContain('iPhone');
    expect(deriveDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X) ... Chrome/120 Safari/537')).toMatch(/Mac/);
    expect(deriveDeviceName('Mozilla/5.0 (Windows NT 10.0) ... Edg/120')).toMatch(/Windows/);
    expect(deriveDeviceName(undefined)).toBe('未知设备');
  });
});
