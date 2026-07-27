export class DomainError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotFoundError extends DomainError {
  constructor(msg: string) { super(msg, 'NOT_FOUND', 404); }
}
export class NotControllableError extends DomainError {
  constructor(msg: string) { super(msg, 'NOT_CONTROLLABLE', 409); }
}
export class ConflictError extends DomainError {
  constructor(msg: string) { super(msg, 'CONFLICT', 409); }
}
export class ValidationError extends DomainError {
  constructor(msg: string) { super(msg, 'VALIDATION', 400); }
}
export class UpstreamError extends DomainError {
  constructor(msg: string) { super(msg, 'UPSTREAM', 502); }
}
