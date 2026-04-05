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
ENTRYPOINT ["node", "src/index.js", "de.smartmatix.plugin.fyta-connector", "host.containers.internal", "/TOKEN"]

# ---------------------------------------------------------------------------
#  Plugin-Metadaten (PFLICHT für die HCU – exakt dieses Label-Format)
#
#  pluginId      muss identisch mit der ENTRYPOINT-Plugin-ID sein
#  hcuMinVersion mindestens 1.6.16 für Connect API 1.0.1
#  scope         LOCAL = nur im lokalen Netzwerk
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.fyta-connector",\
  "issuer": "Kevin Schipper",\
  "version": "1.0.0",\
  "hcuMinVersion": "1.6.16",\
  "scope": "LOCAL",\
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
