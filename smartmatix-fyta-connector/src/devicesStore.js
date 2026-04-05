'use strict';

/**
 * devicesStore.js
 *
 * Liest und schreibt die Geräte-Konfiguration aus/in eine devices.json
 * sowie FYTA-Pflanzendaten aus/in eine fyta.json.
 * Die Dateien liegen im Arbeitsverzeichnis des Plugins: /data
 *
 * Format der devices.json:
 * {
 *   "fyta-climate-sensor-1": {
 *     "deviceType":      "CLIMATE_SENSOR",
 *     "deviceId":        "fyta-climate-sensor-1",
 *     "firmwareVersion": "1.0.0",
 *     "friendlyName":    "Meine Pflanze",
 *     "modelType":       "FYTAClimateSensor",
 *     "features": [
 *       { "type": "switchState", "on": false }
 *     ],
 *     "fytaPlant": 0,
 *     "fytaID": 0,
 *     "deviceClimateSensor": false,
 *     "alreadyIncluded": true
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');


const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const allowedTypes = ['devices', 'fyta', 'fyta-gardens']; // Erlaubte Werte für type

const DEVICES_FILE = DATA_PATH;


// Standard-Inhalt wenn die jeweilige Datei noch nicht existiert
const DEFAULT_DEVICES = {};

/**
 * Gibt den absoluten Dateipfad für einen erlaubten Typ zurück.
 *
 * @param {string} type - 'devices' | 'fyta' | 'fyta-gardens'
 * @returns {string|null} Absoluter Pfad oder null bei ungültigem Typ
 */
function checkAllowedDeviceType(type) {
  if (allowedTypes.includes(type)) {
    return DEVICES_FILE + '/' + type + '.json';
  }
  log.warn(`devicesStore: Unbekannter Typ "${type}" – erlaubt sind: ${allowedTypes.join(', ')}.`);
  return null;
}

/**
 * Liest eine JSON-Datei vom Dateisystem.
 * Falls die Datei nicht existiert, wird ein leeres Objekt zurückgegeben.
 *
 * @param {string} type - 'devices' | 'fyta' | 'fyta-gardens'
 * @returns {object} Gespeichertes Objekt oder {}
 */
function load(type) {
  let saveStateFile;

  if ((saveStateFile = checkAllowedDeviceType(type)) == null) {
    return { ...DEFAULT_DEVICES };
  }

  try {
    const raw     = fs.readFileSync(saveStateFile, { encoding: 'utf8' });
    const devices = JSON.parse(raw);
    log.info(`${Object.keys(devices).length} Eintraege geladen aus: ${saveStateFile}`);
    return devices;
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info(`Keine ${type}.json gefunden > lege leere Datei an.`);
      save(type, DEFAULT_DEVICES);
    } else {
      log.warn(`Fehler beim Lesen der ${type}.json:`, err.message);
    }
    return { ...DEFAULT_DEVICES };
  }
}

/**
 * Schreibt ein Objekt als JSON in die Datei des angegebenen Typs.
 *
 * @param {string} type    - 'devices' | 'fyta' | 'fyta-gardens'
 * @param {object} devices - Zu schreibendes Objekt
 */
function save(type, devices) {
  let saveStateFile;

  if ((saveStateFile = checkAllowedDeviceType(type)) == null) {
    log.error('devicesStore.save: Fehler beim Schreiben > ungültiger Typ.');
    return;
  }

  try {
    fs.writeFileSync(saveStateFile, JSON.stringify(devices, null, 2), { encoding: 'utf8' });
    log.info(`Konfiguration gespeichert in: ${saveStateFile}`);
  } catch (err) {
    log.error(`Fehler beim Schreiben der ${type}.json:`, err.message);
  }
}

/**
 * Aktualisiert einen einzelnen Eintrag in der JSON-Datei des angegebenen Typs.
 *
 * @param {string} type         - 'devices' | 'fyta' | 'fyta-gardens'
 * @param {string} deviceId     - Schlüssel des zu aktualisierenden Eintrags
 * @param {object} deviceObject - Neuer Wert
 */
function update(type, deviceId, deviceObject) {
  let saveStateFile;

  if ((saveStateFile = checkAllowedDeviceType(type)) == null) {
    log.error('devicesStore.update: Fehler beim Aktualisieren – ungültiger Typ.');
    return;
  }

  const current = load(type);
  current[deviceId] = deviceObject;
  save(type, current);
}

/**
 * Entfernt einen einzelnen Eintrag aus der JSON-Datei des angegebenen Typs.
 *
 * @param {string} type     - 'devices' | 'fyta' | 'fyta-gardens'
 * @param {string} deviceId - Schlüssel des zu löschenden Eintrags
 */
function remove(type, deviceId) {
  let saveStateFile;

  if ((saveStateFile = checkAllowedDeviceType(type)) == null) {
    log.error('devicesStore.remove: Fehler beim Entfernen – ungültiger Typ.');
    return;
  }

  const current = load(type);
  delete current[deviceId];
  save(type, current);
}

/**
 * Markiert Geräte in der devices.json als bereits an die HCU übermittelt.
 * @param {string[]} deviceIds - Array von Geräte-IDs
 */
function markAsIncluded(deviceIds) {
  const current = load('devices');

  deviceIds.forEach(id => {
    if (current[id]) {
      current[id].alreadyIncluded = true;
    }
  });
  save('devices', current);
}

module.exports = { load, save, update, remove, markAsIncluded };