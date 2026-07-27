import { describe, it, expect } from 'vitest';
import { NotFoundError, NotControllableError, ConflictError, ValidationError, UpstreamError } from '../../src/domain/errors.js';

describe('domain errors', () => {
  it('carry code and httpStatus', () => {
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new NotFoundError('x').code).toBe('NOT_FOUND');
    expect(new NotControllableError('x').httpStatus).toBe(409);
    expect(new ConflictError('x').httpStatus).toBe(409);
    expect(new ValidationError('x').httpStatus).toBe(400);
    expect(new UpstreamError('x').httpStatus).toBe(502);
  });
  it('are instanceof Error', () => {
    expect(new NotFoundError('x')).toBeInstanceOf(Error);
  });
});
