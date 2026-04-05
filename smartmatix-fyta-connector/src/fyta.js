'use strict';

/**
 * fyta.js – Calls an die FYTA API und Verarbeitung der Daten
 *
 * Ablauf:
 *   1. syncPlants()         > Einstiegspunkt: prüft Token, loggt ggf. neu ein,
 *                             ruft getUserPlants() und getPlantDetails() auf
 *   2. login()              > Token holen und in config speichern
 *   3. getUserPlants()      > Gärten → /data/fyta-gardens.json
 *                             Gefilterte Pflanzen-IDs sammeln
 *   4. getPlantDetails(id)  > Details je Pflanze → /data/fyta.json
 *
 * Token-Ablauf:
 *   fytaTokenExpires wird als absoluter Unix-Timestamp (ms) gespeichert,
 *   nicht als der von FYTA gelieferte expires_in-Sekundenwert.
 *   Vor jedem API-Call prüft ensureValidToken() ob der Token noch gültig
 *   ist und loggt bei Bedarf automatisch neu ein.
 *
 * Filter (getUserPlants):
 *   - Pflanze nicht gelöscht  (plant.status !== 0)
 *   - Pflanze hat einen Sensor (sensor.status !== 0)
 */

const https       = require('https');
const fs          = require('fs');
const path        = require('path');
const configStore = require('./configStore');
const log         = require('./logger');

// ---------------------------------------------------------------------------
//  Konstanten
// ---------------------------------------------------------------------------

const FYTA_HOST        = 'web.fyta.de';
const FYTA_LOGIN_PATH  = '/api/auth/login';
const FYTA_PLANTS_PATH = '/api/user-plant';
const FYTA_PLANT_PATH  = '/api/user-plant/';

const DATA_PATH    = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data');
const GARDENS_FILE = path.join(DATA_PATH, 'fyta-gardens.json');
const PLANTS_FILE  = path.join(DATA_PATH, 'fyta.json');

// Token wird 60 Sekunden vor dem echten Ablauf als ungültig betrachtet (Puffer)
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

// ---------------------------------------------------------------------------
//  Interne HTTP-Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * HTTP-POST gegen die FYTA-API.
 *
 * @param {string} apiPath  – Pfad, z.B. '/api/auth/login'
 * @param {object} body     – Wird als JSON serialisiert
 * @param {string} [token]  – Bearer-Token (optional)
 * @returns {Promise<object>}
 */
function post(apiPath, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request(
      { hostname: FYTA_HOST, path: apiPath, method: 'POST', headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          log.debug(`FYTA POST ${apiPath} – HTTP ${res.statusCode}: ${raw}`);
          let parsed;
          try { 
            parsed = JSON.parse(raw); 
          }
          catch { 
            return reject(new Error(`FYTA API: Ungueltige JSON-Antwort von ${apiPath}: ${raw}`)); 
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = parsed?.message ?? parsed?.error ?? res.statusCode;
            return reject(new Error(`FYTA POST ${apiPath} fehlgeschlagen (${res.statusCode}): ${msg}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', (err) => {
      log.error(`FYTA Netzwerkfehler bei POST ${apiPath}:`, err.message);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * HTTP-GET gegen die FYTA-API.
 *
 * @param {string} apiPath – Pfad, z.B. '/api/user-plant'
 * @param {string} token   – Bearer-Token (Pflichtfeld)
 * @returns {Promise<object>}
 */
function get(apiPath, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    };

    const req = https.request(
      { hostname: FYTA_HOST, path: apiPath, method: 'GET', headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          log.debug(`FYTA GET ${apiPath} – HTTP ${res.statusCode}: ${raw}`);
          let parsed;
          try { 
            parsed = JSON.parse(raw); 
          }
          catch { 
            return reject(new Error(`FYTA API: Ungueltige JSON-Antwort von ${apiPath}: ${raw}`)); 
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = parsed?.message ?? parsed?.error ?? res.statusCode;
            return reject(new Error(`FYTA GET ${apiPath} fehlgeschlagen (${res.statusCode}): ${msg}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', (err) => {
      log.error(`FYTA Netzwerkfehler bei GET ${apiPath}:`, err.message);
      reject(err);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  JSON-Datei schreiben
// ---------------------------------------------------------------------------

/**
 * Schreibt ein Objekt als formatiertes JSON in eine Datei.
 * Legt fehlende Verzeichnisse automatisch an.
 *
 * @param {string} filePath – Absoluter Dateipfad
 * @param {*}      data     – Zu schreibende Daten
 */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  log.info(`FYTA: Datei geschrieben > ${filePath}`);
}

// ---------------------------------------------------------------------------
//  Token-Verwaltung
// ---------------------------------------------------------------------------

/**
 * Prüft ob der gespeicherte Token noch gültig ist.
 *
 * 60 Sekunden Puffer vor dem echten Ablauf werden eingerechnet.
 *
 * @param {object} config – Geladenes Konfigurationsobjekt
 * @returns {boolean}
 */
function isTokenValid(config) {
  const token   = config.fytaAccessToken;
  const expires = config.fytaTokenExpires;

  if (!token || !expires) return false;

  const expiresAt = parseInt(expires, 10);
  if (isNaN(expiresAt)) return false;

  return Date.now() < expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Stellt sicher, dass ein gültiger Token vorliegt.
 * Loggt bei abgelaufenem oder fehlendem Token automatisch neu ein.
 *
 * @returns {Promise<string|null>} – Gültiger access_token oder null bei Fehler
 */
async function ensureValidToken() {
  const config = configStore.load();

  if (isTokenValid(config)) {
    log.debug('FYTA: Token noch gueltig.');
    return config.fytaAccessToken;
  }

  log.info('FYTA: Token abgelaufen oder nicht vorhanden – neu einloggen ...');
  const success = await login();
  if (!success) return null;

  return configStore.load().fytaAccessToken;
}

// ---------------------------------------------------------------------------
//  Öffentliche API-Funktionen
// ---------------------------------------------------------------------------

/**
 * Authentifiziert sich an der FYTA-API.
 *
 * Speichert in der config:
 *   fytaAccessToken  – Bearer-Token für API-Calls
 *   fytaRefreshToken – Refresh-Token
 *   fytaTokenExpires – Absoluter Ablauf-Timestamp in ms (nicht expires_in!)
 *
 * @returns {Promise<boolean>} – true bei Erfolg, false bei Fehler
 */
async function login() {
  const currentConfig = configStore.load();
  const email         = currentConfig.fytaEMail;
  const password      = currentConfig.fytaPassword;

  if (!email || !password) {
    log.warn('FYTA Login: E-Mail oder Passwort fehlt in der Konfiguration.');
    return false;
  }

  log.info(`FYTA Login fuer ${email} ...`);

  let data;
  try {
    data = await post(FYTA_LOGIN_PATH, { email, password });
  } catch (err) {
    log.error('FYTA Login fehlgeschlagen:', err.message);
    return false;
  }

  const accessToken  = data?.access_token;
  const refreshToken = data?.refresh_token;
  const expiresIn    = data?.expires_in;   // FYTA-Wert

  if (!accessToken) {
    log.warn('FYTA Login: Kein access_token in der Antwort enthalten.');
    return false;
  }

  // Absoluten Ablauf-Timestamp berechnen – nicht den Rohwert von FYTA speichern
  const expiresAtMs = Date.now() + (expiresIn ?? 0) * 1000;

  currentConfig.fytaAccessToken  = accessToken;
  currentConfig.fytaRefreshToken = refreshToken;
  currentConfig.fytaTokenExpires = expiresAtMs.toString();
  configStore.save(currentConfig);

  log.info(`FYTA Login erfolgreich – Token gueltig bis: ${new Date(expiresAtMs).toISOString()}`);
  return true;
}

/**
 * Lädt alle Gärten und gefilterten Pflanzen vom FYTA-Konto.
 * Ruft für jede gültige Pflanze getPlantDetails() auf.
 *
 * Schreibt Gärten > /data/fyta-gardens.json
 * Schreibt Pflanzen > /data/fyta.json  (via getPlantDetails)
 *
 * Filter:
 *   • plant.status !== 0   (nicht gelöscht)
 *   • plant.status !== 3  (Sensor vorhanden)
 *
 * @param {string|null} [token] – Optionaler Token (wird sonst frisch geprüft)
 * @returns {Promise<void>}
 */
async function getUserPlants(token = null) {
  const activeToken = token ?? await ensureValidToken();
  if (!activeToken) {
    log.warn('FYTA getUserPlants: Kein gueltiger Token verfuegbar.');
    return;
  }

  log.info('FYTA: Lade Pflanzen- und Gartenliste ...');

  let data;
  try {
    data = await get(FYTA_PLANTS_PATH, activeToken);
  } catch (err) {
    log.error('FYTA getUserPlants fehlgeschlagen:', err.message);
    throw err;
  }

  // Gärten speichern
  const gardens = (data?.gardens ?? []).map(({ id, garden_name, origin_path, thumb_path }) => ({
    id,
    garden_name,
    origin_path,
    thumb_path,
  }));
  writeJson(GARDENS_FILE, gardens);
  log.info(`FYTA: ${gardens.length} Garten/Gaerten gespeichert.`);

  // Pflanzen filtern: nicht gelöscht + Sensor vorhanden
  const plants   = data?.plants ?? [];
  const validIds = plants
    .filter((p) => {
      if (p?.status === 0 || p?.status === 3) {
        log.debug('FYTA: Pflanze uebersprungen – als geloescht markiert (status=0 || status=3).');
        return false;
      }
      if (p?.sensor?.status === 0) {
        log.debug('FYTA: Pflanze uebersprungen – kein aktiver Sensor (sensor.status=0).');
        return false;
      }
      return true;
    })
    .map((p) => p?.id)
    .filter(Boolean);

  // log.info(`FYTA: ${validIds.length} von ${plants.length} Pflanze(n) erfuellen die Filterkriterien.`);

  // Details für jede gültige Pflanze sequenziell laden
  for (const plantId of validIds) {
    await getPlantDetails(plantId, activeToken);
  }

  log.info('FYTA: Pflanzensynchronisation abgeschlossen.');
}

/**
 * Ruft die Detailseite einer einzelnen Pflanze ab und persistiert sie.
 *
 * Vorhandene Einträge in /data/fyta.json werden aktualisiert,
 * neue Einträge angehängt.
 * Sensor- und Hub-Felder werden nicht persistiert.
 *
 * @param {number}      plantId       – Pflanzen-ID
 * @param {string|null} [token=null]  – Optionaler Token; wird sonst neu geprüft
 * @returns {Promise<boolean>} – true bei Erfolg
 */
async function getPlantDetails(plantId, token = null) {
  const activeToken = token ?? await ensureValidToken();
  if (!activeToken) {
    log.warn(`FYTA getPlantDetails (${plantId}): Kein gueltiger Token.`);
    return false;
  }

  // log.info(`FYTA: Lade Details fuer Pflanze ${plantId} ...`);

  let data;
  try {
    data = await get(`${FYTA_PLANT_PATH}${plantId}`, activeToken);
  } 
  catch (err) {
    log.error(`FYTA getPlantDetails (${plantId}) fehlgeschlagen:`, err.message);
    return false;
  }

  const p = data?.plant;
  if (!p) {
    log.warn(`FYTA getPlantDetails (${plantId}): Leere oder unerwartete Antwort.`);
    return false;
  }

  // Messwert kompakt extrahieren > nur aktueller Status und Grenzwerte
  const extractMeasurement = (m) => {
    if (!m) return null;
    return {
      status:         m.status                 ?? null,
      current:        m.values?.current        ?? null,
      min_good:       m.values?.min_good       ?? null,
      max_good:       m.values?.max_good       ?? null,
      min_acceptable: m.values?.min_acceptable ?? null,
      max_acceptable: m.values?.max_acceptable ?? null,
      unit:           m.unit                   ?? null,
    };
  };

  const entry = {
    id:               p.id,
    nickname:         p.nickname         ?? null,
    scientific_name:  p.scientific_name  ?? null,
    status:           p.status           ?? null,
    garden_id:        p.garden?.id       ?? null,
    temperature_unit: p.temperature_unit ?? null,
    received_data_at: p.received_data_at ?? null,
    measurements: {
      temperature: extractMeasurement(p.measurements?.temperature),
      light:       extractMeasurement(p.measurements?.light),
      moisture:    extractMeasurement(p.measurements?.moisture),
      salinity:    extractMeasurement(p.measurements?.salinity),
      ph:          extractMeasurement(p.measurements?.ph),
      battery:     p.measurements?.battery ?? null,
    }
  };

  // Bestehende fyta.json einlesen, Eintrag aktualisieren oder anhängen
  let plants = [];
  try {
    const raw    = fs.readFileSync(PLANTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) plants = parsed;
  } 
  catch {
    // Datei existiert noch nicht – starten mit leerem Array
  }

  const idx = plants.findIndex((pl) => pl.id === entry.id);
  if (idx >= 0) {
    // Vorhandene deviceId beibehalten – wird von plugin.js nach Geräteerstellung gesetzt
    // und darf beim API-Sync nicht überschrieben werden
    if (plants[idx].deviceId) {
      entry.deviceId = plants[idx].deviceId;
    }
    
    // Vorhandene autoImportEnabled Werte übertragen
    entry.autoImportEnabled =
    plants[idx].autoImportEnabled !== undefined
      ? plants[idx].autoImportEnabled
      : true;

    plants[idx] = entry;
    log.info(`FYTA: Pflanze ${plantId} in fyta.json aktualisiert.`);
  } else {
    entry.autoImportEnabled = true;
    plants.push(entry);
    log.info(`FYTA: Pflanze ${plantId} in fyta.json neu eingetragen.`);
  }

  writeJson(PLANTS_FILE, plants);
  return true;
}

/**
 * Einstiegspunkt für die vollständige Pflanzensynchronisation.
 * Stellt sicher dass ein gültiger Token vorliegt, dann werden
 * Gärten und alle Pflanzendetails geladen und persistiert.
 *
 * Typischer Aufruf aus plugin.js:
 *   fyta.syncPlants().catch(err => log.error('Sync fehlgeschlagen:', err.message));
 *
 * @returns {Promise<void>}
 */
async function syncPlants() {
  log.info('FYTA: Starte Pflanzensynchronisation ...');
  const token = await ensureValidToken();
  if (!token) {
    log.warn('FYTA syncPlants: Kein gueltiger Token – Synchronisation abgebrochen.');
    return false;
  }
  try {
    await getUserPlants(token);
    return true;
  } catch (err) {
    log.error('FYTA syncPlants: Unerwarteter Fehler:', err.message);
    return false;
  }
}

/**
 * Gibt den Namen des Gartens anhand der in der Pflanze gespeicherten ID zurück
 *
 * @returns {String} Gartenname
 */
function getGardenByPlant(gardenID) {
  try {
    const raw    = fs.readFileSync(GARDENS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr    = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const garden = arr.find(g => g.id === gardenID);
    return garden?.garden_name ?? null;
  } 
  catch {
    return null;
  }
}


module.exports = { login, syncPlants, getUserPlants, getPlantDetails, isTokenValid, getGardenByPlant };