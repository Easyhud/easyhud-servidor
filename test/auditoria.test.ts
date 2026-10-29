/**
 * Correcciones de la auditoría de octubre de 2026 (S1–S8), a nivel de reductor.
 * Las de red (S3 y S9 por socket) están en `auditoria-red.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco } from './ayudas.ts';
import { aSalida } from '../src/partida/serializa.ts';
import { nombreArma, nombreMapa } from '../src/partida/tablas.ts';
import { silencia } from '../src/log.ts';

silencia(true);

const marcador = (b: Banco, extra: Record<string, unknown> = {}, id = 'a', equipo: 0 | 1 = 0) =>
  b.manda('scoreboard', {
    name: id.toUpperCase(), tagline: 'TAG', playerId: id, startTeam: equipo, agentInternal: 'Wushu', isAlive: true,
    initialArmor: 0, scoreboardWeaponInternal: 'TX_Hud_Rifles_Volcano', currUltPoints: 3, maxUltPoints: 7,
    hasSpike: false, money: 4000, kills: 0, deaths: 0, assists: 0, ...extra,
  });
const jug = (b: Banco, id: string) => b.estado.teams.flatMap((t) => t.players).find((j) => j.riotId === id)!;

/* ── S1 ─────────────────────────────────────────────────────────────────── */

test('S1 mapas: cada código conocido da su nombre (Plummet = Summit) y uno desconocido no se vuelve Corrode', () => {
  const conocidos: Record<string, string> = {
    Infinityy: 'Abyss', Triad: 'Haven', Duality: 'Bind', Bonsai: 'Split', Ascent: 'Ascent', Port: 'Icebox',
    Foxtrot: 'Breeze', Canyon: 'Fracture', Pitt: 'Pearl', Jam: 'Lotus', Juliett: 'Sunset', Range: 'The Range', // antes «Practice Range»: no casaba con 	herange del panel ni con el nombre de valorant-api
    Rook: 'Corrode', Plummet: 'Summit',
  };
  for (const [codigo, nombre] of Object.entries(conocidos)) assert.equal(nombreMapa(codigo), nombre, codigo);
  assert.equal(nombreMapa('Xyz'), 'Xyz');
  assert.equal(nombreMapa('Xyz'), 'Xyz', 'la segunda vez igual (el aviso al log sale una sola vez)');
  assert.notEqual(nombreMapa('Xyz'), 'Corrode');
  assert.equal(nombreMapa(undefined), '');
  assert.equal(new Banco().manda('map', 'Plummet').estado.map, 'Summit');
  assert.equal(new Banco().manda('map', 'Xyz').estado.map, 'Xyz');
});

/* ── S2 ─────────────────────────────────────────────────────────────────── */

test('S2 Warden: las dos formas del HUD dejan highestWeapon = Warden', () => {
  for (const codigo of ['TX_Hud_Rifle_BattleRifle', 'TX_Hud_BattleRifle']) {
    assert.equal(nombreArma(codigo), 'Warden');
    const b = new Banco().alta('a', 0, 'A').fase(1, 'shopping');
    marcador(b, { scoreboardWeaponInternal: codigo });
    assert.equal(jug(b, 'a').highestWeapon, 'Warden', codigo);
  }
});

/* ── S3 (a nivel de reductor: sólo el equipo del remitente) ──────────────── */

test('S3 aux_scoreboard_team sólo actualiza a jugadores del mismo equipo que el remitente', () => {
  const b = new Banco().alta('a1', 0, 'A1').alta('a2', 0, 'A2').alta('d1', 1, 'D1').fase(1, 'shopping');
  const lista = ['a2', 'd1'].map((id) => ({ playerId: id, money: 7777, isAlive: true, kills: 0, deaths: 0, assists: 0 }));
  b.manda('aux_scoreboard_team', JSON.stringify(lista), { playerId: 'a1' });
  assert.equal(jug(b, 'a2').money, 7777, 'el compañero sí');
  assert.equal(jug(b, 'd1').money, 0, 'el rival no');
  assert.equal(jug(b, 'd1').auxiliaryAvailable.scoreboard, false);
});

/* ── S4 ─────────────────────────────────────────────────────────────────── */

function bancoDeRonda(): Banco {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  b.fase(1, 'shopping');
  b.t += 30_000;
  b.fase(1, 'combat');
  b.t += 40_000;
  return b;
}
const tipos = (b: Banco, ronda = 0) => b.estado.teams.map((t) => t.roundRecord[ronda].type);

test('S4 motivo: end → score → spike_defused deja «defused»', () => {
  const b = bancoDeRonda();
  b.fase(1, 'end');
  b.t += 300;
  b.manda('score', { team_0: 0, team_1: 1 });
  assert.deepEqual(tipos(b), ['lost', 'kills'], 'de entrada, lo que se sabe en ese instante');
  b.t += 200;
  b.manda('spike_defused');
  assert.deepEqual(tipos(b), ['lost', 'defused']);
});

test('S4 motivo: end → score → spike_detonated deja «detonated»', () => {
  const b = bancoDeRonda();
  b.fase(1, 'end');
  b.manda('score', { team_0: 1, team_1: 0 });
  assert.deepEqual(tipos(b), ['kills', 'lost']);
  b.manda('spike_detonated');
  assert.deepEqual(tipos(b), ['detonated', 'lost']);
});

test('S4 motivo: con el evento ANTES del score sigue igual que siempre', () => {
  const b = bancoDeRonda();
  b.fase(1, 'end').manda('spike_defused').manda('score', { team_0: 0, team_1: 1 });
  assert.deepEqual(tipos(b), ['lost', 'defused']);
  const c = bancoDeRonda();
  c.fase(1, 'end').manda('spike_detonated').manda('score', { team_0: 1, team_1: 0 });
  assert.deepEqual(tipos(c), ['detonated', 'lost']);
});

test('S4 motivo: con la compra siguiente ya empezada, un evento tardío no toca la ronda anterior', () => {
  const b = bancoDeRonda();
  b.fase(1, 'end').manda('score', { team_0: 0, team_1: 1 });
  b.t += 7_000;
  b.fase(2, 'shopping');
  b.manda('spike_defused');
  assert.deepEqual(tipos(b), ['lost', 'kills'], 'el motivo quedó fijo');
});

test('S4 motivo: el score llega ANTES del end y la ronda acabó por tiempo → «timeout»', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  b.fase(1, 'shopping');
  b.t += 30_000;
  b.fase(1, 'combat');
  b.t += 50_000;
  b.manda('score', { team_0: 0, team_1: 1 });
  assert.deepEqual(tipos(b), ['lost', 'kills']);
  b.t += 50_000; // el end llega pasados los 99 s de la ronda
  b.fase(1, 'end');
  assert.deepEqual(tipos(b), ['lost', 'timeout']);
});

/* ── S5 ─────────────────────────────────────────────────────────────────── */

test('S5 desconectado: un marcador muerto en compra no basta; dos separados 3,5 s sí; uno vivo lo recupera', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D').fase(1, 'shopping');
  marcador(b, { isAlive: false });
  assert.equal(jug(b, 'a').disconnected, false);
  b.t += 1_000;
  marcador(b, { isAlive: false });
  assert.equal(jug(b, 'a').disconnected, false, 'dos marcadores, pero sin los 3 s');
  b.t += 2_500; // 3,5 s desde el primero
  marcador(b, { isAlive: false });
  assert.equal(jug(b, 'a').disconnected, true);
  marcador(b, { isAlive: true });
  assert.equal(jug(b, 'a').disconnected, false);
  assert.equal(jug(b, 'a').isAlive, true);
});

test('S5 desconectado: la evidencia de una compra no se arrastra a la siguiente', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D').fase(1, 'shopping');
  marcador(b, { isAlive: false });
  b.t += 5_000;
  b.fase(1, 'combat').fase(1, 'end').manda('score', { team_0: 1, team_1: 0 });
  b.fase(2, 'shopping');
  marcador(b, { isAlive: false }); // primer marcador de ESTA compra
  assert.equal(jug(b, 'a').disconnected, false);
});

/* ── S6 ─────────────────────────────────────────────────────────────────── */

test('S6 compra: shopping(r5) → shopping(r6) directo es ronda nueva; shopping(r5) repetido, no', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D').fase(5, 'shopping');
  marcador(b, { money: 4000 });
  marcador(b, { money: 3000 });
  assert.equal(jug(b, 'a').moneySpent, 1000);

  b.fase(5, 'shopping'); // repetido
  assert.equal(jug(b, 'a').moneySpent, 1000, 'la misma ronda no se reinicia');

  b.manda('score', { team_0: 1, team_1: 4 }); // el marcador de la ronda 5 llegó, pero se perdieron combat y end
  b.fase(6, 'shopping');
  assert.equal(jug(b, 'a').moneySpent, 0, 'ronda nueva: se reinicia el gasto');
  assert.equal(jug(b, 'a').scoreboardAvailable, false, 'y los marcadores de ronda');
  assert.equal(b.estado.roundNumber, 6);
});

test('S6 compra: shopping(r5) → shopping(r6) sin marcador de por medio también reinicia', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D').fase(5, 'shopping');
  marcador(b, { money: 4000 });
  marcador(b, { money: 3000 });
  b.fase(6, 'shopping');
  assert.equal(jug(b, 'a').moneySpent, 0);
  assert.equal(jug(b, 'a').spentMoneyThisRound, false);
});

test('S6 compra: el primer round_info tras el match_start (ya en compra) no cuenta como ronda nueva', () => {
  const b = new Banco().alta('a', 0, 'A').alta('d', 1, 'D');
  b.manda('match_start', 'M1');
  assert.equal(b.estado.roundPhase, 'shopping');
  marcador(b, { money: 4000 });
  marcador(b, { money: 3000 });
  b.fase(1, 'shopping');
  assert.equal(jug(b, 'a').moneySpent, 1000);
});

/* ── S7 ─────────────────────────────────────────────────────────────────── */

test('S7 ulti: sin campos de puntos no hay ulti lista; con los dos datos y puntos ≥ máximo > 0, sí', () => {
  const b = new Banco().alta('a', 0, 'A').fase(1, 'shopping');
  b.manda('scoreboard', { name: 'A', tagline: 'TAG', playerId: 'a', startTeam: 0, isAlive: true, money: 800 });
  assert.equal(jug(b, 'a').ultReady, false);
  marcador(b, { currUltPoints: 7, maxUltPoints: 7 });
  assert.equal(jug(b, 'a').ultReady, true);
  marcador(b, { currUltPoints: 0, maxUltPoints: 0 });
  assert.equal(jug(b, 'a').ultReady, false, 'un máximo de 0 no es una ulti cargada');
  marcador(b, { currUltPoints: 6, maxUltPoints: 7 });
  assert.equal(jug(b, 'a').ultReady, false);
});

/* ── S8 ─────────────────────────────────────────────────────────────────── */

test('S8 reinicios: @reinicia_partida y una partida nueva devuelven agentSelectStartTime al inicial', () => {
  const b = new Banco();
  b.manda('match_start', 'M1');
  b.alta('a', 0, 'A');
  assert.equal(b.estado.agentSelectStartTime, b.t);
  b.t += 60_000;
  b.evento({ type: '@reinicia_partida', timestamp: b.t });
  assert.equal(b.estado.agentSelectStartTime, undefined);
  assert.equal(JSON.parse(JSON.stringify(aSalida(b.estado))).agentSelectStartTime, undefined);
  b.t += 1_000;
  b.alta('a', 0, 'A');
  assert.equal(b.estado.agentSelectStartTime, b.t, 'la selección siguiente arranca su propio contador');

  // Otra partida en el mismo grupo (match_start con otro id): sin jugadores de ella, vuelve al inicial.
  const c = new Banco();
  c.manda('match_start', 'M1');
  c.alta('a', 0, 'A').fase(1, 'shopping');
  c.t += 100_000;
  c.manda('match_start', 'M2');
  assert.equal(c.estado.agentSelectStartTime, undefined);
});

test('S8 reinicios: si los rosters de la partida nueva ya llegaron, el arranque es el suyo, no el de la anterior', () => {
  const b = new Banco();
  b.manda('match_start', 'M1');
  b.alta('a', 0, 'A').fase(1, 'shopping');
  const antes = b.estado.agentSelectStartTime;
  b.t += 100_000;
  b.alta('a', 0, 'A'); // roster de la partida siguiente, antes de su match_start
  const nuevo = b.t;
  b.t += 20_000;
  b.manda('match_start', 'M2');
  assert.notEqual(b.estado.agentSelectStartTime, antes);
  assert.equal(b.estado.agentSelectStartTime, nuevo);
});

/* ── S9 (estado) ────────────────────────────────────────────────────────── */

test('S9 cámaras: la salida pública no lleva la clave y la autenticada sí; sala y quién publica viajan igual', () => {
  const b = new Banco();
  b.evento({ type: '@camaras', timestamp: b.t, publicando: ['Uno#EUW'], conexion: { base: 'https://v.test', params: 'x=1', clave: 'CLAVESECRETA1234' } });
  const publica = JSON.stringify(aSalida(b.estado));
  assert.equal(publica.includes('CLAVESECRETA1234'), false);
  assert.equal('clave' in JSON.parse(publica).tools.playercamsInfo, false);
  const cam = JSON.parse(publica).tools.playercamsInfo;
  assert.deepEqual(cam.enabledPlayers, ['Uno#EUW']);
  assert.equal(cam.base, 'https://v.test');
  assert.equal(cam.params, 'x=1');
  assert.equal(JSON.parse(JSON.stringify(aSalida(b.estado, true))).tools.playercamsInfo.clave, 'CLAVESECRETA1234');
  // El estado en memoria conserva la clave (la usa la central para el canal autenticado).
  assert.equal(b.estado.tools.playercamsInfo.clave, 'CLAVESECRETA1234');
});
