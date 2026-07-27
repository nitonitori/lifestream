import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureToken } from '../../src/index.js';

it('generates token when empty (F1.AC2)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'lsc-')), 'c.json');
  const cfg: any = { web: { host: '127.0.0.1', port: 8787, token: '' } };
  ensureToken(cfg, f);
  expect(cfg.web.token.length).toBeGreaterThanOrEqual(32);
});

it('keeps existing token', () => {
  const cfg: any = { web: { host: '127.0.0.1', port: 8787, token: 'keepme' } };
  ensureToken(cfg, '/nonexistent/should-not-write.json');
  expect(cfg.web.token).toBe('keepme');
});
