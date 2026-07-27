import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileManagedRegistry } from '../../src/adapters/managed-registry.js';
import { FilePendingStore } from '../../src/adapters/pending-store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ls-'));

describe('FileManagedRegistry', () => {
  it('persists and reloads entries', async () => {
    const f = join(dir(), 'managed.json');
    const r1 = new FileManagedRegistry(f);
    await r1.put({ sessionId: 's1', tmuxSession: 't1', cwd: '/w', origin: 'managed', createdAt: 1 });
    const r2 = new FileManagedRegistry(f);
    expect((await r2.get('s1'))?.tmuxSession).toBe('t1');
    await r2.remove('s1');
    expect(await r2.get('s1')).toBeNull();
  });
});

describe('FilePendingStore', () => {
  it('persists actions per conversation', async () => {
    const f = join(dir(), 'pending.json');
    const p = new FilePendingStore(f);
    await p.set('c1', [{ id: 'a', conversationId: 'c1', kind: 'send', params: {}, description: 'd', createdAt: 0 }]);
    expect(await new FilePendingStore(f).get('c1')).toHaveLength(1);
    await p.clear('c1');
    expect(await new FilePendingStore(f).get('c1')).toHaveLength(0);
  });
});
