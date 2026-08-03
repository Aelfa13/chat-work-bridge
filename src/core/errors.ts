export const ERROR_CODES = [
  "INTERNAL_ERROR",
  "INVALID_STATE_TRANSITION",
  "UNKNOWN_WORKSPACE",
  "WORKSPACE_BOUNDARY_VIOLATION",
  "WORKSPACE_PRECONDITION_FAILED",
  "CODEX_UNAVAILABLE",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_EXECUTION_FAILED"
] as const;

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
  },
  UNKNOWN_WORKSPACE: {
    message: "The requested workspace is not registered.",
    retryable: false
  },
  WORKSPACE_BOUNDARY_VIOLATION: {
    message: "The workspace boundary could not be verified.",
    retryable: false
  },
  WORKSPACE_PRECONDITION_FAILED: {
    message: "The workspace preconditions were not met.",
    retryable: false
  },
  CODEX_UNAVAILABLE: {
    message: "Codex is unavailable.",
    retryable: false
  },
  CODEX_PROTOCOL_ERROR: {
    message: "Codex returned an invalid response.",
    retryable: false
  },
  CODEX_EXECUTION_FAILED: {
    message: "Codex execution failed.",
    retryable: false
  }
};

function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
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
