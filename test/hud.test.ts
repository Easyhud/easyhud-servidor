/**
 * Lo que el overlay pinta y el operador vio mal en directo: el bando de cada
 * equipo, el escudo, las cargas de habilidad y el jugador que abandona.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco } from './ayudas.ts';
import { aSalida } from '../src/partida/serializa.ts';

const ataca = (b: Banco) => b.estado.teams.map((t) => t.isAttacking);

/* ── Bandos ─────────────────────────────────────────────────────────────── */

test('bandos: el equipo de juego 0 ataca la primera mitad, defiende la segunda y alterna en prórroga', () => {
  const c = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  for (let r = 1; r <= 28; r++) {
    const ataca0 = r < 13 ? true : r < 25 ? false : (r - 25) % 2 === 0;
    c.fase(r, 'shopping').fase(r, 'combat');
    assert.deepEqual(ataca(c), [ataca0, !ataca0], `ronda ${r}`);
    c.fase(r, 'end').manda('score', { team_0: Math.ceil(r / 2), team_1: Math.floor(r / 2) });
  }
});

test('bandos: un round_number que llega DETRÁS de la fase no deja la segunda mitad al revés', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  for (let r = 1; r <= 12; r++) b.ronda(r, [r, 0]);
  // El cliente manda la fase con el último round_number que vio: todavía 12.
  b.fase(12, 'shopping');
  assert.deepEqual(ataca(b), [false, true], 'con 12 jugadas empieza la 13: cambio de lado');
  assert.equal(b.estado.roundNumber, 13, 'y se difunde la 13, no la 12');
  assert.equal(b.estado.teams[0].players[0].money, 800);
  b.fase(13, 'combat');
  assert.deepEqual(ataca(b), [false, true]);
});

test('bandos: un partido retomado en la segunda mitad se corrige solo', () => {
  // Partido nuevo (observador reconectado): sin marcador, empieza como en la 1.
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  assert.deepEqual(ataca(b), [true, false]);
  b.fase(17, 'combat'); // llega a mitad de la ronda 17
  assert.deepEqual(ataca(b), [false, true]);
});

test('bandos: la inversión manual del operador se mantiene en las rondas siguientes', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  b.ronda(1, [1, 0]);
  b.manda('swap_attacker_defender');
  assert.deepEqual(ataca(b), [false, true]);
  b.ronda(2, [1, 1]);
  assert.deepEqual(ataca(b), [false, true], 'no se deshace en la compra siguiente');
  for (let r = 3; r <= 12; r++) b.ronda(r, [r - 1, 1]);
  b.fase(13, 'shopping');
  assert.deepEqual(ataca(b), [true, false], 'y en la segunda mitad cambia igual');
});

test('bandos: el historial apunta cada ronda con el bando que de verdad tenía el equipo', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  for (let r = 1; r <= 12; r++) b.ronda(r, [r, 0]);
  b.fase(12, 'shopping'); // round_number rezagado otra vez
  b.fase(13, 'combat').fase(13, 'end').manda('score', { team_0: 13, team_1: 0 });
  const r13 = b.estado.teams[0].roundRecord[12];
  assert.equal(r13.round, 13);
  assert.equal(r13.wasAttack, false, 'la 13 la ganó defendiendo');
  assert.equal(b.estado.attackersWon, false);
});

/* ── Escudo ─────────────────────────────────────────────────────────────── */

const marcador = (b: Banco, extra: Record<string, unknown>) =>
  b.manda('scoreboard', {
    name: 'A', tagline: 'TAG', playerId: 'a', startTeam: 0, agentInternal: 'Wushu', isAlive: true,
    initialArmor: 2, scoreboardWeaponInternal: 'TX_Hud_Rifles_Volcano', currUltPoints: 3, maxUltPoints: 7,
    hasSpike: false, money: 4000, kills: 0, deaths: 0, assists: 0, ...extra,
  });

test('escudo: se sigue en cada marcador, se pierde al morir y un marcador sin el campo no lo borra', () => {
  const b = new Banco().alta('a', 0, 'A').fase(1, 'shopping');
  marcador(b, { initialArmor: 0 });
  assert.equal(b.estado.teams[0].players[0].armorName, 'None');
  marcador(b, { initialArmor: 1, money: 3600 });
  assert.equal(b.estado.teams[0].players[0].armorName, 'Light', 'compra de escudo ligero, al momento');
  marcador(b, { initialArmor: 2, money: 3000 });
  assert.equal(b.estado.teams[0].players[0].armorName, 'Heavy');
  const { initialArmor: _fuera, ...sinEscudo } = { initialArmor: 0, money: 3000 };
  marcador(b, sinEscudo);
  assert.equal(b.estado.teams[0].players[0].armorName, 'Heavy', 'lo que no llega no se borra');

  b.fase(1, 'combat');
  // GEP sigue mandando el escudo de inicio de ronda en el marcador del muerto.
  marcador(b, { initialArmor: 2, money: 3000, isAlive: false, deaths: 1 });
  assert.equal(b.estado.teams[0].players[0].armorName, 'None');

  // Y el que muere por el killfeed (sin marcador en la ronda) también lo pierde.
  const c = new Banco().alta('a', 0, 'A').alta('d', 1, 'D').fase(1, 'shopping');
  marcador(c, {});
  c.fase(1, 'end').ronda(2, [1, 0]).fase(3, 'shopping').fase(3, 'combat');
  c.manda('killfeed', { attacker: 'D', victim: 'A', assists: [] });
  assert.equal(c.estado.teams[0].players[0].armorName, 'None');
});

/* ── Habilidades ────────────────────────────────────────────────────────── */

test('habilidades: la capacidad del kit es la máxima vista, y se reinicia con otro agente', () => {
  const b = new Banco().alta('a', 0, 'A', 'Wushu');
  const cargas = (grenade: unknown, ability_1: unknown, ability_2: unknown) =>
    b.manda('aux_abilities', { grenade, ability_1, ability_2 }, { playerId: 'a' });
  const j = () => b.estado.teams[0].players[0];

  cargas(1, 1, 1);
  cargas(2, 1, 1); // compra la segunda nube
  cargas(1, 0, 1); // gasta una nube y el impulso
  assert.deepEqual(j().abilities, { grenade: 1, ability1: 0, ability2: 1 });
  assert.deepEqual(j().abilitiesMax, { grenade: 2, ability1: 1, ability2: 1 });

  // Versiones de GEP que mandan texto o booleanos.
  cargas('2', true, false);
  assert.deepEqual(j().abilities, { grenade: 2, ability1: 1, ability2: 0 });

  b.manda('roster', { name: 'A', tagline: 'TAG', startTeam: 0, agentInternal: 'Sarge', playerId: 'a', locked: true });
  assert.deepEqual(j().abilitiesMax, { grenade: 0, ability1: 0, ability2: 0 });

  const salida = JSON.parse(JSON.stringify(aSalida(b.estado)));
  assert.ok('abilitiesMax' in salida.teams[0].players[0], 'viaja en match_data');
});

/* ── Jugador que abandona ───────────────────────────────────────────────── */

test('desconectado: muerto en plena compra = fuera del mapa; no reaparece hasta volver vivo', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  const j = () => b.estado.teams[0].players[0];
  b.fase(1, 'shopping');
  marcador(b, {});
  assert.equal(j().disconnected, false);
  b.fase(1, 'combat');
  marcador(b, { isAlive: false, deaths: 1 });
  assert.equal(j().disconnected, false, 'morir en combate no es abandonar');

  b.fase(1, 'end').manda('score', { team_0: 0, team_1: 1 });
  b.fase(2, 'shopping');
  assert.equal(j().isAlive, true, 'todo el mundo reaparece');
  marcador(b, { isAlive: false, deaths: 1, money: 5000 });
  assert.equal(j().disconnected, true);
  assert.equal(j().isAlive, false);

  // La ronda siguiente, aunque GEP no vuelva a mandar nada suyo, sigue fuera.
  b.fase(2, 'combat').fase(2, 'end').manda('score', { team_0: 0, team_1: 2 });
  b.fase(3, 'shopping');
  assert.equal(j().isAlive, false);
  assert.equal(j().health, 0);
  assert.equal(JSON.parse(JSON.stringify(aSalida(b.estado))).teams[0].players[0].disconnected, true);

  // Vuelve.
  marcador(b, { isAlive: true, money: 5500 });
  assert.equal(j().disconnected, false);
  assert.equal(j().isAlive, true);
});
