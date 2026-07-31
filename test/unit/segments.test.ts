import { describe, expect, test } from 'vitest';
import { parseSegments, pidFromRunName } from '../../src/domain/segments.js';

describe('pidFromRunName', () => {
  test('从 run 名尾部取 pid', () => {
    expect(pidFromRunName('2026-07-30T16-31-03-abcd-p12092')).toBe(12092);
  });
  test('run 文件名带 .jsonl 也能取', () => {
    expect(pidFromRunName('2026-07-30T16-31-03-abcd-p12092.jsonl')).toBe(12092);
  });
  test('没有 -p 后缀返回 null', () => {
    expect(pidFromRunName('2026-07-30T16-31-03-abcd')).toBeNull();
  });
});

describe('parseSegments', () => {
  const L = (o: unknown) => JSON.stringify(o);

  test('首行 session.config.loaded 的 project_root 就是 cwd', () => {
    const r = parseSegments([
      L({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/foo', interactive: true } }),
    ]);
    expect(r.cwd).toBe('/Users/l/dev/foo');
  });

  test('只取第一条 session.config.loaded 的 project_root', () => {
    const r = parseSegments([
      L({ type: 'session.config.loaded', data: { project_root: '/first' } }),
      L({ type: 'session.config.loaded', data: { project_root: '/second' } }),
    ]);
    expect(r.cwd).toBe('/first');
  });

  test('坏行跳过而不抛', () => {
    const r = parseSegments(['not json', L({ type: 'session.config.loaded', data: { project_root: '/x' } })]);
    expect(r.cwd).toBe('/x');
  });

  test('没有任何事件时无 cwd', () => {
    expect(parseSegments([])).toEqual({ cwd: undefined });
  });
});
