/**
 * Desconexiones por socket, contra el servidor de verdad (puertos libres):
 *
 *  (b) el cliente de un jugador se cae y vuelve;
 *  (c) el socket del observador se cae y vuelve a mitad de mapa (con su
 *      secreto, y sin él: el partido huérfano lo retoma), en la segunda mitad
 *      y en la prórroga;
 *  (d) el cliente del observador se reinicia entero (socket nuevo, traductor
 *      de GEP nuevo que empieza con la ronda a 0 y reenvía el roster en otro
 *      orden).
 *
 * En todos, lo que ve el overlay: cada equipo real en su lado, con su nombre,
 * su alineación y su bando.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import { arranca, type Servidor } from '../src/servidor.ts';
import { firmaToken } from '../src/token.ts';
import { silencia } from '../src/log.ts';
import type { Config } from '../src/config.ts';

const SECRETO = 'r'.repeat(48);
const CERO = ['a1', 'a2', 'a3', 'a4', 'a5'];
const UNO = ['b1', 'b2', 'b3', 'b4', 'b5'];

let servidor: Servidor;
const abiertos: Socket[] = [];

before(async () => {
  silencia(true);
  const config: Config = {
    inseguro: true,
    secretoToken: SECRETO,
    sinAutenticacion: false,
    exigirTokenOverlay: true,
    grabar: false,
    carpetaGrabaciones: '.',
    extraProrroga: 1,
    minutosInactividad: 30,
    puertos: { ingesta: 0, salida: 0, extras: 0 },
  };
  servidor = await arranca(config);
});

after(async () => {
  for (const s of abiertos) s.close();
  await servidor.cierra();
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
      const d = JSON.parse(msg as string);
      if (!cumple(d)) return;
      clearTimeout(reloj);
      s.off(evento, oyente);
      resolve(d);
    };
    s.on(evento, oyente);
  });
}

const desconectado = (s: Socket) => new Promise<void>((r) => (s.connected ? s.once('disconnect', () => r()) : r()));
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un observador: logon y una forma corta de mandar `obs_data`. */
async function observador(grupo: string, token: string, secreto = '') {
  const s = conecta(servidor.puertos.ingesta);
  const ack = espera(s, 'obs_logon_ack');
  s.emit(
    'obs_logon',
    JSON.stringify({
      type: 'authenticate',
      clientVersion: '0.3.3',
      obsName: 'Observador',
      key: token,
      groupCode: grupo,
      groupSecret: secreto,
      leftTeam: { name: '', tricode: '', url: '', attackStart: true },
      rightTeam: { name: '', tricode: '', url: '', attackStart: false },
      toolsData: { timeoutCounter: { max: 2, left: 2, right: 2 }, timeoutDuration: 60 },
    }),
  );
  const a = await ack;
  const manda = (type: string, data: unknown) => s.emit('obs_data', JSON.stringify({ obsName: 'o', groupCode: grupo, type, data }));
  return { socket: s, ack: a, manda };
}

type Manda = (type: string, data: unknown) => void;

function rosters(manda: Manda, orden: 'normal' | 'al-reves' = 'normal') {
  const todos = [...CERO.map((id) => [id, 0] as const), ...UNO.map((id) => [id, 1] as const)];
  if (orden === 'al-reves') todos.reverse();
  todos.forEach(([id, team], i) =>
    manda('roster', { name: id.toUpperCase(), tagline: 'TAG', startTeam: team, agentInternal: 'Wushu', playerId: id, position: i, locked: true, rank: 9 }),
  );
}

function ronda(manda: Manda, n: number, marcador: [number, number]) {
  manda('round_info', { roundNumber: n, roundPhase: 'shopping' });
  manda('round_info', { roundNumber: n, roundPhase: 'combat' });
  manda('round_info', { roundNumber: n, roundPhase: 'end' });
  manda('score', { team_0: marcador[0], team_1: marcador[1] });
}

const atacaCero = (r: number) => (r < 13 ? true : r < 25 ? false : (r - 25) % 2 === 0);
const ids = (t: any) => t.players.map((j: any) => j.riotId).sort();

/** Lo que ve el overlay: identidad, alineación y bando de cada lado. */
function compruebaOverlay(m: any, ronda: number, paso: string, izquierda: 0 | 1 = 0) {
  const [izq, der] = m.teams;
  assert.deepEqual([izq.teamName, der.teamName], ['ALFA', 'BETA'], `${paso}: nombres`);
  assert.deepEqual([izq.teamUrl, der.teamUrl], ['alfa.png', 'beta.png'], `${paso}: logos`);
  assert.equal(izq.ingameTeamId, izquierda, `${paso}: equipo de juego a la izquierda`);
  assert.deepEqual(ids(izq), izquierda === 0 ? CERO : UNO, `${paso}: alineación izquierda`);
  assert.deepEqual(ids(der), izquierda === 0 ? UNO : CERO, `${paso}: alineación derecha`);
  assert.equal(izq.isAttacking, (izq.ingameTeamId === 0) === atacaCero(ronda), `${paso}: bando (ronda ${ronda})`);
  assert.equal(der.isAttacking, !izq.isAttacking, `${paso}: bando derecho`);
}

/** Overlay y panel suscritos a un grupo, con los nombres ya puestos. */
async function preparaGrupo(grupo: string) {
  const token = firmaToken(grupo, 1, 'Pruebas', SECRETO);
  const overlay = conecta(servidor.puertos.salida);
  const ok = espera(overlay, 'logon_success');
  overlay.emit('logon', JSON.stringify({ groupCode: grupo, token }));
  await ok;
  const mando = conecta(servidor.puertos.salida, '/operador');
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
  await listo;
  const sinPartido = espera(mando, 'operador_error');
  mando.emit(
    'configura',
    JSON.stringify({ equipos: [{ name: 'ALFA', tricode: 'ALF', url: 'alfa.png' }, { name: 'BETA', tricode: 'BET', url: 'beta.png' }] }),
  );
  await sinPartido;
  return { token, overlay, mando };
}

/* ── (c) El socket del observador se cae y vuelve ───────────────────────── */

test('(c) el observador se cae y vuelve con su secreto en la segunda mitad y en la prórroga', async () => {
  const grupo = 'RECONC';
  const { token, overlay } = await preparaGrupo(grupo);
  let obs = await observador(grupo, token);
  const secreto = obs.ack.reason as string;
  rosters(obs.manda);
  obs.manda('match_start', 'M-C');
  for (let r = 1; r <= 14; r++) ronda(obs.manda, r, r <= 7 ? [r, 0] : [7, r - 7]);
  obs.manda('round_info', { roundNumber: 15, roundPhase: 'shopping' });
  compruebaOverlay(await espera(overlay, 'match_data', (m) => m.roundNumber === 15), 15, 'antes de caerse');

  // Se cae (corte de red) y vuelve: mismo grupo, con el secreto.
  obs.socket.disconnect();
  await pausa(100);
  obs = await observador(grupo, token, secreto);
  assert.equal(obs.ack.reason, 'reconnected');
  obs.manda('map', 'Ascent');
  obs.manda('match_start', 'M-C'); // lo que reenvía el cliente al autenticar
  obs.manda('round_info', { roundNumber: 15, roundPhase: 'combat' });
  const m = await espera(overlay, 'match_data', (x) => x.roundPhase === 'combat' && x.roundNumber === 15);
  compruebaOverlay(m, 15, 'tras volver en la segunda mitad');
  assert.deepEqual(m.teams.map((t: any) => t.roundsWon), [7, 7], 'el marcador no se pierde');

  for (let r = 15; r <= 24; r++) ronda(obs.manda, r, [7 + Math.ceil((r - 14) / 2), 7 + Math.floor((r - 14) / 2)]);
  obs.manda('round_info', { roundNumber: 25, roundPhase: 'shopping' });
  ronda(obs.manda, 25, [13, 12]);
  obs.manda('round_info', { roundNumber: 26, roundPhase: 'shopping' });
  await espera(overlay, 'match_data', (x) => x.roundNumber === 26);

  obs.socket.disconnect();
  await pausa(100);
  obs = await observador(grupo, token, secreto);
  assert.equal(obs.ack.reason, 'reconnected');
  obs.manda('round_info', { roundNumber: 26, roundPhase: 'combat' });
  compruebaOverlay(await espera(overlay, 'match_data', (x) => x.roundNumber === 26 && x.roundPhase === 'combat'), 26, 'tras volver en la prórroga');
  obs.socket.disconnect();
});

test('(c) el observador vuelve SIN secreto (partido huérfano retomado) después de que el operador intercambiara los lados', async () => {
  const grupo = 'RETOMA';
  const { token, overlay, mando } = await preparaGrupo(grupo);
  let obs = await observador(grupo, token);
  rosters(obs.manda);
  obs.manda('match_start', 'M-R');
  for (let r = 1; r <= 13; r++) ronda(obs.manda, r, r <= 7 ? [r, 0] : [7, r - 7]);
  await espera(overlay, 'match_data', (m) => m.teams.some((t: any) => t.roundsWon === 7) && m.teams[1].roundsWon === 6);

  // El operador pone a los «b» a la izquierda y corrige los nombres.
  mando.emit('orden', JSON.stringify({ tipo: 'intercambiaLados' }));
  mando.emit('orden', JSON.stringify({ tipo: 'intercambiaEquipos' }));
  const antes = await espera(overlay, 'match_data', (m) => m.teams[0].ingameTeamId === 1 && m.teams[0].teamName === 'ALFA');
  compruebaOverlay(antes, 14, 'tras las órdenes', 1);

  // Se cae y el que vuelve no trae secreto (otro PC, o el secreto se perdió).
  obs.socket.disconnect();
  await pausa(100);
  obs = await observador(grupo, token, '');
  assert.equal(obs.ack.value, true, 'el partido huérfano se retoma');
  obs.manda('round_info', { roundNumber: 14, roundPhase: 'shopping' });
  const m = await espera(overlay, 'match_data', (x) => x.roundNumber === 14 && x.roundPhase === 'shopping');
  compruebaOverlay(m, 14, 'tras retomar', 1);
  assert.deepEqual(m.teams.map((t: any) => t.roundsWon), [6, 7], 'el marcador sigue con cada equipo');
  assert.equal(m.matchId, 'M-R');
  obs.socket.disconnect();
});

/* ── (d) El cliente del observador se reinicia entero ───────────────────── */

test('(d) el cliente del observador se reinicia: socket nuevo con el secreto antes de que caiga el viejo, GEP desde cero', async () => {
  const grupo = 'REINICIO';
  const { token, overlay } = await preparaGrupo(grupo);
  const viejo = await observador(grupo, token);
  const secreto = viejo.ack.reason as string;
  rosters(viejo.manda);
  viejo.manda('match_start', 'M-D');
  for (let r = 1; r <= 15; r++) ronda(viejo.manda, r, r <= 8 ? [r, 0] : [8, r - 8]);
  await espera(overlay, 'match_data', (m) => m.teams[1].roundsWon === 7);

  // El proceso nuevo entra mientras el servidor aún cree vivo al viejo.
  const nuevo = await observador(grupo, token, secreto);
  assert.equal(nuevo.ack.reason, 'reconnected');
  viejo.socket.disconnect(); // el viejo cae tarde: no deja huérfano al partido
  await pausa(100);
  const intruso = await observador(grupo, token, '');
  assert.equal(intruso.ack.value, false, 'el partido sigue teniendo dueño');

  // GEP desde cero: la ronda llega a 0, el roster en otro orden, el marcador repetido.
  nuevo.manda('round_info', { roundNumber: 0, roundPhase: 'shopping' });
  rosters(nuevo.manda, 'al-reves');
  nuevo.manda('score', { team_0: 8, team_1: 7 });
  nuevo.manda('round_info', { roundNumber: 16, roundPhase: 'combat' });
  const m = await espera(overlay, 'match_data', (x) => x.roundPhase === 'combat' && x.roundNumber === 16);
  compruebaOverlay(m, 16, 'tras el reinicio');
  assert.deepEqual(m.teams.map((t: any) => t.roundsWon), [8, 7]);
  assert.equal(m.teams[0].roundRecord.filter((r: any) => r.type !== 'upcoming').length, 15, 'el historial sigue');
  nuevo.socket.disconnect();
});

/* ── (b) El cliente de un jugador se cae y vuelve ───────────────────────── */

test('(b) el player-exe se cae y vuelve; y no puede mover equipos por aux_data', async () => {
  const grupo = 'JUGADOR';
  const { token, overlay } = await preparaGrupo(grupo);
  const obs = await observador(grupo, token);
  rosters(obs.manda);
  obs.manda('match_start', 'M-B');
  ronda(obs.manda, 1, [1, 0]);
  obs.manda('round_info', { roundNumber: 2, roundPhase: 'shopping' });
  await espera(overlay, 'match_data', (m) => m.roundNumber === 2);

  const entra = async () => {
    const j = conecta(servidor.puertos.ingesta);
    const ack = espera(j, 'aux_logon_ack');
    j.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'B3', matchId: 'M-B', playerId: 'b3' }));
    assert.equal((await ack).value, true);
    return j;
  };
  const aux = (j: Socket, type: string, data: unknown) =>
    j.emit('aux_data', JSON.stringify({ playerId: 'b3', matchId: 'M-B', type, data }));

  let j = await entra();
  aux(j, 'aux_health', 55);
  await espera(overlay, 'match_data', (m) => m.teams[1].players.some((p: any) => p.riotId === 'b3' && p.health === 55));

  // Un cliente de jugador no puede mandar órdenes de observador por su canal.
  aux(j, 'swap_left_right', true);
  aux(j, 'roster', { name: 'B3', tagline: 'TAG', startTeam: 0, playerId: 'b3', position: 0 });
  aux(j, 'aux_health', 54);
  compruebaOverlay(await espera(overlay, 'match_data', (m) => m.teams.some((t: any) => t.players.some((p: any) => p.health === 54))), 2, 'tras aux_data ajeno');

  j.disconnect();
  await espera(overlay, 'match_data', (m) => m.teams[1].players.some((p: any) => p.riotId === 'b3' && !p.auxiliaryAvailable.health));
  j = await entra();
  aux(j, 'aux_health', 33);
  const m = await espera(overlay, 'match_data', (x) => x.teams[1].players.some((p: any) => p.riotId === 'b3' && p.health === 33));
  compruebaOverlay(m, 2, 'jugador de vuelta');
  j.disconnect();
  obs.socket.disconnect();
});
