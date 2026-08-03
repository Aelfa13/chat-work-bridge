import assert from "node:assert/strict";
import test from "node:test";

import { isId, newId } from "../../src/core/ids.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("newId creates a UUID v4", () => {
  assert.match(newId(), UUID_V4_PATTERN);
});

test("isId accepts RFC-compatible UUID v4 values", () => {
  assert.equal(isId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isId("550E8400-E29B-41D4-A716-446655440000"), true);
});

test("isId rejects non-v4 UUIDs and malformed values", () => {
  const invalidValues: unknown[] = [
    "550e8400-e29b-11d4-a716-446655440000",
    "550e8400-e29b-41d4-c716-446655440000",
    "00000000-0000-0000-0000-000000000000",
    "550e8400e29b41d4a716446655440000",
    "",
    42,
    null,
    undefined,
    {},
    []
  ];

  for (const value of invalidValues) {
    assert.equal(isId(value), false);
  }
});
