import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR';

/** Expected failure that maps to a JSON error response: { error: { code, message, details? } }. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Parses the JSON body against a schema, rejecting malformed JSON and invalid fields with 400. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(body);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request body is invalid.', details);
  }
  return result.data;
}
