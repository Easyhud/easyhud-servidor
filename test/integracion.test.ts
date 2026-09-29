/**
 * Integración: el servidor de verdad, en puertos libres, con clientes
 * socket.io de verdad. Reproduce una grabación real y comprueba lo que ve un
 * overlay, lo que responde a los logons y lo que hace el operador.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { arranca, type Servidor } from '../src/servidor.ts';
import { leeGrabacion } from '../src/grabacion.ts';
import { firmaToken } from '../src/token.ts';
import { silencia } from '../src/log.ts';
import type { Config } from '../src/config.ts';

const SECRETO = 's'.repeat(48);
const FIXTURE = new URL('./fixtures/Match_TORNEO2_1788925164030.replay', import.meta.url);

let servidor: Servidor;
let carpeta: string;
const abiertos: Socket[] = [];

before(async () => {
  silencia(true);
  carpeta = mkdtempSync(join(tmpdir(), 'easyhud-replays-'));
  const config: Config = {
    inseguro: true,
    secretoToken: SECRETO,
    sinAutenticacion: false,
    exigirTokenOverlay: true,
    grabar: true,
    carpetaGrabaciones: carpeta,
    extraProrroga: 1,
    minutosInactividad: 30,
    puertos: { ingesta: 0, salida: 0, extras: 0 },
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

/** Espera un evento cuya carga (JSON) cumpla el predicado. */
function espera<T = any>(s: Socket, evento: string, cumple: (d: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const reloj = setTimeout(() => {
      s.off(evento, oyente);
      reject(new Error(`no llegó ${evento} a tiempo`));
    }, ms);
    const oyente = (msg: unknown) => {
      assert.equal(typeof msg, 'string', `${evento} debe viajar como cadena JSON`);
      const d = JSON.parse(msg as string);
      if (!cumple(d)) return;
      clearTimeout(reloj);
      s.off(evento, oyente);
      resolve(d);
    };
    s.on(evento, oyente);
  });
}

const logonObservador = (grupo: string, key: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'authenticate',
    clientVersion: '0.3.3',
    obsName: 'Observador',
    key,
    groupCode: grupo,
    groupSecret: '',
    leftTeam: { name: '', tricode: '', url: '', attackStart: true },
    rightTeam: { name: '', tricode: '', url: '', attackStart: false },
    toolsData: { timeoutCounter: { max: 2, left: 2, right: 2 }, timeoutDuration: 60 },
    ...extra,
  });

async function intentaObservador(grupo: string, key: string, extra: Record<string, unknown> = {}) {
  const s = conecta(servidor.puertos.ingesta);
  const ack = espera(s, 'obs_logon_ack');
  s.emit('obs_logon', logonObservador(grupo, key, extra));
  return { socket: s, ack: await ack };
}

test('GET /status', async () => {
  const r = await fetch(`http://localhost:${servidor.puertos.extras}/status`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const cuerpo = (await r.json()) as { status: string; matchesRunning: unknown };
  assert.equal(cuerpo.status, 'UP');
  assert.equal(typeof cuerpo.matchesRunning, 'number');
});

test('obs_logon: rechazos con los textos que entiende el cliente', async () => {
  const sinTipo = await intentaObservador('RECHAZO', 'x', { type: 'otra' });
  assert.deepEqual(sinTipo.ack, { type: 'authenticate', value: false, reason: 'Invalid packet.' });

  const version = await intentaObservador('RECHAZO', firmaToken('RECHAZO', 1, 'c', SECRETO), { clientVersion: '0.2.0' });
  assert.match(version.ack.reason, /not compatible with server version \d/);

  const basura = await intentaObservador('RECHAZO', 'no-es-un-token');
  assert.equal(basura.ack.reason, 'Invalid Key');

  const otroGrupo = await intentaObservador('RECHAZO', firmaToken('OTRO', 1, 'c', SECRETO));
  assert.equal(otroGrupo.ack.reason, 'Invalid Key');

  const caducado = await intentaObservador('RECHAZO', firmaToken('RECHAZO', 1, 'c', SECRETO, Date.now() - 3 * 86400_000));
  assert.equal(caducado.ack.reason, 'Expired Key');

  // Tras un rechazo, el servidor corta.
  await new Promise<void>((resolve) => (caducado.socket.connected ? caducado.socket.once('disconnect', () => resolve()) : resolve()));
});

test('overlay: sin token o con token de otro grupo, logon_denied', async () => {
  const s = conecta(servidor.puertos.salida);
  const denegado = espera(s, 'logon_denied');
  s.emit('logon', JSON.stringify({ groupCode: 'TORNEO2', token: '' }));
  assert.deepEqual(await denegado, { reason: 'sin token' });

  const s2 = conecta(servidor.puertos.salida);
  const denegado2 = espera(s2, 'logon_denied');
  s2.emit('logon', JSON.stringify({ groupCode: 'TORNEO2', token: firmaToken('OTRO', 1, 'c', SECRETO) }));
  assert.deepEqual(await denegado2, { reason: 'es para el grupo OTRO' });
});

test('reproducción de una grabación real: el overlay recibe match_data', async () => {
  const { cabecera, paquetes } = leeGrabacion(readFileSync(FIXTURE, 'utf8'));
  const grupo = String(cabecera.groupCode);
  const token = firmaToken(grupo, 1, 'Pruebas', SECRETO);

  // El overlay se suscribe antes de que haya partido.
  const overlay = conecta(servidor.puertos.salida);
  const exito = espera(overlay, 'logon_success');
  overlay.emit('logon', JSON.stringify({ groupCode: grupo, token }));
  assert.deepEqual(await exito, { groupCode: grupo, msg: `Logon succeeded for group code ${grupo}` });

  // El panel también: mira y manda.
  const mando = conecta(servidor.puertos.salida, '/operador');
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
  assert.deepEqual(await listo, { groupCode: grupo });

  // Sin partido, la configuración se guarda igual y avisa.
  const sinPartido = espera(mando, 'operador_error');
  mando.emit('configura', JSON.stringify({ equipos: [{ name: 'Tinta Uno', tricode: 'TU1', url: '' }, null] }));
  assert.deepEqual(await sinPartido, { reason: 'sin partido para configurar' });

  // El observador entra con el token de cuentas.
  const primerEstado = espera(overlay, 'match_data');
  const { socket: obs, ack } = await intentaObservador(grupo, token, {
    leftTeam: cabecera.leftTeam,
    rightTeam: cabecera.rightTeam,
    toolsData: cabecera.toolsData,
    clientVersion: cabecera.clientVersion,
  });
  assert.equal(ack.value, true);
  assert.match(ack.reason, /^[A-Z0-9]{12}$/);
  const inicial = await primerEstado;
  assert.equal(inicial.groupCode, grupo);
  assert.equal(inicial.teams[0].teamName, 'Tinta Uno', 'el equipo guardado antes del partido se aplica');

  // Se reproduce la grabación.
  const final = espera(overlay, 'match_data', (m) => m.roundNumber === 5 && m.roundPhase === 'shopping');
  for (const p of paquetes) obs.emit('obs_data', JSON.stringify(p));
  const m = await final;
  assert.equal(m.matchId !== '', true);
  assert.equal(m.teams[1].roundsWon, 4);
  assert.equal(m.teams[1].players[0].name, 'JugadorDos');
  assert.equal(m.teams[1].players[0].agentProper, 'Jett');
  const historial = m.teams[1].roundRecord.filter((r: { type: string }) => r.type !== 'upcoming');
  assert.equal(historial.length, 4);
  assert.equal(m.tools.playercamsInfo.secret, undefined);

  // Orden del operador: tiempo muerto de la izquierda.
  const conTiempo = espera(overlay, 'match_data', (x) => x.timeoutState.leftTeam === true);
  mando.emit('orden', JSON.stringify({ tipo: 'tiempoMuertoIzq', datos: null }));
  const t = await conTiempo;
  assert.deepEqual(t.tools.timeoutCounter, { max: 2, left: 1, right: 2 });

  const malaOrden = espera(mando, 'operador_error');
  mando.emit('orden', JSON.stringify({ tipo: 'noExiste' }));
  assert.deepEqual(await malaOrden, { reason: 'orden no aplicada: noExiste' });

  // Rótulo con título.
  const conRotulo = espera(overlay, 'match_data', (x) => x.toastInfo.active === true);
  mando.emit('orden', JSON.stringify({ tipo: 'rotulo', datos: { active: true, title: 'Final', message: 'Hola', duration: null } }));
  assert.equal((await conRotulo).toastInfo.title, 'Final');

  // Otro observador sin secreto: el grupo está vivo.
  const intruso = await intentaObservador(grupo, token);
  assert.equal(intruso.ack.reason, `Game with Group Code ${grupo} exists and is still live.`);

  // El mismo observador con su secreto: reconexión sin perder estado.
  const vuelta = await intentaObservador(grupo, token, { groupSecret: ack.reason });
  assert.deepEqual(vuelta.ack, { type: 'authenticate', value: true, reason: 'reconnected' });

  // Un jugador de otro partido: rechazo que el cliente sí muestra.
  const jugador = conecta(servidor.puertos.ingesta);
  const rechazo = espera(jugador, 'aux_logon_ack');
  jugador.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'J', matchId: 'NO-EXISTE', playerId: 'x' }));
  assert.deepEqual(await rechazo, { type: 'aux_authenticate', value: false, reason: 'Game with Match ID NO-EXISTE not found.' });

  // Un jugador con matchId vacío y sin grupo no cae en ningún partido.
  const vacio = conecta(servidor.puertos.ingesta);
  const rechazoVacio = espera(vacio, 'aux_logon_ack');
  vacio.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'J', matchId: '', playerId: 'y' }));
  assert.equal((await rechazoVacio).value, false);

  // "Call players": entra por grupo.
  const llamado = conecta(servidor.puertos.ingesta);
  const aceptado = espera(llamado, 'aux_logon_ack');
  llamado.emit(
    'aux_logon',
    JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'JugadorDos', matchId: '', groupCode: grupo, playerId: '00000000-0000-4000-8000-000000000001' }),
  );
  assert.deepEqual(await aceptado, { type: 'aux_authenticate', value: true });

  // Un jugador no puede escribir en otro grupo ni mandar datos de observador.
  llamado.emit('obs_data', JSON.stringify({ obsName: 'x', groupCode: grupo, type: 'switch_kda_credits', data: true }));
  // Pero sí sus datos propios (y el matchId del paquete no importa).
  const conVida = espera(overlay, 'match_data', (x) => x.teams[1].players[0].health === 42);
  llamado.emit('aux_data', JSON.stringify({ playerId: 'otro-cualquiera', matchId: 'da-igual', type: 'aux_health', data: 42 }));
  const v = await conVida;
  assert.equal(v.showAliveKDA, false, 'el obs_data del jugador se descartó');
  assert.equal(v.teams[1].players[0].auxiliaryAvailable.health, true);

  // Fin de mapa: el estado final SÍ llega, y después se echa al observador.
  const estadoFinal = espera(overlay, 'match_data', (x) => x.roundPhase === 'game_end');
  const echado = new Promise<void>((resolve) => vuelta.socket.once('disconnect', () => resolve()));
  vuelta.socket.emit('obs_data', JSON.stringify({ obsName: 'o', groupCode: grupo, type: 'round_info', data: { roundNumber: 5, roundPhase: 'game_end' } }));
  const f = await estadoFinal;
  assert.equal(f.isRunning, false);
  await echado;
  assert.equal(servidor.central.partido(grupo), undefined);

  // La grabación quedó escrita y se puede volver a leer.
  const ficheros = readdirSync(carpeta).filter((n) => n.startsWith(`Match_${grupo}_`));
  assert.equal(ficheros.length, 1);
  const grabada = leeGrabacion(readFileSync(join(carpeta, ficheros[0]), 'utf8'));
  assert.equal(grabada.cabecera.key, undefined);
  assert.equal(grabada.cabecera.groupCode, grupo);
  assert.ok(grabada.paquetes.length >= paquetes.length);
});

test('operador: token inválido → operador_denegado', async () => {
  const mando = conecta(servidor.puertos.salida, '/operador');
  const denegado = espera(mando, 'operador_denegado');
  mando.emit('operador_logon', JSON.stringify({ groupCode: 'X', token: 'malo' }));
  assert.deepEqual(await denegado, { reason: 'token mal formado' });
});

test('presencia y "Call players"', async () => {
  const grupo = 'LLAMADA';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  const jugador = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => jugador.once('connect', () => r()));
  const llamada = espera(jugador, 'te_llaman');
  jugador.emit('cliente_presente', JSON.stringify({ puuid: 'puuid-1' }));
  await new Promise((r) => setTimeout(r, 100));

  const acuse = espera(obs, 'llamar_jugadores_ack');
  obs.emit('llamar_jugadores', JSON.stringify({ puuids: ['puuid-1', 'puuid-que-no-esta'] }));
  assert.deepEqual(await acuse, { avisados: ['puuid-1'] });
  assert.deepEqual(await llamada, { groupCode: grupo });

  // La sala: el observador la manda, el overlay la recibe con `conectados`.
  const overlay = conecta(servidor.puertos.salida);
  const exito = espera(overlay, 'logon_success');
  overlay.emit('logon', JSON.stringify({ groupCode: grupo, token }));
  await exito;
  const sala = espera(overlay, 'sala');
  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: { equipoUno: [{ puuid: 'puuid-1' }, { puuid: 'puuid-2' }], equipoDos: [] } }));
  const s = await sala;
  assert.deepEqual(s.conectados, ['puuid-1']);
});
