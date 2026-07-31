import { describe, expect, test } from 'vitest';
import { describeAction } from '../../src/domain/pending.js';

describe('describeAction', () => {
  test('create 不带 kernel 时不显示内核（默认 claude）', () => {
    expect(describeAction('create', { cwd: '/w' })).toBe('在 /w 新建会话');
  });
  test('create 带 kernel 时显示内核', () => {
    expect(describeAction('create', { cwd: '/w', kernel: 'qodercli' })).toBe('在 /w 新建 qodercli 会话');
  });
  test('create 的 initialPrompt 仍附在末尾', () => {
    expect(describeAction('create', { cwd: '/w', kernel: 'qodercli', initialPrompt: 'go' }))
      .toBe('在 /w 新建 qodercli 会话，首条: go');
  });
});
