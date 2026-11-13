import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReference,
  extractReferences,
  overlaps,
  normalizeBook,
  formatReference,
  findReferenceHits,
  CANONICAL_BOOKS,
  BOOK_ALIASES
} from '../src/search/bible.ts';

test('CANONICAL_BOOKS contains all 66 Protestant canon books', () => {
  assert.equal(CANONICAL_BOOKS.length, 66);
  // Verify Old Testament sample
  assert.ok(CANONICAL_BOOKS.includes('Genesis'));
  assert.ok(CANONICAL_BOOKS.includes('Psalms'));
  assert.ok(CANONICAL_BOOKS.includes('Song of Solomon'));
  assert.ok(CANONICAL_BOOKS.includes('Malachi'));
  // Verify New Testament sample
  assert.ok(CANONICAL_BOOKS.includes('Matthew'));
  assert.ok(CANONICAL_BOOKS.includes('John'));
  assert.ok(CANONICAL_BOOKS.includes('Romans'));
  assert.ok(CANONICAL_BOOKS.includes('1 Corinthians'));
  assert.ok(CANONICAL_BOOKS.includes('Revelation'));
});

test('normalizes aliases and abbreviations for all 66 Protestant canon books', () => {
  // Test specific examples called out in the brief
  assert.equal(normalizeBook('Jn'), 'John');
  assert.equal(normalizeBook('Jhn'), 'John');
  assert.equal(normalizeBook('jn.'), 'John');
  assert.equal(normalizeBook('JHN.'), 'John');
  assert.equal(normalizeBook('Rom'), 'Romans');
  assert.equal(normalizeBook('rom.'), 'Romans');
  assert.equal(normalizeBook('1 Cor'), '1 Corinthians');
  assert.equal(normalizeBook('1 Cor.'), '1 Corinthians');
  assert.equal(normalizeBook('1Co'), '1 Corinthians');
  assert.equal(normalizeBook('1co.'), '1 Corinthians');
  assert.equal(normalizeBook('Ps'), 'Psalms');
  assert.equal(normalizeBook('Psalm'), 'Psalms');
  assert.equal(normalizeBook('Psalms'), 'Psalms');
  assert.equal(normalizeBook('ps.'), 'Psalms');
  assert.equal(normalizeBook('Song of Songs'), 'Song of Solomon');
  assert.equal(normalizeBook('Song of Solomon'), 'Song of Solomon');
  assert.equal(normalizeBook('song of songs.'), 'Song of Solomon');

  // Verify that every single canonical book normalizes from its name and aliases
  for (const book of CANONICAL_BOOKS) {
    assert.equal(normalizeBook(book), book, `Canonical book "${book}" failed to self-normalize`);
    assert.equal(normalizeBook(book.toLowerCase()), book, `Lowercase book "${book}" failed`);
    assert.equal(normalizeBook(book.toUpperCase()), book, `Uppercase book "${book}" failed`);
    assert.equal(normalizeBook(book + '.'), book, `Trailing period on "${book}" failed`);

    const aliases = BOOK_ALIASES[book] || [];
    for (const alias of aliases) {
      assert.equal(normalizeBook(alias), book, `Alias "${alias}" failed for "${book}"`);
      assert.equal(normalizeBook(alias + '.'), book, `Alias with period "${alias}." failed for "${book}"`);
      assert.equal(normalizeBook(alias.toUpperCase()), book, `Uppercase alias "${alias.toUpperCase()}" failed`);
    }
  }
});

test('parses single verses, ranges, en dash ranges, and whole chapters', () => {
  // Single verse
  const jn = parseReference('John 3:16');
  assert.ok(jn);
  assert.equal(jn.book, 'John');
  assert.equal(jn.chapter, 3);
  assert.equal(jn.verseStart, 16);
  assert.equal(jn.verseEnd, 16);
  assert.equal(jn.v1, 16);
  assert.equal(jn.v2, 16);

  // Abbreviation range with hyphen
  const jnRange = parseReference('Jn 3:16-18');
  assert.ok(jnRange);
  assert.equal(jnRange.book, 'John');
  assert.equal(jnRange.chapter, 3);
  assert.equal(jnRange.verseStart, 16);
  assert.equal(jnRange.verseEnd, 18);
  assert.equal(jnRange.v1, 16);
  assert.equal(jnRange.v2, 18);

  // Range with en dash
  const enDashRange = parseReference('John 3:16–18');
  assert.ok(enDashRange);
  assert.equal(enDashRange.book, 'John');
  assert.equal(enDashRange.chapter, 3);
  assert.equal(enDashRange.verseStart, 16);
  assert.equal(enDashRange.verseEnd, 18);

  // Whole chapter
  const rom8 = parseReference('Romans 8');
  assert.ok(rom8);
  assert.equal(rom8.book, 'Romans');
  assert.equal(rom8.chapter, 8);
  assert.equal(rom8.verseStart, null);
  assert.equal(rom8.verseEnd, null);
  assert.equal(rom8.v1, null);
  assert.equal(rom8.v2, null);

  // Whole chapter with abbreviation and trailing dot
  const rom8Dot = parseReference('Rom. 8');
  assert.ok(rom8Dot);
  assert.equal(rom8Dot.book, 'Romans');
  assert.equal(rom8Dot.chapter, 8);
  assert.equal(rom8Dot.verseStart, null);

  // Formatted reference strings
  assert.equal(jn.format(), 'John 3:16');
  assert.equal(jnRange.format(), 'John 3:16–18');
  assert.equal(rom8.format(), 'Romans 8');
});

test('rejects nonsense and malformed references without throwing', () => {
  const badInputs = [
    '',
    '   ',
    null,
    undefined,
    123,
    {},
    [],
    'nonsense',
    'not a book 3:16',
    'John',
    'Romans',
    'John 3:',
    'John :16',
    'John 3:16-',
    'John 3:16-10', // inverted range
    'John 0:1',      // chapter 0
    'John 3:0',      // verse 0
    'John -1:5',
    'John 3:16 extra text',
    'Foo 1:1',
    'Romans 8:1-9:5' // cross-chapter verse range
  ];

  for (const input of badInputs) {
    assert.doesNotThrow(() => {
      const result = parseReference(input);
      assert.equal(result, null, `Expected null for input: ${JSON.stringify(input)}`);
    });
  }
});

test('overlaps: verifies reference overlap rules', () => {
  // Required in brief: "John 3:16" overlaps "John 3:16–18"
  assert.ok(overlaps('John 3:16', 'John 3:16–18'));
  assert.ok(overlaps('John 3:16–18', 'John 3:16'));

  // Required in brief: "Joshua 1:2" overlaps "Joshua 1:1–9"
  assert.ok(overlaps('Joshua 1:2', 'Joshua 1:1–9'));
  assert.ok(overlaps('Joshua 1:1–9', 'Joshua 1:2'));

  // Required in brief: different chapters or books do not overlap
  assert.equal(overlaps('Joshua 1:2', 'Joshua 2:2'), false);
  assert.equal(overlaps('John 3:16', 'Romans 3:16'), false);
  assert.equal(overlaps('Joshua 1:2', 'Judges 1:2'), false);

  // Disjoint ranges in same chapter do not overlap
  assert.equal(overlaps('John 3:1', 'John 3:16'), false);
  assert.equal(overlaps('John 3:1-15', 'John 3:16-18'), false);
  assert.equal(overlaps('John 3:17-20', 'John 3:16'), false);

  // Adjacent ranges that share an endpoint DO overlap
  assert.ok(overlaps('John 3:1-16', 'John 3:16-18'));

  // Whole chapter overlaps any verse or range in that chapter
  assert.ok(overlaps('Romans 8', 'Romans 8:28'));
  assert.ok(overlaps('Romans 8:28', 'Romans 8'));
  assert.ok(overlaps('Romans 8', 'Romans 8:1-10'));
  assert.ok(overlaps('Romans 8', 'Romans 8'));
  assert.equal(overlaps('Romans 8', 'Romans 9:1'), false);
  assert.equal(overlaps('Romans 8', 'Romans 7'), false);

  // Aliases and abbreviations overlap correctly
  assert.ok(overlaps('Jn 3:16', 'John 3:16–18'));
  assert.ok(overlaps('1 Cor 13:4', '1Co 13:1-13'));
  assert.ok(overlaps('Song of Songs 2:1', 'Song of Solomon 2:1-5'));
  assert.ok(overlaps('Ps 23:1', 'Psalm 23'));

  // Method call on reference object
  const ref = parseReference('John 3:16');
  assert.ok(ref.overlaps('John 3:16-18'));
  assert.equal(ref.overlaps('John 4:16'), false);

  // Non-matching and nonsense inputs safely return false without throwing
  assert.equal(overlaps(null, 'John 3:16'), false);
  assert.equal(overlaps('John 3:16', undefined), false);
  assert.equal(overlaps('nonsense', 'John 3:16'), false);
  assert.equal(overlaps('nonsense', 'nonsense'), false);
});

test('extractReferences finds references inside free text with correct offsets', () => {
  const text = 'For God so loved the world (John 3:16), that he gave his Son. See also Jn 3:16-18 and Rom. 8.';
  const refs = extractReferences(text);

  assert.equal(refs.length, 3);

  // First reference: John 3:16
  const ref1 = refs[0];
  assert.equal(ref1.book, 'John');
  assert.equal(ref1.chapter, 3);
  assert.equal(ref1.verseStart, 16);
  assert.equal(ref1.verseEnd, 16);
  assert.equal(ref1.raw, 'John 3:16');
  assert.equal(text.slice(ref1.start, ref1.end), 'John 3:16');
  assert.equal(ref1.start, 28);
  assert.equal(ref1.end, 37);

  // Second reference: Jn 3:16-18
  const ref2 = refs[1];
  assert.equal(ref2.book, 'John');
  assert.equal(ref2.chapter, 3);
  assert.equal(ref2.verseStart, 16);
  assert.equal(ref2.verseEnd, 18);
  assert.equal(ref2.raw, 'Jn 3:16-18');
  assert.equal(text.slice(ref2.start, ref2.end), 'Jn 3:16-18');

  // Third reference: Rom. 8 (with abbreviation dot)
  const ref3 = refs[2];
  assert.equal(ref3.book, 'Romans');
  assert.equal(ref3.chapter, 8);
  assert.equal(ref3.verseStart, null);
  assert.equal(ref3.verseEnd, null);
  assert.equal(ref3.raw, 'Rom. 8');
  assert.equal(text.slice(ref3.start, ref3.end), 'Rom. 8');
  // Notice: the sentence-ending period after Rom. 8 is NOT included in the offset
  assert.equal(text[ref3.end], '.');
});

test('extractReferences handles complex text, quotes, and punctuation', () => {
  const text = 'Read "1 Cor. 13:4-8", then Joshua 1:1–9; finally check Ps 23:1.';
  const refs = extractReferences(text);

  assert.equal(refs.length, 3);

  assert.equal(refs[0].book, '1 Corinthians');
  assert.equal(refs[0].chapter, 13);
  assert.equal(refs[0].verseStart, 4);
  assert.equal(refs[0].verseEnd, 8);
  assert.equal(refs[0].raw, '1 Cor. 13:4-8');
  assert.equal(text.slice(refs[0].start, refs[0].end), '1 Cor. 13:4-8');

  assert.equal(refs[1].book, 'Joshua');
  assert.equal(refs[1].chapter, 1);
  assert.equal(refs[1].verseStart, 1);
  assert.equal(refs[1].verseEnd, 9);
  assert.equal(refs[1].raw, 'Joshua 1:1–9');
  assert.equal(text.slice(refs[1].start, refs[1].end), 'Joshua 1:1–9');

  assert.equal(refs[2].book, 'Psalms');
  assert.equal(refs[2].chapter, 23);
  assert.equal(refs[2].verseStart, 1);
  assert.equal(refs[2].verseEnd, 1);
  assert.equal(refs[2].raw, 'Ps 23:1');
  assert.equal(text.slice(refs[2].start, refs[2].end), 'Ps 23:1');
});

test('extractReferences returns empty array for null, empty, or non-reference text', () => {
  assert.deepEqual(extractReferences(''), []);
  assert.deepEqual(extractReferences(null), []);
  assert.deepEqual(extractReferences(undefined), []);
  assert.deepEqual(extractReferences(123), []);
  assert.deepEqual(extractReferences('No scripture here, just a plain note.'), []);
});

test('findReferenceHits filters text references that overlap target query', () => {
  const noteText = 'Pastor preached from John 3:16–18 and touched on Romans 8:28 as well as Joshua 1:9.';
  const hits = findReferenceHits(noteText, 'John 3:16');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].raw, 'John 3:16–18');

  const romHits = findReferenceHits(noteText, 'Rom 8');
  assert.equal(romHits.length, 1);
  assert.equal(romHits[0].raw, 'Romans 8:28');

  const noHits = findReferenceHits(noteText, 'John 3:1');
  assert.equal(noHits.length, 0);
});

test('extractReferences does not falsely match common English prose words', () => {
  const prose = 'Today is 10 days since the event. I am 12 years old. Email re 15 questions. He 11 runners.';
  const refs = extractReferences(prose);
  assert.equal(refs.length, 0, `Expected 0 matches in plain prose, but found: ${refs.map(r => r.raw).join(', ')}`);
});

test('extractReferences does not degrade malformed verse or sub-verse suffixes to bare chapters', () => {
  assert.deepEqual(extractReferences('Read John 3:16a today'), []);
  assert.deepEqual(extractReferences('Check John 3:abc today'), []);
  assert.deepEqual(extractReferences('Check John 3:'), []);
});

test('overlaps rejects inverted ranges on raw reference objects', () => {
  const inverted = { book: 'John', chapter: 3, verseStart: 10, verseEnd: 5 };
  const valid = { book: 'John', chapter: 3, verseStart: 5, verseEnd: 10 };
  assert.equal(overlaps(inverted, valid), false);
  assert.equal(overlaps(valid, inverted), false);
});

test('reference object methods evaluate dynamically with this context', () => {
  const ref = parseReference('John 3:16');
  assert.ok(ref);
  assert.equal(ref.format(), 'John 3:16');
  ref.chapter = 4;
  assert.equal(ref.format(), 'John 4:16');
});
