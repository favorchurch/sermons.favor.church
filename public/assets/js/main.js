import { createApi } from './api.js';
import { createApp } from './app.js';
import { localToday } from './format.js';
import { createPrefs } from './prefs.js';

// Reading window.localStorage itself can throw (blocked storage), so it is looked up inside a try.
const localStore = () => { try { return window.localStorage; } catch { return null; } };

const api = createApi();
const prefs = createPrefs({ storage: localStore(), api, win: window });
// The saved layout is on the page, and the saved Library view is known, before the first render.
const { layout: initialLayout } = prefs.boot();

const app = createApp({
  api,
  prefs,
  root: document.getElementById('main'),
  headerRoot: document.getElementById('app-header'),
  announcer: document.getElementById('announcer'),
  toastRoot: document.getElementById('toast'),
  getHash: () => location.hash,
  setHash: hash => { location.hash = hash; },
  today: () => localToday(),
  navigate: url => location.assign(url),
  initialLayout
});

window.addEventListener('hashchange', app.render);
app.start();
