# Basis-Image der HCU (ARM64 – Pflicht für Deployment auf der HCU)
FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

# Abhängigkeiten installieren
COPY package*.json ./
RUN npm install --omit=dev

# Quellcode kopieren
COPY src/ ./src/
COPY constants/ ./constants/
COPY lang/ ./lang/

# Einstiegspunkt:
#   Argument 1: Plugin-ID
#   Argument 2: HCU-Host (host.containers.internal = HCU selbst)
#   Argument 3: Pfad zur Auth-Token-Datei (von der HCU bereitgestellt unter /TOKEN)
EXPOSE 8743

ENTRYPOINT ["node", "src/index.js", "de.smartmatix.plugin.fyta-connector", "host.containers.internal", "/TOKEN"]

# ---------------------------------------------------------------------------
#  Plugin-Metadaten (PFLICHT für die HCU – exakt dieses Label-Format)
#
#  pluginId      muss identisch mit der ENTRYPOINT-Plugin-ID sein
#  hcuMinVersion mindestens 1.7.9 (Connect API 1.0.1, CONFIG_REQUIRED-Status)
#  scope         CLOUD = Plugin benötigt Internetzugriff (FYTA-Web-API)
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.fyta-connector",\
  "issuer": "Kevin Schipper",\
  "version": "1.1.3",\
  "hcuMinVersion": "1.7.9",\
  "scope": "CLOUD",\
  "friendlyName": {\
    "en": "SmartMatix FYTA Connector",\
    "de": "SmartMatix FYTA Connector"\
  },\
  "description": {\
    "en": "A plugin for adding your FYTA Devices to the HCU.",\
    "de": "Ein Plugin, um deine FYTA Geräte zur HCU hinzuzufügen."\
  },\
  "image": "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",\
  "logsEnabled": false\
}'
