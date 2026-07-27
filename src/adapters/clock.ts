import type { Clock } from '../ports/index.js';
export class SystemClock implements Clock { now() { return Date.now(); } }
