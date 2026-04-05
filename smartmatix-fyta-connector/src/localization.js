'use strict';

/**
 * localization.js
 *
 * Lädt Übersetzungen aus /lang/localization.json und stellt eine
 * Übersetzungsfunktion bereit.
 *
 * Schema der localization.json:
 * {
 *   "de": { "key": "Übersetzung", ... },
 *   "en": { "key": "Translation", ... }
 * }
 *
 * Verwendung:
 *   const { t } = require('./localization');
 *   t('de', 'settings.email.label') > 'E-Mail-Adresse'
 *   t('xx', 'settings.email.label') > Fallback auf 'de', dann den Key selbst
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

// ---------------------------------------------------------------------------
//  Konstanten
// ---------------------------------------------------------------------------

const LANG_FILE     = path.join(__dirname, '..', 'lang', 'localization.json');
const FALLBACK_LANG = 'de';

// ---------------------------------------------------------------------------
//  Laden der Übersetzungsdaten (einmalig beim ersten require())
// ---------------------------------------------------------------------------

let translations = {};

try {
  const raw    = fs.readFileSync(LANG_FILE, 'utf8');
  translations = JSON.parse(raw);
  log.info(`Localization: ${Object.keys(translations).length} Sprache(n) geladen aus ${LANG_FILE}`);
} catch (err) {
  log.warn(`Localization: Konnte ${LANG_FILE} nicht laden – nur Key-Passthrough verfügbar.`, err.message);
}

// ---------------------------------------------------------------------------
//  Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Gibt die Übersetzung für einen Key in der gewünschten Sprache zurück.
 *
 * Fallback-Kette:
 *   1. Gewünschte Sprache (lang)
 *   2. Fallback-Sprache ('de')
 *   3. Key selbst (damit die UI nie leer bleibt)
 *
 * @param {string} lang – ISO-639-1-Sprachkürzel, z.B. 'de' | 'en'
 * @param {string} key  – Übersetzungsschlüssel, z.B. 'settings.email.label'
 * @returns {string}    – Übersetzte Zeichenkette
 */
function t(lang, key) {
  const normalizedLang = (lang ?? FALLBACK_LANG).toLowerCase().split('-')[0]; // 'de-DE' → 'de'

  const inLang     = translations[normalizedLang]?.[key];
  if (inLang !== undefined) return inLang;

  const inFallback = translations[FALLBACK_LANG]?.[key];
  if (inFallback !== undefined) return inFallback;

  log.debug(`Localization: Kein Eintrag fuer Key "${key}" in Sprache "${normalizedLang}" oder "${FALLBACK_LANG}".`);
  return key;
}

/**
 * Gibt alle verfügbaren Sprachkürzel zurück.
 *
 * @returns {string[]}
 */
function availableLanguages() {
  return Object.keys(translations);
}

module.exports = { t, availableLanguages };