'use strict';
/* Persistence: localStorage first, IndexedDB as a mirror/fallback, plus downloadable JSON backups. */

const DB_NAME = 'skyline-airport-storage-v1', DB_STORE = 'saves', DB_SLOT = 'airport-collection';
let dbPromise = null, saveQueue = Promise.resolve(), saveSerial = 0, lastSavedAt = 0;

function openSaveDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(Error('IndexedDB недоступна'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE); };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      req.onerror = () => reject(req.error || Error('Ошибка открытия базы'));
      req.onblocked = () => reject(Error('База занята другой вкладкой'));
    }).catch(e => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function readBackup() {
  const db = await openSaveDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(DB_STORE, 'readonly');
      let entry = null;
      tx.objectStore(DB_STORE).get(DB_SLOT).onsuccess = e => { entry = e.target.result; };
      tx.oncomplete = () => resolve(entry || null);
      tx.onerror = () => reject(tx.error || Error('Ошибка чтения'));
      tx.onabort = () => reject(tx.error || Error('Чтение отменено'));
    } catch (e) { reject(e); }
  });
}

async function writeBackup(raw) {
  const db = await openSaveDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(raw, DB_SLOT);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || Error('Ошибка записи'));
      tx.onabort = () => reject(tx.error || Error('Запись отменена'));
    } catch (e) { reject(e); }
  });
}

function snapshot() {
  portfolio.airports[portfolio.active] = G;
  saveView();
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
  return JSON.stringify({version: SAVE_VERSION, savedAt: lastSavedAt, portfolio, speed});
}

function setSaveState(text) { const el = $('saveState'); if (el) el.textContent = text; }

function safeSave(silent = false) {
  let raw;
  try { raw = snapshot(); } catch (e) {
    setSaveState('Ошибка данных · скачайте копию');
    if (!silent) toast('Не удалось подготовить сохранение', 'warn');
    return Promise.resolve(false);
  }
  let localOk = false;
  try {
    localStorage.setItem(SAVE_KEY, raw);
    localOk = true;
    setSaveState('Сохранено · день ' + G.day + ', ' + airportTime());
    if (!silent) toast('Все аэропорты сохранены', 'ok');
  } catch (e) { setSaveState('Сохраняем запасную копию…'); }
  const serial = ++saveSerial;
  saveQueue = saveQueue.catch(() => {}).then(() => writeBackup(raw));
  return saveQueue.then(() => {
    if (!localOk && serial === saveSerial) {
      setSaveState('Сохранено в запасном хранилище · ' + airportTime());
      if (!silent) toast('Все аэропорты сохранены', 'ok');
    }
    return true;
  }, () => {
    if (!localOk && serial === saveSerial) {
      setSaveState('Сохранение заблокировано · скачайте копию');
      if (!silent) toast('Браузер не разрешил сохранить. Нажмите «Скачать копию»', 'warn');
    }
    return localOk;
  });
}

// Parses any supported save (current collection or the single-airport legacy format) into a portfolio.
function parseSave(raw) {
  const v = JSON.parse(raw);
  if ((v.version === 2 || v.version === 3) && v.portfolio) {
    const p = normalizePortfolio(v.portfolio);
    return {portfolio: p, speed: SPEEDS.includes(v.speed) ? v.speed : 1, savedAt: Number(v.savedAt) || 0};
  }
  if (v.g) {
    const g = normalizeAirport(v.g, 'main');
    const p = normalizePortfolio({active: 'main', unlocked: ['main'], airports: {main: g}, views: {main: {camera: v.camera, cameraTouched: !!v.cameraTouched}}});
    return {portfolio: p, speed: SPEEDS.includes(v.speed) ? v.speed : 1, savedAt: 0};
  }
  throw Error('Неизвестный формат сохранения');
}

function applySave(parsed) {
  portfolio = parsed.portfolio;
  G = portfolio.airports[portfolio.active];
  speed = parsed.speed;
  lastSavedAt = Math.max(lastSavedAt, parsed.savedAt);
  afterAirportChange();
}

// Loads the newest valid copy among localStorage, IndexedDB and the legacy single-airport slot.
async function restoreLatest(show = true) {
  const copies = [];
  try { const raw = localStorage.getItem(SAVE_KEY); if (raw) copies.push(raw); } catch (e) {}
  try { const raw = await readBackup(); if (raw) copies.push(raw); } catch (e) {}
  const parsed = [];
  for (const raw of copies) { try { parsed.push(parseSave(raw)); } catch (e) {} }
  parsed.sort((a, b) => b.savedAt - a.savedAt);
  if (!parsed.length) {
    try { const raw = localStorage.getItem(LEGACY_KEY); if (raw) parsed.push(parseSave(raw)); } catch (e) {}
  }
  if (parsed.length) { applySave(parsed[0]); if (show) toast('Аэропорты загружены', 'ok'); return true; }
  if (show) toast(copies.length ? 'Сохранение повреждено' : 'Сохранение пока не найдено', 'warn');
  return false;
}

function exportSave() {
  try {
    const raw = snapshot(), url = URL.createObjectURL(new Blob([raw], {type: 'application/json'})), link = document.createElement('a');
    link.href = url;
    link.download = 'аэропорт-магнат-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Копия аэропортов скачивается', 'ok');
  } catch (e) { toast('Не удалось создать файл сохранения', 'warn'); }
}

async function importSave(file) {
  if (!file) return;
  try {
    const parsed = parseSave(await file.text());
    if (!await ask({title: 'Восстановить из файла?', text: 'Текущая коллекция аэропортов в этом браузере будет заменена данными из файла.', ok: 'Восстановить', danger: true})) return;
    applySave(parsed);
    safeSave(true);
    toast('Коллекция восстановлена из файла', 'ok');
  } catch (e) { toast('Файл не является сохранением этой игры', 'warn'); }
  finally { $('importFile').value = ''; }
}

function loadSettings() {
  try { return {quality: 'high', particles: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')}; } catch (e) { return {quality: 'high', particles: true}; }
}
function storeSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
