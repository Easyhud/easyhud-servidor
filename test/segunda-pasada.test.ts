/**
 * Segunda pasada de auditoría contra Spectra-Server (rama copia-funcional).
 * Tablas del juego (agente nuevo Hush / Paprika) y situaciones límite del directo.
 *
 * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — src/util/ValorantInternalTranslator.ts
 * (la tabla de agentes) y src/model/Match.ts (los casos de partida que se prueban).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco } from './ayudas.ts';
import { agenteDeIconoKillfeed, agenteNormalizado, nombreAgente } from '../src/partida/tablas.ts';

/* ── Tablas: Hush (Paprika) ─────────────────────────────────────────────── */

test('T1 Hush: el interno «Paprika» (con y sin _PC_C) sale como Hush y se normaliza', () => {
  assert.equal(nombreAgente('Paprika'), 'Hush');
  assert.equal(nombreAgente('Paprika_PC_C'), 'Hush');
  assert.equal(agenteNormalizado('Paprika_PC_C'), 'Paprika');
});

test('T1 Hush: el icono del killfeed llega con el nombre interno (como Miks) y también con el visible', () => {
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_Paprika'), 'Paprika');
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_Hush'), 'Paprika');
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_Iris'), 'Iris');
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_Miks'), 'Iris');
  // Los de siempre no se tocan: visible → interno, y ahora también interno → interno.
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_Raze'), 'Clay');
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_Clay'), 'Clay');
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_KAYO'), 'Grenadier');
  assert.equal(agenteDeIconoKillfeed('TX_Killfeed_NoExiste'), undefined);
});

test('T1 Hush: por roster y por marcador sale agentProper = Hush, y su asistencia de killfeed casa', () => {
  const b = new Banco();
  b.alta('a1', 0, 'Atacante', 'Wushu').alta('a2', 0, 'Ayudante', 'Paprika').alta('d1', 1, 'Victima', 'Sarge');
  assert.equal(b.estado.teams[0].players[1].agentProper, 'Hush');
  b.fase(1, 'shopping').fase(1, 'combat');
  b.manda('killfeed', {
    attacker: 'Atacante', victim: 'Victima', weaponKillfeedInternal: 'TX_Hud_Volcano', headshotKill: false,
    assists: ['TX_Killfeed_Paprika'], isTeamkill: false,
  });
  assert.equal(b.estado.teams[0].players[1].assists, 1);
  // Y si el agente llega por el marcador del observador, también.
  b.manda('scoreboard', {
    name: 'Ayudante', tagline: 'TAG', playerId: 'a2', startTeam: 0, agentInternal: 'Paprika_PC_C', isAlive: true,
    initialArmor: 0, scoreboardWeaponInternal: 'TX_Hud_Pistol_Classic', currUltPoints: 0, maxUltPoints: 8, hasSpike: false,
    money: 800, kills: 0, deaths: 0, assists: 1,
  });
  assert.equal(b.estado.teams[0].players[1].agentProper, 'Hush');
});

/* ── Situaciones límite del directo (task 4) ───────────────────────────── */

test('R1 combat repetido: la misma ronda no alarga el tope de 99 s (una ronda por tiempo sigue siendo «timeout») ni quita el rótulo', () => {
  const b = new Banco();
  b.alta('a1', 0, 'A1').alta('d1', 1, 'D1');
  b.fase(1, 'shopping');
  b.t += 30_000;
  b.fase(1, 'combat');
  const limite = b.estado.roundTimeoutTime;
  assert.equal(limite, b.t + 99_000);
  b.manda('toast', { active: true, title: 'Aviso', message: 'hola', duration: null });
  assert.equal(b.estado.toastInfo.active, true);

  b.t += 50_000;
  b.fase(1, 'combat'); // el observador reconecta y reenvía el último estado
  assert.equal(b.estado.roundTimeoutTime, limite, 'el tope no se mueve');
  assert.equal(b.estado.toastInfo.active, true, 'el rótulo del operador sigue');

  b.t += 50_000;
  b.fase(1, 'end');
  b.t += 300;
  b.manda('score', { team_0: 0, team_1: 1 });
  assert.equal(b.estado.wasTimeout, true);
  assert.equal(b.estado.teams[1].roundRecord[0].type, 'timeout');
});

test('R1 combat repetido tras plantar: no vuelve a haber tope de ronda ni se mueve la detonación', () => {
  const b = new Banco();
  b.alta('a1', 0, 'A1').alta('d1', 1, 'D1');
  b.fase(1, 'shopping');
  b.t += 30_000;
  b.fase(1, 'combat');
  b.t += 20_000;
  b.manda('spike_planted', true);
  const detonacion = b.estado.spikeDetonationTime;
  assert.equal(b.estado.roundTimeoutTime, undefined);
  b.t += 10_000;
  b.fase(1, 'combat');
  assert.equal(b.estado.roundTimeoutTime, undefined);
  assert.equal(b.estado.spikeDetonationTime, detonacion);
});

test('R1 combat de una ronda NUEVA (se perdieron la compra y el fin) sí empieza la cuenta de nuevo', () => {
  const b = new Banco();
  b.alta('a1', 0, 'A1').alta('d1', 1, 'D1');
  b.fase(1, 'shopping');
  b.t += 30_000;
  b.fase(1, 'combat');
  const primero = b.estado.roundTimeoutTime;
  b.t += 60_000;
  b.manda('score', { team_0: 1, team_1: 0 });
  b.t += 5_000;
  b.fase(2, 'combat'); // sin shopping ni end de por medio
  assert.equal(b.estado.roundNumber, 2);
  assert.equal(b.estado.roundTimeoutTime, b.t + 99_000);
  assert.notEqual(b.estado.roundTimeoutTime, primero);
});

test('R2 la lista de compañeros no mata a nadie fuera del combate (lobby, selección, compra) pero sí en combate', () => {
  const b = new Banco();
  b.alta('i1', 0, 'I1').alta('i2', 0, 'I2');
  const lista = (vivo: boolean) =>
    JSON.stringify([{ playerId: 'i2', agentInternal: 'Clay', isAlive: vivo, money: 800, kills: 0, deaths: 0, assists: 0 }]);
  // Lobby: en las grabaciones reales llega «muerto» para todos.
  b.manda('aux_scoreboard_team', lista(false), { playerId: 'i1' });
  const i2 = () => b.estado.teams[0].players[1];
  assert.equal(i2().isAlive, true);
  assert.equal(i2().health, 100);
  assert.equal(i2().auxiliaryAvailable.scoreboard, true, 'el resto del dato sí se toma');
  b.fase(1, 'game_start');
  b.manda('aux_scoreboard_team', lista(false), { playerId: 'i1' });
  assert.equal(i2().isAlive, true);
  b.fase(1, 'shopping');
  b.manda('aux_scoreboard_team', lista(false), { playerId: 'i1' });
  assert.equal(i2().isAlive, true);
  // En combate sí: es un compañero que ha muerto.
  b.fase(1, 'combat');
  b.manda('aux_scoreboard_team', JSON.stringify([{ playerId: 'i2', agentInternal: 'Clay', isAlive: false, money: 800, kills: 0, deaths: 1, assists: 0 }]), { playerId: 'i1' });
  assert.equal(i2().isAlive, false);
  assert.equal(i2().health, 0);
});

/** Juega un mapa entero sin mandar `game_end` (el observador lo pierde). */
function mapaSinGameEnd(b: Banco): void {
  b.alta('a1', 0, 'Viejo A').alta('d1', 1, 'Viejo D');
  b.manda('match_start', 'M-1');
  for (let r = 1; r <= 13; r++) b.ronda(r, [r, 0]);
}

test('R3 fin de mapa sin game_end: se queda el marcador final y la partida siguiente (match_start nuevo) empieza limpia', () => {
  const b = new Banco();
  mapaSinGameEnd(b);
  assert.equal(b.estado.roundPhase, 'end');
  assert.equal(b.estado.teams[0].roundsWon, 13);
  assert.equal(b.ultimo.finDeMapa, false, 'sin game_end el servidor no inventa el fin');

  // Mapa siguiente en el mismo partido: el cliente manda mapa, modo, roster y el match_start nuevo.
  b.t += 120_000;
  b.manda('map', 'Bind').manda('game_mode', 'bomb');
  b.alta('a2', 0, 'Nuevo A').alta('d2', 1, 'Nuevo D');
  b.manda('match_start', 'M-2');
  b.fase(1, 'shopping');
  const p = b.estado;
  assert.equal(p.matchId, 'M-2');
  assert.equal(p.map, 'Bind');
  assert.deepEqual(p.teams.map((t) => t.roundsWon), [0, 0]);
  assert.equal(p.roundNumber, 1);
  assert.equal(p.roundPhase, 'shopping');
  assert.deepEqual(p.teams.map((t) => t.players.map((j) => j.riotId)), [['a2'], ['d2']], 'sólo los jugadores de la partida nueva');
  assert.equal(p.teams[0].isAttacking, true);
  assert.equal(p.teams[1].isAttacking, false);
  assert.equal(p.teams[0].roundRecord.filter((r) => r.type !== 'upcoming').length, 0);
});

test('R3 fin de mapa sin game_end: si el primer round_info de la partida nueva llega ANTES del match_start, se corrige al llegar', () => {
  const b = new Banco();
  mapaSinGameEnd(b);
  b.t += 120_000;
  b.manda('map', 'Bind').manda('game_mode', 'bomb');
  b.alta('a2', 0, 'Nuevo A').alta('d2', 1, 'Nuevo D');
  b.fase(1, 'shopping'); // el partido viejo cree que es la ronda 14
  b.manda('match_start', 'M-2');
  b.fase(1, 'shopping');
  b.fase(1, 'combat');
  // Los rosters eran anteriores al round_info: al llegar el match_start se les da por viejos, pero vuelven con su marcador.
  const marcador = (id: string, nombre: string, equipo: number) =>
    b.manda('scoreboard', {
      name: nombre, tagline: 'TAG', playerId: id, startTeam: equipo, agentInternal: 'Wushu', isAlive: true, initialArmor: 0,
      scoreboardWeaponInternal: 'TX_Hud_Pistol_Classic', currUltPoints: 0, maxUltPoints: 8, hasSpike: false, money: 800, kills: 0, deaths: 0, assists: 0,
    });
  marcador('a2', 'Nuevo A', 0);
  marcador('d2', 'Nuevo D', 1);
  const p = b.estado;
  assert.equal(p.roundNumber, 1);
  assert.deepEqual(p.teams.map((t) => t.roundsWon), [0, 0]);
  assert.equal(p.teams[0].isAttacking, true);
  assert.deepEqual(p.teams.map((t) => t.players.map((j) => j.riotId)), [['a2'], ['d2']], 'sin rastro de la partida vieja');
  assert.equal(p.teams[0].roundRecord.filter((r) => r.type !== 'upcoming').length, 0);
});

test('R4 prórroga: 12-12, la ronda 25 cambia de lado y da el tiempo muerto extra UNA vez; un shopping repetido no lo repite', () => {
  const b = new Banco();
  b.alta('a1', 0, 'A1').alta('d1', 1, 'D1');
  b.manda('match_start', 'M-OT');
  for (let r = 1; r <= 24; r++) b.ronda(r, [Math.ceil(r / 2), Math.floor(r / 2)]);
  b.fase(25, 'shopping');
  const p = b.estado;
  assert.equal(p.roundNumber, 25);
  assert.equal(p.firstOtRound, 25);
  const [t0, t1] = p.teams;
  // El equipo 0 atacó la 1.ª mitad, defendió la 2.ª y en la prórroga la primera la ataca de nuevo.
  assert.equal(t0.isAttacking, true);
  assert.equal(t1.isAttacking, false);
  const extra = p.interno.tiempos.restantes.slice();
  b.fase(25, 'shopping');
  assert.deepEqual(b.estado.interno.tiempos.restantes, extra, 'el extra no se concede dos veces');
  b.ronda(25, [13, 12]);
  b.fase(26, 'shopping');
  assert.equal(b.estado.teams[0].isAttacking, false, 'en prórroga se cambia cada ronda');
  assert.equal(b.estado.teams[0].roundRecord[24].type !== 'upcoming', true, 'la ronda 25 queda en el historial');
});

test('R5 jugador que entra a mitad de ronda: su marcador lo da de alta y su ficha no pisa a nadie', () => {
  const b = new Banco();
  b.alta('a1', 0, 'A1').alta('d1', 1, 'D1');
  b.fase(3, 'shopping').fase(3, 'combat');
  b.manda('scoreboard', {
    name: 'Tarde', tagline: 'TAG', playerId: 'a9', startTeam: 0, agentInternal: 'Paprika', isAlive: true, initialArmor: 1,
    scoreboardWeaponInternal: 'TX_Hud_Rifles_Volcano', currUltPoints: 2, maxUltPoints: 8, hasSpike: false, money: 2300, kills: 1, deaths: 0, assists: 0,
  });
  const j = b.estado.teams[0].players.find((x) => x.riotId === 'a9');
  assert.ok(j, 'dado de alta por su marcador');
  assert.equal(j.agentProper, 'Hush');
  assert.equal(j.highestWeapon, 'Vandal');
  assert.equal(b.estado.teams[0].players.length, 2);
  assert.equal(b.estado.teams[1].players.length, 1);
});