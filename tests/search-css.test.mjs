// Type floor for the Search page: every text node renders at 13px or larger at desktop and phone
// widths, in Original and in layouts A and C. The fake DOM used by the UI tests has no layout, so this
// resolves font-size from the real stylesheets with a small cascade (descendant and compound selectors,
// :is() lists, specificity, source order, max-width media queries, inheritance) for each element kind
// the page renders. Layout rules sit under html[data-layout="a"|"c"]; they join the cascade only for that
// layout, with the specificity of the html[...] attribute selector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/assets/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const SHEETS = ['app.css', 'themes/layout.css', 'themes/other.css']; // the order index.html links them
const LAYOUT_PREFIX = /^html\[data-layout="(a|c)"\]\s*/;

/** Top-level comma split that leaves :is(...) lists whole. */
function splitList(text) {
  const parts = [];
  let depth = 0, current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** ":is(.a, .b) .c" becomes [".a .c", ".b .c"]. */
function expandIs(selector) {
  const at = selector.indexOf(':is(');
  if (at < 0) return [selector];
  let depth = 0, end = at + 3;
  for (; end < selector.length; end++) {
    if (selector[end] === '(') depth++;
    else if (selector[end] === ')' && --depth === 0) break;
  }
  const tail = selector.slice(end + 1);
  return splitList(selector.slice(at + 4, end)).flatMap(option => expandIs(selector.slice(0, at) + option + tail));
}

/** Flat rule list: { selector, maxWidth (or null), size (px or null), order, bonus }. */
function parseRules(source, layout) {
  const rules = [];
  let order = 0;
  const walk = (text, maxWidth) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0; j++; }
      const inner = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) {
        const width = /max-width:\s*(\d+)px/.exec(prelude);
        walk(inner, width ? Number(width[1]) : Infinity);
      } else if (!prelude.startsWith('@')) {
        const size = fontSize(inner);
        for (const listed of splitList(prelude)) {
          const scoped = LAYOUT_PREFIX.exec(listed);
          if (scoped && scoped[1] !== layout) continue; // another layout's rule, or Original, which has none
          const selector = listed.replace(LAYOUT_PREFIX, '');
          for (const alternative of expandIs(selector)) {
            rules.push({ selector: alternative, maxWidth, size, order: order++, bonus: scoped ? 101 : 0 });
          }
        }
      }
      i = j;
    }
  };
  walk(source, null);
  return rules;
}

function fontSize(declarations) {
  const longhand = /(?:^|;|\s)font-size:\s*([^;]+)/.exec(declarations);
  if (longhand) return firstPx(longhand[1]);
  const shorthand = /(?:^|;|\s)font:\s*([^;]+)/.exec(declarations);
  return shorthand ? firstPx(shorthand[1]) : null;
}
// A clamp(min, ...) renders at its minimum or more, so its first length is the floor.
const firstPx = value => { const m = /([\d.]+)px/.exec(value); return m ? Number(m[1]) : null; };

const compound = text => ({
  tag: /^[a-z][a-z0-9]*/i.exec(text)?.[0] || null,
  classes: [...text.matchAll(/\.([\w-]+)/g)].map(m => m[1]),
  clean: !/[:\[#>+~*]/.test(text)
});
const matches = (part, el) => part.clean && (!part.tag || part.tag === el.tag) && part.classes.every(c => el.classes.includes(c));
const specificity = selector => selector.split(/\s+/).map(compound).reduce(
  (sum, p) => sum + p.classes.length * 100 + (p.tag ? 1 : 0), 0);

/** Does the selector match the last element of the chain, with its other parts matching ancestors in order? */
function selectorMatches(selector, chain) {
  const parts = selector.split(/\s+/).map(compound);
  if (!matches(parts.at(-1), chain.at(-1))) return false;
  let at = chain.length - 2;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (at >= 0 && !matches(parts[p], chain[at])) at--;
    if (at < 0) return false;
    at--;
  }
  return true;
}

const RULES = Object.fromEntries(['original', 'a', 'c'].map(layout =>
  [layout, parseRules(SHEETS.map(read).join('\n'), layout === 'original' ? null : layout)]));
const el = (spec) => { const [tag, ...classes] = spec.split('.'); return { tag, classes }; };

function resolve(chain, width, layout = 'original') {
  const rules = RULES[layout];
  let size = 16;
  for (let n = 1; n <= chain.length; n++) {
    const sub = chain.slice(0, n);
    const hit = rules
      .filter(r => r.size != null && (r.maxWidth == null || width <= r.maxWidth) && selectorMatches(r.selector, sub))
      .sort((a, b) => specificity(a.selector) + a.bonus - specificity(b.selector) - b.bonus || a.order - b.order).at(-1);
    if (hit) size = hit.size;
  }
  return size;
}

const page = ['body', 'section.search-page'].map(el);
// One entry per kind of text node the Search page renders, as the ancestor chain below section.search-page.
const KINDS = {
  title: ['h1'],
  subtitle: ['p.search-sub'],
  'field label': ['form.search-form', 'div.search-row', 'div.field', 'label'],
  'search input': ['form.search-form', 'div.search-row', 'div.field', 'input'],
  'search button': ['form.search-form', 'div.search-row', 'button.btn.btn-primary'],
  'scope button': ['form.search-form', 'div.search-options', 'div.segmented', 'button'],
  'archived checkbox label': ['form.search-form', 'div.search-options', 'label.check'],
  'idle art': ['div.search-results', 'img.search-art'],
  'idle copy': ['div.search-results', 'p.muted'],
  notice: ['div.search-results', 'p.notice'],
  'result count': ['div.search-results', 'p.result-count'],
  'group heading': ['div.search-results', 'section.result-group', 'h2'],
  'group count': ['div.search-results', 'section.result-group', 'h2', 'span.count'],
  'pending line': ['div.search-results', 'section.result-group', 'p.muted'],
  'error text': ['div.search-results', 'section.result-group', 'div.inline-error', 'p'],
  'error retry button': ['div.search-results', 'section.result-group', 'div.inline-error', 'button.btn'],
  'sermon title': ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'a.result-title'],
  'sermon details': ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.muted'],
  'notes pill': ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.result-meta', 'span.pill.pill-good'],
  'notes version': ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.result-meta', 'strong'],
  'notes source': ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.result-meta', 'span.muted'],
  excerpt: ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.excerpt'],
  'excerpt match': ['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.excerpt', 'mark']
};

const LAYOUT_NAMES = { original: 'Original', a: 'layout A', c: 'layout C' };
for (const layout of Object.keys(LAYOUT_NAMES)) {
  for (const [label, width] of [['desktop (1280px)', 1280], ['tablet (768px)', 768], ['phone (480px)', 480], ['small phone (360px)', 360]]) {
    test(`every Search page text node is at least 13px in ${LAYOUT_NAMES[layout]} on ${label}`, () => {
      const tooSmall = Object.entries(KINDS)
        .map(([name, chain]) => [name, resolve([...page, ...chain.map(el)], width, layout)])
        .filter(([, size]) => size < 13);
      assert.deepEqual(tooSmall, []);
    });
  }
}

test('every class the Search view renders has a probe above', () => {
  const view = readFileSync(new URL('../public/assets/js/views/search.js', import.meta.url), 'utf8');
  const pageCode = view.slice(0, view.indexOf('export function notesPanel')); // the per-sermon panel is another page
  const rendered = new Set([...pageCode.matchAll(/class: '([^']+)'/g)].flatMap(m => m[1].split(/\s+/)));
  const probed = new Set(Object.values(KINDS).flat().flatMap(spec => spec.split('.').slice(1)));
  const probeless = [...rendered].filter(name => !probed.has(name) && name !== 'search-page');
  assert.deepEqual(probeless, [], 'add each new class to KINDS so the 13px floor covers it');
});

test('the pill keeps its smaller size outside the Search page in Original', () => {
  const chain = ['body', 'main', 'table.people-table', 'td', 'span.pill'].map(el);
  assert.equal(resolve(chain, 1280), 11.5);
  assert.equal(resolve(chain, 360), 11.5);
});

test('layouts A and C join the cascade and Original does not (guards against a prefix the parser skips)', () => {
  const heading = [...page, ...['div.search-results', 'section.result-group', 'h2'].map(el)];
  assert.equal(resolve(heading, 1280, 'original'), 17);
  assert.equal(resolve(heading, 1280, 'a'), 18);
  assert.equal(resolve(heading, 1280, 'c'), 18);
  const pill = [...page, ...['div.search-results', 'section.result-group', 'ul.result-list', 'li.result-item', 'p.result-meta', 'span.pill.pill-good'].map(el)];
  assert.equal(resolve(pill, 1280, 'a'), 13);
  assert.equal(resolve(pill, 1280, 'c'), 13);
});

test(':is() lists expand into one selector each', () => {
  assert.deepEqual(expandIs('.a :is(.b, .c .d) .e'), ['.a .b .e', '.a .c .d .e']);
  assert.deepEqual(splitList('.a :is(.b, .c), .d'), ['.a :is(.b, .c)', '.d']);
});

test('the cascade resolver sees the stylesheet (guards against a parser that finds nothing)', () => {
  assert.equal(resolve(['body'].map(el), 1280), 15);
  assert.equal(resolve([...page, ...['h1'].map(el)], 360), 24);
});
