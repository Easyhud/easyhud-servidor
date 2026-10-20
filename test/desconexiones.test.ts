/**
 * «Los equipos se cambian cuando uno se desconecta»: cada camino de
 * desconexión que se nos ocurre, con la misma comprobación al final de cada
 * paso. Cada equipo real tiene que seguir en SU lado de la pantalla, con SU
 * nombre/logo, SU alineación (sin duplicados ni huecos) y el bando
 * (ataque/defensa) que le toca en esa ronda.
 *
 * Los caminos por socket (observador que se cae, cliente que se reinicia) van
 * en `reconexion.test.ts`, contra el servidor de verdad.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco, partidoNuevo } from './ayudas.ts';
import { aplicaParcheGrupo, memoriaVacia } from '../src/partida/configuracion.ts';
import { aSalida } from '../src/partida/serializa.ts';
import { Central, type Difusion } from '../src/central.ts';
import type { Config } from '../src/config.ts';
import type { Equipo, Lado, MemoriaGrupo, Partido } from '../src/partida/tipos.ts';

/* ── El escenario ───────────────────────────────────────────────────────── */

/** Equipo de juego 0 (empieza atacando) y equipo de juego 1. */
const CERO = ['a1', 'a2', 'a3', 'a4', 'a5'];
const UNO = ['b1', 'b2', 'b3', 'b4', 'b5'];

function memoriaConNombres(extra: Record<string, unknown>[] = [{}, {}]): MemoriaGrupo {
  const m = memoriaVacia();
  aplicaParcheGrupo(m, {
    equipos: [
      { name: 'ALFA', tricode: 'ALF', url: 'alfa.png', ...extra[0] },
      { name: 'BETA', tricode: 'BET', url: 'beta.png', ...extra[1] },
    ],
  });
  return m;
}

function roster(b: Banco, id: string, equipo: 0 | 1 | '0' | '1', posicion = 0, extra: Record<string, unknown> = {}) {
  return b.manda('roster', {
    name: id.toUpperCase(),
    tagline: 'TAG',
    startTeam: equipo,
    agentInternal: 'Wushu',
    playerId: id,
    position: posicion,
    locked: true,
    rank: 12,
    ...extra,
  });
}

function marcador(b: Banco, id: string, equipo: 0 | 1, extra: Record<string, unknown> = {}) {
  return b.manda('scoreboard', {
    name: id.toUpperCase(),
    tagline: 'TAG',
    playerId: id,
    startTeam: equipo,
    agentInternal: 'Wushu',
    isAlive: true,
    money: 800,
    kills: 0,
    deaths: 0,
    assists: 0,
    currUltPoints: 0,
    maxUltPoints: 7,
    ...extra,
  });
}

function rostersCompletos(b: Banco): Banco {
  CERO.forEach((id, i) => roster(b, id, 0, i));
  UNO.forEach((id, i) => roster(b, id, 1, i + 5));
  return b;
}

function bancoConNombres(memoria = memoriaConNombres()): Banco {
  return rostersCompletos(new Banco(partidoNuevo({}, memoria)));
}

/** Ronda con marcadores de todos (como hace GEP en el observador). */
function rondaConMarcadores(b: Banco, n: number, resultado: [number, number]): Banco {
  b.fase(n, 'shopping');
  for (const id of CERO) marcador(b, id, 0);
  for (const id of UNO) marcador(b, id, 1);
  b.t += 30_000;
  b.fase(n, 'combat');
  b.t += 40_000;
  b.fase(n, 'end');
  b.t += 300;
  b.manda('score', { team_0: resultado[0], team_1: resultado[1] });
  b.t += 7_000;
  return b;
}

/** ¿Ataca el equipo de juego 0 en la ronda `r` (BOMB: cambio en la 13, prórroga desde la 25)? */
const atacaCero = (r: number) => (r < 13 ? true : r < 25 ? false : (r - 25) % 2 === 0);

const ids = (e: Equipo) => e.players.map((j) => j.riotId).sort();

/**
 * La comprobación de siempre: el equipo de juego `izquierda` está a la
 * izquierda con el nombre ALFA y su alineación completa, el otro a la derecha
 * con BETA, y cada uno en el bando de la ronda `ronda`.
 */
function compruebaEquipos(p: Partido, ronda: number, paso: string, izquierda: Lado = 0): void {
  const [izq, der] = p.teams;
  assert.equal(izq.ingameTeamId, izquierda, `${paso}: equipo de juego de la izquierda`);
  assert.equal(der.ingameTeamId, 1 - izquierda, `${paso}: equipo de juego de la derecha`);
  assert.deepEqual([izq.teamName, izq.teamTricode, izq.teamUrl], ['ALFA', 'ALF', 'alfa.png'], `${paso}: identidad izquierda`);
  assert.deepEqual([der.teamName, der.teamTricode, der.teamUrl], ['BETA', 'BET', 'beta.png'], `${paso}: identidad derecha`);
  assert.deepEqual(ids(izq), izquierda === 0 ? CERO : UNO, `${paso}: alineación izquierda`);
  assert.deepEqual(ids(der), izquierda === 0 ? UNO : CERO, `${paso}: alineación derecha`);
  assert.equal(izq.playerCount, 5, `${paso}: playerCount izquierda`);
  assert.equal(der.playerCount, 5, `${paso}: playerCount derecha`);
  const ataca0 = atacaCero(ronda);
  assert.equal(izq.isAttacking, (izq.ingameTeamId === 0) === ataca0, `${paso}: bando izquierda (ronda ${ronda})`);
  assert.equal(der.isAttacking, !izq.isAttacking, `${paso}: bando derecha (ronda ${ronda})`);
  // Y lo mismo en lo que sale por el cable.
  const s = JSON.parse(JSON.stringify(aSalida(p)));
  assert.equal(s.teams[0].teamName, 'ALFA');
  assert.equal(s.teams[0].isAttacking, izq.isAttacking);
}

const jugador = (p: Partido, id: string) => p.teams.flatMap((t) => t.players).find((j) => j.riotId === id)!;

/* ── (a) Un jugador se va de la partida y vuelve ────────────────────────── */

test('(a) se va a mitad de ronda y vuelve: cada equipo sigue en su lado, con su nombre y su alineación', () => {
  const b = bancoConNombres();
  for (let r = 1; r <= 3; r++) rondaConMarcadores(b, r, [r, 0]);
  compruebaEquipos(b.estado, 4, 'tras 3 rondas');

  b.fase(4, 'shopping').fase(4, 'combat');
  marcador(b, 'a3', 0, { isAlive: false }); // se cae en pleno combate
  // GEP renumera las posiciones de los que quedan y deja vacío el hueco del que se fue.
  [...CERO.filter((x) => x !== 'a3'), ...UNO].forEach((id, i) => roster(b, id, CERO.includes(id) ? 0 : 1, i));
  b.manda('roster', { name: '', tagline: '', startTeam: 0, playerId: '', position: 9 });
  b.fase(4, 'end').manda('score', { team_0: 3, team_1: 1 });
  compruebaEquipos(b.estado, 4, 'con a3 fuera');

  b.fase(5, 'shopping');
  marcador(b, 'a3', 0, { isAlive: false });
  b.t += 3_500;
  marcador(b, 'a3', 0, { isAlive: false });
  assert.equal(jugador(b.estado, 'a3').disconnected, true);
  compruebaEquipos(b.estado, 5, 'compra con a3 desconectado');

  // Vuelve: GEP reenvía su roster y su marcador lo da vivo.
  roster(b, 'a3', 0, 2);
  marcador(b, 'a3', 0, { isAlive: true });
  assert.equal(jugador(b.estado, 'a3').disconnected, false);
  compruebaEquipos(b.estado, 5, 'a3 de vuelta');
  rondaConMarcadores(b, 5, [3, 2]);
  compruebaEquipos(b.estado, 6, 'ronda siguiente');
});

test('(a) se va en plena compra de la segunda mitad y vuelve en la siguiente', () => {
  const b = bancoConNombres();
  for (let r = 1; r <= 13; r++) rondaConMarcadores(b, r, r <= 7 ? [r, 0] : [7, r - 7]);
  b.fase(14, 'shopping');
  marcador(b, 'b4', 1, { isAlive: false });
  b.t += 3_500;
  marcador(b, 'b4', 1, { isAlive: false });
  assert.equal(jugador(b.estado, 'b4').disconnected, true);
  compruebaEquipos(b.estado, 14, 'compra de la 14 con b4 fuera');
  b.fase(14, 'combat').fase(14, 'end').manda('score', { team_0: 7, team_1: 7 });

  b.fase(15, 'shopping');
  assert.equal(jugador(b.estado, 'b4').isAlive, false, 'sigue fuera');
  roster(b, 'b4', 1, 8);
  marcador(b, 'b4', 1, { isAlive: true });
  compruebaEquipos(b.estado, 15, 'b4 de vuelta en la 15');
});

test('(a) se va y vuelve en la prórroga', () => {
  const b = bancoConNombres();
  for (let r = 1; r <= 24; r++) rondaConMarcadores(b, r, [Math.ceil(r / 2), Math.floor(r / 2)]);
  rondaConMarcadores(b, 25, [13, 12]);
  b.fase(26, 'shopping');
  compruebaEquipos(b.estado, 26, 'compra de la 26');
  marcador(b, 'a1', 0, { isAlive: false });
  b.fase(26, 'combat').fase(26, 'end').manda('score', { team_0: 13, team_1: 13 });
  b.fase(27, 'shopping');
  roster(b, 'a1', 0, 0);
  marcador(b, 'a1', 0, { isAlive: true });
  compruebaEquipos(b.estado, 27, 'a1 de vuelta en la 27');
});

/* ── (b) El cliente de un jugador (player-exe) se cae y vuelve ──────────── */

const config: Config = {
  inseguro: true,
  sinAutenticacion: true,
  exigirTokenOverlay: false,
  grabar: false,
  carpetaGrabaciones: '.',
  extraProrroga: 1,
  minutosInactividad: 30,
  puertos: { ingesta: 0, salida: 0, extras: 0 },
  camaras: { base: 'https://vdo.ninja', params: '' },
};

const centrales: Central[] = [];
after(() => {
  for (const c of centrales) c.cierra();
});

function centralDePrueba() {
  let t = 1_000_000;
  const difusion: Difusion = { estado: () => undefined, sala: () => undefined, expulsaGrupo: () => undefined, camaras: () => undefined, llama: () => undefined, pideInforme: () => false, ordenJugador: () => false };
  const central = new Central(config, () => t);
  central.conecta(difusion);
  centrales.push(central);
  return { central, avanza: (ms: number) => (t += ms) };
}

const logon = (grupo: string) => ({
  groupCode: grupo,
  leftTeam: { name: '', tricode: '', url: '', attackStart: true },
  rightTeam: { name: '', tricode: '', url: '', attackStart: false },
  toolsData: {},
});

const NOMBRES = { equipos: [{ name: 'ALFA', tricode: 'ALF', url: 'alfa.png' }, { name: 'BETA', tricode: 'BET', url: 'beta.png' }] };

test('(b) el socket auxiliar de un jugador se cae y vuelve: sus datos vuelven a su equipo', () => {
  const { central } = centralDePrueba();
  const G = 'AUXB';
  central.configura(G, NOMBRES);
  central.crea(logon(G), {}, 'obs');
  const paquete = (type: string, data: unknown, extra: Record<string, unknown> = {}) =>
    central.procesa(G, { type, data, timestamp: Date.now(), ...extra });
  CERO.forEach((id, i) => paquete('roster', { name: id, tagline: 'T', startTeam: 0, playerId: id, position: i, agentInternal: 'Wushu' }));
  UNO.forEach((id, i) => paquete('roster', { name: id, tagline: 'T', startTeam: 1, playerId: id, position: i + 5, agentInternal: 'Wushu' }));
  paquete('round_info', { roundNumber: 1, roundPhase: 'shopping' });

  paquete('aux_health', 77, { playerId: 'b2' });
  assert.equal(jugador(central.partido(G)!.estado, 'b2').auxiliaryAvailable.health, true);

  central.jugadorDesconectado(G, 'b2'); // se cae el socket
  const p1 = central.partido(G)!.estado;
  assert.deepEqual(jugador(p1, 'b2').auxiliaryAvailable, { health: false, abilities: false, scoreboard: false });
  assert.deepEqual([p1.teams[0].teamName, p1.teams[1].teamName], ['ALFA', 'BETA']);

  // Vuelve: el GEP del jugador manda su marcador (con su `team`) y la vida.
  central.jugadorConectado(G, 'b2');
  paquete('aux_scoreboard', { name: 'b2', tagline: 'T', playerId: 'b2', startTeam: 1, isAlive: true, money: 900, kills: 2 }, { playerId: 'b2' });
  paquete('aux_health', 64, { playerId: 'b2' });
  const p2 = central.partido(G)!.estado;
  assert.equal(jugador(p2, 'b2').health, 64);
  assert.equal(jugador(p2, 'b2').kills, 2);
  assert.deepEqual(ids(p2.teams[0]), CERO);
  assert.deepEqual(ids(p2.teams[1]), UNO);
  assert.deepEqual([p2.teams[0].teamName, p2.teams[1].teamName], ['ALFA', 'BETA']);
  central.cierra();
});

test('(b) aux_scoreboard con un `team` que no casa: actualiza a su jugador, sin moverlo ni duplicarlo', () => {
  const b = bancoConNombres();
  b.fase(1, 'shopping');
  // El GEP del propio jugador puede dar el equipo visto desde él.
  b.manda('aux_scoreboard', { name: 'B2', tagline: 'TAG', playerId: 'b2', startTeam: 0, isAlive: true, kills: 3 }, { playerId: 'b2' });
  assert.equal(jugador(b.estado, 'b2').kills, 3);
  compruebaEquipos(b.estado, 1, 'tras el aux_scoreboard');
});

/* ── (e) El roster llega en otro orden ──────────────────────────────────── */

test('(e) roster del equipo 1 primero, parcial y con el resto ya empezada la ronda', () => {
  const b = new Banco(partidoNuevo({}, memoriaConNombres()));
  UNO.forEach((id, i) => roster(b, id, 1, i));
  roster(b, 'a4', 0);
  roster(b, 'a1', '0');
  b.fase(1, 'shopping');
  for (const id of ['a2', 'a3', 'a5']) roster(b, id, 0);
  compruebaEquipos(b.estado, 1, 'roster desordenado');
  b.fase(1, 'combat');
  compruebaEquipos(b.estado, 1, 'combate');
});

test('(e) el roster de uno que se fue llega repetido (y con el `team` como texto): ni duplica ni cambia de equipo', () => {
  const b = bancoConNombres();
  rondaConMarcadores(b, 1, [1, 0]);
  for (let k = 0; k < 4; k++) roster(b, 'b5', k % 2 === 0 ? 1 : '1', 9 - k);
  roster(b, 'a2', 0, 7, { agentInternal: 'Sarge' });
  compruebaEquipos(b.estado, 2, 'rosters repetidos');
  assert.equal(jugador(b.estado, 'a2').agentInternal, 'Sarge');
});

test('(e) sin roster (observador retomado a mitad de mapa): el marcador del observador da de alta al jugador', () => {
  const b = new Banco(partidoNuevo({}, memoriaConNombres()));
  b.fase(16, 'shopping');
  b.manda('score', { team_0: 8, team_1: 7 });
  for (const id of UNO) marcador(b, id, 1, { money: 3000 });
  for (const id of CERO) marcador(b, id, 0, { money: 3000 });
  compruebaEquipos(b.estado, 16, 'alta por marcador');
  assert.equal(jugador(b.estado, 'a1').money, 3000);
  // Y si después llega el roster, no duplica.
  rostersCompletos(b);
  compruebaEquipos(b.estado, 16, 'roster tras alta por marcador');
});

/* ── (d) Partido viejo + partida nueva (remake tras una desconexión) ────── */

test('(d) remake tras una desconexión: partida nueva en el mismo partido (sin game_end) con los equipos de juego al revés', () => {
  const b = bancoConNombres();
  b.manda('match_start', 'PARTIDA-1');
  for (let r = 1; r <= 4; r++) rondaConMarcadores(b, r, [r, 0]);
  // Alguien se cae y rehacen la partida: el observador vuelve al menú (sin
  // game_end) y entra en la nueva. Ahora los «b» empiezan atacando.
  CERO.forEach((id, i) => roster(b, id, 1, i + 5));
  UNO.forEach((id, i) => roster(b, id, 0, i));
  b.manda('match_start', 'PARTIDA-2');
  const p = b.estado;
  assert.equal(p.matchId, 'PARTIDA-2');
  assert.deepEqual(ids(p.teams[0]), UNO, 'el equipo de juego 0 (ahora los b) a la izquierda');
  assert.deepEqual(ids(p.teams[1]), CERO);
  assert.deepEqual(p.teams.map((t) => t.roundsWon), [0, 0], 'el marcador de la partida vieja no se hereda');
  assert.ok(p.teams.every((t) => t.roundRecord.every((r) => r.type === 'upcoming')), 'ni el historial');
  assert.ok(p.teams.flatMap((t) => t.players).every((j) => j.kills === 0 && !j.disconnected), 'ni las estadísticas');
  rondaConMarcadores(b, 1, [0, 1]);
  assert.deepEqual(b.estado.teams.map((t) => t.roundsWon), [0, 1]);
  assert.deepEqual(b.estado.teams.map((t) => t.isAttacking), [true, false]);
});

test('(d) match_start con el mismo matchId (reconexión) o vacío no reinicia nada', () => {
  const b = bancoConNombres();
  b.manda('match_start', 'PARTIDA-1');
  for (let r = 1; r <= 3; r++) rondaConMarcadores(b, r, [r, 0]);
  b.manda('match_start', 'PARTIDA-1');
  b.manda('match_start', '');
  assert.equal(b.estado.matchId, 'PARTIDA-1', 'un match_start vacío no borra el matchId (los jugadores entran con él)');
  assert.equal(b.estado.teams[0].roundsWon, 3);
  compruebaEquipos(b.estado, 4, 'tras match_start repetido');
});

/* ── Las órdenes del operador sobreviven al partido nuevo ───────────────── */

test('«Switch teams» (swap_identity) se recuerda para el partido siguiente del grupo', () => {
  const { central } = centralDePrueba();
  const G = 'IDENT';
  central.configura(G, NOMBRES);
  central.crea(logon(G), {}, 'obs');
  central.procesa(G, { type: 'swap_identity', data: null, timestamp: Date.now() });
  assert.deepEqual(central.partido(G)!.estado.teams.map((t) => t.teamName), ['BETA', 'ALFA']);
  // Fin de mapa y mapa siguiente (o el observador recrea el partido).
  central.procesa(G, { type: 'round_info', data: { roundNumber: 1, roundPhase: 'game_end' }, timestamp: Date.now() });
  assert.equal(central.partido(G), undefined);
  central.crea(logon(G), {}, 'obs');
  assert.deepEqual(central.partido(G)!.estado.teams.map((t) => t.teamName), ['BETA', 'ALFA'], 'la identidad cambiada se mantiene');
  central.cierra();
});

/* ── Vínculo por puuid: el nombre va con los jugadores, no con el lado ──── */

test('vínculo por roster: si los registrados a la izquierda son el equipo de juego 1, se colocan a la izquierda con su nombre', () => {
  // El panel registró ALFA (a1…a5) a la izquierda, pero en la partida ALFA
  // empieza defendiendo: es el equipo de juego 1.
  const memoria = memoriaConNombres([{ puuids: UNO }, { puuids: CERO }]);
  const b = new Banco(partidoNuevo({}, memoria));
  UNO.forEach((id, i) => roster(b, id, 1, i));
  CERO.forEach((id, i) => roster(b, id, 0, i));
  // Aquí «ALFA» son los b (UNO), que son el equipo de juego 1.
  const p = b.estado;
  assert.equal(p.teams[0].ingameTeamId, 1);
  assert.equal(p.teams[0].teamName, 'ALFA');
  assert.deepEqual(ids(p.teams[0]), UNO);
  assert.equal(p.teams[1].teamName, 'BETA');
  assert.deepEqual(ids(p.teams[1]), CERO);
  rondaConMarcadores(b, 1, [1, 0]);
  assert.deepEqual(b.estado.teams.map((t) => t.isAttacking), [false, true], 'ALFA defiende la primera mitad');
  assert.deepEqual(b.estado.teams.map((t) => t.roundsWon), [0, 1], 'y la ronda la ganó BETA (equipo de juego 0)');
  b.manda('left_timeout');
  assert.equal(aSalida(b.estado).tools.timeoutCounter.left, 1, 'el tiempo muerto izquierdo es el de ALFA');
});

test('vínculo por roster: con el orden ya bueno no se toca nada, y basta con la mayoría', () => {
  const memoria = memoriaConNombres([{ puuids: ['a1', 'a2', 'a3', 'b9'] }, { puuids: ['b1', 'b2'] }]);
  const b = bancoConNombres(memoria);
  compruebaEquipos(b.estado, 1, 'orden ya bueno');
});

test('vínculo por roster: los puuids llegan con el partido ya empezado y se corrige una vez', () => {
  const b = bancoConNombres();
  for (let r = 1; r <= 2; r++) rondaConMarcadores(b, r, [r, 0]);
  b.evento({ type: '@configura', timestamp: b.t, parche: { equipos: [{ puuids: UNO }, { puuids: CERO }] } });
  const p = b.estado;
  assert.deepEqual(p.teams.map((t) => t.teamName), ['ALFA', 'BETA'], 'los nombres se quedan en su lado');
  assert.deepEqual(ids(p.teams[0]), UNO, 'y los jugadores registrados como ALFA pasan a la izquierda');
  assert.deepEqual(p.teams.map((t) => t.roundsWon), [0, 2], 'con su marcador');
  // El operador lo invierte a mano: el vínculo no se lo deshace.
  b.manda('swap_left_right');
  roster(b, 'a1', 0, 0);
  assert.deepEqual(ids(b.estado.teams[0]), CERO, 'el intercambio manual se respeta');
});

test('inactividad: con el observador conectado el partido NO caduca; sin observador, sí', () => {
  const { central, avanza } = centralDePrueba();
  central.crea(logon('CONOBS'), {}, 'obs');
  central.crea(logon('SINOBS'), {}, 'obs');
  central.partido('SINOBS')!.dueno = null; // su observador se cayó

  central.tic(); // el primer tic envía el estado inicial (y reinicia la cuenta)
  avanza(31 * 60_000); // más de los 30 minutos sin datos
  central.tic();

  assert.ok(central.partido('CONOBS'), 'el observador sigue conectado: el partido se queda (menú, lobby…)');
  assert.equal(central.partido('SINOBS'), undefined, 'abandonado: caduca');
});

test('estadoJugadores: app abierta, dentro del grupo, antigüedad del último dato y cámara', () => {
  const { central, avanza } = centralDePrueba();
  const G = 'ESTJ';
  central.crea(logon(G), {}, 'obs');
  central.late('p-app'); // sólo el programa abierto
  central.jugadorConectado(G, 'p-juega');
  central.datoDeJugador(G, 'p-juega', 'aux_health');
  central.camara(G, 'p-juega', 'Juega_H_TAG');
  avanza(7_000);

  const e = central.estadoJugadores(G, ['p-app', 'p-juega', 'p-nadie']);
  const base = (x: (typeof e)[string]) => ({ app: x.app, dentro: x.dentro, datosMs: x.datosMs, camara: x.camara });
  assert.deepEqual(base(e['p-app']), { app: true, dentro: false, datosMs: null, camara: false });
  assert.deepEqual(base(e['p-juega']), { app: true, dentro: true, datosMs: 7_000, camara: true });
  assert.deepEqual(base(e['p-nadie']), { app: false, dentro: false, datosMs: null, camara: false });
  assert.equal(e['p-nadie'].veredicto, 'sin-programa');
  assert.equal(e['p-app'].veredicto, 'sin-diagnostico', 'exe antiguo: abierto pero sin diagnóstico');
  assert.deepEqual(e['p-juega'].paquetes, { aux_health: { n: 1, haceMs: 7_000 } });
  central.cierra();
});

test('diagnóstico del exe: se guarda, se acota y da el veredicto; uno viejo caduca', () => {
  const { central, avanza } = centralDePrueba();
  const G = 'DIAG';
  central.crea(logon(G), {}, 'obs');
  central.late('p1');
  const bueno = {
    version: '0.3.5', gep: 'listo', gepVersion: '315.0.2', juegoAbierto: true, juegoDetectado: true, eventosHace: 2_000,
    datos: 'conectada', red: '', riot: 'ok', camara: { permitida: false, publicando: false, error: '' },
    enviados: { aux_health: 12, 'mal tipo!': 3 }, errores: ['uno', 'dos'],
  };
  assert.equal(central.diagnostico('p1', bueno), true);
  let e = central.estadoJugadores(G, ['p1']).p1;
  assert.equal(e.veredicto, 'ok');
  assert.deepEqual(e.diag?.enviados, { aux_health: 12 }, 'el tipo con caracteres raros se descarta');
  assert.equal(central.diagnostico('p1', { gep: 'inventado' }), false, 'una carga inválida no se guarda');

  central.diagnostico('p1', { ...bueno, juegoAbierto: true, juegoDetectado: false });
  assert.equal(central.estadoJugadores(G, ['p1']).p1.veredicto, 'juego-no-detectado');
  central.diagnostico('p1', { ...bueno, eventosHace: 700_000 });
  assert.equal(central.estadoJugadores(G, ['p1']).p1.veredicto, 'sin-eventos');
  central.diagnostico('p1', { ...bueno, conflictos: ['ValoSpectra.exe (pid 300)', 7, 'Overwolf.exe (pid 400)'] });
  assert.equal(central.estadoJugadores(G, ['p1']).p1.veredicto, 'conflicto', 'otro programa usa Overwolf a la vez');
  assert.deepEqual(central.estadoJugadores(G, ['p1']).p1.diag?.conflictos, ['ValoSpectra.exe (pid 300)', 'Overwolf.exe (pid 400)']);
  central.diagnostico('p1', { ...bueno, espectador: true });
  assert.equal(central.estadoJugadores(G, ['p1']).p1.veredicto, 'espectador', 'se cree espectador: no manda vida ni habilidades');
  central.diagnostico('p1', { ...bueno, claves: { health: 4, 'mal clave!': 2, scoreboard_n: 9 } });
  assert.deepEqual(central.estadoJugadores(G, ['p1']).p1.diag?.claves, { health: 4, scoreboard_n: 9 });
  central.diagnostico('p1', { ...bueno, gep: 'esperando' });
  assert.equal(central.estadoJugadores(G, ['p1']).p1.veredicto, 'gep-esperando');

  central.diagnostico('p1', bueno);
  central.late('p1');
  avanza(40_000); // más de tres latidos sin diagnóstico nuevo: el último ya no describe al exe de ahora
  central.late('p1');
  e = central.estadoJugadores(G, ['p1']).p1;
  assert.equal(e.veredicto, 'sin-diagnostico');
  assert.equal(e.diag, null);
  central.cierra();
});

test('marcadorDe: cuenta los marcadores que el observador recibió de cada jugador', () => {
  const { central, avanza } = centralDePrueba();
  const G = 'MARC';
  central.crea(logon(G), {}, 'obs');
  central.marcadorDe(G, 'a');
  avanza(4_000);
  central.marcadorDe(G, 'a');
  const e = central.estadoJugadores(G, ['a', 'b']);
  assert.deepEqual(e.a.marcador, { n: 2, haceMs: 0 });
  assert.equal(e.b.marcador, null);
  central.cierra();
});

test('jugador REGISTRADO en un equipo: se le llama solo al grupo cada vez que abre su programa, sin «Call players»', () => {
  const { central } = centralDePrueba();
  const G = 'AUTOLLAMA';
  central.configura(G, { equipos: [{ name: 'ALFA', tricode: 'ALF', url: '', puuids: ['reg-1', 'reg-2'] }, { name: 'BETA', tricode: 'BET', url: '', puuids: ['reg-3'] }] });
  assert.equal(central.grupoPendiente('reg-1'), undefined, 'sin partido vivo no hay a dónde llamarlo');

  central.crea(logon(G), {}, 'obs');
  assert.equal(central.grupoPendiente('reg-1'), G, 'registrado + partido vivo: se le manda al grupo');
  assert.equal(central.grupoPendiente('reg-3'), G, 'también el del otro equipo');
  assert.equal(central.grupoPendiente('desconocido'), undefined, 'quien no es de ningún equipo no se llama');

  central.jugadorConectado(G, 'reg-1'); // ya está dentro
  assert.equal(central.grupoPendiente('reg-1'), undefined);
  central.jugadorDesconectado(G, 'reg-1'); // se le cae la conexión: vuelve a llamársele
  assert.equal(central.grupoPendiente('reg-1'), G);
  central.cierra();
});

test('(b) partida NUEVA o reinicio del operador con el jugador aún conectado: no se queda «sin dato de vida» ni sin habilidades', () => {
  const { central } = centralDePrueba();
  const G = 'AUXPERSISTE';
  central.configura(G, NOMBRES);
  central.crea(logon(G), {}, 'obs');
  const paquete = (type: string, data: unknown, extra: Record<string, unknown> = {}) =>
    central.procesa(G, { type, data, timestamp: Date.now(), ...extra });
  const rosters = () => {
    CERO.forEach((id, i) => paquete('roster', { name: id, tagline: 'T', startTeam: 0, playerId: id, position: i, agentInternal: 'Wushu' }));
    UNO.forEach((id, i) => paquete('roster', { name: id, tagline: 'T', startTeam: 1, playerId: id, position: i + 5, agentInternal: 'Wushu' }));
  };
  rosters();
  paquete('round_info', { roundNumber: 1, roundPhase: 'shopping' });
  central.jugadorConectado(G, 'b2'); // su programa está conectado al grupo
  paquete('aux_health', 77, { playerId: 'b2' });
  paquete('aux_abilities', { grenade: 1, ability_1: 2, ability_2: 1, ultimate: 0 }, { playerId: 'b2' });
  assert.equal(jugador(central.partido(G)!.estado, 'b2').auxiliaryAvailable.health, true);

  // El operador crea otra partida (o llega un matchId nuevo): las fichas se recrean…
  central.procesa(G, { type: '@reinicia_partida', timestamp: Date.now() });
  rosters();
  // …y SIN que el programa del jugador mande nada (sólo reenvía lo que cambia), recupera la marca.
  const nuevo = jugador(central.partido(G)!.estado, 'b2');
  assert.equal(nuevo.auxiliaryAvailable.health, true, 'sigue contando como jugador con vida propia');
  assert.equal(nuevo.auxiliaryAvailable.abilities, true, 'y con habilidades propias');
  assert.equal(jugador(central.partido(G)!.estado, 'b3').auxiliaryAvailable.health, false, 'quien no está conectado, no');

  // Si el jugador se desconecta de verdad, la marca se va y NO vuelve sola.
  central.jugadorDesconectado(G, 'b2');
  paquete('round_info', { roundNumber: 2, roundPhase: 'shopping' });
  assert.equal(jugador(central.partido(G)!.estado, 'b2').auxiliaryAvailable.health, false);
  central.cierra();
});

test('el jugador que estuvo en el grupo en la partida anterior se llama SOLO en la siguiente (sin volver a pulsar «Call players»)', () => {
  const { central, avanza } = centralDePrueba();
  const G = 'CONOCIDOS';
  central.crea(logon(G), {}, 'obs');
  central.jugadorConectado(G, 'jenzu');
  assert.equal(central.grupoPendiente('jenzu'), undefined, 'ya está dentro: no se le llama');
  // Acaba la partida y el operador crea otra: el jugador aún no ha entrado a la nueva.
  central.jugadorDesconectado(G, 'jenzu');
  assert.equal(central.grupoPendiente('jenzu'), G, 'conocido y sin estar dentro → se le llama');
  avanza(7 * 60 * 60 * 1000);
  assert.equal(central.grupoPendiente('jenzu'), undefined, 'pasadas muchas horas ya no');
  central.cierra();
});

test('match_start desde el lobby pasa ya a la compra, y la lista de compañeros no mata a nadie en la compra (auditoría vs ValoSpectra)', () => {
  const b = rostersCompletos(new Banco(partidoNuevo({}, memoriaConNombres())));
  assert.equal(b.estado.roundPhase, 'LOBBY');
  b.manda('match_start', 'partida-nueva');
  assert.equal(b.estado.roundPhase, 'shopping', 'tras match_start ya es la compra de la ronda 1 (aunque el round_info se pierda)');
  assert.equal(b.estado.isRunning, true);

  // Un compañero manda la lista del equipo con «isAlive: false» (llega así en la compra de la ronda 1).
  const lista = JSON.stringify(CERO.filter((x) => x !== 'a1').map((id) => ({ playerId: id, agentInternal: 'Wushu', isAlive: false, money: 800, initialArmor: 0, scoreboardWeaponInternal: 'Pistol_Classic', currUltPoints: 0, maxUltPoints: 8, hasSpike: false, kills: 0, deaths: 0, assists: 0 })));
  b.manda('aux_scoreboard_team', lista, { playerId: 'a1' });
  const a2 = jugador(b.estado, 'a2');
  assert.equal(a2.money, 800, 'el dinero de la lista sí se toma');
  assert.equal(a2.isAlive, true, 'pero no se le da por muerto en la compra');
  assert.equal(a2.disconnected, false, 'ni por desconectado');
});
