# Easy HUD — Servidor de partidas (v2)

Relé en tiempo real entre el cliente de escritorio de Easy HUD (observador y
jugadores), el overlay de OBS y el panel del operador. Mantiene el estado de
cada partido por código de grupo y lo difunde entero a quien esté mirando ese
grupo.

**Implementación original de Easy HUD.** Habla el protocolo que usan el
cliente de escritorio y el overlay de Easy HUD.

## Puertos

| Puerto | Qué | Quién |
|---|---|---|
| 5100 | socket.io — ingesta | observador (`obs_logon`), jugadores (`aux_logon`), latidos de presencia |
| 5200 | socket.io — salida | overlays y panel (`logon`), mando del operador (espacio `/operador`) |
| 5101 | HTTP | `GET /status` (sonda de salud) |

Los puertos son fijos: el cliente deriva el 5200 sustituyendo `:5100` en su URL.

## Requisitos

- Node 22.6 o superior (el TypeScript se ejecuta directamente con
  `--experimental-strip-types`; no hay paso de compilación).
- Una única dependencia de ejecución: `socket.io` (4.x, la que impone el protocolo).

## Arranque

```bash
npm ci
cp .env.example .env        # y rellenar OVERLAY_TOKEN_SECRET (el mismo que el servicio de cuentas)
npm start
```

Sin `OVERLAY_TOKEN_SECRET` (≥ 32 caracteres) el servidor **no arranca**. Para
desarrollo local sin cuentas: `EASY_DEV_SIN_AUTH=true` (abre todas las
puertas y lo avisa en el log; nunca en producción).

Con Docker:

```bash
docker compose up -d --build
```

## Autenticación

- **Observador** (`obs_logon`): el campo `key` debe ser un token de emisión
  firmado por el servicio de cuentas (`<base64url(JSON{g,exp,c})>.<HMAC>`),
  válido para el `groupCode` del logon (o para `*`) y sin caducar. Si caduca
  durante la emisión, se corta la ingesta en ese instante. Rechazos:
  `Invalid Key` / `Expired Key`.
- **Panel** (`/operador`): token obligatorio, estricto, ligado al grupo.
- **Overlay** (`logon` en 5200): token sólo si `REQUIRE_OVERLAY_TOKEN=true`.
- **Jugadores** (`aux_logon`) y **presencia**: sin token (como antes).

Todo lo que manda un socket autenticado va a SU grupo; el `groupCode` que
traigan los paquetes no se usa para enrutar.

## Herramientas

```bash
npm run token -- --secreto                                   # secreto nuevo
npm run token -- --grupo TORNEO1 --cliente "Estudio" --dias 30   # token de emergencia
npm run reproduce -- -game replays/Match_X_123.replay -server http://localhost:5100 -timestamps
```

Las grabaciones (`.replay`) se escriben en `CARPETA_GRABACIONES` (por defecto
`./replays`), una por partido.

## Desarrollo

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test: reductor, tiempos muertos, tokens, grabaciones e integración
```

## Estructura

```
src/
  index.ts              arranque: configuración, avisos, señales
  config.ts             entorno + .env; arranque cerrado sin secreto
  servidor.ts           los tres puertos y el cableado entre módulos
  central.ts            partidos vivos, memoria por grupo, sala, presencia, bucle de envío
  ingesta.ts            puerto 5100: logons, datos, sala, llamadas, desconexiones
  salida.ts             puerto 5200: logon de overlays, /operador (órdenes y parches)
  mensajes.ts           leer/emitir cargas JSON y responder-y-cortar
  token.ts              firma y validación de tokens de emisión
  version.ts            versión del servidor y rango de clientes compatibles
  grabacion.ts          escritura y lectura de .replay
  log.ts                registro
  partida/
    tipos.ts            tipos del estado, eventos y memoria de grupo
    creacion.ts         estado inicial, configuración por defecto, altas
    reductor.ts         (estado, evento) → estado: el corazón, puro
    jugadores.ts        roster, marcadores, killfeed, datos auxiliares, reinicio de ronda
    tiempos.ts          tiempos muertos y pausa técnica
    configuracion.ts    parches `configura` (partido y memoria de grupo)
    serializa.ts        estado → match_data
    tablas.ts           agentes, armas, mapas y escudos
  herramientas/
    token.ts            emisión de tokens por línea de comandos
    reproductor.ts      observador falso que reproduce un .replay
test/                   pruebas (node --test) y grabaciones de ejemplo
```

## Licencia

Propietario — © Easy HUD. Todos los derechos reservados. Ver `LICENSE`.
