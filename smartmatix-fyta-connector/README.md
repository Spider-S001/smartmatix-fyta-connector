# SmartMatix FYTA Connector

![Das Plugin-Icon von SmartMatix FYTA Connector](/Screenshots/fyta-connector-plugin-icon.png "Plugin-Icon")

Ein Plugin für die **Homematic IP Home Control Unit (HCU)** (@homematicip), das FYTA-Pflanzensensoren (@FYTA-GmbH) über die [FYTA Web API](https://web.fyta.de) in das Homematic IP System einbindet – vollständig lokal und ohne Cloud-Abhängigkeit auf HCU-Seite, über die [Connect API 1.0.1](https://github.com/homematicip/connect-api).

Hinweis: Wir empfehlen bei der Verwendung des Plugins den Einsatz des FYTA WLAN- oder Outdoor-Hub, da die Daten deiner Sonsoren sonst zwingend über dein Smartphone auf den Server übertragen werden müssen. Das setzt für die meisten Automatisierungen voraus, dass du in Bluetooth-Reichweite deiner Sensoren bist.

> Entwickelt von **Kevin Schipper** · Plugin-ID: `de.smartmatix.plugin.fyta-connector`

---

## Einsatzmöglichkeiten

Mit den Daten der **FYTA Pflanzensensoren** kannst du dein **Homematic IP Ökosystem** sinnvoll erweitern. So kannst du beispielsweise einen **FYTA Terra Outdoor-Pflanzensensor** kinderleicht mit dem **Homematic IP Bewässerungsaktor** verbinden und dein Hochbeet automatisiert gießen lassen, wenn die Erde zu trocken ist.
Oder lass doch einfach von deinem **FYTA Beam Pflanzensensor** die Helligkeit direkt an deiner Pflanze messen und schalte mit einer **Homematic IP Schaltsteckdose** einfach das Pflanzenlicht ein, wenn es zu dunkel für deine Pflanze wird.
So sind deine Pflanzen immer optimal versorgt und du sparst gleichzeitig auch noch Energie und Ressourcen.

![So siehst du deine Pflanzen in der Homematic IP App](/Screenshots/App-Ansicht-der-Fyta-Pflanzen.jpg "Darstellung der FYTA Pflanzen in der Homematic IP App")

---

## Features

- **FYTA-Pflanzen automatisch importieren** – neue Pflanzen aus der FYTA-App erscheinen nach der nächsten Synchronisation automatisch als Gerät in der HCU
- **Climate-Sensor je Pflanze** – jede Pflanze wird als `CLIMATE_SENSOR`-Gerät in der HCU angelegt und live aktualisiert
- **Messwert-Synchronisation** – Bodenfeuchte, Temperatur, Helligkeit, Salinität und Akkustand werden periodisch aus der FYTA-API gelesen und als STATUS_EVENT an die HCU übermittelt
- **Konfigurierbares Sync-Intervall** – 5, 10, 15, 30, 60, 180 oder 360 Minuten, direkt aus den Plugin-Einstellungen einstellbar
- **Automatische Token-Erneuerung** – der FYTA-API-Token wird vor Ablauf automatisch erneuert
- **Garten-Zuordnung** – Einstellungsgruppen zeigen den FYTA-Garten der jeweiligen Pflanze an
- **Persistenz** – alle Geräte, Konfiguration und Pflanzendaten werden in `/data` gespeichert und überleben Plugin-Updates und Neustarts
- **Automatische Wiederverbindung** – Exponential Backoff bei Verbindungsabbruch zur HCU

![Die Einrichtung der Verbindung zur FYTA-API](/Screenshots/Konfiguration-Fyta-Connector.jpg "Login bei der FYTA-API über die Plugin-Oberfläche")

![Die Einbindung der Pflanzen im Plugin](/Screenshots/Pflanzenuebersicht-Fyta-Connector.jpg "Die Einbindung der FYTA-Pflanzen über die Plugin-Oberfläche")

---

## Voraussetzungen

| Voraussetzung | Version |
|---|---|
| Node.js | ≥ 18 |
| HCU-Firmware | ≥ 1.5.16 |
| FYTA-Konto | vorhanden (web.fyta.de) |
| Entwicklermodus | aktiviert (HCUWeb) |

---

## Projektstruktur

```
smartmatix-fyta-connector/
├── Dockerfile                        ← Deployment auf der HCU (ARM64)
├── package.json
├── README.md
├── LICENSE
├── constants/
│   └── device_constants.js           ← Gerätetypen & Feature-Definitionen
├── data/
│   ├── config.json                   ← Plugin-Konfiguration (FYTA-Zugangsdaten, Intervall)
│   ├── devices.json                  ← HCU-Gerätedefinitionen
│   ├── fyta.json                     ← Pflanzenliste mit Messwerten (Cache)
│   └── fyta-gardens.json             ← Gartenliste (Cache)
├── lang/
│   ├── localization.json             ← Plugin-Übersetzungen
└── src/
    ├── index.js                      ← Einstiegspunkt
    ├── plugin.js                     ← WebSocket, Protokoll, Sync-Logik, Einstellungsmenü
    ├── fyta.js                       ← FYTA-API-Client (Login, Pflanzen, Messwerte)
    ├── devices.js                    ← Geräteverwaltung & Steuerlogik
    ├── devicesStore.js               ← Persistenz für Geräte & FYTA-Daten
    ├── configStore.js                ← Persistenz für Konfiguration
    ├── localization.js               ← Übersetzungen des Plugins ausgeben
    └── logger.js                     ← Konsolenlogger
```

---

## Messwert-Mapping

Die FYTA-Messwerte werden auf die Connect API Feature-Typen wie folgt abgebildet:

| FYTA-Messgröße | HCU-Feature | Typ | Einheit / Hinweis |
|---|---|---|---|
| `moisture` | `humidity` | Integer 0–100 | Bodenfeuchte in % → %rh |
| `temperature` | `actualTemperature` | Float −50…60 | °C |
| `light` | `illumination` | Float ≥ 0 | μmol/h direkt übernommen |
| `salinity` | `co2` | Float ≥ 0 | mS/h × 1000 → ppm-Feld (semantisches Mapping) |
| `battery` | `batteryState` | 0–1 Float | `battery% / 100`, `batteryCapacity: 100 Wh` |

> **Hinweis zur Salinität:** Das Connect API Schema bietet kein dediziertes Feld für Leitfähigkeit. Die Salinität wird daher auf das CO₂-Konzentrationsfeld gemappt und mit 1000 multipliziert, um einen sinnvollen Wertebereich zu erzeugen. In der HCU erscheint der Wert entsprechend als „CO₂-Konzentration".

---

## Plugin auf der HCU installieren

HCUWeb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

> Der Entwicklermodus muss aktiviert sein.

---

## Ersteinrichtung in der HCUWeb

Nach der Installation des Plugins:

1. Plugin-Einstellungen öffnen (`Plugins → FYTA Connector → Einstellungen`)
2. **E-Mail-Adresse** und **Passwort** des FYTA-App-Kontos eintragen
3. Speichern – das Plugin loggt sich automatisch bei der FYTA-API ein
4. Nach der ersten Synchronisation erscheinen alle Pflanzen mit aktivem Sensor als Einstellungsgruppen
5. Pro Pflanze kann über **„Sensor anlegen?"** ein Climate-Sensor-Gerät in der HCU erstellt werden – oder automatisch über die Einstellung **„Neue FYTA-Pflanzen automatisch importieren"**

---

## Einstellungen in der HCUWeb

### Allgemein

| Einstellung | Beschreibung | Standard |
|---|---|---|
| **FYTA-Konto E-Mail-Adresse** | Login-E-Mail für die FYTA Web API | – |
| **FYTA-Konto Passwort** | Login-Passwort für die FYTA Web API | – |
| **FYTA API verbunden?** | Zeigt an ob der Login erfolgreich war (schreibgeschützt) | Nicht verbunden |
| **Synchronisation** | Intervall für den automatischen Datenabgleich in Minuten | 15 |
| **Neue Pflanzen automatisch importieren** | Legt neue FYTA-Pflanzen beim nächsten Sync automatisch als Gerät an | Ja |
| **Gelöschte Geräte neu inkludieren** | Meldet beim nächsten Discover bereits entfernte Geräte erneut an die HCU | Nein |

### Je Pflanze

| Einstellung | Beschreibung |
|---|---|
| **Pflanzenname** | Name und wissenschaftlicher Name laut FYTA-App (schreibgeschützt) |
| **Verknüpfte HCU-Geräte-ID** | ID des zugehörigen HCU-Geräts, wird automatisch gesetzt (schreibgeschützt) |
| **Sensor anlegen?** | Erstellt ein Climate-Sensor-Gerät für diese Pflanze in der HCU; deaktivieren entfernt das Gerät |

---

## Lokale Entwicklung

### 1. Repository klonen & Abhängigkeiten installieren

```bash
git clone https://github.com/Spider-S001/smartmatix-fyta-connector.git
cd smartmatix-fyta-connector
npm install
```

### 2. Aktivierungsschlüssel & Auth-Token erzeugen

In der **HCUWeb** (`https://hcu-XXXX.local`) unter  
`Einstellungen → Entwicklermodus → Aktivierungsschlüssel generieren`

Anschließend über Postman oder curl den Auth-Token generieren (siehe HCU-Dokumentation) und in eine Datei speichern:

```bash
echo "DEIN-AUTHTOKEN" > authtoken.txt
```

### 3. Plugin starten

```bash
node src/index.js de.smartmatix.plugin.fyta-connector hcu1-XXXX.local authtoken.txt
```

Mit Debug-Logging:

```bash
LOG_LEVEL=debug node src/index.js de.smartmatix.plugin.fyta-connector hcu1-XXXX.local authtoken.txt
```

### Log-Level

| Wert | Beschreibung |
|---|---|
| `debug` | Alle Nachrichten inkl. Roh-JSON und API-Antworten |
| `info` | Standard (Default) |
| `warn` | Nur Warnungen und Fehler |
| `error` | Nur Fehler |

---

## Deployment auf der HCU

### 1. Docker-Image bauen

Das Plugin läuft auf der HCU in einem ARM64-Container. Zum Bauen auf einem x86-Rechner wird Docker Buildx benötigt:

```bash
docker buildx build --platform linux/arm64 -t smartmatix-fyta-connector:1.0.0 .
```

### 2. Image exportieren

```bash
docker save smartmatix-fyta-connector:1.0.0 | gzip > smartmatix-fyta-connector-1.0.0.tar.gz
```

### Unter Windows (anschließend mit 7zip zu .tar.gz konvertieren)

```bash
docker save smartmatix-fyta-connector:1.0.0 -o smartmatix-fyta-connector-1.0.0.tar
```

### 3. Plugin auf der HCU installieren

HCUWeb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

> Der Entwicklermodus muss aktiviert sein.

---

## Protokollablauf

```
Plugin                                    HCU
  │                                        │
  │── WebSocket (wss://<host>:9001) ──────►│
  │   Header: authtoken, plugin-id         │
  │                                        │
  │── PLUGIN_STATE_RESPONSE { READY } ────►│  (sofort beim Verbindungsaufbau)
  │── STATUS_EVENT (alle Geräte) ─────────►│  (gespeicherte Zustände wiederherstellen)
  │                                        │
  │   [FYTA API Login & Sync] ────────────►│  (FYTA-Daten holen, Geräte aktualisieren)
  │── STATUS_EVENT (je Pflanze) ───────────►│  (aktuelle Messwerte)
  │                                        │
  │◄── PLUGIN_STATE_REQUEST ───────────────│  (periodisch)
  │── PLUGIN_STATE_RESPONSE { READY } ────►│
  │                                        │
  │◄── DISCOVER_REQUEST ───────────────────│  (HCU sucht Geräte)
  │── DISCOVER_RESPONSE ──────────────────►│  (Climate-Sensor-Geräteliste)
  │                                        │
  │◄── CONFIG_TEMPLATE_REQUEST ────────────│  (HCU öffnet Einstellungen)
  │── CONFIG_TEMPLATE_RESPONSE ───────────►│  (Felder je Pflanze + allg. Einstellungen)
  │                                        │
  │◄── CONFIG_UPDATE_REQUEST ──────────────│  (Nutzer speichert Einstellungen)
  │── CONFIG_UPDATE_RESPONSE ─────────────►│
  │── DISCOVER_RESPONSE ──────────────────►│  (wenn neue Geräte erstellt wurden)
  │                                        │
  │   [alle N Minuten] ────────────────────│
  │── STATUS_EVENT (je Pflanze) ───────────►│  (aktualisierte Messwerte)
```

---

## Datenhaltung

Alle persistierten Daten liegen im Verzeichnis `/data` des Containers und überleben Plugin-Updates sowie Neustarts.

| Datei | Inhalt |
|---|---|
| `config.json` | FYTA-Zugangsdaten, Token, Sync-Intervall, autoImport, reincludeDevices |
| `devices.json` | HCU-Gerätedefinitionen (Climate-Sensoren) mit FYTA-Verknüpfung |
| `fyta.json` | Gepufferte Pflanzenliste mit Messwerten und `deviceId`-Verknüpfung |
| `fyta-gardens.json` | Gepufferte Gartenliste für die Anzeige in der HCUWeb |

> **Sicherheitshinweis:** Das FYTA-Passwort wird im Klartext in `config.json` gespeichert. Der Zugriff auf das `/data`-Verzeichnis sollte durch restriktive Dateisystem-Rechte abgesichert werden (`chmod 600 /data/config.json`).

---

## Filter: Welche Pflanzen werden synchronisiert?

Das Plugin importiert nur Pflanzen, die folgende Bedingungen erfüllen:

- Pflanzenstatus ist **nicht** `0` (nicht als gelöscht markiert) und **nicht** `3` (kein Sensor vorhanden laut Pflanzenstatus)
- Sensor-Status ist **nicht** `0` (Sensor ist aktiv und hat zuletzt Daten gesendet)

Pflanzen ohne aktiven Sensor werden zwar gefiltert, aber bei der nächsten Synchronisation erneut geprüft – sie erscheinen automatisch sobald ein Sensor wieder aktiv ist.

---

## Lizenz

Siehe [LICENSE](./LICENSE).  
Copyright © 2026 Kevin Schipper