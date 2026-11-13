import { createApi } from './api.js';
import { createApp } from './app.js';
import { localToday } from './format.js';

const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* storage unavailable: the choice just won't persist */ } }
};

const app = createApp({
  api: createApi(),
  root: document.getElementById('main'),
  headerRoot: document.getElementById('app-header'),
  announcer: document.getElementById('announcer'),
  toastRoot: document.getElementById('toast'),
  getHash: () => location.hash,
  setHash: hash => { location.hash = hash; },
  storage,
  today: () => localToday(),
  navigate: url => location.assign(url)
});

window.addEventListener('hashchange', app.render);
app.start();
