/**
 * Bible reference resolver and extractor for Protestant canon (66 books).
 */

export interface BibleReference {
  book: string;
  chapter: number;
  verseStart: number | null;
  verseEnd: number | null;
  v1: number | null;
  v2: number | null;
  raw: string;
  overlaps(other: BibleReference | string): boolean;
  format(): string;
  toString(): string;
}

export interface ExtractedReference extends BibleReference {
  start: number;
  end: number;
  startIndex: number;
  endIndex: number;
  index: number;
}

export const CANONICAL_BOOKS: readonly string[] = [
  // Old Testament (39 books)
  'Genesis',
  'Exodus',
  'Leviticus',
  'Numbers',
  'Deuteronomy',
  'Joshua',
  'Judges',
  'Ruth',
  '1 Samuel',
  '2 Samuel',
  '1 Kings',
  '2 Kings',
  '1 Chronicles',
  '2 Chronicles',
  'Ezra',
  'Nehemiah',
  'Esther',
  'Job',
  'Psalms',
  'Proverbs',
  'Ecclesiastes',
  'Song of Solomon',
  'Isaiah',
  'Jeremiah',
  'Lamentations',
  'Ezekiel',
  'Daniel',
  'Hosea',
  'Joel',
  'Amos',
  'Obadiah',
  'Jonah',
  'Micah',
  'Nahum',
  'Habakkuk',
  'Zephaniah',
  'Haggai',
  'Zechariah',
  'Malachi',
  // New Testament (27 books)
  'Matthew',
  'Mark',
  'Luke',
  'John',
  'Acts',
  'Romans',
  '1 Corinthians',
  '2 Corinthians',
  'Galatians',
  'Ephesians',
  'Philippians',
  'Colossians',
  '1 Thessalonians',
  '2 Thessalonians',
  '1 Timothy',
  '2 Timothy',
  'Titus',
  'Philemon',
  'Hebrews',
  'James',
  '1 Peter',
  '2 Peter',
  '1 John',
  '2 John',
  '3 John',
  'Jude',
  'Revelation'
];

export const BOOKS = CANONICAL_BOOKS;

export const BOOK_ALIASES: Record<string, readonly string[]> = {
  Genesis: ['genesis', 'gen', 'ge', 'gn'],
  Exodus: ['exodus', 'exod', 'exo', 'ex'],
  Leviticus: ['leviticus', 'lev', 'le', 'lv'],
  Numbers: ['numbers', 'num', 'nu', 'nm', 'nb'],
  Deuteronomy: ['deuteronomy', 'deut', 'de', 'dt'],
  Joshua: ['joshua', 'josh', 'jos', 'jsh'],
  Judges: ['judges', 'judg', 'jdg', 'jdgs', 'jds'],
  Ruth: ['ruth', 'rth', 'ru'],
  '1 Samuel': [
    '1 samuel', '1samuel', '1 sam', '1sam', '1 sa', '1sa', '1 s', '1s',
    'i samuel', 'i sam', 'i sa', '1st samuel', 'first samuel'
  ],
  '2 Samuel': [
    '2 samuel', '2samuel', '2 sam', '2sam', '2 sa', '2sa', '2 s', '2s',
    'ii samuel', 'ii sam', 'ii sa', '2nd samuel', 'second samuel'
  ],
  '1 Kings': [
    '1 kings', '1kings', '1 kgs', '1kgs', '1 ki', '1ki', '1 k', '1k',
    '1 king', '1king', '1 kin', '1kin', 'i kings', 'i kgs', 'i ki', '1st kings', 'first kings'
  ],
  '2 Kings': [
    '2 kings', '2kings', '2 kgs', '2kgs', '2 ki', '2ki', '2 k', '2k',
    '2 king', '2king', '2 kin', '2kin', 'ii kings', 'ii kgs', 'ii ki', '2nd kings', 'second kings'
  ],
  '1 Chronicles': [
    '1 chronicles', '1chronicles', '1 chron', '1chron', '1 chr', '1chr', '1 ch', '1ch',
    'i chronicles', 'i chron', 'i chr', '1st chronicles', 'first chronicles'
  ],
  '2 Chronicles': [
    '2 chronicles', '2chronicles', '2 chron', '2chron', '2 chr', '2chr', '2 ch', '2ch',
    'ii chronicles', 'ii chron', 'ii chr', '2nd chronicles', 'second chronicles'
  ],
  Ezra: ['ezra', 'ezr', 'ez'],
  Nehemiah: ['nehemiah', 'neh', 'ne'],
  Esther: ['esther', 'esth', 'est', 'es'],
  Job: ['job', 'jb'],
  Psalms: ['psalms', 'psalm', 'psa', 'psm', 'pss', 'ps'],
  Proverbs: ['proverbs', 'prov', 'pro', 'prv', 'pr'],
  Ecclesiastes: ['ecclesiastes', 'eccles', 'eccl', 'ecc', 'ec', 'qoh', 'qoheleth'],
  'Song of Solomon': [
    'song of solomon', 'song of songs', 'song of sol', 'canticle of canticles',
    'canticles', 'song', 'sos', 'cant'
  ],
  Isaiah: ['isaiah', 'isa', 'is'],
  Jeremiah: ['jeremiah', 'jer', 'je', 'jr'],
  Lamentations: ['lamentations', 'lam', 'la'],
  Ezekiel: ['ezekiel', 'ezek', 'eze', 'ezk'],
  Daniel: ['daniel', 'dan', 'da', 'dn'],
  Hosea: ['hosea', 'hos', 'ho'],
  Joel: ['joel', 'joe', 'jl'],
  Amos: ['amos', 'am'],
  Obadiah: ['obadiah', 'obad', 'oba', 'ob'],
  Jonah: ['jonah', 'jon', 'jnh'],
  Micah: ['micah', 'mic', 'mc'],
  Nahum: ['nahum', 'nah', 'na'],
  Habakkuk: ['habakkuk', 'hab', 'hb'],
  Zephaniah: ['zephaniah', 'zeph', 'zep', 'zp'],
  Haggai: ['haggai', 'hag', 'hg'],
  Zechariah: ['zechariah', 'zech', 'zec', 'zc'],
  Malachi: ['malachi', 'mal', 'ml'],
  Matthew: ['matthew', 'matt', 'mat', 'mt'],
  Mark: ['mark', 'mrk', 'mar', 'mk', 'mr'],
  Luke: ['luke', 'luk', 'lu', 'lk'],
  John: ['john', 'jhn', 'joh', 'jn'],
  Acts: ['acts', 'act', 'ac'],
  Romans: ['romans', 'rom', 'ro', 'rm'],
  '1 Corinthians': [
    '1 corinthians', '1corinthians', '1 cor', '1cor', '1 co', '1co',
    'i corinthians', 'i cor', 'i co', '1st corinthians', 'first corinthians'
  ],
  '2 Corinthians': [
    '2 corinthians', '2corinthians', '2 cor', '2cor', '2 co', '2co',
    'ii corinthians', 'ii cor', 'ii co', '2nd corinthians', 'second corinthians'
  ],
  Galatians: ['galatians', 'gal', 'ga'],
  Ephesians: ['ephesians', 'ephes', 'eph', 'ep'],
  Philippians: ['philippians', 'phil', 'php', 'pp'],
  Colossians: ['colossians', 'col', 'co'],
  '1 Thessalonians': [
    '1 thessalonians', '1thessalonians', '1 thess', '1thess', '1 thes', '1thes',
    '1 th', '1th', 'i thessalonians', 'i thess', 'i thes', '1st thessalonians', 'first thessalonians'
  ],
  '2 Thessalonians': [
    '2 thessalonians', '2thessalonians', '2 thess', '2thess', '2 thes', '2thes',
    '2 th', '2th', 'ii thessalonians', 'ii thess', 'ii thes', '2nd thessalonians', 'second thessalonians'
  ],
  '1 Timothy': [
    '1 timothy', '1timothy', '1 tim', '1tim', '1 ti', '1ti',
    'i timothy', 'i tim', 'i ti', '1st timothy', 'first timothy'
  ],
  '2 Timothy': [
    '2 timothy', '2timothy', '2 tim', '2tim', '2 ti', '2ti',
    'ii timothy', 'ii tim', 'ii ti', '2nd timothy', 'second timothy'
  ],
  Titus: ['titus', 'tit', 'ti'],
  Philemon: ['philemon', 'philem', 'phlm', 'phm', 'pm'],
  Hebrews: ['hebrews', 'heb', 'he'],
  James: ['james', 'jas', 'jam', 'jm'],
  '1 Peter': [
    '1 peter', '1peter', '1 pet', '1pet', '1 pe', '1pe', '1 pt', '1pt',
    'i peter', 'i pet', 'i pt', '1st peter', 'first peter'
  ],
  '2 Peter': [
    '2 peter', '2peter', '2 pet', '2pet', '2 pe', '2pe', '2 pt', '2pt',
    'ii peter', 'ii pet', 'ii pt', '2nd peter', 'second peter'
  ],
  '1 John': [
    '1 john', '1john', '1 jhn', '1jhn', '1 jn', '1jn', '1 joh', '1joh',
    '1 j', '1j', 'i john', 'i jn', 'i jhn', '1st john', 'first john'
  ],
  '2 John': [
    '2 john', '2john', '2 jhn', '2jhn', '2 jn', '2jn', '2 joh', '2joh',
    '2 j', '2j', 'ii john', 'ii jn', 'ii jhn', '2nd john', 'second john'
  ],
  '3 John': [
    '3 john', '3john', '3 jhn', '3jhn', '3 jn', '3jn', '3 joh', '3joh',
    '3 j', '3j', 'iii john', 'iii jn', 'iii jhn', '3rd john', 'third john'
  ],
  Jude: ['jude', 'jud', 'jd'],
  Revelation: ['revelation', 'revelations', 'rev', 're', 'the revelation', 'apocalypse']
};

// Map each normalized alias to canonical book name
const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(BOOK_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
  }
}

/**
 * Normalizes any book name or alias (case-insensitive, optional trailing period)
 * to its canonical 66-book Protestant name, or returns null if not recognized.
 */
export function normalizeBook(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^([0-9iv]+)\.\s*/i, '$1 ')
    .replace(/\s+/g, ' ');
  return ALIAS_TO_CANONICAL.get(cleaned) ?? null;
}

// Build regex patterns for aliases
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const aliasPatterns: string[] = [];
for (const alias of ALIAS_TO_CANONICAL.keys()) {
  aliasPatterns.push(escapeRegex(alias).replace(/\s+/g, '\\s+'));
}
// Sort by length descending to ensure longer matches take precedence
aliasPatterns.sort((a, b) => b.length - a.length);

const BOOK_PATTERN = aliasPatterns.join('|');

// Matches book abbreviation with optional trailing period, whitespace,
// chapter number, and optional :verse[-verse]
const REF_REGEX = new RegExp(
  `(?<![A-Za-z0-9])(${BOOK_PATTERN})\\.?\\s+(\\d{1,3})(?::(\\d{1,3})(?:\\s*[-–—]\\s*(?:(\\d{1,3}):)?(\\d{1,3}))?)?(?![A-Za-z0-9])`,
  'gi'
);

function createReferenceMethods(
  book: string,
  chapter: number,
  verseStart: number | null,
  verseEnd: number | null,
  raw: string
): Pick<BibleReference, 'overlaps' | 'format' | 'toString'> {
  const self = {
    book,
    chapter,
    verseStart,
    verseEnd,
    v1: verseStart,
    v2: verseEnd,
    raw
  };
  return {
    overlaps(other: BibleReference | string): boolean {
      return overlaps(self, other);
    },
    format(): string {
      return formatReference(self);
    },
    toString(): string {
      return formatReference(self);
    }
  };
}

/**
 * Formats a BibleReference into standard string representation.
 */
export function formatReference(ref: {
  book: string;
  chapter: number;
  verseStart?: number | null;
  verseEnd?: number | null;
  v1?: number | null;
  v2?: number | null;
}): string {
  const vStart = ref.verseStart ?? ref.v1 ?? null;
  const vEnd = ref.verseEnd ?? ref.v2 ?? vStart;
  if (vStart === null) {
    return `${ref.book} ${ref.chapter}`;
  }
  if (vEnd !== null && vEnd !== vStart) {
    return `${ref.book} ${ref.chapter}:${vStart}–${vEnd}`;
  }
  return `${ref.book} ${ref.chapter}:${vStart}`;
}

/**
 * Extracts all valid Bible references from free text with character offsets.
 */
export function extractReferences(text: string | null | undefined): ExtractedReference[] {
  const out: ExtractedReference[] = [];
  if (typeof text !== 'string' || !text) return out;

  REF_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = REF_REGEX.exec(text)) !== null) {
    const rawMatch = m[0];
    const bookStr = m[1];
    const canonicalBook = normalizeBook(bookStr);
    if (!canonicalBook) continue;

    const chapter = Number(m[2]);
    if (chapter <= 0) continue;

    const v1Str = m[3];
    const ch2Str = m[4];
    const v2Str = m[5];

    let verseStart: number | null = null;
    let verseEnd: number | null = null;

    if (v1Str !== undefined) {
      verseStart = Number(v1Str);
      if (verseStart <= 0) continue;

      if (v2Str !== undefined) {
        verseEnd = Number(v2Str);
        if (verseEnd <= 0) continue;

        // If second chapter was explicitly provided (e.g. 8:1-8:5), must match first chapter
        if (ch2Str !== undefined && Number(ch2Str) !== chapter) {
          continue;
        }

        // Inverted range check (e.g. 16-10 is invalid)
        if (verseEnd < verseStart) {
          continue;
        }
      } else {
        verseEnd = verseStart;
      }
    }

    const start = m.index;
    const end = m.index + rawMatch.length;

    const methods = createReferenceMethods(
      canonicalBook,
      chapter,
      verseStart,
      verseEnd,
      rawMatch
    );

    out.push({
      book: canonicalBook,
      chapter,
      verseStart,
      verseEnd,
      v1: verseStart,
      v2: verseEnd,
      raw: rawMatch,
      start,
      end,
      startIndex: start,
      endIndex: end,
      index: start,
      ...methods
    });
  }

  return out;
}

/**
 * Parses a single Bible reference string (e.g. "John 3:16", "Jn 3:16-18", "Romans 8").
 * Returns null if the input is nonsense or malformed, without throwing.
 */
export function parseReference(input: string | null | undefined): BibleReference | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const refs = extractReferences(trimmed);
  if (refs.length !== 1) return null;

  const ref = refs[0];
  // Must match from start of string
  if (ref.start !== 0) return null;

  // The match must cover the whole trimmed input, or the trimmed input minus a single trailing period
  if (ref.end === trimmed.length || (ref.end === trimmed.length - 1 && trimmed.endsWith('.'))) {
    return ref;
  }

  return null;
}

// Alias for convenience
export const parseBibleReference = parseReference;

/**
 * Checks whether two Bible references overlap.
 * - Both must be in the same canonical book and chapter.
 * - A whole chapter reference overlaps any reference in that chapter.
 * - Verse ranges [v1Start, v1End] and [v2Start, v2End] overlap when v1Start <= v2End && v2Start <= v1End.
 * Accepts either parsed BibleReference objects or reference strings.
 * Never throws on invalid inputs.
 */
export function overlaps(
  a: BibleReference | { book: string; chapter: number; verseStart?: number | null; verseEnd?: number | null; v1?: number | null; v2?: number | null } | string | null | undefined,
  b: BibleReference | { book: string; chapter: number; verseStart?: number | null; verseEnd?: number | null; v1?: number | null; v2?: number | null } | string | null | undefined
): boolean {
  const refA = typeof a === 'string' ? parseReference(a) : a;
  const refB = typeof b === 'string' ? parseReference(b) : b;
  if (!refA || !refB) return false;

  const bookA = normalizeBook(refA.book);
  const bookB = normalizeBook(refB.book);
  if (!bookA || !bookB || bookA !== bookB) return false;

  if (refA.chapter !== refB.chapter) return false;

  const aStart = refA.verseStart ?? refA.v1 ?? null;
  const aEnd = refA.verseEnd ?? refA.v2 ?? aStart;
  const bStart = refB.verseStart ?? refB.v1 ?? null;
  const bEnd = refB.verseEnd ?? refB.v2 ?? bStart;

  // Whole chapter reference overlaps anything in that same chapter
  if (aStart === null || bStart === null) return true;

  const effectiveAEnd = aEnd ?? aStart;
  const effectiveBEnd = bEnd ?? bStart;

  return aStart <= effectiveBEnd && bStart <= effectiveAEnd;
}

export const referenceOverlaps = overlaps;

/**
 * Finds all reference hits in a text that overlap with the target query reference.
 */
export function findReferenceHits(
  text: string | null | undefined,
  target: BibleReference | string
): ExtractedReference[] {
  const targetRef = typeof target === 'string' ? parseReference(target) : target;
  if (!targetRef) return [];
  return extractReferences(text).filter(ref => overlaps(ref, targetRef));
}
