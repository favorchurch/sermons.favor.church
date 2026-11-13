/**
 * Route registry for the workspace-scoped library API. Paths are relative to
 * /api/workspaces/:workspaceId and every :param must be a UUID. Handlers receive a
 * verified workspace id and role (see Ctx); non-GET routes are refused for Viewers
 * before the handler runs.
 *
 * Later tasks add routes by appending to ROUTES below the marker, importing their
 * handlers at the top of this file. They do not need to touch src/api/index.ts.
 */
import type { Ctx } from './http.ts';
import {
  archiveSermon, createSermon, createVersion, getSermon, listSermons, listVersions, restoreSermon, updateSermon, updateVersion
} from './sermons.ts';
import { createEvent, deleteEvent, getEvent, listEvents, listSermonEvents, updateEvent } from './events.ts';
import { createPlace, listPlaces, mergePlace, previewPlaceMerge, renamePlace } from './places.ts';
import { upload, summary, rows, attest, ignore, approve, rollback } from '../import/routes.ts';
import { findInNotes, search } from '../search/api.ts';
import { consentToIndex, downloadPdf, revokeIndexing, uploadPdf } from '../sources/api.ts';

export type Handler = (c: Ctx) => Promise<Response>;
export type Route = { method: string; pattern: string[]; write: boolean; handler: Handler };

export const route = (method: string, path: string, handler: Handler): Route =>
  ({ method, pattern: path.split('/').slice(1), write: method !== 'GET', handler });

export const ROUTES: Route[] = [
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
  route('POST', '/places/:placeId/merge', mergePlace),
  route('POST', '/imports', upload),
  route('GET', '/imports/:batchId/summary', summary),
  route('GET', '/imports/:batchId/rows', rows),
  route('POST', '/imports/:batchId/attest', attest),
  route('POST', '/imports/:batchId/rows/:rowId/ignore', ignore),
  route('POST', '/imports/:batchId/rows/:rowId/approve', approve),
  route('POST', '/imports/:batchId/rows/:rowId/rollback', rollback),
  route('GET', '/search', search),
  route('GET', '/sermons/:sermonId/find-in-notes', findInNotes),
  route('POST', '/sermons/:sermonId/versions/:versionId/pdf', uploadPdf),
  route('GET', '/sermons/:sermonId/versions/:versionId/pdf', downloadPdf),
  route('POST', '/sermons/:sermonId/versions/:versionId/consent', consentToIndex),
  route('POST', '/sermons/:sermonId/versions/:versionId/revoke', revokeIndexing),
  // --- append new routes above this line ---
];
