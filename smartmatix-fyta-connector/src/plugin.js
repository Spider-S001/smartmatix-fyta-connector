'use strict';

/**
 * Plugin
 *
 * Kernklasse des Plugins. Verwaltet:
 *   • WebSocket-Verbindung zur HCU (inkl. Exponential-Backoff-Reconnect)
 *   • Authentifizierung per Header (authtoken + plugin-id)
 *   • Protokoll-Handshake gemäß Connect API 1.0.1
 *   • Routing eingehender Nachrichten an Handler-Methoden
 *
 * Verbindungsablauf (aus den offiziellen Node.js-Beispielen):
 *   1. WebSocket-Verbindung aufbauen
 *        Header: authtoken, plugin-id
 *   2. Bei „open": sofort PLUGIN_STATE_RESPONSE { READY } senden
 *   3. Auf PLUGIN_STATE_REQUEST > erneut PLUGIN_STATE_RESPONSE { READY }
 *   4. Auf DISCOVER_REQUEST     > DISCOVER_RESPONSE mit Geräteliste
 *   5. Auf CONTROL_REQUEST      > Gerät steuern + CONTROL_RESPONSE
 */

const WebSocket           = require('ws');
const fs                  = require('fs');
const path                = require('path');
const { v4: uuidv4 }      = require('uuid');
const log                 = require('./logger');
const devices             = require('./devices');
const configStore         = require('./configStore');
const devicesStore        = require('./devicesStore');
const fyta                = require('./fyta.js');
const { t }               = require('./localization');
const { HcuPluginUpdater } = require('./hcu-plugin-updater');
const backup              = require('./backup-plugin-data');


// Reconnect-Einstellungen
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
const RECONNECT_FACTOR  = 1.5;

// Pfad zur FYTA-Pflanzenliste (von fyta.js befüllt)
const DATA_PATH         = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data');
const FYTA_PLANTS_FILE  = path.join(DATA_PATH, 'fyta.json');

// Feste ID für die API-Erreichbarkeits-Benachrichtigung (static → self-replacing)
const API_UNAVAILABLE_MSG_ID = 'fyta-api-unavailable';


class Plugin {
  /**
   * @param {object} opts
   * @param {string} opts.pluginId  - Eindeutige Plugin-ID (z.B. de.example.mein-plugin)
   * @param {string} opts.host      - Hostname/IP der HCU
   * @param {string} opts.authtoken - Aktivierungsschlüssel aus der HCU
   */
  constructor({ pluginId, host, authtoken }) {
    this.pluginId  = pluginId;
    this.host      = host;
    this.authtoken = authtoken;

    // Konfiguration beim Start aus config.json laden
    this._config = configStore.load();
    log.info(`Geraete reinkludieren: ${this._config.reincludeDevices ? 'vorhanden' : '[X] noch nicht gesetzt'}`);

    // Geräte beim Start aus devices.json laden
    this._devices = devices.getAll();
    log.info(`Geraeteliste geladen: ${this._devices.DEVICES_FILE ? 'vorhanden' : '[X] noch nicht gesetzt'}`);

    this._ws             = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._fytaSyncTimer  = null;
    this._stopping       = false;
    this._lang           = 'de'; // Wird aus CONFIG_TEMPLATE_REQUEST aktualisiert

    // Update-Checker (hcu-plugin-updater) – wird in _onOpen() initialisiert,
    // sobald die WebSocket-Verbindung steht.
    this._updater = null;

    // Backup-/Restore-Manager (backup-plugin-data).
    // pluginId wird automatisch aus process.argv gelesen, version aus package.json.
    this._backupManager = backup.create();

    // Hostname der HCU für die in den Backup-/Restore-Links verwendeten URLs.
    // Auf der HCU steht die SGTIN unter /SGTIN bereit → hcu1-XXXX.local,
    // ansonsten (lokale Entwicklung) Fallback auf localhost.
    try {
      const _sgtin = fs.readFileSync('/SGTIN', 'utf8').trim();
      this._backupHost = `hcu1-${_sgtin.slice(-4)}.local`;
    } catch {
      this._backupHost = 'localhost';
    }
  }

  // ---------------------------------------------------------------------------
  //  Öffentliche API
  // ---------------------------------------------------------------------------

  start() {
    this._stopping = false;
    this._connect();
  }

  stop() {
    log.info('Plugin wird beendet...');
    this._stopping = true;
    this._clearReconnect();
    this._stopFytaSync();
    // Automatischen Update-Check beenden
    this._updater?.stopSchedule();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  //  WebSocket-Lifecycle
  // ---------------------------------------------------------------------------

  _connect() {
    const url = `wss://${this.host}:9001`;
    log.info(`Verbinde zu ${url} ...`);

    this._ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
      headers: {
        'authtoken': this.authtoken,
        'plugin-id': this.pluginId,
      },
    });

    this._ws.on('open',    ()           => this._onOpen());
    this._ws.on('message', (data)       => this._onMessage(data));
    this._ws.on('error',   (err)        => this._onError(err));
    this._ws.on('close',   (code, reason) => this._onClose(code, reason));
  }

  _onOpen() {
    log.info('WebSocket verbunden.');
    this._reconnectDelay = RECONNECT_BASE_MS; // Reset nach Erfolg

    // Update-Checker starten (täglich, sofort beim ersten Verbindungsaufbau).
    // Nur einmalig initialisieren – bei Reconnects bleibt der Scheduler bestehen.
    if (!this._updater) {
      this._updater = new HcuPluginUpdater(this._ws, this.pluginId);
      this._updater.startSchedule(
        'https://github.com/Spider-S001/smartmatix-fyta-connector',
        'SmartMatix FYTA Connector'
      );
    }

    // Pflicht bei Verbindungsaufbau: Plugin als READY melden
    this._sendPluginReady(uuidv4());

    // Zustände aller Geräte an HCU übertragen
    this._sendAllStatusEvents();

    // FYTA-Pflanzendaten einmalig beim Verbindungsaufbau synchronisieren
    this._startFytaSync();
  }

  _onMessage(raw) {
    let message;
    try {
      // raw als Buffer behandeln und explizit als UTF-8 dekodieren
      const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
      message = JSON.parse(decoded);
    } catch {
      log.warn('Ungueltige JSON-Nachricht empfangen:', raw.toString());
      return;
    }

    log.debug('< HCU:', JSON.stringify(message, null, 2));

    switch (message.type) {
      case 'PLUGIN_STATE_REQUEST':
        // HCU fragt regelmäßig nach dem Plugin-Status
        this._sendPluginReady(message.id);
        break;

      case 'DISCOVER_REQUEST':
        // HCU möchte wissen, welche Geräte das Plugin verwaltet
        this._handleDiscoverRequest(message);
        break;

      case 'CONTROL_REQUEST':
        // HCU möchte ein Gerät steuern
        this._handleControlRequest(message);
        break;

      case 'STATUS_REQUEST':
        // HCU fragt den aktuellen Gerätestatus ab
        this._handleStatusRequest(message);
        break;

      case 'CONFIG_TEMPLATE_REQUEST':
        // HCU fragt nach konfigurierbaren Einstellungen des Plugins
        this._handleConfigTemplateRequest(message);
        break;

      case 'CONFIG_UPDATE_REQUEST':
        // Benutzer hat Konfiguration in der HCU-Oberfläche gespeichert
        this._handleConfigUpdateRequest(message);
        break;

      default:
        log.debug(`Unbekannter Nachrichtentyp: "${message.type}"`);
    }
  }

  _onError(err) {
    log.error('WebSocket-Fehler:', err.code ?? '', err.message ?? err);
  }

  _onClose(code, reason) {
    const r = reason ? reason.toString() : '>';
    log.warn(`WebSocket getrennt (Code: ${code}, Grund: ${r})`);

    if (!this._stopping) {
      this._scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------------------
  //  Ausgehende Nachrichten
  // ---------------------------------------------------------------------------

  _send(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      log.warn('_send() aufgerufen, aber WebSocket ist nicht offen.');
      return;
    }
    const payload = JSON.stringify(message);
    log.debug('> HCU:', payload);
    this._ws.send(payload);
  }

  /**
   * PLUGIN_STATE_RESPONSE – teilt der HCU mit, dass das Plugin betriebsbereit ist.
   * Muss beim Verbindungsaufbau und auf jeden PLUGIN_STATE_REQUEST gesendet werden.
   */
  _sendPluginReady(messageId) {
    const message = {
      id:       messageId,
      pluginId: this.pluginId,
      type:     'PLUGIN_STATE_RESPONSE',
      body: {
        pluginReadinessStatus: 'READY',
      },
    };
    // log.info('Sende PLUGIN_STATE_RESPONSE { READY }');
    this._send(message);
  }

  // ---------------------------------------------------------------------------
  //  Request-Handler
  // ---------------------------------------------------------------------------

  /**
   * DISCOVER_REQUEST > DISCOVER_RESPONSE
   * Die HCU fragt, welche Drittanbieter-Geräte das Plugin kennt.
   */
  _handleDiscoverRequest(message) {
    log.info('DISCOVER_REQUEST empfangen > sende Geraeteliste.');
    this._sendDiscoverResponse(message.id);
  }

  /**
   * CONTROL_REQUEST > Gerät steuern > CONTROL_RESPONSE
   * Die HCU möchte den Zustand eines Geräts ändern.
   */
  _handleControlRequest(message) {
    const { deviceId, features } = message.body ?? {};
    log.info(`CONTROL_REQUEST fuer Geraet: ${deviceId}`, features);

    const success = devices.control(deviceId, features);

    if (success) {
      // Aktualisierten Zustand in devices.json speichern
      const updatedDevice = devices.getById(deviceId);
      if (updatedDevice) {
        devicesStore.update("devices", deviceId, updatedDevice);
        log.info(`Zustand von "${deviceId}" in devices.json gespeichert.`);
      }
    }

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONTROL_RESPONSE',
      body: {
        deviceId,
        success,
      },
    };
    this._send(response);
  }

  /**
   * STATUS_REQUEST > aktuellen Gerätestatus liefern
   */
  _handleStatusRequest(message) {
    const { deviceId } = message.body ?? {};
    log.info(`STATUS_REQUEST für Geraet: ${deviceId}`);

    const device  = devices.getById(deviceId);
    const success = device != null;

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'STATUS_RESPONSE',
      body: {
        success,
        devices: success ? [device] : [],
      },
    };
    this._send(response);
  }

  /**
   * CONFIG_TEMPLATE_REQUEST → Konfigurationsvorlage liefern
   *
   * Hier werden die Felder definiert, die der Benutzer in der
   * HCU-Oberfläche konfigurieren kann (z.B. Benutzername, Passwort, ...).
   * Wenn das Plugin keine Konfiguration benötigt, wird eine leere
   * Parameterliste zurückgegeben.
   */
  _handleConfigTemplateRequest(message) {
    log.info('CONFIG_TEMPLATE_REQUEST empfangen > sende Konfigurationsvorlage.');

    // Sprache der HCU aus dem Request lesen und für UI-Texte verwenden
    if (message.body?.language) {
      this._lang = message.body.language;
      log.debug(`Localization: Sprache aus CONFIG_TEMPLATE_REQUEST: ${this._lang}`);
    }

    // Pflanzenliste aus fyta.json lesen (von fyta.syncPlants() befüllt)
    // Dabei verwaiste deviceId-Verweise bereinigen (z.B. nach Plugin-Neuinstallation)
    const fytaPlants = this._loadFytaPlants().map(plant => {
      if (plant.deviceId && !devices.getById(plant.deviceId)) {
        log.info(`FYTA: deviceId ${plant.deviceId} nicht mehr in devices.json – wird zurückgesetzt (Pflanze ${plant.id}).`);
        plant.deviceId = null;
        this._updateFytaPlant(plant);
      }
      return plant;
    });

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_TEMPLATE_RESPONSE',
      body: {
        groups:     this._generateSettingsGroups(fytaPlants),
        properties: this._defineVariableFields(fytaPlants),
      },
    };
    this._send(response);
  }

  /**
   * CONFIG_UPDATE_REQUEST > neue Konfiguration entgegennehmen
   *
   * Wird aufgerufen wenn der Benutzer in der HCU-Oberfläche
   * die Konfiguration gespeichert hat.
   */
  _handleConfigUpdateRequest(message) {
    const { properties } = message.body ?? {};
    log.info('CONFIG_UPDATE_REQUEST empfangen');

    // --- Backup / Restore ---
    // Die zusammengefasste Gruppe nutzt ein Dropdown (backup_restore_action)
    // mit den lokalisierten Werten "Deaktiviert" / "Backup starten" /
    // "Wiederherstellung starten". Der gewählte Anzeigetext wird gegen die
    // Lokalisierung gematcht und in die backupMode/restoreMode-Felder übersetzt,
    // die der backupManager erwartet.
    const lang        = this._lang;
    const actionValue = properties?.backup_restore_action;
    const backupFields = {};
    if (actionValue !== undefined && actionValue !== null) {
      if (actionValue === t(lang, 'settings.backup_restore.action.backup')) {
        backupFields.backupMode = true;
      } else if (actionValue === t(lang, 'settings.backup_restore.action.restore')) {
        backupFields.restoreMode = true;
      }
    }
    if (this._backupManager.handleConfigUpdate(backupFields)) {
      // Update wurde vom Backup-Manager verarbeitet – Einstellungsseite neu
      // pushen (damit Token/Link erscheinen) und Antwort sofort senden.
      this._pushConfigTemplate();
      this._send({
        id:       message.id,
        pluginId: this.pluginId,
        type:     'CONFIG_UPDATE_RESPONSE',
        body:     { status: 'APPLIED' },
      });
      return;
    }
 
    // Properties kommen als flaches Objekt: { reincludeDevices: 'wert', ... }
    const reincludeDevices = properties?.reincludeDevices;
 
    if (reincludeDevices !== undefined) {
      this._config.reincludeDevices = reincludeDevices;
      configStore.save(this._config);
    }

    // Synchronisationseinstellungen speichern
    const newSyncInterval = properties?.fytaAPIsyncInterval;
    const newAutoImport   = properties?.fytaAutoImport;
    if (newSyncInterval !== undefined) {
      this._config.syncInterval = Number(newSyncInterval) || 15;
      configStore.save(this._config);
      // Intervall-Neustart wird am Ende des Handlers ausgeführt (nach der
      // forEach-Schleife), damit autoImportEnabled-Schreibvorgänge nicht
      // durch einen sofort startenden Sync überschrieben werden können.
      log.info(`FYTA: Synchronisationsintervall auf ${this._config.syncInterval} Min. geaendert.`);
    }
    if (newAutoImport !== undefined) {
      this._config.autoImport = newAutoImport === true || newAutoImport === 'true';
      configStore.save(this._config);
    }

    // Wenn sich FYTA Zugangsdaten geändert haben, speichern und Login versuchen
    const fytaEMail    = properties?.fytaEMail;
    const fytaPassword = properties?.fytaPassword;

    if (fytaEMail !== undefined && fytaPassword !== undefined) {
      const emailUpdated    = configStore.checkAndUpdate('fytaEMail', fytaEMail);
      const passwordUpdated = configStore.checkAndUpdate('fytaPassword', fytaPassword);

      if (emailUpdated) {
        this._config.fytaEMail = fytaEMail;
      }
      if (passwordUpdated) {
        this._config.fytaPassword = fytaPassword;
      }

      if (emailUpdated || passwordUpdated) {
        // Login + Sync sequenziell ausführen, danach Einstellungsseite aktualisieren.
        // Async hier bewusst fire-and-forget (kein await auf Handler-Ebene), damit
        // CONFIG_UPDATE_RESPONSE sofort gesendet werden kann.
        fyta.login()
          .then((success) => {
            if (!success) {
              log.warn('FYTA Login nach Konfigurationsaenderung fehlgeschlagen.');
              return;
            }
            this._config = configStore.load();
            log.info('FYTA Zugangsdaten aktualisiert und Login erfolgreich – starte Sync ...');
            return fyta.syncPlants();
          })
          .then((syncSuccess) => {
            if (syncSuccess === undefined) return; // Login hatte bereits fehlgeschlagen
            if (syncSuccess) {
              this._deleteApiUnavailableNotification();
              this._syncFytaDataToDevices();
            } else {
              this._sendApiUnavailableNotification();
            }
            // Einstellungsseite proaktiv aktualisieren – Pflanzen sind jetzt sichtbar
            this._pushConfigTemplate();
          })
          .catch((err) => {
            log.error('FYTA Login/Sync nach Konfigurationsaenderung fehlgeschlagen:', err.message);
          });
      }
    }
 
    // Für jede Pflanze in fyta.json: Toggle-Wert aus den Einstellungen auswerten.
    //
    // fyta_${num}_climate_sensor = autoImportEnabled der Pflanze:
    //   true  → Gerät soll für diese Pflanze angelegt werden (manuell oder per autoImport)
    //   false → Kein Gerät für diese Pflanze, auch wenn globaler autoImport aktiv ist
    //
    // Die Einstellung wird immer in fyta.json persistiert wenn sie im Request enthalten ist.
    // Geräte werden nur erstellt/gelöscht wenn der Wert sich auf den Gerätezustand auswirkt.
    const fytaPlants = this._loadFytaPlants();
    let devicesChanged = false;

    fytaPlants.forEach((plant, index) => {
      const num              = index + 1;
      const climateSensorRaw = properties[`fyta_${num}_climate_sensor`];

      // Pflanze nicht im Request enthalten > nichts tun
      if (climateSensorRaw === undefined) return;

      const climateSensor = climateSensorRaw === true || climateSensorRaw === 'true';

      // autoImportEnabled immer persistieren – unabhängig vom aktuellen Gerätezustand
      const previousValue = plant.autoImportEnabled;
      plant.autoImportEnabled = climateSensor;

      if (climateSensor && !plant.deviceId) {
        // Aktiviert + kein Gerät vorhanden > Gerät erstellen
        devicesChanged = this._createClimateSensorForPlant(plant, num) || devicesChanged;

      } else if (!climateSensor && plant.deviceId) {
        // Deaktiviert + Gerät vorhanden > Gerät entfernen
        devicesStore.remove('devices', plant.deviceId);
        log.info(`Climate-Sensor "${plant.deviceId}" fuer Pflanze ${plant.id} entfernt.`);
        plant.deviceId = null;
        this._updateFytaPlant(plant);
        devicesChanged = true;

      } else if (climateSensor !== previousValue) {
        // Kein Gerät betroffen, aber Wert hat sich geändert > nur persistieren
        this._updateFytaPlant(plant);
      }
      // Gerät vorhanden + aktiviert, oder kein Gerät + deaktiviert ohne Änderung > nichts tun
    });

    if (devicesChanged) {
      devices.reload();
      this._sendDiscoverResponse();
    }
 
    // Aktualisierte Geräteliste neu laden
    devices.reload();

    // Einstellungsseite mit der bereits geladenen Pflanzenliste aktualisieren –
    // kein erneuter Disk-Read nötig da fytaPlants bereits aktuell ist
    this._pushConfigTemplate(fytaPlants);

    // Sync-Timer erst jetzt neu starten – nach allen fyta.json-Schreibvorgängen.
    // Verhindert Race Condition: ein sofort startender Sync würde autoImportEnabled-
    // Änderungen aus der forEach-Schleife überschreiben.
    if (newSyncInterval !== undefined) {
      this._stopFytaSync();
      this._startFytaSync();
    }
 
    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_UPDATE_RESPONSE',
      body: {
        status: 'APPLIED',
      },
    };
    this._send(response);
  }

  /**
   * Sendet eine DISCOVER_RESPONSE an die HCU, um neue Geräte zu melden
   */
  _sendDiscoverResponse(messageId = null) {
    const id = messageId ?? uuidv4();
    const allDevices = devices.getAll();
    const devicesToReport = this._config.reincludeDevices
      ? allDevices
      : allDevices.filter(d => !d.alreadyIncluded);

    const message = {
      id:       id,  // neue ID nötig, da kein Request vorausging
      pluginId: this.pluginId,
      type:     'DISCOVER_RESPONSE',
      body: {
        success: true,
        devices: devicesToReport,
      },
    };

    this._send(message);
    devicesStore.markAsIncluded(devicesToReport.map(d => d.deviceId));
    devices.reload();
    log.info(`DISCOVER_RESPONSE gesendet mit ${devicesToReport.length} Geraet(en).`);
  }

  /**
   * Generiert alle Einstellungsgruppen anhand der FYTA-Pflanzenliste.
   * Benötigt für _handleConfigTemplateRequest.
   *
   * @param   {Array} fytaPlants – Pflanzen aus fyta.json
   * @returns {object} Gruppenobjekt { general: {...}, fyta_1: {...}, ... }
   */
  _generateSettingsGroups(fytaPlants) {
    const lang = this._lang;
    const groups = {
      general: {
        friendlyName: t(lang, 'group.general.name'),
        description:  t(lang, 'group.general.description'),
        order:        1,
      },
      info: {
        friendlyName: t(lang, 'group.info.name'),
        description:  t(lang, 'group.info.description'),
        order:        999,
      },
    };

    fytaPlants.forEach((plant, i) => {
      const num    = i + 1;
      const name   = plant.nickname ?? plant.scientific_name ?? `Pflanze ${num}`;
      const garden = fyta.getGardenByPlant(plant.garden_id) ?? `Garten von Pflanze ${num}`;
      const desc   = t(lang, 'group.plant.description').replace('{garden}', garden);
      groups[`fyta_${num}`] = {
        friendlyName: name,
        description:  desc,
        order:        2 + i,
      };
    });

    // --- Backup & Restore (zu EINER Gruppe zusammengefasst) ---
    const backupConfigGroups = this._backupManager.getConfigGroups();
    const backupHost = this._backupHost;
    const resolveDesc = (desc) => {
      const raw = (typeof desc === 'object' ? desc?.[lang] : desc) ?? '';
      return raw
        .replace(/\{\{hostname\}\}/g, backupHost)
        .replace(/\{\{lang\}\}/g, lang ?? 'en');
    };

    // Aktiven Modus ermitteln: liefert getConfigGroups() für eine Gruppe
    // andere Felder als die Standard-Checkbox, läuft dieser Modus gerade.
    const backupGroup   = backupConfigGroups[0];
    const restoreGroup  = backupConfigGroups[1];
    const backupActive  = backupGroup.fields.some(f => f.type !== 'BOOLEAN');
    const restoreActive = restoreGroup.fields.some(f => f.type !== 'BOOLEAN');

    // Beschreibung der zusammengefassten Gruppe je nach Zustand:
    //   - Backup aktiv  > Backup-Schritt-2-Beschreibung
    //   - Restore aktiv > Restore-Schritt-2-Beschreibung
    //   - sonst         > allgemeine Auswahl-Beschreibung aus localization.json
    let combinedDesc;
    if (backupActive) {
      combinedDesc = resolveDesc(backupGroup.description);
    } else if (restoreActive) {
      combinedDesc = resolveDesc(restoreGroup.description);
    } else {
      combinedDesc = t(lang, 'group.backup_restore.description');
    }

    groups.backup_restore = {
      friendlyName: t(lang, 'group.backup_restore.name'),
      description:  combinedDesc,
      order:        997,
    };

    return groups;
  }

  /**
   * Erstellt alle konfigurierbaren Einstellungsfelder anhand der FYTA-Pflanzenliste.
   * Benötigt für _handleConfigTemplateRequest.
   *
   * @param   {Array} fytaPlants – Pflanzen aus fyta.json
   * @returns {object} Properties-Objekt für CONFIG_TEMPLATE_RESPONSE
   */
  _defineVariableFields(fytaPlants) {
    // Aktuelle config neu laden, damit fytaAccessToken stets aktuell ist
    this._config = configStore.load();
    const lang           = this._lang;
    const apiConnected   = this._config.fytaAccessToken
      ? t(lang, 'settings.connected.yes')
      : t(lang, 'settings.connected.no');
    const syncInterval   = this._config.syncInterval;
    const autoImport     = this._config.autoImport;
    const reincludeDevices = this._config.reincludeDevices;

    const properties = {
      fytaEMail: {
        friendlyName: t(lang, 'settings.email.label'),
        description:  t(lang, 'settings.email.description'),
        dataType:     'STRING',
        required:     'true',
        groupId:      'general',
        order:        1,
        defaultValue: '',
        currentValue: this._config.fytaEMail || '',
      },
      fytaPassword: {
        friendlyName: t(lang, 'settings.password.label'),
        description:  t(lang, 'settings.password.description'),
        dataType:     'PASSWORD',
        required:     'true',
        groupId:      'general',
        order:        2,
        defaultValue: '',
        currentValue: this._config.fytaPassword || '',
      },
      fytaAPIconnected: {
        friendlyName: t(lang, 'settings.connected.label'),
        description:  t(lang, 'settings.connected.description'),
        dataType:     'READONLY',
        groupId:      'general',
        order:        3,
        defaultValue: t(lang, 'settings.connected.no'),
        currentValue: apiConnected,
      },
      fytaAPIsyncInterval: {
        friendlyName: t(lang, 'settings.interval.label'),
        description:  t(lang, 'settings.interval.description'),
        dataType:     'ENUM',
        groupId:      'general',
        order:        4,
        values:       [5, 10, 15, 30, 60, 180, 360],
        defaultValue: 15,
        currentValue: syncInterval,
      },
      fytaAutoImport: {
        friendlyName: t(lang, 'settings.autoimport.label'),
        description:  t(lang, 'settings.autoimport.description'),
        dataType:     'BOOLEAN',
        groupId:      'general',
        order:        5,
        defaultValue: true,
        currentValue: autoImport,
      },
      reincludeDevices: {
        friendlyName: t(lang, 'settings.reinclude.label'),
        description:  t(lang, 'settings.reinclude.description'),
        dataType:     'BOOLEAN',
        groupId:      'general',
        order:        6,
        defaultValue: true,
        currentValue: reincludeDevices,
      },
      copyrightInfo: {
        friendlyName: t(lang, 'settings.copyrightinfo.label'),
        description:  t(lang, 'settings.copyrightinfo.description'),
        dataType:     'WEBLINK',
        groupId:      'info',
        order:        1,
        defaultValue: t(lang, 'settings.copyrightinfo.linktitle'),
        currentValue: "https://fyta.de/",
      },
      pluginInfo: {
        friendlyName: t(lang, 'settings.pluginInfo.label'),
        description:  t(lang, 'settings.pluginInfo.description'),
        dataType:     'WEBLINK',
        groupId:      'info',
        order:        2,
        defaultValue: t(lang, 'settings.pluginInfo.linktitle'),
        currentValue: "https://github.com/Spider-S001/smartmatix-fyta-connector",
      },
    };

    // Je Pflanze aus fyta.json eine Einstellungsgruppe mit Feldern erstellen
    fytaPlants.forEach((plant, index) => {
      const num       = index + 1;
      const orderBase = index * 4;
      const plantName = plant.nickname ?? plant.scientific_name ?? `Pflanze ${num}`;

      properties[`fyta_${num}_name`] = {
        friendlyName: t(lang, 'plant.name.label'),
        description:  t(lang, 'plant.name.description'),
        dataType:     'READONLY',
        groupId:      `fyta_${num}`,
        order:        orderBase + 1,
        currentValue: plant.scientific_name && plant.scientific_name !== plantName
          ? `${plantName} (${plant.scientific_name})`
          : plantName,
      };

      properties[`fyta_${num}_device_id`] = {
        friendlyName: t(lang, 'plant.deviceid.label'),
        description:  t(lang, 'plant.deviceid.description'),
        dataType:     'READONLY',
        groupId:      `fyta_${num}`,
        order:        orderBase + 3,
        currentValue: plant.deviceId ?? t(lang, 'plant.deviceid.none'),
      };

      properties[`fyta_${num}_climate_sensor`] = {
        friendlyName: t(lang, 'plant.sensor.label'),
        description:  t(lang, 'plant.sensor.description'),
        dataType:     'BOOLEAN',
        groupId:      `fyta_${num}`,
        order:        orderBase + 4,
        defaultValue: 'false',
        currentValue: plant.autoImportEnabled !== false ? 'true' : 'false',
      };
    });

    // --- Backup & Restore (eine Gruppe, Dropdown-Steuerung) ---
    const backupConfigGroups = this._backupManager.getConfigGroups();
    const backupHost = this._backupHost;
    const safeLang   = lang || 'de';

    const backupGroup   = backupConfigGroups[0];
    const restoreGroup  = backupConfigGroups[1];
    const backupActive  = backupGroup.fields.some(f => f.type !== 'BOOLEAN');
    const restoreActive = restoreGroup.fields.some(f => f.type !== 'BOOLEAN');

    if (backupActive || restoreActive) {
      // Ein Modus läuft: die aktiven Felder (Token, Link) dieser Gruppe anzeigen.
      const activeFields = backupActive ? backupGroup.fields : restoreGroup.fields;

      activeFields.forEach((field, i) => {
        if (field.type === 'LABEL') return;

        if (field.type === 'LINK') {
          const resolvedUrl = (field.url ?? '')
            .replace('{{hostname}}', backupHost)
            .replace('{{lang}}', safeLang);
          properties[`backup_restore_${field.id}`] = {
            friendlyName: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
            description:  field.label?.[safeLang] ?? '',
            dataType:     'WEBLINK',
            groupId:      'backup_restore',
            order:        i + 2,
            defaultValue: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
            currentValue: resolvedUrl,
          };
          return;
        }

        // STRING-Feld (z.B. Restore-Token, readOnly)
        const resolvedValue = field.readOnly
          ? (field.value ?? '').replace('{{hostname}}', backupHost).replace('{{lang}}', lang ?? 'en')
          : (field.value ?? '');
        properties[`backup_restore_${field.id}`] = {
          friendlyName: field.label?.[safeLang] ?? '',
          description:  '',
          dataType:     'STRING',
          groupId:      'backup_restore',
          order:        i + 2,
          defaultValue: resolvedValue,
          currentValue: resolvedValue,
          ...(field.readOnly ? { readOnly: true } : {}),
        };
      });
    } else {
      // Kein Modus aktiv: Dropdown zur Auswahl der Aktion.
      properties.backup_restore_action = {
        friendlyName: t(lang, 'settings.backup_restore.action.label'),
        description:  t(lang, 'settings.backup_restore.action.description'),
        dataType:     'ENUM',
        groupId:      'backup_restore',
        order:        1,
        defaultValue: t(lang, 'settings.backup_restore.action.disabled'),
        currentValue: t(lang, 'settings.backup_restore.action.disabled'),
        values: [
          t(lang, 'settings.backup_restore.action.disabled'),
          t(lang, 'settings.backup_restore.action.backup'),
          t(lang, 'settings.backup_restore.action.restore'),
        ],
      };
    }

    return properties;
  }

  /**
   * Übermittelt alle im Plugin gespeicherten Status-Zustände an die HCU.
   * Benötigt für _onOpen(), da Werte beim HCU-Neustart zurückgesetzt werden.
   */
  _sendAllStatusEvents() {
    const allDevices = devices.getAll();
    allDevices.forEach(device => {
      this._send({
        id:       uuidv4(),
        pluginId: this.pluginId,
        type:     'STATUS_EVENT',
        body: {
          deviceId: device.deviceId,
          features: device.features,
        },
      });
    });
    log.info(`${allDevices.length} Geraetezustand(e) an HCU uebertragen.`);
  }

  // ---------------------------------------------------------------------------
  //  FYTA-Synchronisation
  // ---------------------------------------------------------------------------

  /**
   * Startet die initiale und periodische FYTA-Pflanzensynchronisation.
   * Wird bei jedem _onOpen() aufgerufen.
   */
  _startFytaSync() {
    // Sofort beim Verbinden synchronisieren und Gerätewerte aktualisieren.
    // Nach erfolgreichem Sync wird die Einstellungsseite der HCU aktiv
    // aktualisiert (CONFIG_TEMPLATE_RESPONSE), damit Pflanzen sofort sichtbar
    // sind – ohne dass der Benutzer die Seite manuell neu laden muss.
    fyta.syncPlants()
      .then((success) => {
        if (success) {
          this._deleteApiUnavailableNotification();
          // _syncFytaDataToDevices liest fyta.json intern; _pushConfigTemplate
          // liest sie danach erneut – beide Disk-Reads sind hier unvermeidbar
          // da kein gemeinsamer Aufrufer das Array halten kann.
          this._syncFytaDataToDevices();
          this._pushConfigTemplate();
        } else {
          this._sendApiUnavailableNotification();
        }
      })
      .catch((err) => {
        log.error('FYTA syncPlants fehlgeschlagen:', err.message);
        this._sendApiUnavailableNotification();
      });

    // Alten Timer ggf. abbrechen und neuen starten
    this._stopFytaSync();
    // syncInterval aus config ist in Minuten gespeichert > in Millisekunden umrechnen
    const syncIntervalMin = Number(this._config.syncInterval) || 15;
    const syncIntervalMs  = syncIntervalMin * 60 * 1000;

    this._fytaSyncTimer = setInterval(() => {
      fyta.syncPlants()
        .then((success) => {
          if (success) {
            this._deleteApiUnavailableNotification();
            this._syncFytaDataToDevices();
          } else {
            this._sendApiUnavailableNotification();
          }
        })
        .catch((err) => {
          log.error('FYTA syncPlants (Intervall) fehlgeschlagen:', err.message);
          this._sendApiUnavailableNotification();
        });
    }, syncIntervalMs);

    log.info(`FYTA: Synchronisationsintervall gestartet (alle ${syncIntervalMin} Min.).`);
  }

  /**
   * Stoppt den FYTA-Synchronisations-Timer.
   */
  _stopFytaSync() {
    if (this._fytaSyncTimer) {
      clearInterval(this._fytaSyncTimer);
      this._fytaSyncTimer = null;
    }
  }

  /**
   * Liest die aktuelle Pflanzenliste aus /data/fyta.json.
   * Gibt ein leeres Array zurück wenn die Datei noch nicht existiert.
   *
   * @returns {Array} Pflanzenliste
   */
  _loadFytaPlants() {
    try {
      const raw    = fs.readFileSync(FYTA_PLANTS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
    catch {
      return [];
    }
  }

  /**
   * Aktualisiert einen einzelnen Pflanzeneintrag in /data/fyta.json.
   * Wird verwendet um deviceId nach Geräteerstellung zurückzuschreiben.
   *
   * @param {object} updatedPlant – Pflanzeneintrag mit aktualisierten Feldern
   */
  _updateFytaPlant(updatedPlant) {
    const plants = this._loadFytaPlants();
    const idx    = plants.findIndex((p) => p.id === updatedPlant.id);
    if (idx >= 0) {
      plants[idx] = updatedPlant;
    } else {
      plants.push(updatedPlant);
    }
    try {
      fs.writeFileSync(FYTA_PLANTS_FILE, JSON.stringify(plants, null, 2), 'utf8');
      log.info(`FYTA: Pflanze ${updatedPlant.id} in fyta.json aktualisiert (deviceId=${updatedPlant.deviceId}).`);
    }
    catch (err) {
      log.error('FYTA: Fehler beim Schreiben von fyta.json:', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  //  FYTA > HCU Datensynchronisation
  // ---------------------------------------------------------------------------

  /**
   * Erstellt einen Climate-Sensor für eine Pflanze und verknüpft Gerät ↔ Pflanze.
   * Wird sowohl aus _handleConfigUpdateRequest (manuell) als auch aus
   * _syncFytaDataToDevices (autoImport) aufgerufen.
   *
   * @param {object} plant – Pflanzeneintrag aus fyta.json
   * @param {number} num   – Laufende Nummer (für Logging)
   * @returns {boolean}    – true wenn ein neues Gerät erstellt wurde
   */
  _createClimateSensorForPlant(plant, num) {
    const plantName = plant.nickname
      ? (plant.scientific_name && plant.scientific_name !== plant.nickname
          ? `${plant.nickname} (${plant.scientific_name})`
          : plant.nickname)
      : (plant.scientific_name ?? `FYTA Pflanze ${num}`);
    const deviceList = devices.getAll();
    const newDevice  = devices.createDevice(plantName, 'CLIMATE_SENSOR', deviceList);

    // Verknüpfung Gerät > Pflanze
    newDevice.fytaID    = plant.id;
    newDevice.fytaPlant = plant.nickname ?? plant.scientific_name ?? '';

    devicesStore.update('devices', newDevice.deviceId, newDevice);
    log.info(`Climate-Sensor erstellt fuer Pflanze "${plantName}" (fytaID=${plant.id}): ${newDevice.deviceId}`);

    // Verknüpfung Pflanze > Gerät
    plant.deviceId = newDevice.deviceId;
    this._updateFytaPlant(plant);

    return true;
  }

  /**
   * Liest die aktuellen Messwerte aus fyta.json und überträgt sie als STATUS_EVENTs
   * an die HCU. Wird nach jedem syncPlants()-Aufruf aufgerufen.
   *
   * Mapping FYTA > HCU (Connect API Feature-Typen):
   *   moisture    > humidity          (% Bodenfeuchte > %rh, 0–100 Integer)
   *   temperature > actualTemperature (°C, Float)
   *   light       > illumination      (μmol/h > lux-ähnlich, Float)
   *   salinity    > co2               (mS/h > ppm-Feld, Float; semantisches Mapping)
   *   battery     > batteryState      (%, 0–100 > 0–1 Float; capacity 100 Wh)
   *
   * Neue Pflanzen ohne Gerät werden bei aktiviertem autoImport automatisch angelegt.
   */
  _syncFytaDataToDevices() {
    const fytaPlants = this._loadFytaPlants();
    this._config     = configStore.load();
    const autoImport = this._config.autoImport !== false; // Standard: true

    let devicesCreated = false;

    fytaPlants.forEach((plant, index) => {
      const num = index + 1;

      // autoImport: Gerät für neue Pflanzen automatisch anlegen,
      // aber nur wenn der Nutzer den Import für diese Pflanze nicht explizit
      // abgelehnt hat (autoImportEnabled = true in fyta.json)
      // autoImportEnabled === undefined gilt als true (Standardwert für ältere Einträge)
      if (autoImport && !plant.deviceId && plant.autoImportEnabled !== false) {
        devicesCreated = this._createClimateSensorForPlant(plant, num) || devicesCreated;
        // _createClimateSensorForPlant schreibt deviceId in fyta.json und in plant.deviceId.
        // Da das Objekt per Referenz übergeben wurde, ist plant.deviceId bereits gesetzt.
        // Kein erneutes _loadFytaPlants() nötig – spart einen Disk-Read pro Pflanze.
        devices.reload(); // deviceRegistry aktualisieren damit getById() funktioniert
      }

      if (!plant.deviceId) return; // kein Gerät vorhanden, überspringen

      const m = plant.measurements;
      if (!m) return;

      // Feature-Array aufbauen - nur Werte die tatsächlich vorhanden sind
      const features = [];

      // Bodenfeuchte → Humidity (0-100 Integer)
      const moistureCurrent = parseFloat(m.moisture?.current);
      if (!isNaN(moistureCurrent)) {
        features.push({
          type:     'humidity',
          humidity: Math.round(Math.min(100, Math.max(0, moistureCurrent))),
        });
      }

      // Temperatur > ActualTemperature (°C Float)
      const tempCurrent = parseFloat(m.temperature?.current);
      if (!isNaN(tempCurrent)) {
        features.push({
          type:               'actualTemperature',
          actualTemperature:  Math.min(60, Math.max(-50, tempCurrent)),
        });
      }

      // Licht > Illumination (lux-ähnlich Float ≥ 0)
      const lightCurrent = parseFloat(m.light?.current);
      if (!isNaN(lightCurrent)) {
        features.push({
          type:         'illumination',
          illumination: Math.max(0, lightCurrent),
        });
      }

      // Salinität > CO2Concentration (ppm-Feld; semantisches Mapping, ≥ 0)
      // Die FYTA-Einheit ist mS/h - wir multiplizieren mit 1000 um einen
      // sinnvollen ppm-Bereich zu erhalten (0-1400 mS/h > 0-1400 "ppm").
      const salinityCurrent = parseFloat(m.salinity?.current);
      if (!isNaN(salinityCurrent)) {
        features.push({
          type: 'co2',
          co2:  Math.max(0, salinityCurrent * 1000),
        });
      }

      // Batterie > BatteryState (0-1, capacity 100 Wh als Orientierungswert)
      const batteryPct = parseFloat(m.battery);
      if (!isNaN(batteryPct)) {
        features.push({
          type:            'batteryState',
          batteryLevel:    Math.min(1, Math.max(0, batteryPct / 100)),
          batteryCapacity: 100,
        });
      }

      if (features.length === 0) return;

      // Messwerte nur im In-Memory-Geräteobjekt aktualisieren – nicht in devices.json.
      //
      // Das In-Memory-Objekt wird direkt befüllt, damit STATUS_REQUEST-Antworten
      // der HCU stets die aktuellen Messwerte zurückgeben.
      const device = devices.getById(plant.deviceId);
      if (device) {
        for (const incoming of features) {
          const existing = device.features.find(f => f.type === incoming.type);
          if (existing) {
            Object.assign(existing, incoming);
          } else {
            device.features.push(incoming);
          }
        }
      }

      // STATUS_EVENT an die HCU senden
      this._send({
        id:       uuidv4(),
        pluginId: this.pluginId,
        type:     'STATUS_EVENT',
        body: {
          deviceId: plant.deviceId,
          features,
        },
      });

      log.info(`FYTA: STATUS_EVENT fuer Gerät ${plant.deviceId} (Pflanze ${plant.id}) gesendet.`);
    });

    if (devicesCreated) {
      devices.reload();
      this._sendDiscoverResponse();
    }
  }

  // ---------------------------------------------------------------------------
  //  Proaktive Einstellungsseiten-Aktualisierung
  // ---------------------------------------------------------------------------

  /**
   * Sendet eine unaufgeforderte CONFIG_TEMPLATE_RESPONSE an die HCU.
   *
   * Wird aufgerufen nachdem der erste FYTA-Sync oder ein Login abgeschlossen
   * ist, damit die Einstellungsseite Pflanzen anzeigt ohne dass der Benutzer
   * sie manuell neu laden muss.
   *
   * Schlägt lautlos fehl wenn die Verbindung nicht offen ist.
   */
  /**
   * @param {Array|null} [cachedPlants] – Optional bereits geladene Pflanzenliste,
   *   um einen erneuten Disk-Read zu vermeiden wenn der Aufrufer sie schon hat.
   */
  _pushConfigTemplate(cachedPlants = null) {
    if (!this._ws || this._ws.readyState !== 1 /* WebSocket.OPEN */) return;

    const fytaPlants = (cachedPlants ?? this._loadFytaPlants()).map(plant => {
      if (plant.deviceId && !devices.getById(plant.deviceId)) {
        plant.deviceId = null;
        this._updateFytaPlant(plant);
      }
      return plant;
    });

    log.info('FYTA: Sende proaktive CONFIG_TEMPLATE_RESPONSE mit aktualisierten Pflanzendaten.');
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'CONFIG_TEMPLATE_RESPONSE',
      body: {
        groups:     this._generateSettingsGroups(fytaPlants),
        properties: this._defineVariableFields(fytaPlants),
      },
    });
  }

  // ---------------------------------------------------------------------------
  //  HCU Benachrichtigungen
  // ---------------------------------------------------------------------------

  /**
   * Sendet eine Benachrichtigung in der Homematic IP-App wenn die FYTA API
   * nicht erreichbar ist. Nutzt eine statische ID → die Nachricht ersetzt sich
   * selbst, sodass sie nur einmal in der App erscheint.
   */
  _sendApiUnavailableNotification() {
    const lang = this._lang;
    log.warn('FYTA: API nicht erreichbar – sende App-Benachrichtigung.');
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'CREATE_USER_MESSAGE_REQUEST',
      body: {
        userMessageId:   API_UNAVAILABLE_MSG_ID,
        messageCategory: 'ERROR',
        behaviorType:    'DISMISSIBLE',
        title: {
          de: t('de', 'notification.api.unavailable.title'),
          en: t('en', 'notification.api.unavailable.title'),
        },
        message: {
          de: t('de', 'notification.api.unavailable.message'),
          en: t('en', 'notification.api.unavailable.message'),
        },
      },
    });
  }

  /**
   * Löscht die API-Erreichbarkeits-Benachrichtigung wenn die API wieder
   * erreichbar ist.
   */
  _deleteApiUnavailableNotification() {
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'DELETE_USER_MESSAGE_REQUEST',
      body: {
        userMessageId: API_UNAVAILABLE_MSG_ID,
      },
    });
  }

  // ---------------------------------------------------------------------------
  //  Reconnect mit Exponential Backoff
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    log.info(`Wiederverbindung in ${this._reconnectDelay / 1000}s ...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelay);

    this._reconnectDelay = Math.min(
      Math.round(this._reconnectDelay * RECONNECT_FACTOR),
      RECONNECT_MAX_MS,
    );
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = Plugin;