/**
 * Auditoría de octubre de 2026, lo que se comprueba por socket de verdad:
 *  - S3: un jugador sólo escribe en SU ficha (el playerId sale del logon, no del paquete).
 *  - S9: la clave de las cámaras no viaja en `match_data` a overlays sin autenticar, aunque no se exija token.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { arranca, type Servidor } from '../src/servidor.ts';
import { firmaToken } from '../src/token.ts';
import { silencia } from '../src/log.ts';
import type { Config } from '../src/config.ts';

const SECRETO = 'r'.repeat(48);
const GRUPO = 'AUDIT1';
const P1 = '00000000-0000-4000-8000-0000000000a1'; // equipo de juego 0
const P2 = '00000000-0000-4000-8000-0000000000b2'; // equipo de juego 1
const TOKEN = () => firmaToken(GRUPO, 1, 'Pruebas', SECRETO);

let servidor: Servidor;
let carpeta: string;
const abiertos: Socket[] = [];

before(async () => {
  silencia(true);
  carpeta = mkdtempSync(join(tmpdir(), 'easyhud-audit-'));
  const config: Config = {
    inseguro: true,
    secretoToken: SECRETO,
    sinAutenticacion: false,
    exigirTokenOverlay: false, // el valor por defecto: cualquiera que conozca el grupo puede mirar
    grabar: false,
    carpetaGrabaciones: carpeta,
    extraProrroga: 1,
    minutosInactividad: 30,
    puertos: { ingesta: 0, salida: 0, extras: 0 },
    camaras: { base: 'https://vdo.ninja', params: '' },
  };
  servidor = await arranca(config);
});

after(async () => {
  for (const s of abiertos) s.close();
  await servidor.cierra();
  rmSync(carpeta, { recursive: true, force: true });
});

function conecta(puerto: number, ruta = ''): Socket {
  const s = io(`http://localhost:${puerto}${ruta}`, { transports: ['websocket'], reconnection: false, forceNew: true });
  abiertos.push(s);
  return s;
}

function espera<T = any>(s: Socket, evento: string, cumple: (d: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const reloj = setTimeout(() => {
      s.off(evento, oyente);
      reject(new Error(`no llegó ${evento} a tiempo`));
    }, ms);
    const oyente = (msg: unknown) => {
      const d = typeof msg === 'string' ? JSON.parse(msg) : msg;
      if (!cumple(d)) return;
      clearTimeout(reloj);
      s.off(evento, oyente);
      resolve(d);
    };
    s.on(evento, oyente);
  });
}

const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('S3 + S9 por la red: un jugador no toca a otro y la clave de cámaras no llega al overlay sin token', async () => {
  // Overlays: uno sin token (público) y otro con token válido del grupo.
  const publico = conecta(servidor.puertos.salida);
  const logonP = espera(publico, 'logon_success');
  publico.emit('logon', JSON.stringify({ groupCode: GRUPO, token: '' }));
  await logonP;
  const autenticado = conecta(servidor.puertos.salida);
  const logonA = espera(autenticado, 'logon_success');
  autenticado.emit('logon', JSON.stringify({ groupCode: GRUPO, token: TOKEN() }));
  await logonA;

  // Observador: crea el partido y da de alta a un jugador por equipo.
  const obs = conecta(servidor.puertos.ingesta);
  const ack = espera(obs, 'obs_logon_ack');
  obs.emit(
    'obs_logon',
    JSON.stringify({
      type: 'authenticate', clientVersion: '0.3.3', obsName: 'Obs', key: TOKEN(), groupCode: GRUPO, groupSecret: '',
      leftTeam: { name: '', tricode: '', url: '', attackStart: true },
      rightTeam: { name: '', tricode: '', url: '', attackStart: false },
      toolsData: { timeoutCounter: { max: 2, left: 2, right: 2 }, timeoutDuration: 60 },
    }),
  );
  assert.equal((await ack).value, true);
  const roster = (playerId: string, name: string, startTeam: number) =>
    obs.emit('obs_data', JSON.stringify({
      obsName: 'Obs', groupCode: GRUPO, type: 'roster',
      data: { name, tagline: 'TAG', startTeam, agentInternal: 'Wushu', playerId, position: 0, locked: true, rank: 1 },
    }));
  roster(P1, 'Uno', 0);
  roster(P2, 'Dos', 1);

  // S9: la sala de cámaras (con la clave) se configura; el público no ve la clave, el autenticado sí.
  const mando = conecta(servidor.puertos.salida, '/operador');
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: GRUPO, token: TOKEN() }));
  await listo;
  const vistoPublico = espera(publico, 'match_data', (m) => m.tools.playercamsInfo.identifier === 'SALA-A');
  const vistoAut = espera(autenticado, 'match_data', (m) => m.tools.playercamsInfo.identifier === 'SALA-A');
  mando.emit('configura', JSON.stringify({ playercamsInfo: { enable: true, identifier: 'SALA-A' } }));
  const mp = await vistoPublico;
  const ma = await vistoAut;
  assert.equal('clave' in mp.tools.playercamsInfo, false, 'el estado público no lleva la clave');
  assert.equal(mp.tools.playercamsInfo.enable, true);
  assert.equal(mp.tools.playercamsInfo.base, 'https://vdo.ninja');
  assert.deepEqual(mp.tools.playercamsInfo.enabledPlayers, []);
  assert.match(ma.tools.playercamsInfo.clave, /^[A-Za-z0-9_-]{16}$/, 'el overlay con token sí la recibe (pinta las cámaras)');

  // S3: el jugador 1 entra y manda datos con su identidad y con la de otro.
  const j1 = conecta(servidor.puertos.ingesta);
  const entra = espera(j1, 'aux_logon_ack');
  j1.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'Uno', matchId: '', groupCode: GRUPO, playerId: P1 }));
  assert.equal((await entra).value, true);

  const aux = (type: string, data: unknown, playerId: string) =>
    j1.emit('aux_data', JSON.stringify({ playerId, groupCode: GRUPO, matchId: '', type, data }));
  // Suplantación: vida y marcador de P2 mandados por P1 → se descartan.
  aux('aux_health', 11, P2);
  aux('aux_scoreboard', { playerId: P2, name: 'Dos', tagline: 'TAG', startTeam: 1, money: 9999, kills: 5, isAlive: true }, P1);
  aux('aux_scoreboard', { playerId: P2, name: 'Dos', tagline: 'TAG', startTeam: 1, money: 9999, kills: 5, isAlive: true }, P2);
  // Y los propios sí (el marcador propio, con y sin playerId dentro del dato).
  const conPropio = espera(autenticado, 'match_data', (m) => m.teams.flatMap((t: any) => t.players).find((j: any) => j.riotId === P1)?.health === 77);
  aux('aux_health', 77, P1);
  aux('aux_scoreboard', { name: 'Uno', tagline: 'TAG', startTeam: 0, money: 1234, isAlive: true }, P1);
  const m = await conPropio;
  await pausa(150);
  const estado = servidor.central.partido(GRUPO)!.estado;
  const dos = estado.teams.flatMap((t) => t.players).find((j) => j.riotId === P2)!;
  const uno = estado.teams.flatMap((t) => t.players).find((j) => j.riotId === P1)!;
  assert.equal(dos.health, 100, 'la vida de P2 no cambió');
  assert.equal(dos.money, 0, 'ni su dinero');
  assert.equal(dos.kills, 0, 'ni sus kills');
  assert.equal(dos.auxiliaryAvailable.health, false);
  assert.equal(dos.auxiliaryAvailable.scoreboard, false);
  assert.equal(uno.health, 77, 'lo suyo sí');
  assert.equal(uno.money, 1234, 'el marcador propio (sin playerId en el dato) se aplica a su ficha');
  assert.equal(m.tools.playercamsInfo.clave === undefined, false);

  // Un socket de jugador cuyo logon no trajo playerId no aprende uno de un paquete.
  const j2 = conecta(servidor.puertos.ingesta);
  const entra2 = espera(j2, 'aux_logon_ack');
  j2.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'SinId', matchId: '', groupCode: GRUPO }));
  assert.equal((await entra2).value, true);
  j2.emit('aux_data', JSON.stringify({ playerId: P2, groupCode: GRUPO, matchId: '', type: 'aux_scoreboard', data: { playerId: P2, name: 'Dos', tagline: 'TAG', startTeam: 1, money: 5555, isAlive: true } }));
  j2.emit('aux_data', JSON.stringify({ playerId: P2, groupCode: GRUPO, matchId: '', type: 'aux_health', data: 3 }));
  await pausa(150);
  const dos2 = servidor.central.partido(GRUPO)!.estado.teams.flatMap((t) => t.players).find((j) => j.riotId === P2)!;
  assert.equal(dos2.money, 0);
  assert.equal(dos2.health, 100);
});
