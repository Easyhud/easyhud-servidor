# Servidor de partidas de Easy HUD.
# TypeScript ejecutado directamente por Node (sin paso de compilación).
FROM node:22-alpine

# openssl sólo para generar un certificado autofirmado si se arranca en HTTPS sin claves.
RUN apk add --no-cache openssl

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY docker-entrypoint.sh ./

RUN mkdir -p /app/keys /app/replays && chown -R node:node /app/keys /app/replays

ENV NODE_ENV=production \
    INSECURE=false \
    SERVER_KEY=/app/keys/server.key \
    SERVER_CERT=/app/keys/server.crt \
    CARPETA_GRABACIONES=/app/replays

USER node
EXPOSE 5100 5101 5200
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
