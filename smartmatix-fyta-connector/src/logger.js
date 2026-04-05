'use strict';

/**
 * Einfacher Konsolenlogger mit Zeitstempel und Level-Steuerung.
 * Level per Umgebungsvariable: LOG_LEVEL=debug|info|warn|error
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function log(level, ...args) {
  if (LEVELS[level] < current) return;
  const ts     = new Date().toISOString();
  const label  = level.toUpperCase().padEnd(5);
  const output = level === 'error' || level === 'warn' ? console.error : console.log;
  output(`[${ts}] [${label}]`, ...args);
}

module.exports = {
  debug: (...a) => log('debug', ...a),
  info:  (...a) => log('info',  ...a),
  warn:  (...a) => log('warn',  ...a),
  error: (...a) => log('error', ...a),
};
