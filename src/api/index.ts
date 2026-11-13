/**
 * Workspace-scoped library API. The caller (src/auth/app.ts) has already authenticated the
 * session and resolved an active membership, so every handler here receives a verified
 * workspace id and role. Every query still filters by that workspace id.
 */
import { can, isUuid, reply, type Role } from '../auth/security.ts';
import { Conflict, Invalid, isForeignKeyViolation, isUniqueViolation, notFound, type Ctx } from './http.ts';
import {
  archiveSermon, createSermon, createVersion, getSermon, listSermons, listVersions, restoreSermon, updateSermon, updateVersion
} from './sermons.ts';
import { createEvent, deleteEvent, getEvent, listEvents, listSermonEvents, updateEvent } from './events.ts';
import { createPlace, listPlaces, mergePlace, previewPlaceMerge, renamePlace } from './places.ts';

type Handler = (c: Ctx) => Promise<Response>;
type Route = { method: string; pattern: string[]; write: boolean; handler: Handler };

const route = (method: string, path: string, handler: Handler): Route =>
  ({ method, pattern: path.split('/').slice(1), write: method !== 'GET', handler });

const ROUTES: Route[] = [
  route('GET', '/sermons', listSermons),
  route('POST', '/sermons', createSermon),
  route('GET', '/sermons/:sermonId', getSermon),
  route('PATCH', '/sermons/:sermonId', updateSermon),
  route('POST', '/sermons/:sermonId/archive', archiveSermon),
  route('POST', '/sermons/:sermonId/restore', restoreSermon),
  route('GET', '/sermons/:sermonId/versions', listVersions),
  route('POST', '/sermons/:sermonId/versions', createVersion),
  route('PATCH', '/sermons/:sermonId/versions/:versionId', updateVersion),
  route('GET', '/sermons/:sermonId/events', listSermonEvents),
  route('POST', '/sermons/:sermonId/events', createEvent),
  route('GET', '/events', listEvents),
  route('GET', '/events/:eventId', getEvent),
  route('PATCH', '/events/:eventId', updateEvent),
  route('DELETE', '/events/:eventId', deleteEvent),
  route('GET', '/places', listPlaces),
  route('POST', '/places', createPlace),
  route('PATCH', '/places/:placeId', renamePlace),
  route('GET', '/places/:placeId/merge-preview', previewPlaceMerge),
  route('POST', '/places/:placeId/merge', mergePlace)
];

/** Returns path params, or null when the shape does not match. Param values must be UUIDs. */
function match(pattern: string[], segments: string[]): Record<string, string> | null | 'invalid_id' {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) {
      if (!isUuid(segments[i])) return 'invalid_id';
      params[pattern[i].slice(1)] = segments[i];
    } else if (pattern[i] !== segments[i]) return null;
  }
  return params;
}

export async function handleLibraryRoute(
  request: Request, env: Env,
  access: { workspaceId: string; actorId: string; role: Role },
  path: string
): Promise<Response | null> {
  const segments = path.split('/').slice(1);
  for (const candidate of ROUTES) {
    if (candidate.method !== request.method) continue;
    const params = match(candidate.pattern, segments);
    if (params === null) continue;
    if (params === 'invalid_id') return notFound();
    // Members may read. Viewers are refused before any body is parsed or row is looked up.
    if (candidate.write && !can(access.role, 'edit')) return reply(403, { error: 'forbidden' });
    const ctx: Ctx = { env, request, url: new URL(request.url), ...access, params };
    try {
      return await candidate.handler(ctx);
    } catch (error) {
      if (error instanceof Invalid) return reply(400, { error: error.code, field: error.field });
      if (error instanceof Conflict) return reply(409, { error: error.code });
      if (isUniqueViolation(error) || isForeignKeyViolation(error)) return reply(409, { error: 'conflict' });
      throw error;
    }
  }
  return null;
}
