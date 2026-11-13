/** Shared request context, strict input parsing and audit helpers for library routes. */
import { reply, readJson, isUuid, type Role } from '../auth/security.ts';

export type Ctx = {
  env: Env;
  request: Request;
  url: URL;
  workspaceId: string;
  actorId: string;
  role: Role;
  params: Record<string, string>;
};

/** Thrown for a rejected client value. Never carries the value itself. */
export class Invalid extends Error {
  field: string;
  code: string;
  constructor(field: string, code = 'invalid_request') {
    super(code);
    this.field = field;
    this.code = code;
  }
}

/** Thrown for a state conflict (name taken, already archived, locked source). */
export class Conflict extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const notFound = (): Response => reply(404, { error: 'not_found' });

function causeText(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return error.message + ' ' + cause;
}

export const isUniqueViolation = (error: unknown): boolean => /UNIQUE constraint failed/i.test(causeText(error));
export const isForeignKeyViolation = (error: unknown): boolean => /FOREIGN KEY constraint failed/i.test(causeText(error));

const CONTROL = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Single-line text: whitespace collapsed, non-empty, bounded, no control characters. */
export function line(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Invalid(field);
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text || text.length > max || CONTROL.test(text)) throw new Invalid(field);
  return text;
}

export function optionalLine(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return line(value, field, max);
}

export function multiline(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Invalid(field);
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (text.length > max || MULTILINE_CONTROL.test(text)) throw new Invalid(field);
  return text || null;
}

export function lineList(value: unknown, field: string, maxItems: number, maxLength: number, dedupe = false): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Invalid(field);
  const items = value.map(item => line(item, field, maxLength));
  if (!dedupe) return items;
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.toLowerCase();
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

export function uuidOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) throw new Invalid(field);
  return value;
}

/** Read a JSON object body and reject unknown keys so clients cannot set server-owned columns. */
export async function readBody(request: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const body = await readJson(request);
  if (!body) throw new Invalid('body', 'invalid_json');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Invalid(key, 'unknown_field');
  return body;
}

export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new Invalid(name);
  const value = Number(raw);
  if (value < min || value > max) throw new Invalid(name);
  return value;
}

export function uuidParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  if (!isUuid(raw)) throw new Invalid(name);
  return raw;
}

/**
 * Audit row for a mutation. `afterWrite` ties the row to the immediately preceding
 * statement in the same batch so a lost race records nothing. `details` must hold ids,
 * counts or field names only, never titles, notes or URLs.
 */
export function auditStatement(
  c: Ctx, action: string, targetType: string, targetId: string,
  details: Record<string, unknown> = {}, afterWrite = false
): D1PreparedStatement {
  return c.env.DB.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id, details_json)
    SELECT ?, ?, ?, ?, ?, ?, ?${afterWrite ? ' WHERE changes() = 1' : ''}`)
    .bind(crypto.randomUUID(), c.workspaceId, c.actorId, action, targetType, targetId, JSON.stringify(details));
}

export const changes = (result: D1Result | undefined): number => result?.meta?.changes ?? 0;
