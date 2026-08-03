import assert from "node:assert/strict";
import test from "node:test";

import { CoreError, ERROR_CODES, serializeError } from "../../src/core/errors.js";

test("exposes the Codex error codes", () => {
  assert.deepEqual(ERROR_CODES, [
    "INTERNAL_ERROR",
    "INVALID_STATE_TRANSITION",
    "CODEX_UNAVAILABLE",
    "CODEX_PROTOCOL_ERROR",
    "CODEX_EXECUTION_FAILED"
  ]);
  assert.deepEqual(serializeError(new CoreError("CODEX_UNAVAILABLE")), {
    code: "CODEX_UNAVAILABLE", message: "Codex is unavailable.", retryable: false
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_PROTOCOL_ERROR")), {
    code: "CODEX_PROTOCOL_ERROR", message: "Codex returned an invalid response.", retryable: false
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_EXECUTION_FAILED")), {
    code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed.", retryable: false
  });
});

test("serializeError exposes an allowlisted core error", () => {
  const serialized = serializeError(new CoreError("INVALID_STATE_TRANSITION"));

  assert.deepEqual(serialized, {
    code: "INVALID_STATE_TRANSITION",
    message: "The requested state transition is not allowed.",
    retryable: false
  });
});

test("serializeError ignores mutated CoreError details", () => {
  const secretMarkers = ["secret-message", "secret-stack", "secret-cause", "/test-only/private-path"] as const;
  const error = new CoreError("INVALID_STATE_TRANSITION");

  Object.assign(error, {
    message: secretMarkers[0],
    stack: secretMarkers[1],
    cause: new Error(secretMarkers[2]),
    path: secretMarkers[3]
  });

  const serialized = serializeError(error);
  const json = JSON.stringify(serialized);

  assert.deepEqual(serialized, {
    code: "INVALID_STATE_TRANSITION",
    message: "The requested state transition is not allowed.",
    retryable: false
  });
  for (const marker of secretMarkers) {
    assert.equal(json.includes(marker), false);
  }
});

test("serializeError removes details from unknown errors and values", () => {
  const secretMarkers = ["secret-message", "secret-stack", "secret-cause", "/test-only/private-path"] as const;
  const error = Object.assign(new Error(secretMarkers[0]), {
    stack: secretMarkers[1],
    cause: new Error(secretMarkers[2]),
    path: secretMarkers[3]
  });
  const inputs: unknown[] = [error, secretMarkers[0], { path: secretMarkers[3] }, [], 42, null, undefined];

  for (const input of inputs) {
    const serialized = serializeError(input);
    const json = JSON.stringify(serialized);

    assert.deepEqual(serialized, {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
      retryable: false
    });
    for (const marker of secretMarkers) {
      assert.equal(json.includes(marker), false);
    }
  }
});
