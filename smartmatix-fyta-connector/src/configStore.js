'use strict';

/**
 * configStore.js
 *
 * Liest und schreibt die Plugin-Konfiguration aus/in eine config.json.
 * Die Datei liegt im Arbeitsverzeichnis des Plugins: /data
 *
 * Inhalt config.json (Beispiel):
 * {
 *   "reincludeDevices": "false"
 * }
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');


const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const CONFIG_FILE = DATA_PATH + '/config.json';


// Standard-Konfiguration – wird verwendet wenn config.json noch nicht existiert
const DEFAULTS = {
  "fytaEMail":        "",
  "fytaPassword":     "",
  "fytaAccessToken":  "",
  "fytaRefreshToken": "",
  "fytaTokenExpires": "",
  "syncInterval":     15,
  "autoImport":       true,
  "reincludeDevices": false,
};

/**
 * Liest die config.json vom Dateisystem.
 * Falls die Datei nicht existiert, wird die Standard-Konfiguration zurückgegeben.
 * @returns {object} Konfigurationsobjekt
 */
function load() {
  try {
    const raw    = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    log.info(`Konfiguration geladen aus: ${CONFIG_FILE}`);
    return { ...DEFAULTS, ...config };
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info('Keine config.json gefunden > verwende Standard-Konfiguration.');
    } else {
      log.warn('Fehler beim Lesen der config.json:', err.message);
    }
    return { ...DEFAULTS };
  }
}

/**
 * Schreibt das Konfigurationsobjekt in die config.json.
 * @param {object} config - Konfigurationsobjekt
 */
function save(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    log.info(`Konfiguration gespeichert in: ${CONFIG_FILE}`);
  } catch (err) {
    log.error('Fehler beim Schreiben der config.json:', err.message);
  }
}

/**
 * Prüft ob sich ein Wert geändert hat und speichert ihn bei Änderung.
 *
 * @param {string} setting - Schlüssel in der Konfiguration
 * @param {string} value   - Neuer Wert
 * @returns {boolean} true wenn der Wert geändert und gespeichert wurde
 */
function checkAndUpdate(setting, value) {
  const currentConfig = load();

  if (currentConfig[setting] !== value) {
    currentConfig[setting] = value;
    save(currentConfig);
    return true;
  }

  return false;
}

module.exports = { load, save, checkAndUpdate };