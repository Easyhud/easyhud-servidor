/**
 * Rama `copia-funcional`: lo que el overlay necesita y el servidor no mandaba (cabezas de serie, alias, caja de
 * victoria, modo mínimo, quitar tricodes), el saneado de todo lo que entra por el panel, y la defensa contra el
 * estado viejo que el observador reenvía tras el menú.
 *
 * Los campos con nombre del original (`seedingInfo`, `nameOverrides`, `roundWinBox`, `removeTricodes`) siguen su forma.
 * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — model/ToolsData.ts, model/Player.ts
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco, partidoNuevo } from './ayudas.ts';
import { Central, type Difusion } from '../src/central.ts';
import type { Config } from '../src/config.ts';
import { aplicaParcheGrupo, memoriaVacia } from '../src/partida/configuracion.ts';
import { normalizaParche } from '../src/partida/saneado.ts';
import { aSalida } from '../src/partida/serializa.ts';
import { silencia } from '../src/log.ts';

silencia(true);

const salida = (b: Banco) => JSON.parse(JSON.stringify(aSalida(b.estado)));
const configura = (b: Banco, parche: Record<string, unknown>) => b.evento({ type: '@configura', timestamp: b.t, parche });
const jug = (b: Banco, id: string) => b.estado.teams.flatMap((t) => t.players).find((j) => j.riotId === id)!;

/* ── 1. Campos nuevos del estado ────────────────────────────────────────── */

test('estado inicial: los campos nuevos existen con su valor neutro', () => {
  const t = salida(new Banco()).tools;
  assert.deepEqual(t.seedingInfo, { left: '', right: '' });
  assert.deepEqual(t.nameOverrides, { overrides: '[]' });
  assert.deepEqual(t.roundWinBox, { type: 'disabled', sponsors: [] });
  assert.equal(t.minimal, false);
  assert.equal(t.playercamsInfo.removeTricodes, undefined, 'ausente = false');
});

test('seedingInfo y minimal: los pone el panel, parcial, y se limitan', () => {
  const b = new Banco();
  configura(b, { seedingInfo: { left: '#1 seed' }, minimal: true });
  let t = salida(b).tools;
  assert.deepEqual(t.seedingInfo, { left: '#1 seed', right: '' });
  assert.equal(t.minimal, true);
  configura(b, { seedingInfo: { right: 'x'.repeat(100) }, minimal: 'sí' });
  t = salida(b).tools;
  assert.equal(t.seedingInfo.right.length, 20, 'recortado al tope');
  assert.equal(t.seedingInfo.left, '#1 seed', 'lo que no vino no se toca');
  assert.equal(t.minimal, true, 'un tipo que no toca no cambia nada');
});

test('nameOverrides: pares, objeto o JSON; vacío quita el alias; se limitan tamaños y controles', () => {
  const b = new Banco();
  configura(b, { nameOverrides: { overrides: [['Uno#EUW', 'Apodo'], ['Dos#EUW', 'Otro']] } });
  assert.deepEqual(JSON.parse(salida(b).tools.nameOverrides.overrides), [['Uno#EUW', 'Apodo'], ['Dos#EUW', 'Otro']]);

  configura(b, { nameOverrides: { 'Tres#X': 'Tres' } });
  assert.deepEqual(JSON.parse(salida(b).tools.nameOverrides.overrides), [['Tres#X', 'Tres']], 'sustituye a la lista anterior');

  configura(b, { nameOverrides: { overrides: JSON.stringify([['A#1', 'a'], ['B#1', ''], ['C#1', 'c\u0000\n']]) } });
  assert.deepEqual(JSON.parse(salida(b).tools.nameOverrides.overrides), [['A#1', 'a'], ['C#1', 'c']], 'alias vacío fuera; sin controles');

  const muchos = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`J${i}#T`, `alias${i}`]));
  configura(b, { nameOverrides: muchos });
  assert.equal(JSON.parse(salida(b).tools.nameOverrides.overrides).length, 100, 'tope de 100 alias');

  configura(b, { nameOverrides: { overrides: [['K#1', 'x'.repeat(80)]] } });
  assert.equal(JSON.parse(salida(b).tools.nameOverrides.overrides)[0][1].length, 32);

  configura(b, { nameOverrides: 'esto no es json' });
  assert.equal(JSON.parse(salida(b).tools.nameOverrides.overrides)[0][0], 'K#1', 'texto ilegible: se ignora y se queda lo que había');
});

test('roundWinBox: tipo, patrocinadores por ceremonia y equipo; lo inválido se descarta', () => {
  const b = new Banco();
  configura(b, {
    roundWinBox: {
      type: 'sponsors',
      sponsors: [
        { wonTeam: 'left', roundCeremony: ['ace', 'clutch', 'inventada'], iconUrl: 'https://x/i.png', backdropUrl: 'https://x/f.png' },
        { wonTeam: 'nadie', roundCeremony: [], iconUrl: 'javascript:alert(1)', backdropUrl: 7 },
        'basura',
      ],
    },
  });
  const c = salida(b).tools.roundWinBox;
  assert.equal(c.type, 'sponsors');
  assert.equal(c.sponsors.length, 2, 'lo que no es objeto se va');
  assert.deepEqual(c.sponsors[0], { wonTeam: 'left', roundCeremony: ['ace', 'clutch'], iconUrl: 'https://x/i.png', backdropUrl: 'https://x/f.png' });
  assert.deepEqual(c.sponsors[1], { wonTeam: 'all', roundCeremony: ['all'], iconUrl: '', backdropUrl: '' }, 'valores por defecto sensatos');

  configura(b, { roundWinBox: { type: 'marciano' } });
  assert.equal(salida(b).tools.roundWinBox.type, 'sponsors', 'un tipo desconocido no cambia el actual');
  configura(b, { roundWinBox: { type: 'tournamentInfo' } });
  assert.equal(salida(b).tools.roundWinBox.type, 'tournamentInfo');
  assert.equal(salida(b).tools.roundWinBox.sponsors.length, 2, 'parcial: los patrocinadores siguen');

  const muchos = Array.from({ length: 25 }, () => ({ wonTeam: 'all', roundCeremony: ['all'], iconUrl: '', backdropUrl: '' }));
  configura(b, { roundWinBox: { sponsors: muchos } });
  assert.equal(salida(b).tools.roundWinBox.sponsors.length, 10);
});

test('removeTricodes: el nombre SALE sin el tricode del equipo; dentro se queda el real (casa con el killfeed)', () => {
  const b = new Banco();
  configura(b, { equipos: [{ name: 'Izq', tricode: 'ABC', url: '' }, { name: 'Der', tricode: 'XYZ', url: '' }] });
  b.alta('a', 0, 'ABC Nombre').alta('b', 0, 'ABCsolo').alta('c', 1, 'XYZ').alta('d', 1, 'Otro');
  // Sin activar, no cambia nada.
  assert.deepEqual(salida(b).teams[0].players.map((j: { name: string }) => j.name), ['ABC Nombre', 'ABCsolo']);
  configura(b, { playercamsInfo: { removeTricodes: true } });
  const s = salida(b);
  assert.deepEqual(s.teams[0].players.map((j: { name: string }) => j.name), ['Nombre', 'solo']);
  assert.deepEqual(s.teams[1].players.map((j: { name: string }) => j.name), ['XYZ', 'Otro'], 'si quedara vacío, se conserva el nombre');
  assert.equal(s.tools.playercamsInfo.removeTricodes, true);
  assert.equal(jug(b, 'a').name, 'ABC Nombre', 'el estado interno no se toca');
  b.manda('killfeed', { attacker: 'ABC Nombre', victim: 'Otro', weaponKillfeedInternal: 'x', headshotKill: false, assists: [], isTeamkill: false });
  assert.equal(jug(b, 'a').kills, 1, 'el killfeed sigue casando con el nombre real');
});

/* ── Saneado ────────────────────────────────────────────────────────────── */

test('normalizaParche: tipos, rangos y tamaños; lo que sobra se ignora y se avisa', () => {
  const { limpio, avisos } = normalizaParche({
    tournamentInfo: { name: 'N'.repeat(200), logoUrl: 'https://x/' + 'a'.repeat(5000), backdropUrl: 'javascript:alert(1)' },
    seriesInfo: { needed: 99, wonLeft: -3, wonRight: '2', mapInfo: [{ type: 'past', map: 'Bind' }, { type: 'raro' }, 'x', { type: 'present' }] },
    sponsorInfo: { enabled: 'yes', duration: 9999, sponsors: ['https://a', 3, 'https://a', 'https://b'] },
    watermarkInfo: { customText: 'W'.repeat(300), brandWatermark: true },
    timeoutDuration: 0,
    timeoutCounter: { max: 50 },
    playercamsInfo: { identifier: 'sala&otra=1', enable: true },
    equipos: [{ name: 'E'.repeat(100), tricode: 'TRICODELARGO', url: 7, puuids: ['p1', 'p1', '', 5, 'p2'] }, 'no', 'sobra'],
    desconocido: { algo: 1 },
  });
  assert.equal(limpio.tournamentInfo?.name?.length, 80);
  assert.equal(limpio.tournamentInfo?.logoUrl, undefined, 'dirección demasiado larga: fuera');
  assert.equal(limpio.tournamentInfo?.backdropUrl, undefined, 'javascript: fuera');
  assert.deepEqual([limpio.seriesInfo?.needed, limpio.seriesInfo?.wonLeft, limpio.seriesInfo?.wonRight], [20, 0, 2]);
  assert.deepEqual(limpio.seriesInfo?.mapInfo?.map((m) => m.type), ['past', 'present']);
  assert.equal(limpio.sponsorInfo?.enabled, undefined);
  assert.equal(limpio.sponsorInfo?.duration, 120);
  assert.deepEqual(limpio.sponsorInfo?.sponsors, ['https://a', 'https://b']);
  assert.equal(limpio.watermarkInfo?.customText?.length, 80);
  assert.equal('brandWatermark' in (limpio.watermarkInfo ?? {}), false);
  assert.equal(limpio.timeoutDuration, undefined);
  assert.equal(limpio.timeoutCounter?.max, 10);
  assert.equal(limpio.playercamsInfo?.identifier, undefined, 'la sala no puede llevar & = …');
  assert.equal(limpio.playercamsInfo?.enable, true);
  assert.equal(limpio.equipos?.[0]?.name?.length, 40);
  assert.equal(limpio.equipos?.[0]?.tricode?.length, 10);
  assert.equal(limpio.equipos?.[0]?.url, undefined);
  assert.deepEqual(limpio.equipos?.[0]?.puuids, ['p1', 'p2']);
  assert.equal(limpio.equipos?.[1], null);
  assert.equal('desconocido' in limpio, false);
  assert.ok(avisos.length >= 6 && avisos.length <= 20, `avisos: ${avisos.join(' | ')}`);
  // Idempotente: lo limpio, vuelto a limpiar, no cambia.
  assert.deepEqual(normalizaParche(limpio).limpio, limpio);
});

test('un parche con __proto__ no contamina nada ni cambia el prototipo de la configuración', () => {
  const b = new Banco();
  const malo = JSON.parse('{"tournamentInfo":{"__proto__":{"polluted":true},"name":"Copa"},"sponsorInfo":{"__proto__":{"x":1}}}');
  configura(b, malo);
  assert.equal(b.estado.tools.tournamentInfo.name, 'Copa');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(b.estado.tools.tournamentInfo), Object.prototype);
});

test('un parche enorme o con tipos cruzados no rompe nada y el resto se aplica', () => {
  const b = new Banco();
  configura(b, { tournamentInfo: 5, seriesInfo: 'x', sponsorInfo: [1], equipos: 'a', timeoutCounter: { max: 'tres' }, seedingInfo: { left: 'A' } });
  assert.equal(salida(b).tools.seedingInfo.left, 'A');
  assert.equal(salida(b).tools.timeoutCounter.max, 2);
});

test('el logon pasa por el mismo saneado (y trae los campos nuevos si los manda)', () => {
  const p = partidoNuevo({
    tournamentInfo: { name: 'Copa', logoUrl: 'javascript:x' },
    seedingInfo: { left: '1', right: '2' },
    roundWinBox: { type: 'tournamentInfo', sponsors: [] },
    nameOverrides: { overrides: JSON.stringify([['A#1', 'a']]) },
    timeoutDuration: -5,
    playercamsInfo: { enable: true, identifier: 'ok-1', removeTricodes: true },
  });
  assert.equal(p.tools.tournamentInfo.name, 'Copa');
  assert.equal(p.tools.tournamentInfo.logoUrl, '');
  assert.deepEqual(p.tools.seedingInfo, { left: '1', right: '2' });
  assert.equal(p.tools.roundWinBox.type, 'tournamentInfo');
  assert.equal(p.tools.nameOverrides.overrides, '[["A#1","a"]]');
  assert.equal(p.tools.timeoutDuration, 60, 'una duración negativa no vale: se queda la de siempre');
  assert.equal(p.tools.playercamsInfo.removeTricodes, true);
});

test('lo configurado en el panel (torneo, patrocinio, alias…) vale también para el mapa siguiente', () => {
  const memoria = memoriaVacia();
  aplicaParcheGrupo(memoria, {
    tournamentInfo: { name: 'Copa', logoUrl: 'https://x/l.png' },
    sponsorInfo: { enabled: true, sponsors: ['https://s/1.png'] },
    seedingInfo: { left: '1' },
    nameOverrides: [['A#1', 'a']],
    roundWinBox: { type: 'sponsors', sponsors: [] },
    minimal: true,
    playercamsInfo: { removeTricodes: true },
  });
  aplicaParcheGrupo(memoria, { seedingInfo: { right: '8' }, tournamentInfo: { name: 'Copa 2' } });
  // El logon del observador trae valores de fábrica: lo del panel manda.
  const p = partidoNuevo({ tournamentInfo: { name: '', logoUrl: '' }, sponsorInfo: { enabled: false, duration: 5, sponsors: [] } }, memoria);
  assert.equal(p.tools.tournamentInfo.name, 'Copa 2');
  assert.equal(p.tools.tournamentInfo.logoUrl, 'https://x/l.png');
  assert.deepEqual(p.tools.sponsorInfo.sponsors, ['https://s/1.png']);
  assert.equal(p.tools.sponsorInfo.enabled, true);
  assert.deepEqual(p.tools.seedingInfo, { left: '1', right: '8' });
  assert.equal(p.tools.nameOverrides.overrides, '[["A#1","a"]]');
  assert.equal(p.tools.roundWinBox.type, 'sponsors');
  assert.equal(p.tools.minimal, true);
  assert.equal(p.tools.playercamsInfo.removeTricodes, true);
});

/* ── Rótulo ─────────────────────────────────────────────────────────────── */

test('rótulo: título y mensaje acotados, equipo válido o ninguno, duración con tope', () => {
  const b = new Banco();
  b.manda('toast', { active: true, title: 'T'.repeat(500), message: 'M'.repeat(2000), duration: 1e12, selectedTeam: 'otro', eventLogoEnabled: false });
  const r = salida(b).toastInfo;
  assert.equal(r.title.length, 120);
  assert.equal(r.message.length, 500);
  assert.equal(r.duration, 3_600_000);
  assert.equal(r.selectedTeam, undefined);
  assert.equal(r.eventLogoEnabled, false, 'eventLogoEnabled viaja tal cual para que el overlay lo respete');
  b.manda('toast', { active: true, title: 'x', selectedTeam: 'right' });
  assert.equal(salida(b).toastInfo.selectedTeam, 'right');
});

/* ── 3a. Practice Range ─────────────────────────────────────────────────── */

test('el campo de tiro sale como «The Range»: casa con therange del panel y con valorant-api', () => {
  assert.equal(new Banco().manda('map', 'Range').estado.map, 'The Range');
  assert.equal(new Banco().manda('map', 'x'.repeat(200)).estado.map.length, 40, 'un mapa desconocido se recorta');
});

/* ── 3b. Estado viejo tras el menú ──────────────────────────────────────── */

const ID_VIEJA = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_NUEVA = 'bbbbbbbb-0000-4000-8000-000000000002';

test('un match_start de una partida que ya terminó no vale, y su mapa y modo tampoco', () => {
  // Partida vieja: Ascent, swift... y termina.
  const vieja = new Banco();
  vieja.manda('map', 'Ascent').manda('game_mode', 'swift').manda('match_start', ID_VIEJA).fase(1, 'shopping').fase(1, 'game_end');
  assert.equal(vieja.ultimo.finDeMapa, true);
  assert.deepEqual(vieja.estado.interno.idsTerminados, [ID_VIEJA]);

  // El partido siguiente del grupo conoce la partida terminada.
  const memoria = memoriaVacia();
  memoria.terminadas = [...vieja.estado.interno.idsTerminados];
  const b = new Banco(partidoNuevo({}, memoria));
  b.t = vieja.t + 60_000;
  // El observador vuelve del menú y reenvía lo viejo en una ráfaga.
  b.manda('map', 'Ascent').manda('game_mode', 'swift').manda('match_start', ID_VIEJA);
  assert.equal(b.estado.matchId, '', 'el id viejo no se acepta');
  assert.equal(b.estado.isRunning, false);
  assert.equal(b.estado.roundPhase, 'LOBBY');
  assert.equal(b.estado.map, 'Loading', 'el mapa de la ráfaga vieja se deshace');
  assert.equal(b.estado.matchType, 'bomb');
  assert.equal(b.estado.switchRound, 13);

  // Una partida de verdad nueva sí entra, con su mapa.
  b.t += 120_000;
  b.manda('map', 'Bind').manda('game_mode', 'bomb').manda('match_start', ID_NUEVA);
  assert.equal(b.estado.matchId, ID_NUEVA);
  assert.equal(b.estado.map, 'Bind');
  assert.equal(b.estado.isRunning, true);
});

test('un match_start viejo fuera de ráfaga se ignora sin tocar un mapa que ya era bueno', () => {
  const memoria = memoriaVacia();
  memoria.terminadas = [ID_VIEJA];
  const b = new Banco(partidoNuevo({}, memoria));
  b.manda('map', 'Bind'); // el de la partida nueva
  b.t += 60_000;
  b.manda('match_start', ID_VIEJA);
  assert.equal(b.estado.map, 'Bind');
  assert.equal(b.estado.matchId, '');
});

test('reinicio del operador: el match_start de la partida descartada no resucita el estado viejo', () => {
  const b = new Banco();
  b.manda('match_start', ID_VIEJA).fase(1, 'shopping');
  b.evento({ type: '@reinicia_partida', timestamp: b.t });
  assert.equal(b.estado.matchId, '');
  assert.equal(b.estado.roundPhase, 'LOBBY');
  b.t += 1000;
  b.manda('match_start', ID_VIEJA);
  assert.equal(b.estado.matchId, '', 'el id descartado no vuelve');
  assert.equal(b.estado.roundPhase, 'LOBBY');
  b.manda('match_start', ID_NUEVA);
  assert.equal(b.estado.matchId, ID_NUEVA);
});

test('partida nueva sobre un partido vivo: el id anterior queda descartado (no se va y viene)', () => {
  const b = new Banco();
  b.manda('match_start', ID_VIEJA).fase(1, 'shopping');
  b.t += 5000;
  b.manda('match_start', ID_NUEVA);
  assert.equal(b.estado.matchId, ID_NUEVA);
  b.t += 5000;
  b.manda('match_start', ID_VIEJA); // un reenvío rezagado de la anterior
  assert.equal(b.estado.matchId, ID_NUEVA, 'no vuelve a la anterior');
});

test('el mismo match_start de la partida en curso (reconexión) no toca nada', () => {
  const b = new Banco();
  b.manda('map', 'Bind').manda('match_start', ID_NUEVA).fase(1, 'shopping');
  b.alta('a', 0, 'A');
  b.manda('match_start', ID_NUEVA);
  assert.equal(b.estado.map, 'Bind');
  assert.equal(b.estado.teams[0].players.length, 1);
});

test('Central: lo que termina en un grupo se recuerda para el partido siguiente de ese grupo', () => {
  const { central } = centralDePrueba();
  const G = 'TERMINA';
  central.crea(logon(G), {}, 'obs');
  central.procesa(G, { type: 'match_start', data: ID_VIEJA, timestamp: 1 });
  central.procesa(G, { type: 'round_info', data: { roundNumber: 1, roundPhase: 'game_end' }, timestamp: 2 });
  assert.equal(central.partido(G), undefined, 'el mapa terminó: el partido se destruye');
  central.crea(logon(G), {}, 'obs');
  central.procesa(G, { type: 'match_start', data: ID_VIEJA, timestamp: 3 });
  assert.equal(central.partido(G)!.estado.matchId, '', 'el observador reenvía el id viejo: no vale');
  central.procesa(G, { type: 'match_start', data: ID_NUEVA, timestamp: 4 });
  assert.equal(central.partido(G)!.estado.matchId, ID_NUEVA);
  central.cierra();
});

/* ── Datos rotos que no pueden dejar el partido inconsistente ───────────── */

test('marcador de rondas fuera de rango: se ignora (antes un 1e9 colgaba el servidor al rellenar el historial)', () => {
  const b = new Banco();
  b.alta('a', 0, 'A').fase(1, 'shopping').fase(1, 'combat').fase(1, 'end');
  const inicio = Date.now();
  b.manda('score', { team_0: 1_000_000_000, team_1: 0 });
  assert.ok(Date.now() - inicio < 1000, 'sin bucles enormes');
  assert.equal(b.estado.teams[0].roundsWon, 0);
  assert.equal(b.estado.teams[0].roundRecord.length <= 100, true);
  b.manda('score', { team_0: -2, team_1: 1.5 });
  assert.deepEqual([b.estado.teams[0].roundsWon, b.estado.teams[1].roundsWon], [0, 0]);
  b.manda('score', { team_0: 1, team_1: 0 });
  assert.equal(b.estado.teams[0].roundsWon, 1, 'uno bueno sí se aplica');
});

test('fase y número de ronda inventados no cambian el estado', () => {
  const b = new Banco();
  b.fase(3, 'shopping');
  b.manda('round_info', { roundNumber: 5000, roundPhase: 'combat' });
  assert.equal(b.estado.roundNumber >= 0 && b.estado.roundNumber <= 99, true);
  b.manda('round_info', { roundNumber: 4, roundPhase: '<script>' });
  assert.equal(b.estado.roundPhase, 'combat', 'una fase con símbolos no vale');
  b.manda('round_info', { roundNumber: -1, roundPhase: 'end' });
  assert.notEqual(b.estado.roundNumber, -1);
});

test('modo de juego y id de partida con basura se ignoran', () => {
  const b = new Banco();
  b.manda('game_mode', { raro: true });
  assert.equal(b.estado.matchType, 'bomb');
  b.manda('game_mode', 'x'.repeat(100));
  assert.equal(b.estado.matchType, 'bomb');
  b.manda('match_start', 'z'.repeat(200));
  assert.equal(b.estado.matchId, '');
  assert.equal(b.estado.isRunning, false);
});

test('marcadores con números rotos: vida acotada a 0-100, contadores y dinero absurdos ignorados, nombres acotados', () => {
  const b = new Banco();
  b.alta('a', 0, 'A').fase(1, 'shopping');
  b.manda('aux_health', 150, { playerId: 'a' });
  assert.equal(jug(b, 'a').health, 100);
  b.manda('aux_health', -20, { playerId: 'a' });
  assert.equal(jug(b, 'a').health, 0);
  b.manda('scoreboard', { name: 'A', tagline: 'TAG', playerId: 'a', startTeam: 0, isAlive: true, money: 3000, kills: 2, deaths: 1, assists: 0 });
  b.manda('scoreboard', { name: 'A', tagline: 'TAG', playerId: 'a', startTeam: 0, isAlive: true, money: 1e12, kills: 5000, deaths: -4, assists: 1.5, currUltPoints: 1e9 });
  const j = jug(b, 'a');
  assert.deepEqual([j.money, j.kills, j.deaths, j.assists, j.currUltPoints], [3000, 2, 1, 0, 0], 'cada dato roto se queda como estaba');
  b.manda('roster', { name: 'N'.repeat(300), tagline: 'T', startTeam: 1, playerId: 'z', agentInternal: 'Wushu', position: 0 });
  assert.equal(b.estado.teams[1].players[0].name.length, 64);
  b.manda('roster', { name: 'Largo', tagline: 'T', startTeam: 1, playerId: 'q'.repeat(300), agentInternal: 'Wushu', position: 0 });
  assert.equal(b.estado.teams[1].players.length, 1, 'un id absurdo no da de alta a nadie');
});

test('killfeed: la lista de víctimas de la ronda tiene tope', () => {
  const b = new Banco();
  b.alta('a', 0, 'A').fase(1, 'combat');
  for (let i = 0; i < 40; i++) b.manda('killfeed', { attacker: 'A', victim: `V${i}`, weaponKillfeedInternal: 'x', headshotKill: false, assists: [], isTeamkill: false });
  assert.equal(jug(b, 'a').killedPlayerNames.length, 10);
});

/* ── Central: límites ───────────────────────────────────────────────────── */

const config: Config = {
  inseguro: true,
  secretoToken: 'c'.repeat(48),
  sinAutenticacion: false,
  exigirTokenOverlay: false,
  grabar: false,
  carpetaGrabaciones: './no-se-usa',
  extraProrroga: 1,
  minutosInactividad: 30,
  maxPartidos: 2,
  puertos: { ingesta: 0, salida: 0, extras: 0 },
  camaras: { base: 'https://vdo.ninja', params: '' },
};
const centrales: Central[] = [];
after(() => {
  for (const c of centrales) c.cierra();
});

function centralDePrueba() {
  let t = 1_000_000;
  const difusion: Difusion = {
    estado: () => undefined, sala: () => undefined, expulsaGrupo: () => undefined, camaras: () => undefined,
    llama: () => undefined, pideInforme: () => false, ordenJugador: () => false,
  };
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

test('Central.completo: con el tope de partidos, uno nuevo no cabe pero el que ya existe sí puede reconectar', () => {
  const { central } = centralDePrueba();
  assert.equal(central.completo('A'), false);
  central.crea(logon('A'), {}, 'obs');
  central.crea(logon('B'), {}, 'obs');
  assert.equal(central.completo('C'), true);
  assert.equal(central.completo('A'), false, 'un grupo que ya tiene partido no cuenta como nuevo');
  central.cierra();
});

test('Central.limpia: el diagnóstico y los conocidos de grupos viejos caducan (no crecen sin fin)', () => {
  const { central, avanza } = centralDePrueba();
  central.crea(logon('L'), {}, 'obs');
  central.jugadorConectado('L', 'p1');
  assert.equal(central.diagnostico('p1', { gep: 'listo', datos: 'conectada' }), true);
  central.destruye('L', 'prueba');
  const internos = central as unknown as { conocidos: Map<string, unknown>; diagnosticos: Map<string, unknown> };
  assert.equal(internos.conocidos.size, 1, 'antes de limpiar sí estaba');
  assert.equal(internos.diagnosticos.size, 1);
  avanza(7 * 3600_000);
  (central as unknown as { limpia(): void }).limpia();
  assert.equal(internos.conocidos.size, 0);
  assert.equal(internos.diagnosticos.size, 0);
  central.cierra();
});
