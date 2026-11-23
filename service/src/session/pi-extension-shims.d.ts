declare module "typebox" {
  export interface TSchema {
    [key: string]: unknown;
  }

  export const Type: {
    Object(properties: Record<string, TSchema>, options?: Record<string, unknown>): TSchema;
    Optional(schema: TSchema): TSchema;
    String(options?: Record<string, unknown>): TSchema;
    Number(options?: Record<string, unknown>): TSchema;
    Integer(options?: Record<string, unknown>): TSchema;
    Boolean(options?: Record<string, unknown>): TSchema;
    Array(items: TSchema, options?: Record<string, unknown>): TSchema;
    Union(schemas: TSchema[], options?: Record<string, unknown>): TSchema;
    Literal(value: string | number | boolean): TSchema;
    Null(): TSchema;
  };
}

declare module "typebox/value" {
  import type { TSchema } from "typebox";

  export const Value: {
    Check(schema: TSchema, value: unknown): boolean;
  };
}
