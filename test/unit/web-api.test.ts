import { describe, it, expect } from 'vitest';
import { ApiError, errText } from '../../web/src/core/api';

// errText 是 6 条固定兜底文案（发送/按键发送/接管/结束/创建/撤销失败）的唯一收口。
describe('errText', () => {
  it('服务端给了 message 就用服务端文案', () => {
    expect(errText(new ApiError(400, 'BAD_REQUEST', '该会话未托管'), '按键发送失败')).toBe('该会话未托管');
  });

  // Fastify 框架级错误（如 FST_ERR_CTP_EMPTY_JSON_BODY）没有 { error: { message } }，
  // 会落成 code:'UNKNOWN' / message:''，此时必须走兜底而不是弹出空 toast。
  it('ApiError 的 message 为空串时用兜底', () => {
    expect(errText(new ApiError(400, 'UNKNOWN', ''), '按键发送失败')).toBe('按键发送失败');
  });

  it('非 ApiError（网络中断等）用兜底', () => {
    expect(errText(new TypeError('Failed to fetch'), '发送失败')).toBe('发送失败');
  });
});
