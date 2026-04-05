'use strict';

/**
 * Homematic IP Connect API – SmartMatix FYTA Connector (Node.js)
 *
 * Einstiegspunkt. Liest den Auth-Token aus einer Datei und startet
 * die WebSocket-Verbindung zur HCU.
 *
 * Aufruf:
 *   node src/index.js <plugin-id> <hcu-host> <authtoken-datei>
 *
 * Beispiel:
 *   node src/index.js de.example.mein-plugin hcu1-1234.local authtoken.txt
 */

const fs     = require('fs').promises;
const Plugin = require('./plugin');
const log    = require('./logger');

async function main() {
  const [pluginId, host, authtokenFile] = process.argv.slice(2);

  if (!pluginId || !host || !authtokenFile) {
    console.error('Verwendung: node src/index.js <plugin-id> <hcu-host> <authtoken-datei>');
    process.exit(1);
  }

  let authtoken;
  try {
    authtoken = await fs.readFile(authtokenFile, 'utf8');
  } catch (err) {
    log.error(`Auth-Token-Datei konnte nicht gelesen werden: ${authtokenFile}`, err.message);
    process.exit(1);
  }

  log.info('=== Homematic IP Connect API Plugin SmartMatix FYTA Connector ===');
  log.info(`Plugin-ID : ${pluginId}`);
  log.info(`HCU-Host  : ${host}`);

  const plugin = new Plugin({ pluginId, host, authtoken });

  process.on('SIGINT',  () => plugin.stop());
  process.on('SIGTERM', () => plugin.stop());

  plugin.start();
}

main();
