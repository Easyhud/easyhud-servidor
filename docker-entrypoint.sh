#!/bin/sh
# Arranque del contenedor: en HTTPS sin clave o certificado, se genera uno
# autofirmado (el cliente no verifica el certificado, así que vale).
set -e

if [ "$INSECURE" != "true" ] && { [ ! -f "$SERVER_KEY" ] || [ ! -f "$SERVER_CERT" ]; }; then
  echo "Sin clave/certificado TLS: generando uno autofirmado (CN=easyhud, 10 años)."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$SERVER_KEY" -out "$SERVER_CERT" -subj "/CN=easyhud"
fi

exec node --experimental-strip-types --disable-warning=ExperimentalWarning src/index.ts
