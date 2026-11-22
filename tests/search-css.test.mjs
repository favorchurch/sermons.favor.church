// Type floor for the Search page: every text node renders at 13px or larger at desktop and phone
// widths. The fake DOM used by the UI tests has no layout, so this resolves font-size from the real
// stylesheet with a small cascade (descendant and compound selectors, specificity, source order,
// max-width media queries, inheritance) for each element kind the page renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/assets/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Flat rule list: { selector, maxWidth (or null), size (px or null), order }. */
function parseRules(source) {
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
        for (const selector of prelude.split(',')) rules.push({ selector: selector.trim(), maxWidth, size, order: order++ });
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

const rules = parseRules(css);
const el = (spec) => { const [tag, ...classes] = spec.split('.'); return { tag, classes }; };

function resolve(chain, width) {
  let size = 16;
  for (let n = 1; n <= chain.length; n++) {
    const sub = chain.slice(0, n);
    const hit = rules
      .filter(r => r.size != null && (r.maxWidth == null || width <= r.maxWidth) && selectorMatches(r.selector, sub))
      .sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order).at(-1);
    if (hit) size = hit.size;
  }
  return size;
}

const page = ['body', 'section.search-page'].map(el);
// One entry per kind of text node the Search page renders, as the ancestor chain below section.search-page.
const KINDS = {
  title: ['h1'],
  'field label': ['form.search-form', 'div.search-row', 'div.field', 'label'],
  'search input': ['form.search-form', 'div.search-row', 'div.field', 'input'],
  'search button': ['form.search-form', 'div.search-row', 'button.btn.btn-primary'],
  'scope button': ['form.search-form', 'div.search-options', 'div.segmented', 'button'],
  'archived checkbox label': ['form.search-form', 'div.search-options', 'label.check'],
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

for (const [label, width] of [['desktop (1280px)', 1280], ['tablet (768px)', 768], ['phone (480px)', 480], ['small phone (360px)', 360]]) {
  test(`every Search page text node is at least 13px on ${label}`, () => {
    const tooSmall = Object.entries(KINDS)
      .map(([name, chain]) => [name, resolve([...page, ...chain.map(el)], width)])
      .filter(([, size]) => size < 13);
    assert.deepEqual(tooSmall, []);
  });
}

test('the pill keeps its smaller size outside the Search page', () => {
  const chain = ['body', 'main', 'table.people-table', 'td', 'span.pill'].map(el);
  assert.equal(resolve(chain, 1280), 11.5);
  assert.equal(resolve(chain, 360), 11.5);
});

test('the cascade resolver sees the stylesheet (guards against a parser that finds nothing)', () => {
  assert.equal(resolve(['body'].map(el), 1280), 15);
  assert.equal(resolve([...page, ...['h1'].map(el)], 360), 24);
});
