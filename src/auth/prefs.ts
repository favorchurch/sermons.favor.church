/** Account view preferences: a closed allow-list, merged on PATCH and capped when stored. */

export const MAX_PREFS_BYTES = 2048;

export type ViewPrefs = {
  libraryView?: 'covers' | 'rows' | 'table' | 'calendar';
  sort?: 'recent' | 'title' | 'added';
  archive?: 'active' | 'archived';
  series?: string;
  searchScope?: 'everything' | 'bible' | 'notes';
  workspaceId?: string;
};

type Check = (value: unknown) => boolean;
const oneOf = (...allowed: string[]): Check => value => typeof value === 'string' && allowed.includes(value);
const text = (max: number): Check => value => typeof value === 'string' && value.length <= max;

// A null value clears the key, so it is accepted for every key.
const FIELDS: Record<keyof ViewPrefs, Check> = {
  libraryView: oneOf('covers', 'rows', 'table', 'calendar'),
  sort: oneOf('recent', 'title', 'added'),
  archive: oneOf('active', 'archived'),
  series: text(200),
  searchScope: oneOf('everything', 'bible', 'notes'),
  workspaceId: text(64)
};

export type PrefsPatch = { [K in keyof ViewPrefs]?: ViewPrefs[K] | null };

/** Returns the validated partial patch, or null when the shape, a key or a value is not allowed. */
export function parsePrefsPatch(value: unknown): PrefsPatch | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const patch: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(FIELDS, key)) return null;
    if (entry !== null && !FIELDS[key as keyof ViewPrefs](entry)) return null;
    patch[key] = entry;
  }
  return patch as PrefsPatch;
}

/** Reads the stored column. Anything that is not a plain JSON object reads as no preferences. */
export function readStoredPrefs(stored: string | null | undefined): ViewPrefs {
  try {
    const parsed: unknown = JSON.parse(stored ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as ViewPrefs : {};
  } catch { return {}; }
}

/** Merges a patch into the stored prefs. Returns null when the result would exceed the size cap. */
export function mergePrefs(current: ViewPrefs, patch: PrefsPatch): { prefs: ViewPrefs; json: string } | null {
  const prefs: Record<string, unknown> = { ...current };
  for (const [key, entry] of Object.entries(patch)) {
    if (entry === null) delete prefs[key]; else prefs[key] = entry;
  }
  const json = JSON.stringify(prefs);
  return new TextEncoder().encode(json).length > MAX_PREFS_BYTES ? null : { prefs: prefs as ViewPrefs, json };
}
