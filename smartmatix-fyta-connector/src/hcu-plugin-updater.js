'use strict';

/**
 * hcu-plugin-updater.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bibliothek für Homematic IP HCU1 Connect-API-Plugins.
 * Prüft automatisch auf neuere Plugin-Versionen (GitHub / Gitea / Codeberg …)
 * und zeigt bei Bedarf eine schließbare Benachrichtigung in der Homematic IP
 * App an.
 *
 * Verwendung in plugin.js:
 * ─────────────────────────────────────────────────────────────────────────────
 *   const { HcuPluginUpdater } = require('./hcu-plugin-updater');
 *
 *   // Variante A – Version automatisch aus package.json lesen:
 *   const updater = new HcuPluginUpdater(webSocket, pluginId);
 *   updater.checkForUpdates('https://github.com/user/repo', 'Mein Plugin');
 *
 *   // Variante B – Version explizit übergeben:
 *   updater.checkForUpdates('https://github.com/user/repo', 'Mein Plugin', '1.2.3');
 *
 *   // Sprache aus einem HCU-Request übernehmen (ISO 639-1, z. B. 'de' oder 'en'):
 *   const updater = new HcuPluginUpdater(webSocket, pluginId, { language: message.body.languageCode });
 *
 *   // Intervall (Standard: täglich):
 *   updater.startSchedule('https://github.com/user/repo', 'Mein Plugin', '1.2.3', 24 * 60 * 60 * 1000);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Unterstützte Repository-Hoster:
 *   • GitHub   (github.com)
 *   • Gitea    (beliebige Instanz, z. B. codeberg.org)
 *   • GitLab   (gitlab.com + selbst gehostete Instanzen)
 *
 * Versionsformat: Semantic Versioning (Major.Minor.Patch), Tags dürfen ein
 * führendes „v" tragen (v1.2.3 wird korrekt erkannt).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https  = require('https');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// --- Hilfsfunktionen

/**
 * Parsed eine Semver-Zeichenkette in ein vergleichbares Objekt.
 * Führendes „v" wird automatisch entfernt.
 * @param {string} raw  z. B. "v2.1.0" oder "1.0.0-beta"
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseSemver(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  const match   = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Vergleicht zwei Versionen.
 * @returns {boolean}  true wenn "remote" neuer ist als "local"
 */
function isNewer(local, remote) {
  if (!local || !remote) return false;
  if (remote.major !== local.major) return remote.major > local.major;
  if (remote.minor !== local.minor) return remote.minor > local.minor;
  return remote.patch > local.patch;
}

/**
 * Führt einen HTTPS-GET-Request aus und liefert den geparsten JSON-Body.
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<object>}
 */
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib      = url.startsWith('https') ? https : http;
    const options  = {
      headers: {
        'User-Agent': 'hcu-plugin-updater/1.0 (Homematic IP Connect API Plugin)',
        'Accept'    : 'application/json',
        ...headers,
      },
    };

    const req = lib.get(url, options, (res) => {
      // Redirects folgen (GitHub API leitet gelegentlich um)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, headers).then(resolve).catch(reject);
        res.resume();
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} bei ${url}`));
        res.resume();
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end',  ()    => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON-Parse-Fehler: ${e.message}`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Request Timeout')); });
  });
}

// ─── API-Adapter ──────────────────────────────────────────────────────────────

/**
 * Ermittelt das neueste Release/Tag eines GitHub-Repos.
 * @param {string} owner  z. B. "homematic-ip"
 * @param {string} repo   z. B. "hello-world"
 * @returns {Promise<{ version: string, url: string }>}
 */
async function fetchGitHub(owner, repo) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  try {
    const data = await fetchJson(apiUrl);
    return { version: data.tag_name, url: data.html_url };
  } catch {
    // Fallback: Tags (falls kein Release existiert)
    const tags  = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/tags`);
    if (!tags.length) throw new Error('Keine Tags/Releases gefunden.');
    return {
      version: tags[0].name,
      url    : `https://github.com/${owner}/${repo}/releases/tag/${tags[0].name}`,
    };
  }
}

/**
 * Ermittelt das neueste Release/Tag eines Gitea/Codeberg-Repos.
 * @param {string} host
 * @param {string} owner
 * @param {string} repo
 */
async function fetchGitea(host, owner, repo) {
  const apiUrl = `https://${host}/api/v1/repos/${owner}/${repo}/releases?limit=1`;
  try {
    const data = await fetchJson(apiUrl);
    if (data.length) {
      return { version: data[0].tag_name, url: data[0].html_url };
    }
  } catch { /* weiter zu Tags */ }
  // Fallback Tags
  const tags = await fetchJson(`https://${host}/api/v1/repos/${owner}/${repo}/tags?limit=1`);
  if (!tags.length) throw new Error('Keine Tags/Releases gefunden.');
  return {
    version: tags[0].name,
    url    : `https://${host}/${owner}/${repo}/releases/tag/${tags[0].name}`,
  };
}

/**
 * Ermittelt das neueste Release/Tag eines GitLab-Repos.
 * @param {string} host
 * @param {string} namespace z. B. "user/repo" oder "group/subgroup/repo"
 */
async function fetchGitLab(host, namespace) {
  const encoded = encodeURIComponent(namespace);
  const apiUrl  = `https://${host}/api/v4/projects/${encoded}/releases?per_page=1`;
  try {
    const data = await fetchJson(apiUrl);
    if (data.length) {
      return {
        version: data[0].tag_name,
        url    : `https://${host}/${namespace}/-/releases/${data[0].tag_name}`,
      };
    }
  } catch { /* weiter zu Tags */ }
  const tags = await fetchJson(`https://${host}/api/v4/projects/${encoded}/repository/tags?per_page=1`);
  if (!tags.length) throw new Error('Keine Tags/Releases gefunden.');
  return {
    version: tags[0].name,
    url    : `https://${host}/${namespace}/-/tags/${tags[0].name}`,
  };
}

/**
 * Universeller Dispatcher: erkennt den Hoster anhand der URL und ruft den
 * passenden Adapter auf.
 * @param {string} repoUrl  Vollständige Repository-URL
 * @returns {Promise<{ version: string, url: string }>}
 */
async function fetchLatestVersion(repoUrl) {
  const parsed = new URL(repoUrl);
  const host   = parsed.hostname.toLowerCase();
  // Pfad ohne führenden Slash, z. B. "user/repo"
  const parts  = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');

  if (host === 'github.com') {
    if (parts.length < 2) throw new Error('Ungültige GitHub-URL.');
    return fetchGitHub(parts[0], parts[1]);
  }

  if (host === 'gitlab.com' || host.includes('gitlab')) {
    const namespace = parts.join('/');
    return fetchGitLab(host, namespace);
  }

  // Gitea / Codeberg / Forgejo und vergleichbare Instanzen
  if (parts.length < 2) throw new Error(`Ungueltige Repository-URL für ${host}.`);
  return fetchGitea(host, parts[0], parts[1]);
}

// --- Versionserkennung

/**
 * Versucht, die aktuelle Plugin-Version aus einer package.json zu lesen.
 * Sucht ausgehend von "startDir" aufwärts, bis package.json gefunden wird.
 * @param {string} [startDir]  Startverzeichnis (Standard: Verzeichnis des Aufrufers)
 * @returns {string | null}
 */
function readVersionFromPackageJson(startDir) {
  let dir = startDir || path.dirname(module.parent?.filename || process.cwd());
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg.version) return pkg.version;
      } catch { /* ignorieren */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// --- Hauptklasse

class HcuPluginUpdater {
  /**
   * @param {import('ws').WebSocket} webSocket  Aktive WebSocket-Verbindung zur HCU
   * @param {string}                 pluginId   Plugin-Identifier (z. B. "de.example.myplugin")
   * @param {object}                 [options]
   * @param {string}                 [options.language]  ISO 639-1 Sprachcode für die Benachrichtigung,
   *                                                     wie von der HCU geliefert (z. B. message.body.languageCode).
   *                                                     Wird kein passender Text gefunden, fällt die Bibliothek
   *                                                     automatisch auf 'de' zurück. Standard: 'de'
   * @param {boolean}                [options.debug]     Ausführliche Logs
   */
  constructor(webSocket, pluginId, options = {}) {
    if (!webSocket) throw new Error('HcuPluginUpdater: webSocket ist erforderlich.');
    if (!pluginId)  throw new Error('HcuPluginUpdater: pluginId ist erforderlich.');

    this._ws                  = webSocket;
    this._pluginId            = pluginId;
    this._lang                = options.language || 'de';
    this._debug               = options.debug    || false;
    this._timer               = null;
    this._lastNotifiedVersion = null;
  }

  // --- Öffentliche API

  /**
   * Prüft einmalig auf Updates und zeigt ggf. eine Benachrichtigung an.
   *
   * @param {string}  repoUrl      Vollständige Repository-URL
   * @param {string}  [pluginName] Anzeigename des Plugins (Standard: pluginId)
   * @param {string}  [version]    Aktuelle Version; wird aus package.json gelesen, falls weggelassen
   * @returns {Promise<void>}
   */
  async checkForUpdates(repoUrl, pluginName, version) {
    const name        = pluginName || this._pluginId;
    const localRaw    = version    || readVersionFromPackageJson();
    const localParsed = parseSemver(localRaw);

    if (!localParsed) {
      this._log(`Konnte lokale Version nicht ermitteln. Uebergebe Version-Parameter oder stelle package.json bereit.`);
      return;
    }

    this._log(`Pruefe auf Updates für „${name}" (lokal: ${localRaw}) …`);

    let remote;
    try {
      remote = await fetchLatestVersion(repoUrl);
    } catch (err) {
      this._log(`Update-Check fehlgeschlagen: ${err.message}`);
      return;
    }

    const remoteParsed = parseSemver(remote.version);

    this._log(`Neueste verfuegbare Version: ${remote.version}`);

    if (!isNewer(localParsed, remoteParsed)) {
      this._log(`Kein Update verfuegbar.`);
      return;
    }

    this._log(`Update verfuegbar: ${localRaw} → ${remote.version}`);

    if (this._lastNotifiedVersion === remote.version) {
      this._log(`Benachrichtigung fuer ${remote.version} wurde bereits angezeigt, wird nicht erneut gesendet.`);
      return;
    }

    this._lastNotifiedVersion = remote.version;
    await this._sendUpdateNotification(name, localRaw, remote.version);
  }

  /**
   * Startet einen wiederkehrenden Update-Check (Standard: alle 24 Stunden).
   * Führt sofort beim Start den ersten Check durch.
   *
   * @param {string}  repoUrl
   * @param {string}  [pluginName]
   * @param {string}  [version]
   * @param {number}  [intervalMs]  Intervall in Millisekunden (Standard: 86 400 000 = 24 h)
   */
  startSchedule(repoUrl, pluginName, version, intervalMs = 24 * 60 * 60 * 1000) {
    this.checkForUpdates(repoUrl, pluginName, version);
    this._timer = setInterval(
      () => this.checkForUpdates(repoUrl, pluginName, version),
      intervalMs
    );
    this._log(`Automatischer Update-Check alle ${Math.round(intervalMs / 3_600_000)} Stunde(n) gestartet.`);
  }

  /**
   * Stoppt den wiederkehrenden Update-Check.
   */
  stopSchedule() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._log('Automatischer Update-Check gestoppt.');
    }
  }

  // --- Private Methoden

  /**
   * Sendet eine DISMISSIBLE-Benachrichtigung an die HCU.
   * title und message sind Maps nach ISO 639-1.
   * Die Bibliothek liefert immer 'de' und 'en'
   */
  async _sendUpdateNotification(pluginName, localVersion, remoteVersion) {
    const msgId = `hcu-plugin-updater-${crypto.randomUUID()}`;

    // Die Connect API erwartet Map<String, String> mit ISO-639-1-Keys.
    const title = {
      de: `Update verfügbar: ${pluginName}`,
      en: `Update available: ${pluginName}`,
    };
    const message = {
      de: `Version ${remoteVersion} ist verfügbar. Installiert: ${localVersion}.`,
      en: `Version ${remoteVersion} is available. Installed: ${localVersion}.`,
    };

    // Falls der Nutzer eine andere Sprache eingestellt hat,
    // Fallback-Eintrag für diesen Sprachcode (zeigt den englischen Text).
    const lang = this._lang;
    if (lang && lang !== 'de' && lang !== 'en') {
      title[lang]   = title['en'];
      message[lang] = message['en'];
    }

    const payload = {
      pluginId: this._pluginId,
      id      : crypto.randomUUID(),
      type    : 'CREATE_USER_MESSAGE_REQUEST',
      body    : {
        userMessageId  : msgId,
        behaviorType   : 'DISMISSIBLE',
        messageCategory: 'INFO',
        timestamp      : Date.now(),
        title,
        message,
      },
    };

    try {
      this._ws.send(JSON.stringify(payload));
      this._log(`Benachrichtigung gesendet (ID: ${msgId}).`);
    } catch (err) {
      this._log(`Fehler beim Senden der Benachrichtigung: ${err.message}`);
    }
  }

  _log(msg) {
    if (this._debug || true) {   // immer loggen; auf false setzen für Produktion
      console.log(`[hcu-plugin-updater] ${msg}`);
    }
  }
}

// --- Exports

module.exports = { HcuPluginUpdater, parseSemver, isNewer, readVersionFromPackageJson };