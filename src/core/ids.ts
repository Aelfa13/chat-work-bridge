import { randomUUID } from "node:crypto";

declare const idBrand: unique symbol;

export type Id = string & { readonly [idBrand]: "Id" };

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newId(): Id {
  return randomUUID() as Id;
}

export function isId(value: unknown): value is Id {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}
