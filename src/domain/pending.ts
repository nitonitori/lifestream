import type { PendingActionKind } from './types.js';

export function describeAction(kind: PendingActionKind, params: any): string {
  if (kind === 'send') return `向会话 ${params.sessionId} 发送: ${params.text}`;
  if (kind === 'create') return `在 ${params.cwd} 新建会话${params.initialPrompt ? '，首条: ' + params.initialPrompt : ''}`;
  if (kind === 'adopt') return `接管会话 ${params.sessionId}${params.force ? '(强制)' : ''}`;
  return String(kind);
}
