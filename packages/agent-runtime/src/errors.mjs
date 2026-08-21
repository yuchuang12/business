export class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new RuntimeError(code, message, details);
}
