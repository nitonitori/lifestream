import { it, expect } from 'vitest';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeSource, InMemoryManagedRegistry } from '../fakes/index.js';
import { wireSse } from '../../src/index.js';

it('plane events broadcast over SSE (F1)', () => {
  const sse = new SseHub();
  const frames: string[] = [];
  sse.add({ write: (s: string) => frames.push(s) } as any);
  const plane = new ControlPlane({
    tmux: new FakeTmux(), sources: [new FakeSource()], registry: new InMemoryManagedRegistry(),
    clock: new FakeClock(), newSessionId: () => 'x',
  });
  wireSse(plane, sse);
  plane.emit('event', { type: 'session.removed', sessionId: 'gone' });
  expect(frames.join('')).toContain('"sessionId":"gone"');
  expect(frames.join('')).toContain('event: status');
});

it('message events use message channel', () => {
  const sse = new SseHub();
  const frames: string[] = [];
  sse.add({ write: (s: string) => frames.push(s) } as any);
  const plane = new ControlPlane({
    tmux: new FakeTmux(), sources: [new FakeSource()], registry: new InMemoryManagedRegistry(),
    clock: new FakeClock(), newSessionId: () => 'x',
  });
  wireSse(plane, sse);
  plane.emit('event', { type: 'message', sessionId: 's1', event: { kind: 'user', uuid: 'u', ts: 0, text: 'hi', raw: {} } });
  expect(frames.join('')).toContain('event: message');
});
