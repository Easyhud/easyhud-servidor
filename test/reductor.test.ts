import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco, partidoNuevo } from './ayudas.ts';
import { reduce } from '../src/partida/reductor.ts';
import { aSalida, serializa } from '../src/partida/serializa.ts';
import { aplicaParcheGrupo, memoriaVacia } from '../src/partida/configuracion.ts';

/* ── Creación ───────────────────────────────────────────────────────────── */

test('creación: valores iniciales y configuración por defecto rellenando lo que falta', () => {
  const p = partidoNuevo({
    tournamentInfo: { logoUrl: 'x.png', backdropUrl: '' }, // sin name, como el cliente actual
    timeoutCounter: { max: 3, left: 0, right: 1 }, // left/right del logon se ignoran
    watermarkInfo: { brandWatermark: true, customTextEnabled: false, customText: '' },
    playercamsInfo: { enable: false, identifier: '', secret: 'no-debe-salir', endTime: 0 },
    seriesInfo: { needed: null, wonLeft: null, wonRight: null, mapInfo: [] },
  });
  assert.equal(p.roundPhase, 'LOBBY');
  assert.equal(p.map, 'Loading');
  assert.equal(p.teams[0].ingameTeamId, 0);
  assert.equal(p.teams[1].ingameTeamId, 1);
  assert.equal(p.teams[0].roundRecord.length, 25);
  assert.equal(p.tools.tournamentInfo.name, '');
  assert.equal(p.tools.watermarkInfo.brandWatermark, false);
  assert.equal(p.tools.seriesInfo.needed, 1);
  const salida = aSalida(p);
  assert.deepEqual(salida.tools.timeoutCounter, { max: 3, left: 3, right: 3 });
  assert.equal(JSON.stringify(salida).includes('no-debe-salir'), false);
});

test('creación: siembra la serie y los equipos que recuerda el grupo', () => {
  const m = memoriaVacia();
  aplicaParcheGrupo(m, {
    seriesInfo: { needed: 2, wonLeft: 1, wonRight: 0, mapInfo: [{ type: 'past', map: 'Bind' }] },
    equipos: [{ name: 'Alfa', tricode: 'ALF', url: 'a.png' }, null],
  });
  const p = partidoNuevo({}, m);
  assert.equal(p.tools.seriesInfo.needed, 2);
  assert.equal(p.tools.seriesInfo.wonLeft, 1);
  assert.equal(p.teams[0].teamName, 'Alfa');
  assert.equal(p.teams[0].teamUrl, 'a.png');
  assert.equal(p.teams[1].teamName, 'Derecha');
});

/* ── Pureza ─────────────────────────────────────────────────────────────── */

test('el reductor no toca el estado que recibe', () => {
  const p = partidoNuevo();
  const antes = JSON.stringify(p);
  const r = reduce(p, { type: 'map', data: 'Ascent', timestamp: 1 });
  assert.equal(JSON.stringify(p), antes);
  assert.equal(r.estado.map, 'Ascent');
  assert.notEqual(r.estado, p);
});

test('tipos desconocidos no cambian nada ni provocan envío', () => {
  const p = partidoNuevo();
  const r = reduce(p, { type: 'team_is_attacker', data: true, timestamp: 1 });
  assert.equal(r.cambiado, false);
  assert.equal(r.estado, p);
});

/* ── Roster y marcador ──────────────────────────────────────────────────── */

test('roster: alta, actualización sin degradar el rango y tope de cinco', () => {
  const b = new Banco();
  b.alta('p1', 0, 'Uno');
  b.manda('roster', { name: 'Uno', tagline: 'TAG', startTeam: '0', agentInternal: 'Clay', playerId: 'p1', locked: true, rank: 0 });
  const j = b.estado.teams[0].players[0];
  assert.equal(j.agentProper, 'Raze');
  assert.equal(j.rank, 10);
  assert.equal(j.searchName, 'Uno #TAG');
  for (let i = 2; i <= 6; i++) b.alta(`p${i}`, 0, `J${i}`);
  assert.equal(b.estado.teams[0].players.length, 5);
});

test('roster: equipo inexistente no provoca envío', () => {
  const b = new Banco().manda('roster', { name: 'X', tagline: 'Y', startTeam: 7, playerId: 'z' });
  assert.equal(b.ultimo.cambiado, false);
});

test('roster: un alta tardía no devuelve al equipo a su bando inicial', () => {
  const b = new Banco();
  b.alta('a1', 0, 'A1').alta('d1', 1, 'D1');
  for (let r = 1; r <= 12; r++) b.ronda(r, [r, 0]);
  b.fase(13, 'shopping'); // cambio de lado
  assert.equal(b.estado.teams[0].isAttacking, false);
  b.alta('a2', 0, 'A2'); // alguien entra tarde
  assert.equal(b.estado.teams[0].isAttacking, false);
});

test('scoreboard: kills de la ronda, gasto, escudo, arma y muerte', () => {
  const b = new Banco().alta('p1', 0, 'Uno');
  const marcador = (extra: Record<string, unknown>) =>
    b.manda('scoreboard', {
      name: 'Uno', tagline: 'TAG', playerId: 'p1', startTeam: 0, agentInternal: 'Wushu', isAlive: true,
      initialArmor: 2, scoreboardWeaponInternal: 'TX_Hud_Rifles_Volcano', currUltPoints: 3, maxUltPoints: 7,
      hasSpike: false, money: 4000, kills: 0, deaths: 0, assists: 0, ...extra,
    });
  b.fase(1, 'shopping');
  marcador({});
  marcador({ money: 1100 });
  assert.equal(b.estado.teams[0].players[0].armorName, 'Heavy');
  b.fase(1, 'combat');
  marcador({ money: 1100, kills: 2, isAlive: false });
  const j = b.estado.teams[0].players[0];
  assert.equal(j.killsThisRound, 1);
  assert.equal(j.moneySpent, 2900);
  assert.equal(j.armorName, 'None', 'el escudo se pierde al morir');
  assert.equal(j.highestWeapon, 'Vandal');
  assert.equal(j.health, 0);
  assert.equal(j.disconnected, false, 'morir en combate no es abandonar');
  assert.equal(j.scoreboardAvailable, true);
  assert.equal(b.estado.teams[0].spentThisRound, 2900);
});

/* ── Spike ──────────────────────────────────────────────────────────────── */

test('spike: sólo se planta en combate, y se detecta por los 300 créditos', () => {
  const b = new Banco().alta('p1', 0, 'Uno');
  b.manda('spike_planted', true);
  assert.equal(b.estado.spikeState.planted, false);
  b.fase(1, 'shopping').fase(1, 'combat');
  const base = { name: 'Uno', tagline: 'TAG', playerId: 'p1', startTeam: 0, isAlive: true, kills: 0, deaths: 0, assists: 0 };
  b.manda('scoreboard', { ...base, money: 500 });
  b.manda('scoreboard', { ...base, money: 800 });
  assert.equal(b.estado.spikeState.planted, true);
  assert.equal(b.estado.spikeDetonationTime, b.t + 45_000);
  assert.equal(b.estado.roundTimeoutTime, undefined);
  b.manda('spike_detonated', true);
  assert.equal(b.estado.spikeDetonationTime, undefined);
  b.fase(2, 'shopping');
  assert.deepEqual(b.estado.spikeState, { planted: false, detonated: false, defused: false });
});

/* ── Rondas, historial y lados ──────────────────────────────────────────── */

test('score: apunta la ronda al llegar el marcador, con su motivo', () => {
  const b = new Banco();
  b.ronda(1, [1, 0]); // ataque (equipo 0) gana por eliminación
  const [izq, der] = b.estado.teams;
  assert.equal(b.estado.attackersWon, true);
  assert.deepEqual(izq.roundRecord[0], { type: 'kills', wasAttack: true, round: 1 });
  assert.deepEqual(der.roundRecord[0], { type: 'lost', wasAttack: false, round: 1 });
  assert.equal(izq.roundsWon, 1);

  // Ronda 2: la defensa desactiva.
  b.fase(2, 'shopping').fase(2, 'combat');
  b.manda('spike_planted', true).manda('spike_defused', true);
  b.fase(2, 'end').manda('score', { team_0: 1, team_1: 1 });
  assert.equal(b.estado.attackersWon, false);
  assert.equal(b.estado.teams[1].roundRecord[1].type, 'defused');
});

test('score: la última ronda del mapa también entra en el historial', () => {
  const b = new Banco();
  for (let r = 1; r <= 13; r++) b.ronda(r, [r, 0]);
  const izq = b.estado.teams[0];
  assert.equal(izq.roundRecord[12].type === 'upcoming', false);
  assert.equal(izq.roundRecord[12].round, 13);
  b.fase(13, 'game_end');
  assert.equal(b.ultimo.finDeMapa, true);
  assert.equal(b.estado.isRunning, false);
});

test('score: ronda ganada por tiempo aunque el `end` llegue antes que el `score`', () => {
  const b = new Banco();
  b.fase(1, 'shopping');
  b.fase(1, 'combat');
  b.t += 100_000; // se agota el reloj
  b.fase(1, 'end');
  b.t += 300;
  b.manda('score', { team_0: 0, team_1: 1 });
  assert.equal(b.estado.wasTimeout, true);
  assert.equal(b.estado.teams[1].roundRecord[0].type, 'timeout');
});

test('score repetido no vuelve a apuntar la ronda', () => {
  const b = new Banco().ronda(1, [1, 0]);
  const antes = JSON.stringify(b.estado.teams);
  b.manda('score', { team_0: 1, team_1: 0 });
  assert.equal(JSON.stringify(b.estado.teams), antes);
});

test('cambio de lado en la 13 y un `shopping` repetido no cambia dos veces', () => {
  const b = new Banco().alta('p1', 0, 'Uno');
  for (let r = 1; r <= 12; r++) b.ronda(r, [Math.ceil(r / 2), Math.floor(r / 2)]);
  b.fase(13, 'shopping');
  b.fase(13, 'shopping');
  assert.equal(b.estado.teams[0].isAttacking, false);
  assert.equal(b.estado.teams[1].isAttacking, true);
  assert.equal(b.estado.teams[0].players[0].money, 800);
});

test('prórroga: cambio en cada ronda y tiempo muerto extra una sola vez', () => {
  const b = new Banco();
  for (let r = 1; r <= 24; r++) b.ronda(r, [Math.ceil(r / 2), Math.floor(r / 2)]);
  // Gastan los dos del equipo 0 para ver el extra.
  b.manda('left_timeout').espera(61_000).manda('left_timeout').espera(61_000);
  assert.equal(aSalida(b.estado).tools.timeoutCounter.left, 0);
  const atacaAntes = b.estado.teams[0].isAttacking;
  b.fase(25, 'shopping');
  assert.equal(b.estado.teams[0].isAttacking, !atacaAntes);
  assert.equal(aSalida(b.estado).hasEnteredOvertime, true);
  assert.deepEqual(aSalida(b.estado).tools.timeoutCounter, { max: 2, left: 1, right: 2 });
  b.fase(25, 'combat').fase(25, 'end').manda('score', { team_0: 13, team_1: 12 });
  b.fase(26, 'shopping');
  assert.equal(b.estado.teams[0].isAttacking, atacaAntes);
  assert.deepEqual(aSalida(b.estado).tools.timeoutCounter, { max: 2, left: 1, right: 2 });
});

test('prórroga: el extra es configurable (0 = ninguno)', () => {
  const b = new Banco(partidoNuevo({}, undefined, 0));
  b.manda('left_timeout').espera(61_000);
  for (let r = 1; r <= 24; r++) b.ronda(r, [Math.ceil(r / 2), Math.floor(r / 2)]);
  b.fase(25, 'shopping');
  assert.equal(aSalida(b.estado).tools.timeoutCounter.left, 1);
});

test('swift: cambio en la 5 y sin prórroga', () => {
  const b = new Banco().manda('game_mode', 'swift');
  assert.equal(b.estado.switchRound, 5);
  assert.equal(b.estado.firstOtRound, 99);
  for (let r = 1; r <= 4; r++) b.ronda(r, [r, 0]);
  b.fase(5, 'shopping');
  assert.equal(b.estado.teams[0].isAttacking, false);
});

test('mapas: nombre visible, desconocido tal cual (nunca otro mapa), Piazza sin espacio', () => {
  const b = new Banco().manda('map', 'Infinityy');
  assert.equal(b.estado.map, 'Abyss');
  assert.equal(b.manda('map', 'HURM_Yard').estado.map, 'Piazza');
  assert.equal(b.manda('map', 'Nuevo').estado.map, 'Nuevo', 'un código que no se conoce no se traduce a otro mapa');
});

/* ── Killfeed ───────────────────────────────────────────────────────────── */

test('killfeed: respaldo de kills, muertes y asistencias sin marcador', () => {
  const b = new Banco();
  b.alta('a1', 0, 'Atacante', 'Wushu').alta('a2', 0, 'Ayudante', 'Iris').alta('d1', 1, 'Victima', 'Sarge');
  b.fase(1, 'shopping').fase(1, 'combat');
  b.manda('killfeed', {
    attacker: 'Atacante', victim: 'Victima', weaponKillfeedInternal: 'TX_Hud_Volcano', headshotKill: true,
    assists: ['TX_Killfeed_Iris'], isTeamkill: false,
  });
  const [a1, a2] = b.estado.teams[0].players;
  const d1 = b.estado.teams[1].players[0];
  assert.equal(a1.kills, 1);
  assert.equal(a1.killsThisRound, 1);
  assert.deepEqual(a1.killedPlayerNames, ['Victima']);
  assert.equal(a1.headshotKills, 1);
  assert.equal(a2.assists, 1, 'las asistencias de Miks ya casan');
  assert.equal(d1.isAlive, false);
  assert.equal(d1.deaths, 1);
});

/* ── Rótulo ─────────────────────────────────────────────────────────────── */

test('rótulo: poner con título, sustituir, caducar solo y quitar', () => {
  const b = new Banco();
  b.manda('toast', { active: true, title: 'Título', message: 'Hola', duration: 5000, selectedTeam: 'left' });
  assert.equal(b.estado.toastInfo.active, true);
  assert.equal(b.estado.toastInfo.title, 'Título');
  b.manda('toast', { active: true, title: 'Otro', message: 'Adiós', duration: null });
  assert.equal(b.estado.toastInfo.message, 'Adiós');
  b.espera(10_000);
  assert.equal(b.estado.toastInfo.active, true, 'sin duración no caduca');
  b.manda('toast', { active: false, title: '', message: '', duration: null });
  assert.equal(b.estado.toastInfo.active, false);
  b.manda('toast', { active: false });
  assert.equal(b.estado.toastInfo.active, false, 'quitar sin rótulo no enciende uno vacío');
  b.manda('toast', { active: true, message: 'Breve', duration: 2000 });
  b.espera(1000);
  assert.equal(b.estado.toastInfo.active, true);
  b.espera(1500);
  assert.equal(b.estado.toastInfo.active, false);
});

test('rótulo: el combate lo retira', () => {
  const b = new Banco().manda('toast', { active: true, message: 'x', duration: null });
  b.fase(1, 'shopping').fase(1, 'combat');
  assert.equal(b.estado.toastInfo.active, false);
});

/* ── Datos de los jugadores ─────────────────────────────────────────────── */

test('aux_scoreboard_team va al equipo del remitente (también el izquierdo)', () => {
  const b = new Banco();
  b.alta('i1', 0, 'I1').alta('i2', 0, 'I2').alta('d1', 1, 'D1');
  b.fase(1, 'shopping');
  const companeros = [{ playerId: 'i2', agentInternal: 'Clay', isAlive: true, money: 3900, kills: 4, deaths: 1, assists: 2 }];
  b.manda('aux_scoreboard_team', JSON.stringify(companeros), { playerId: 'i1' });
  const i2 = b.estado.teams[0].players[1];
  assert.equal(i2.kills, 4);
  assert.equal(i2.agentProper, 'Raze');
  assert.equal(i2.auxiliaryAvailable.scoreboard, true);
});

test('aux_scoreboard no pisa el marcador del observador', () => {
  const b = new Banco().alta('p1', 0, 'Uno');
  b.fase(1, 'shopping');
  const base = { name: 'Uno', tagline: 'TAG', playerId: 'p1', startTeam: 0, isAlive: true, deaths: 0, assists: 0 };
  b.manda('scoreboard', { ...base, kills: 1 });
  b.manda('aux_scoreboard', { ...base, kills: 5 }, { playerId: 'p1' });
  assert.equal(b.estado.teams[0].players[0].kills, 1);
});

test('aux_health, aux_abilities y desconexión del jugador', () => {
  const b = new Banco().alta('p1', 1, 'Uno');
  b.manda('aux_health', 67, { playerId: 'p1' });
  b.manda('aux_abilities', { grenade: 1, ability_1: 0, ability_2: 2, ultimate: 1 }, { playerId: 'p1' });
  const j = () => b.estado.teams[1].players[0];
  assert.equal(j().health, 67);
  assert.deepEqual(j().abilities, { grenade: 1, ability1: 0, ability2: 2 });
  assert.deepEqual(j().auxiliaryAvailable, { health: true, abilities: true, scoreboard: false });
  b.evento({ type: '@jugador_desconectado', timestamp: b.t, playerId: 'p1' });
  assert.deepEqual(j().auxiliaryAvailable, { health: false, abilities: false, scoreboard: false });
});

test('aux_round_report repetido en la misma ronda no duplica los totales', () => {
  const b = new Banco().alta('p1', 0, 'Uno');
  b.fase(1, 'shopping');
  const informe = { damage: 145, damageReceived: 82, headshots: 1 };
  b.manda('aux_round_report', informe, { playerId: 'p1' });
  b.manda('aux_round_report', informe, { playerId: 'p1' });
  let j = b.estado.teams[0].players[0];
  assert.equal(j.totalDamage, 145);
  b.fase(1, 'combat').fase(1, 'end').manda('score', { team_0: 1, team_1: 0 });
  b.fase(2, 'shopping');
  b.manda('aux_round_report', { damage: 50, damageReceived: 0, headshots: 0 }, { playerId: 'p1' });
  j = b.estado.teams[0].players[0];
  assert.equal(j.totalDamage, 195);
  assert.equal(j.damageThisRound, 50);
});

test('iconos especiales: Astra apuntando', () => {
  const b = new Banco().alta('p1', 0, 'Uno', 'Rift');
  b.manda('aux_astra_targeting', true, { playerId: 'p1' });
  assert.equal(b.estado.teams[0].players[0].iconNameSuffix, 'Targeting');
  b.manda('aux_cypher_cam', true, { playerId: 'p1' });
  assert.equal(b.estado.teams[0].players[0].iconNameSuffix, 'Targeting', 'no es Cypher');
});

/* ── Intercambios y configuración ───────────────────────────────────────── */

test('swap_identity cambia sólo nombre, tricode y logo', () => {
  const b = new Banco().alta('p1', 0, 'Uno').manda('swap_identity');
  assert.equal(b.estado.teams[0].teamName, 'Derecha');
  assert.equal(b.estado.teams[0].players.length, 1);
  assert.equal(b.estado.teams[0].isAttacking, true);
});

test('configura: parche de torneo, cámaras y equipos', () => {
  const b = new Banco();
  b.evento({
    type: '@configura',
    timestamp: b.t,
    parche: {
      tournamentInfo: { name: 'Copa' },
      playercamsInfo: { enable: true, identifier: 'sala', enabledPlayers: ['A#1', 3] },
      equipos: [null, { name: 'Nuevo', tricode: '', url: 'n.png' }],
    },
  });
  const s = aSalida(b.estado);
  assert.equal(s.tools.tournamentInfo.name, 'Copa');
  assert.equal(s.tools.tournamentInfo.logoUrl, '');
  assert.deepEqual(s.tools.playercamsInfo, { enable: true, identifier: 'sala', enabledPlayers: [] });
  assert.equal(s.teams[1].teamName, 'Nuevo');
  assert.equal(s.teams[1].teamTricode, 'DER', 'tricode vacío no pisa');
});

test('cámaras: quién publica lo fija el servidor, el panel no puede', () => {
  const b = new Banco();
  b.evento({ type: '@camaras', timestamp: b.t, publicando: ['A#1', 'B#2'] });
  assert.deepEqual(aSalida(b.estado).tools.playercamsInfo.enabledPlayers, ['A#1', 'B#2']);
  b.evento({
    type: '@configura',
    timestamp: b.t,
    parche: { playercamsInfo: { enable: true, enabledPlayers: ['Falso#9'] } },
  });
  assert.deepEqual(aSalida(b.estado).tools.playercamsInfo.enabledPlayers, ['A#1', 'B#2']);
  b.evento({ type: '@camaras', timestamp: b.t, publicando: [] });
  assert.deepEqual(aSalida(b.estado).tools.playercamsInfo.enabledPlayers, []);
});

/* ── Serialización ──────────────────────────────────────────────────────── */

test('serialización: sin campos internos, indefinidos fuera', () => {
  const b = new Banco();
  const texto = serializa(b.estado);
  const o = JSON.parse(texto);
  assert.equal('interno' in o, false);
  assert.equal('roundTimeoutTime' in o, false);
  assert.equal('agentSelectStartTime' in o, false);
  assert.deepEqual(o.timeoutState, { techPause: false, leftTeam: false, rightTeam: false, timeRemaining: 0 });
  assert.equal(o.tools.timeoutMax, undefined);
  assert.equal(typeof o.tools.timeoutCounter.max, 'number');
  b.fase(1, 'shopping').fase(1, 'combat');
  assert.equal(typeof JSON.parse(serializa(b.estado)).roundTimeoutTime, 'number');
});

test('@reinicia_partida: deja el estado de juego limpio (ronda, marcador, jugadores) y conserva la configuración', async () => {
  const { Banco } = await import('./ayudas.ts');
  const b = new Banco();
  b.manda('match_start', 'partida-vieja');
  b.alta('a1', 0, 'Ana').alta('b1', 1, 'Beto');
  b.ronda(1, [1, 0]).ronda(2, [2, 0]);
  b.fase(3, 'shopping');
  assert.equal(b.estado.roundNumber, 3);
  assert.equal(b.estado.teams[0].roundsWon, 2);
  assert.equal(b.estado.teams[0].players.length + b.estado.teams[1].players.length, 2);
  const nombres = b.estado.teams.map((t) => t.teamName);

  b.evento({ type: '@reinicia_partida', timestamp: b.t });
  assert.equal(b.ultimo.cambiado, true);
  assert.equal(b.estado.roundNumber, 0);
  assert.equal(b.estado.roundPhase, 'LOBBY');
  assert.deepEqual(b.estado.teams.map((t) => t.roundsWon), [0, 0]);
  assert.deepEqual(b.estado.teams.map((t) => t.players.length), [0, 0], 'nadie de la partida anterior se queda');
  assert.equal(b.estado.matchId, '');
  assert.equal(b.estado.isRunning, false);
  assert.deepEqual(b.estado.teams.map((t) => t.teamName), nombres, 'los equipos (configuración) siguen');

  // La partida nueva empieza como una cualquiera.
  b.manda('match_start', 'partida-nueva').alta('a2', 0, 'Ana');
  assert.equal(b.estado.matchId, 'partida-nueva');
  assert.equal(b.estado.teams[0].players.length, 1);
});

test('pausa visual: pone la pausa, se asigna al equipo con un clic y se acaba sola al volver el color; no vale fuera de la compra', () => {
  let e = partidoNuevo({});
  const manda = (ev: Record<string, unknown>) => (e = reduce(e, ev as never).estado);
  const gris = (activa: boolean, t: number) => manda({ type: '@pausa_visual', timestamp: t, activa });
  const s = () => aSalida(e).timeoutState;
  gris(true, 1);
  assert.equal(s().techPause, false, 'en el lobby no se hace caso');
  e.isRunning = true;
  e.roundPhase = 'combat';
  gris(true, 2);
  assert.equal(s().techPause, false, 'fuera de la compra no se hace caso (los timeouts sólo ocurren en la compra)');
  e.roundPhase = 'shopping';
  gris(true, 3);
  assert.equal(s().techPause, true, 'gris + timer quieto → pausa al instante');
  // El operador dice de quién fue: pasa a ser ese timeout (con cuenta atrás y descontado).
  manda({ type: 'left_timeout', timestamp: 4 });
  assert.equal(s().techPause, false);
  assert.equal(s().leftTeam, true, 'el timeout del equipo izquierdo corre');
  assert.equal(aSalida(e).tools.timeoutCounter.left, 1, 'y le quedan 1 de 2');
  // Vuelve el color: el timeout asignado se acaba (no se queda los 60 s enteros).
  gris(false, 5000);
  assert.equal(s().leftTeam, false, 'al volver el color, termina');
  assert.equal(aSalida(e).tools.timeoutCounter.left, 1, 'y sigue descontado');
  // Una pausa que puso el operador a mano no la quita el color.
  manda({ type: 'tech_pause', timestamp: 6000 });
  assert.equal(s().techPause, true);
  gris(false, 7000);
  assert.equal(s().techPause, true, 'la pausa manual manda');
  manda({ type: 'tech_pause', timestamp: 8000 });
  // Y una automática no sobrevive a la compra.
  gris(true, 9000);
  assert.equal(s().techPause, true);
  manda({ type: 'round_info', timestamp: 10000, data: { roundPhase: 'combat' } });
  assert.equal(s().techPause, false, 'la pausa automática no sobrevive a la compra');
});
