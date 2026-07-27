import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

it('cli sessions runs without crash (A4.AC1)', () => {
  const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'sessions'], { encoding: 'utf8', timeout: 60000 });
  expect(typeof out).toBe('string');
}, 70000);

it('cli usage without args', () => {
  const out = execFileSync('npx', ['tsx', 'src/cli.ts'], { encoding: 'utf8', timeout: 60000 });
  expect(out).toContain('usage: lifestream');
}, 70000);
