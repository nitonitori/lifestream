import { timingSafeEqual } from 'node:crypto';

export function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractToken(req: { headers: Record<string, any>; cookies: Record<string, any> }): string | undefined {
  if (req.cookies?.ls_token) return String(req.cookies.ls_token);
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}
