'use strict';

/**
 * backup-plugin-data
 * ==================
 * Universelle Bibliothek für HCU-Plugins zum Exportieren und Importieren
 * von persistenten /data-Dateien via HCU Connect API (ConfigTemplate/ConfigUpdate).
 *
 * Funktionsweise:
 *  - Backup:  Nutzer aktiviert Backup-Modus in den Plugin-Einstellungen → nach
 *             erneutem Öffnen erscheint ein einmaliger Download-Button.
 *  - Restore: Nutzer aktiviert Restore-Modus → nach erneutem Öffnen erscheint
 *             ein Token + Button zur Upload-Seite. Upload erfordert Token-Eingabe.
 *             Nach Erfolg startet das Plugin automatisch neu.
 *
 * Integration in plugin.js:
 *
 *   const backup = require('./backup-plugin-data');
 *   const backupManager = backup.create();
 *   // pluginId wird automatisch aus process.argv[2] gelesen
 *   // version  wird automatisch aus package.json gelesen
 *
 *   // Im CONFIG_TEMPLATE_REQUEST-Handler:
 *   //   backupManager.getConfigGroups() in den Template-Body einfügen
 *
 *   // Im CONFIG_UPDATE_REQUEST-Handler:
 *   //   backupManager.handleConfigUpdate(body.fields) aufrufen;
 *   //   gibt true zurück, wenn das Update von der Bibliothek behandelt wurde
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// --- Konstanten

// /SGTIN existiert nur im Container auf der HCU: dann ist /data der korrekte Pfad. Nötig für lokale Entwicklung
const DATA_DIR = fs.existsSync('/SGTIN')
  ? '/data'
  : path.join(require.main ? path.dirname(require.main.filename) : process.cwd(), 'data');

// HCU-TLS-Zertifikat: das selbstsignierte Zertifikat der HCU, dem der Browser
// nach einmaliger Ausnahme vertraut. Liegt im Container unter /etc/ssl/.
const TLS_CERT_PATHS = [
  { key: '/etc/ssl/private/ssl-cert-snakeoil.key', cert: '/etc/ssl/certs/ssl-cert-snakeoil.pem' },
  { key: '/etc/ssl/private/server.key',            cert: '/etc/ssl/certs/server.crt'            },
  { key: '/etc/ssl/server.key',                    cert: '/etc/ssl/server.crt'                  },
];

function getTlsCredentials() {
  for (const { key, cert } of TLS_CERT_PATHS) {
    try {
      return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    } catch { /* Pfad nicht vorhanden, nächsten versuchen */ }
  }
  return null; // Kein Zertifikat gefunden: HTTP als Fallback
}
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 Minuten
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_PORT   = 8743;

// ── i18n ─────────────────────────────────────────────────────────────────────

const STRINGS = {
  de: {
    // Plugin-Einstellungen
    backupGroupLabel:   'Backup erstellen',
    backupStep1Desc:    'Aktiviere den Backup-Modus, speichere die Einstellungen und öffne die Einstellungen anschließend erneut.',
    backupStep2Desc:    'Klicke den Button, um das Backup einmalig herunterzuladen. Der Link ist 10 Minuten gültig und wird danach automatisch deaktiviert.',
    backupModeLabel:    'Backup-Modus aktivieren',
    backupGroupTitle:   'Backup wurde erfolgreich erstellt',
    backupStep2Desc:    'Mit dem Link kann die Datei einmal heruntergeladen werden. Danach verfällt er.',
    backupButtonLabel:  'Backup-Datei herunterladen',
    restoreGroupLabel:  'Backup wiederherstellen',
    restoreStep1Desc:   'Aktiviere den Restore-Modus, speichere die Einstellungen und öffne die Einstellungen anschließend erneut.',
    restoreModeLabel:   'Restore-Modus aktivieren',
    restoreGroupTitle:  'Wiederherstellungsmodus aktiv',
    restoreStep2Desc:   'Klicke auf den Link und lade dort deine Backup-Datei hoch.',
    restoreTokenLabel:  'Sicherheits-Token',
    restoreButtonLabel: 'Wiederherstellungsseite öffnen',
    // Restore-Webseite
    restorePageTitle:       'Backup wiederherstellen',
    restoreTokenInputLabel: 'Sicherheits-Token',
    restoreTokenPlaceholder:'Token aus den Plugin-Einstellungen',
    restoreFileLabel:       'Backup-Datei',
    restoreDropHint:        'Datei hierher ziehen oder klicken',
    restoreSubmitBtn:       'Wiederherstellen',
    restoreErrInvalidToken: 'Ungültiger Token',
    restoreErrNetworkError: 'Netzwerkfehler',
    restoreErrReadFile:     'Datei konnte nicht gelesen werden',
    restoreErrUploadFailed: 'Upload fehlgeschlagen',
    restoreOkMessage:       'Dateien wiederhergestellt (Backup v{version}). Plugin wird neu gestartet… Du kannst diesen Tab jetzt schließen.',
  },
  en: {
    // Plugin-Einstellungen
    backupGroupLabel:   'Create Backup',
    backupStep1Desc:    'Enable backup mode, save the settings, then reopen the settings.',
    backupStep2Desc:    'Click the button to download the backup once. The link is valid for 10 minutes and will be deactivated automatically afterwards.',
    backupModeLabel:    'Enable backup mode',
    backupGroupTitle:   'Backup created successfully',
    backupStep2Desc:    'The link can be used to download the file once. After that it expires.',
    backupButtonLabel:  'Download backup file',
    restoreGroupLabel:  'Restore Backup',
    restoreStep1Desc:   'Enable restore mode, save the settings, then reopen the settings.',
    restoreModeLabel:   'Enable restore mode',
    restoreGroupTitle:  'Restore mode active',
    restoreStep2Desc:   'Click the link and upload your backup file there.',
    restoreTokenLabel:  'Security token',
    restoreButtonLabel: 'Open restore page',
    // Restore-Webseite
    restorePageTitle:       'Restore Backup',
    restoreTokenInputLabel: 'Security token',
    restoreTokenPlaceholder:'Token from plugin settings',
    restoreFileLabel:       'Backup file',
    restoreDropHint:        'Drag file here or click',
    restoreSubmitBtn:       'Restore',
    restoreErrInvalidToken: 'Invalid token',
    restoreErrNetworkError: 'Network error',
    restoreErrReadFile:     'Could not read file',
    restoreErrUploadFailed: 'Upload failed',
    restoreOkMessage:       'files restored (backup v{version}). Plugin restarting… You can close this Tab now.',
  },
};

/** Gibt ein zweisprachiges { de, en } Objekt zurück (für Plugin-Einstellungen) */
function bi(key) {
  return { de: STRINGS.de[key], en: STRINGS.en[key] };
}

/** Gibt einen einsprachigen String zurück; fällt auf 'en' zurück */
function t(lang, key) {
  return (STRINGS[lang] ?? STRINGS.en)[key] ?? key;
}

// --- Dateisystem-Helper

function readDataDir(baseDir = DATA_DIR) {
  const result = {};

  function walk(dir, prefix = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        try {
          const raw = fs.readFileSync(absPath, 'utf8');
          result[relPath] = relPath.endsWith('.json') ? JSON.parse(raw) : raw;
        } catch {
          result[relPath] = null;
        }
      }
    }
  }

  walk(baseDir);
  return result;
}

function writeDataDir(files, baseDir = DATA_DIR) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const data = content !== null && typeof content === 'object'
      ? JSON.stringify(content, null, 2)
      : String(content ?? '');
    fs.writeFileSync(absPath, data, 'utf8');
  }
}

/** Gibt true zurück, wenn das Backup eine neuere Hauptversion hat als das Plugin */
function isMajorDowngrade(backupVersion, currentVersion) {
  const b = parseInt(String(backupVersion).split('.')[0], 10);
  const c = parseInt(String(currentVersion).split('.')[0], 10);
  return b > c;
}

// --- HTTP-Helper

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('too large')); }
      body += chunk.toString('utf8');
    });
    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// --- Restore-Upload-UI

function buildRestoreHTML(pluginId, lang = 'en') {
  const s = STRINGS[lang] ?? STRINGS.en;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${s.restorePageTitle} · ${pluginId}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:      #f2f2f2;
      --surface: #ffffff;
      --border:  #d7e7fa;
      --accent:  #00112d;
      --accent2: #ceff00;
      --text:    #00112d;
      --muted:   #406c8d;
      --ok:      #4caf7d;
      --err:     #e05c5c;
      --r:       10px;
      --font:    Arial, sans-serif;
    }

    @media(prefers-color-scheme: dark) {
      :root {
        --bg:      #0f1117;
        --surface: #1a1d27;
        --border:  #2e3147;
        --accent:  #0d48b6;
        --accent2: #ceff00;
        --text:    #e8eaf6;
        --muted:   #7b82a8;
        --ok:      #4caf7d;
        --err:     #e05c5c;
      }
    }
    
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0px;
      padding: 36px 40px;
      width: 100%;
      max-width: 480px;
    }
    .pid { font-size: .7rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
    h1   { font-size: 1.1rem; font-weight: 500; margin-bottom: 28px; line-height: 1.4; }
    label {
      display: block;
      font-size: .72rem;
      color: var(--muted);
      letter-spacing: .07em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    input[type=password] {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      color: var(--text);
      font-family: var(--font);
      font-size: .9rem;
      margin-bottom: 20px;
      outline: none;
      transition: border-color .2s;
    }
    input:focus { border-color: var(--accent); }
    .drop {
      border: 2px dashed var(--border);
      border-radius: var(--r);
      padding: 28px;
      text-align: center;
      cursor: pointer;
      transition: border-color .2s, background .2s;
      margin-bottom: 20px;
      position: relative;
    }
    .drop.over { border-color: var(--accent); background: rgba(79,142,247,.06); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .drop .icon { font-size: 1.8rem; margin-bottom: 8px; }
    .drop .hint { font-size: .78rem; color: var(--muted); }
    .drop .name { font-size: .85rem; color: var(--accent); margin-top: 6px; min-height: 1.2em; }
    button {
      width: 100%;
      padding: 12px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 0px;
      font-family: var(--font);
      font-size: .9rem;
      cursor: pointer;
      transition: opacity .2s;
    }
    button:disabled { opacity: .35; cursor: not-allowed; }
    button:not(:disabled):hover { opacity: .85; }
    .bar-wrap { height: 3px; background: var(--border); border-radius: 2px; margin-top: 14px; display: none; overflow: hidden; }
    .bar      { height: 100%; width: 0%; background: var(--accent2); transition: width .3s; }
    #status   {
      margin-top: 16px;
      padding: 12px 16px;
      border-radius: 6px;
      font-size: .82rem;
      line-height: 1.5;
      display: none;
    }
    #status.ok  { background: rgba(76,175,125,.12); border: 1px solid var(--ok);  color: var(--ok); }
    #status.err { background: rgba(224,92,92,.12);  border: 1px solid var(--err); color: var(--err); }
  </style>
</head>
<body>
<div class="card">
  <h1>${s.restorePageTitle}</h1>

  <label for="token">${s.restoreTokenInputLabel}</label>
  <input type="password" id="token" placeholder="${s.restoreTokenPlaceholder}" autocomplete="off">

  <label>${s.restoreFileLabel}</label>
  <div class="drop" id="drop">
    <input type="file" id="file" accept=".json,application/json">
    <div class="icon">📂</div>
    <div class="hint">${s.restoreDropHint}</div>
    <div class="name" id="fname"></div>
  </div>

  <button id="btn" disabled>${s.restoreSubmitBtn}</button>
  <div class="bar-wrap"><div class="bar" id="bar"></div></div>
  <div id="status"></div>
</div>
<script>
  const tokenEl = document.getElementById('token');
  const fileEl  = document.getElementById('file');
  const dropEl  = document.getElementById('drop');
  const fnameEl = document.getElementById('fname');
  const btnEl   = document.getElementById('btn');
  const statusEl = document.getElementById('status');
  const barWrap = document.querySelector('.bar-wrap');
  const bar     = document.getElementById('bar');

  const MSG = {
    errInvalidToken: '${s.restoreErrInvalidToken}',
    errNetworkError: '${s.restoreErrNetworkError}',
    errReadFile:     '${s.restoreErrReadFile}',
    errUploadFailed: '${s.restoreErrUploadFailed}',
    okMessage:       '${s.restoreOkMessage}',
  };

  let pickedFile = null;

  const check = () => btnEl.disabled = !(tokenEl.value.trim() && pickedFile);

  tokenEl.addEventListener('input', check);
  fileEl.addEventListener('change', () => {
    pickedFile = fileEl.files[0] || null;
    fnameEl.textContent = pickedFile ? pickedFile.name : '';
    check();
  });
  dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('over'); });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
  dropEl.addEventListener('drop', e => {
    e.preventDefault(); dropEl.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) { pickedFile = f; fnameEl.textContent = f.name; check(); }
  });

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className   = type;
    statusEl.style.display = 'block';
  }

  btnEl.addEventListener('click', async () => {
    const token = tokenEl.value.trim();
    if (!token || !pickedFile) return;

    btnEl.disabled = true;
    statusEl.style.display = 'none';
    barWrap.style.display = 'block';
    bar.style.width = '15%';

    // 1. Token validieren
    const base = window.location.pathname;
    try {
      const vRes = await fetch(base + '/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!vRes.ok) {
        const j = await vRes.json().catch(() => ({}));
        setStatus(MSG.errInvalidToken + (j.error ? ': ' + j.error : ''), 'err');
        btnEl.disabled = false; barWrap.style.display = 'none'; return;
      }
    } catch {
      setStatus(MSG.errNetworkError, 'err');
      btnEl.disabled = false; barWrap.style.display = 'none'; return;
    }

    bar.style.width = '50%';

    // 2. Datei hochladen
    let text;
    try { text = await pickedFile.text(); }
    catch { setStatus(MSG.errReadFile, 'err'); btnEl.disabled = false; barWrap.style.display = 'none'; return; }

    try {
      const uRes = await fetch(base + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Backup-Token': token },
        body: text,
      });
      bar.style.width = '100%';
      const j = await uRes.json().catch(() => ({}));
      if (uRes.ok) {
        setStatus(j.restoredFiles + ' ' + MSG.okMessage.replace('{version}', j.backupVersion), 'ok');
      } else {
        setStatus((j.error || uRes.statusText) + (j.detail ? ' — ' + j.detail : ''), 'err');
        btnEl.disabled = false;
      }
    } catch {
      setStatus(MSG.errUploadFailed, 'err');
      btnEl.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

// --- Session

function newSession(type) {
  const tlsCreds = getTlsCredentials();
  return {
    type,
    tlsCreds,
    protocol: tlsCreds ? 'https' : 'http',
    token:     crypto.randomBytes(32).toString('hex'),
    route:     crypto.randomBytes(16).toString('hex'),
    expiresAt: Date.now() + SESSION_TTL_MS,
    used:      false,
    server:    null,
    timer:     null,
  };
}

// --- Haupt-Funktionen

/**
 * Liest die pluginId aus process.argv.
 */
function readPluginIdFromArgv() {
  // process.argv = ['node', 'plugin.js', '<pluginId>', ...]
  const id = process.argv[2];
  // Plausibilitätsprüfung: muss wie ein reverser Domain-Name aussehen
  return (id && /^[a-z0-9]+(\.[a-z0-9_-]+)+$/i.test(id)) ? id : null;
}

/**
 * Liest die Version aus der package.json des aufrufenden Projekts.
 * Sucht ausgehend vom Verzeichnis des Haupt-Einstiegspunkts (require.main)
 * nach oben, bis eine package.json mit einem "version"-Feld gefunden wird.
 * Fällt auf process.cwd() zurück, wenn require.main nicht verfügbar ist.
 */
function readVersionFromPackageJson() {
  const startDir = require.main
    ? path.dirname(require.main.filename)
    : process.cwd();

  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg.version) return pkg.version;
    } catch { /* nicht vorhanden oder kein valides JSON */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // Dateisystem-Wurzel erreicht
    dir = parent;
  }
  return null;
}

/**
 * Erstellt eine Backup-Manager-Instanz für ein Plugin.
 *
 * Beide Parameter werden automatisch ermittelt, wenn nicht angegeben:
 *  - pluginId: aus process.argv[2] (erstes Argument an plugin.js)
 *  - version:  aus package.json (aufwärts vom Einstiegspunkt gesucht)
 *
 * @param {object}  [options]
 * @param {string}  [options.pluginId]  - Plugin-Identifier (z. B. 'de.doe.jane.plugin.example').
 *                                        Standard: process.argv[2]
 * @param {string}  [options.version]   - Plugin-Version (Semver).
 *                                        Standard: version aus package.json
 * @param {number}  [options.port]      - HTTP-Port für den temporären Server (Standard: 8743)
 */
function create({ pluginId, version, port = DEFAULT_PORT } = {}) {
  if (!pluginId) {
    pluginId = readPluginIdFromArgv();
    if (!pluginId) throw new Error(
      '[backup-plugin-data] PluginId konnte nicht von process.argv gelesen werden > bitte explizit uebergeben'
    );
    console.log(`[backup-plugin-data] Plugin-ID automatisch von argv erkannt: ${pluginId}`);
  }

  if (!version) {
    version = readVersionFromPackageJson();
    if (!version) throw new Error(
      '[backup-plugin-data] Version konnte nicht von package.json gelesen werden > bitte explizit uebergeben'
    );
    console.log(`[backup-plugin-data] Version automatisch von package.json erkannt: ${version}`);
  }

  let session = null;

  // --- Session beenden
  function closeSession(reason = 'closed') {
    if (!session) return;
    clearTimeout(session.timer);
    // type und server vor dem Nullsetzen sichern –
    // der close()-Callback läuft asynchron, session ist dann schon null.
    const type   = session.type;
    const server = session.server;
    session = null;
    server?.close(() =>
      console.log(`[backup-plugin-data] ${type} Server geschlossen (${reason})`));
  }

  // --- Backup-Server
  function startBackupServer() {
    const sess  = session;
    const route = `/${sess.route}`;

    const createServer = sess.tlsCreds
      ? (h) => https.createServer(sess.tlsCreds, h)
      : (h) => http.createServer(h);
    const server = createServer((req, res) => {
      const url = req.url?.split('?')[0];
      if (req.method !== 'GET' || (url !== route && url !== route + '/download')) {
        return sendJSON(res, 404, { error: 'Not found' });
      }
      if (Date.now() > sess.expiresAt) {
        return sendJSON(res, 410, { error: 'Session expired' });
      }

      try {
        const payload  = { [pluginId]: { version, exportedAt: new Date().toISOString(), files: readDataDir() } };
        const json     = JSON.stringify(payload, null, 2);
        const filename = `backup-${pluginId}-v${version}-${Date.now()}.json`;
        const b64      = Buffer.from(json, 'utf8').toString('base64');

        // HTML-Seite mit eingebettetem Download – kein separater HTTP-Request nötig
        const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>Backup</title></head>
<body>
<p style="font-family:sans-serif">Download startet automatisch…</p>
<script>
  const b64  = '${b64}';
  const bin  = atob(b64);
  const arr  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'application/octet-stream' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = '${filename}';
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  setTimeout(() => { document.body.innerHTML = '<p style="font-family:sans-serif">✅ Download abgeschlossen. Diese Seite kann geschlossen werden.</p>'; }, 1000);
<\/script>
</body>
</html>`;

        // Nach Download: Server noch 60s offen lassen (fuehrt sonst zu Fehlern)
        if (!sess.used) {
          sess.used = true;
          console.log(`[backup-plugin-data] Backup heruntergeladen: ${filename}`);
          clearTimeout(sess.timer);
          sess.timer = setTimeout(() => closeSession('post-download-timeout'), 60_000);
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        console.error('[backup-plugin-data] Export error:', err);
        sendJSON(res, 500, { error: 'Export failed', detail: err.message });
      }
    });

    server.listen(port, '0.0.0.0', () =>
      console.log(`[backup-plugin-data] Backup Server bereit (${sess.protocol}, port ${port}, route ${route})`));
    server.on('error', err =>
      console.error('[backup-plugin-data] Backup Server error:', err));

    sess.server = server;
    sess.timer  = setTimeout(() => closeSession('timeout'), SESSION_TTL_MS);
  }

  // --- Restore-Server
  function startRestoreServer() {
    const sess = session;
    const base = `/${sess.route}`;

    const createServer = sess.tlsCreds
      ? (h) => https.createServer(sess.tlsCreds, h)
      : (h) => http.createServer(h);
    const server = createServer(async (req, res) => {
      const url = req.url?.split('?')[0];

      if (Date.now() > sess.expiresAt) {
        return sendJSON(res, 410, { error: 'Session expired' });
      }

      // UI
      if (req.method === 'GET' && url === base) {
        const qs   = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
        const lang = ['de', 'en'].includes(qs.get('hl')) ? qs.get('hl') : 'en';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(buildRestoreHTML(pluginId, lang));
      }

      // Token-Validierung (vor dem Upload)
      if (req.method === 'POST' && url === `${base}/validate`) {
        let body;
        try   { body = JSON.parse(await readBody(req)); }
        catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
        if (body.token !== sess.token) return sendJSON(res, 401, { error: 'Invalid token' });
        return sendJSON(res, 200, { ok: true });
      }

      // Datei-Upload
      if (req.method === 'POST' && url === `${base}/upload`) {
        if (sess.used) return sendJSON(res, 410, { error: 'Session already used' });

        if (req.headers['x-backup-token'] !== sess.token) {
          return sendJSON(res, 401, { error: 'Invalid token' });
        }

        let raw;
        try   { raw = await readBody(req); }
        catch { return sendJSON(res, 413, { error: 'Payload too large' }); }

        let payload;
        try   { payload = JSON.parse(raw); }
        catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

        const entry = payload[pluginId];
        if (!entry || typeof entry !== 'object') {
          return sendJSON(res, 400, { error: `No entry for plugin "${pluginId}" in backup` });
        }
        if (!entry.version) {
          return sendJSON(res, 400, { error: 'Backup entry missing "version"' });
        }
        if (isMajorDowngrade(entry.version, version)) {
          return sendJSON(res, 409, {
            error:   'Major version downgrade rejected',
            detail:  `Backup v${entry.version} cannot be restored into plugin v${version}`,
            backup:  entry.version,
            current: version,
          });
        }
        if (!entry.files || typeof entry.files !== 'object') {
          return sendJSON(res, 400, { error: 'Backup entry missing "files"' });
        }

        try   { writeDataDir(entry.files); }
        catch (err) { return sendJSON(res, 500, { error: 'Restore failed', detail: err.message }); }

        const count = Object.keys(entry.files).length;
        console.log(`[backup-plugin-data] ${count} Datei(en) aus Backup wiederhergestellt v${entry.version}`);

        sess.used = true;
        sendJSON(res, 200, { success: true, restoredFiles: count, backupVersion: entry.version, exportedAt: entry.exportedAt ?? null });

        setImmediate(() => {
          closeSession('restored');
          console.log('[backup-plugin-data] Starte Plugin neu...');
          process.exit(0);
        });
        return;
      }

      sendJSON(res, 404, { error: 'Not found' });
    });

    server.listen(port, '0.0.0.0', () =>
      console.log(`[backup-plugin-data] Restore Server bereit (${sess.protocol}, port ${port}, route ${base})`));
    server.on('error', err =>
      console.error('[backup-plugin-data] Restore Server error:', err));

    sess.server = server;
    sess.timer  = setTimeout(() => closeSession('timeout'), SESSION_TTL_MS);
  }

  // --- Öffentliche API

  /**
   * Gibt zwei Konfigurationsgruppen (Backup + Restore) zurück,
   * die direkt in den groups-Array eines ConfigTemplateResponse eingefügt werden.
   *
   * Der Platzhalter {{hostname}} in URLs muss vom Plugin durch den
   * tatsächlichen Hostnamen der HCU ersetzt werden, sofern gewünscht.
   */
  function getConfigGroups() {
    const now           = Date.now();
    const sessionValid  = session && !session.used && now < session.expiresAt;
    const backupActive  = sessionValid && session.type === 'backup';
    const restoreActive = sessionValid && session.type === 'restore';
    const backupBlocked  = restoreActive; // Restore läuft > kein Backup
    const restoreBlocked = backupActive;  // Backup läuft  > kein Restore

    // --- Backup-Gruppe
    let backupDescription;
    let backupFields;
    if (backupActive) {
      backupDescription = bi('backupStep2Desc');
      backupFields = [
        { id: 'backupAction', type: 'LINK',
          label:       bi('backupGroupTitle'),
          buttonLabel: bi('backupButtonLabel'),
          url: `${session.protocol}://{{hostname}}:${port}/${session.route}`, displayAsButton: true },
      ];
    } else if (backupBlocked) {
      backupDescription = bi('backupStep1Desc');
      backupFields = []; // Restore läuft > keine Checkbox anzeigen
    } else {
      backupDescription = bi('backupStep1Desc');
      backupFields = [
        { id: 'backupMode', type: 'BOOLEAN', label: bi('backupModeLabel'), value: false },
      ];
    }

    // --- Restore-Gruppe
    let restoreDescription;
    let restoreFields;
    if (restoreActive) {
      restoreDescription = bi('restoreStep2Desc');
      restoreFields = [
        { id: 'restoreToken',  type: 'STRING', label: bi('restoreTokenLabel'), value: session.token, readOnly: true },
        { id: 'restoreAction', type: 'LINK',
          label:       bi('restoreGroupTitle'),
          buttonLabel: bi('restoreButtonLabel'),
          url: `${session.protocol}://{{hostname}}:${port}/${session.route}?hl={{lang}}`, displayAsButton: true },
      ];
    } else if (restoreBlocked) {
      restoreDescription = bi('restoreStep1Desc');
      restoreFields = []; // Backup läuft > keine Checkbox anzeigen
    } else {
      restoreDescription = bi('restoreStep1Desc');
      restoreFields = [
        { id: 'restoreMode', type: 'BOOLEAN', label: bi('restoreModeLabel'), value: false },
      ];
    }

    return [
      { id: 'backupGroup',  label: bi('backupGroupLabel'),  description: backupDescription,  fields: backupFields  },
      { id: 'restoreGroup', label: bi('restoreGroupLabel'), description: restoreDescription, fields: restoreFields },
    ];
  }

  /**
   * Verarbeitet Felder aus einem CONFIG_UPDATE_REQUEST.
   * Gibt true zurück, wenn ein Backup- oder Restore-Modus aktiviert wurde
   * (das Plugin muss in diesem Fall keine eigene Update-Logik ausführen).
   *
   * @param {object} fields - Update-Felder (body.fields des CONFIG_UPDATE_REQUEST)
   * @returns {boolean}
   */
  function handleConfigUpdate(fields = {}) {
    if (fields.backupMode === true) {
      closeSession('new-backup-session');
      session = newSession('backup');
      startBackupServer();
      return true;
    }
    if (fields.restoreMode === true) {
      closeSession('new-restore-session');
      session = newSession('restore');
      startRestoreServer();
      return true;
    }
    return false;
  }

  return { getConfigGroups, handleConfigUpdate, closeSession };
}

module.exports = { create };
