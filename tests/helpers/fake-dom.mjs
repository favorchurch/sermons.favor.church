// A minimal fake DOM for running the app controller without a browser. The same fake the page tests use.
import assert from 'node:assert/strict';

class FakeText {
  constructor(text) { this.nodeType = 3; this.text = text; this.parent = null; }
  get textContent() { return this.text; }
}
class FakeElement {
  constructor(doc, tag) {
    this.doc = doc; this.tag = tag; this.nodeType = 1; this.attrs = new Map(); this.children = [];
    this.parent = null; this.listeners = {}; this.open = false; this._value = undefined;
    this.style = { setProperty: (name, value) => { (this.styles ||= {})[name] = value; } };
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasClass(name) { return (this.attrs.get('class') || '').split(/\s+/).includes(name); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) {
    const e = { type, target: this, preventDefault() {}, ...event };
    for (const handler of this.listeners[type] || []) handler(e);
  }
  adopt(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    return node;
  }
  append(...nodes) { for (const node of nodes) this.children.push(this.adopt(typeof node === 'string' ? new FakeText(node) : node)); }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === this.doc.body; }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.replaceChildren(String(text)); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tag === 'textarea') return this.textContent;
    if (this.tag === 'select') {
      const options = all(this, e => e.tag === 'option');
      return (options.find(o => o.hasAttribute('selected')) || options[0])?.getAttribute('value') ?? '';
    }
    return this.getAttribute('value') ?? '';
  }
  set value(v) { this._value = String(v); }
  focus() { this.doc.activeElement = this; }
  select() {}
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatch('close'); }
  closest(selector) { for (let node = this; node && node.nodeType === 1; node = node.parent) if (matches(node, selector)) return node; return null; }
  querySelectorAll(selector) { return all(this, e => matches(e, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class FakeDocument {
  constructor() { this.body = new FakeElement(this, 'body'); this.activeElement = this.body; this.title = ''; }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(text); }
  make(tag) { return this.createElement(tag); }
}
function matchesCompound(el, compound) {
  let rest = compound.trim();
  const tag = /^[a-z][a-z0-9]*/i.exec(rest);
  if (tag) { if (el.tag !== tag[0].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { if (el.getAttribute('id') !== m[1]) return false; }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { if (!el.hasClass(m[1])) return false; }
    else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) { if (m[2] === undefined ? !el.hasAttribute(m[1]) : el.getAttribute(m[1]) !== m[2]) return false; }
    else if ((m = /^:not\((.+?\])\)/.exec(rest))) { if (matchesCompound(el, m[1])) return false; }
    else throw new Error('fake DOM cannot match selector part: ' + rest);
    rest = rest.slice(m[0].length);
  }
  return true;
}
const matches = (el, selector) => selector.split(/,\s*(?![^(]*\))/).some(part => matchesCompound(el, part));
function all(node, predicate) {
  const found = [];
  for (const child of node.children || []) {
    if (child.nodeType === 1 && predicate(child)) found.push(child);
    if (child.nodeType === 1) found.push(...all(child, predicate));
  }
  return found;
}
const one = (node, predicate, message = 'expected element not found') => {
  const found = all(node, predicate)[0];
  assert.ok(found, message);
  return found;
};
const textOf = node => node?.textContent ?? '';

export { FakeDocument, FakeElement, all, one, textOf };
