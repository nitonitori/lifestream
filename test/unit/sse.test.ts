import { describe, it, expect } from 'vitest';
import { SseHub } from '../../src/server/sse.js';

function fakeRes() {
  const w: string[] = [];
  return { w, write: (s: string) => { w.push(s); return true; } };
}

describe('SseHub', () => {
  it('broadcasts to all and formats frames', () => {
    const hub = new SseHub();
    const a = fakeRes();
    const b = fakeRes();
    hub.add(a as any);
    hub.add(b as any);
    hub.broadcast('message', { x: 1 });
    expect(a.w.join('')).toContain('event: message\ndata: {"x":1}\n\n');
    expect(b.w.join('')).toContain('event: message');
  });
  it('stops writing after remove', () => {
    const hub = new SseHub();
    const a = fakeRes();
    hub.add(a as any);
    hub.remove(a as any);
    hub.broadcast('status', {});
    expect(a.w.join('')).not.toContain('event: status');
  });
});
