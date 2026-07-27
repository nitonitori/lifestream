import { describe, it, expect } from 'vitest';
import { checkToken, extractToken } from '../../src/server/auth.js';

describe('checkToken', () => {
  it('true only on exact match (C1.AC3)', () => {
    expect(checkToken('abc', 'abc')).toBe(true);
    expect(checkToken('abc', 'abd')).toBe(false);
    expect(checkToken(undefined, 'abc')).toBe(false);
    expect(checkToken('abc', '')).toBe(false); // empty expected never passes
    expect(checkToken('short', 'longertoken')).toBe(false);
  });
});

describe('extractToken', () => {
  it('prefers cookie then bearer', () => {
    expect(extractToken({ headers: {}, cookies: { ls_token: 'c' } })).toBe('c');
    expect(extractToken({ headers: { authorization: 'Bearer b' }, cookies: {} })).toBe('b');
    expect(extractToken({ headers: {}, cookies: {} })).toBeUndefined();
  });
});
