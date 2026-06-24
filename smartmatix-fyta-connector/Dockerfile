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
#  hcuMinVersion mindestens 1.6.16 für Connect API 1.0.1
#  scope         LOCAL = nur im lokalen Netzwerk
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.fyta-connector",\
  "issuer": "Kevin Schipper",\
  "version": "1.1.0",\
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
