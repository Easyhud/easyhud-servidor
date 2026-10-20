/**
 * Banco de pruebas de las cámaras, sin partida real.
 *
 * Hace de observador y de operador a la vez, contra un servidor local:
 *   1. entra como observador en un grupo de pruebas y carga una ronda grabada,
 *      en la que está observado `JugadorDos#EH2`;
 *   2. como operador, activa las cámaras y fija la sala;
 *   3. llama (por su puuid) al exe de jugador que tengas abierto.
 *
 * Tú arrancas el exe del jugador con `EASY_CAM_NOMBRE=JugadorDos#EH2`, pulsas el
 * botón de su cámara y abres el overlay con la URL que imprime: debe salir tu
 * cámara en el recuadro, con el nombre y el K/D/A de JugadorDos.
 *
 *   npm run prueba:camaras -- -puuid <puuid-del-exe-jugador> [-group PRUEBACAM]
 *                             [-sala SALAPRUEBA] [-ingesta http://localhost:5100]
 *                             [-salida http://localhost:5200]
 *
 * El puuid del exe: `%APPDATA%\EasyHUD-Jugador\storage\playerId.json`.
 * Sólo para desarrollo (el servidor debe ir con EASY_DEV_SIN_AUTH=true).
 */

import { readFileSync } from 'node:fs';
import { io, type Socket } from 'socket.io-client';
import { leeGrabacion } from '../grabacion.ts';

const args = process.argv.slice(2);
const valor = (nombre: string, defecto: string): string => {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[i + 1] : defecto;
};

const grupo = valor('-group', 'PRUEBACAM');
const sala = valor('-sala', 'SALAPRUEBA');
const puuid = valor('-puuid', '');
/** Token del grupo (con un servidor que lo exige): `npm run token -- --grupo <G>`. En desarrollo vale cualquiera. */
const token = valor('-token', 'prueba');
const ingesta = valor('-ingesta', 'http://localhost:5100');
const salida = valor('-salida', 'http://localhost:5200');
const FIXTURE = new URL('../../test/fixtures/Match_TORNEO2_1788925164030.replay', import.meta.url);

if (puuid === '') {
  console.error('Falta -puuid <puuid del exe de jugador> (mira %APPDATA%\\EasyHUD-Jugador\\storage\\playerId.json).');
  process.exit(1);
}

const { cabecera, paquetes } = leeGrabacion(readFileSync(FIXTURE, 'utf8'));
const unaVez = <T = Record<string, unknown>>(s: Socket, evento: string, ms = 8000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no llegó ${evento}`)), ms);
    s.once(evento, (m: unknown) => {
      clearTimeout(t);
      resolve((typeof m === 'string' ? JSON.parse(m) : m) as T);
    });
  });

/* 1. Observador */
const obs = io(ingesta, { transports: ['websocket'], reconnection: false });
await unaVez(obs, 'connect');
const ackObs = unaVez<{ value: boolean; reason: string }>(obs, 'obs_logon_ack');
obs.emit('obs_logon', JSON.stringify({ ...cabecera, type: 'authenticate', groupCode: grupo, key: token, obsName: 'Banco de pruebas', groupSecret: '' }));
const a = await ackObs;
if (a.value !== true) {
  console.error(`El servidor rechazó al observador: ${a.reason}`);
  process.exit(1);
}
for (const p of paquetes) {
  obs.emit('obs_data', JSON.stringify({ obsName: 'Banco de pruebas', groupCode: grupo, type: p.type, data: p.data }));
}

// La grabación acaba en la fase de compra y la cámara sólo sale en combate: se pasa a combate.
obs.emit(
  'obs_data',
  JSON.stringify({ obsName: 'Banco de pruebas', groupCode: grupo, type: 'round_info', data: { roundNumber: 5, roundPhase: 'combat' } }),
);

/* 2. Operador: cámaras activadas y sala */
const mando = io(`${salida}/operador`, { transports: ['websocket'], reconnection: false });
await unaVez(mando, 'connect');
const listo = unaVez(mando, 'operador_listo');
mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
await listo;
mando.emit('configura', JSON.stringify({ playercamsInfo: { enable: true, identifier: sala } }));

/* 3. Llamar al exe del jugador (el servidor sigue llamando hasta que entre) */
const ack = unaVez<{ avisados: string[] }>(obs, 'llamar_jugadores_ack');
obs.emit('llamar_jugadores', JSON.stringify({ puuids: [puuid] }));
const { avisados } = await ack;

console.log(`
Banco de pruebas listo (grupo ${grupo}, sala de cámaras ${sala}).
  · Exe de jugador ${avisados.length > 0 ? 'AVISADO' : 'aún sin abrir: se le seguirá llamando solo'}.
  · En su ventana, pulsa el icono de la cámara (debe quedar en rojo "EN DIRECTO").
  · Overlay:  http://localhost:5310/combate/?endpoint=${salida}&groupCode=${grupo}${token === 'prueba' ? '' : '&token=<el token>'}

Ctrl+C para terminar.`);
setInterval(() => undefined, 60_000);
