const DEFINITIONS = {
  COMMERCE_INVALID_REQUEST: ["validation", false],
  COMMERCE_FORBIDDEN: ["authorization", false],
  COMMERCE_NOT_FOUND: ["not_found", false],
  COMMERCE_CONFLICT: ["conflict", false],
  COMMERCE_DUPLICATE_SKU: ["conflict", false],
  COMMERCE_APPROVAL_REQUIRED: ["approval", false],
  COMMERCE_APPROVAL_INVALID: ["approval", false],
  COMMERCE_PROVIDER_FAILED: ["provider", true],
  COMMERCE_PROVIDER_TIMEOUT: ["timeout", true],
  COMMERCE_PROVIDER_RATE_LIMITED: ["rate_limit", true],
  COMMERCE_PROVIDER_UNAVAILABLE: ["provider", true],
  COMMERCE_PROVIDER_REJECTED: ["provider", false],
  COMMERCE_UNKNOWN_IN_FLIGHT: ["provider", true]
};

export class CommerceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.category = DEFINITIONS[code]?.[0] ?? "internal";
    this.retryable = DEFINITIONS[code]?.[1] ?? false;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new CommerceError(code, message, details);
}

export function errorDefinition(code) {
  const definition = DEFINITIONS[code];
  return definition ? { code, category: definition[0], retryable: definition[1] } : null;
}
