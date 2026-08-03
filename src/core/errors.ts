export const ERROR_CODES = ["INTERNAL_ERROR", "INVALID_STATE_TRANSITION"] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

interface ErrorDefinition {
  message: string;
  retryable: boolean;
}

const ERROR_DEFINITIONS: Readonly<Record<ErrorCode, ErrorDefinition>> = {
  INTERNAL_ERROR: {
    message: "The request could not be completed.",
    retryable: false
  },
  INVALID_STATE_TRANSITION: {
    message: "The requested state transition is not allowed.",
    retryable: false
  }
};

function isErrorCode(value: unknown): value is ErrorCode {
  return value === "INTERNAL_ERROR" || value === "INVALID_STATE_TRANSITION";
}

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = "CoreError";
  }
}

export function serializeError(error: unknown): SerializedError {
  const code = error instanceof CoreError && isErrorCode(error.code)
    ? error.code
    : "INTERNAL_ERROR";
  const definition = ERROR_DEFINITIONS[code];

  return {
    code,
    message: definition.message,
    retryable: definition.retryable
  };
}
