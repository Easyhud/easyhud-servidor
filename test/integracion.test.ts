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
  const primeraConfig = espera(llamado, 'cam_config');
  llamado.emit(
    'aux_logon',
    JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'JugadorDos', matchId: '', groupCode: grupo, playerId: '00000000-0000-4000-8000-000000000001' }),
  );
  assert.deepEqual(await aceptado, { type: 'aux_authenticate', value: true });

  // Cámaras: el jugador recibe la configuración al entrar y cuando el operador la cambia.
  const c0 = await primeraConfig;
  assert.equal(c0.enable, false);
  assert.equal(c0.base, 'https://vdo.ninja');
  assert.match(c0.clave, /^[A-Za-z0-9_-]{16}$/);
  const nuevaConfig = espera(llamado, 'cam_config', (c) => c.enable === true);
  mando.emit('configura', JSON.stringify({ playercamsInfo: { enable: true, identifier: 'SALA9' } }));
  const c1 = await nuevaConfig;
  assert.equal(c1.room, 'SALA9');
  assert.equal(c1.clave, c0.clave, 'la clave es estable para el grupo');

  // Un jugador no puede escribir en otro grupo ni mandar datos de observador.
  llamado.emit('obs_data', JSON.stringify({ obsName: 'x', groupCode: grupo, type: 'switch_kda_credits', data: true }));
  // Pero sí sus datos propios (y el matchId del paquete no importa). Con el playerId de OTRO, el paquete se descarta (S3).
  llamado.emit('aux_data', JSON.stringify({ playerId: 'otro-cualquiera', matchId: 'da-igual', type: 'aux_health', data: 7 }));
  const conVida = espera(overlay, 'match_data', (x) => x.teams[1].players[0].health === 42);
  llamado.emit('aux_data', JSON.stringify({ playerId: '00000000-0000-4000-8000-000000000001', matchId: 'da-igual', type: 'aux_health', data: 42 }));
  const v = await conVida;
  assert.equal(v.showAliveKDA, false, 'el obs_data del jugador se descartó');
  assert.equal(v.teams[1].players[0].auxiliaryAvailable.health, true);

  // Cámara: el jugador anuncia que publica; un nombre inválido se ignora.
  const conCamara = espera(overlay, 'match_data', (x) => x.tools.playercamsInfo.enabledPlayers.length === 1);
  llamado.emit('aux_data', JSON.stringify({ playerId: 'x', matchId: '', type: 'aux_cam', data: { publishing: true, id: 'JugadorDos#EUW' } }));
  assert.deepEqual((await conCamara).tools.playercamsInfo.enabledPlayers, ['JugadorDos#EUW']);
  llamado.emit('aux_data', JSON.stringify({ playerId: 'x', matchId: '', type: 'aux_cam', data: { publishing: true, id: 'sin-tag' } }));
  const sinCamara = espera(overlay, 'match_data', (x) => x.tools.playercamsInfo.enabledPlayers.length === 0);
  await sinCamara;

  // Y al volver a publicar y desconectarse, sale de la lista.
  llamado.emit('aux_data', JSON.stringify({ playerId: 'x', matchId: '', type: 'aux_cam', data: { publishing: true, id: 'JugadorDos#EUW' } }));
  await espera(overlay, 'match_data', (x) => x.tools.playercamsInfo.enabledPlayers.length === 1);
  const sinConexion = espera(overlay, 'match_data', (x) => x.tools.playercamsInfo.enabledPlayers.length === 0);
  llamado.close();
  await sinConexion;

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

test('"Call players" insiste hasta que el jugador conecta y el panel ve quién tiene el programa', async () => {
  const grupo = 'INSISTE';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  // El jugador todavía no ha abierto el programa: nadie a quien avisar.
  const acuse = espera(obs, 'llamar_jugadores_ack');
  obs.emit('llamar_jugadores', JSON.stringify({ puuids: ['p-tarde', 'p-nunca'] }));
  assert.deepEqual(await acuse, { avisados: [] });

  // Lo abre después: su primer latido ya recibe la llamada que quedó pendiente.
  const j = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => j.once('connect', () => r()));
  const llamada = espera(j, 'te_llaman');
  j.emit('cliente_presente', JSON.stringify({ puuid: 'p-tarde' }));
  assert.deepEqual(await llamada, { groupCode: grupo });

  // El panel pregunta por los dos: sólo uno tiene el programa abierto.
  const mando = conecta(servidor.puertos.salida, '/operador');
  await new Promise<void>((r) => mando.once('connect', () => r()));
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
  await listo;
  const respuesta = espera(mando, 'presencia');
  mando.emit('presencia_consulta', JSON.stringify({ puuids: ['p-tarde', 'p-nunca'] }));
  const r = (await respuesta) as { activos: string[]; estado: Record<string, { app: boolean }> };
  assert.deepEqual(r.activos, ['p-tarde']);
  assert.deepEqual([r.estado['p-tarde'].app, r.estado['p-nunca'].app], [true, false]);

  // Si el aviso se pierde, el siguiente latido lo repite…
  const repetida = espera(j, 'te_llaman');
  j.emit('cliente_presente', JSON.stringify({ puuid: 'p-tarde' }));
  assert.deepEqual(await repetida, { groupCode: grupo });

  // …pero en cuanto entra al grupo deja de llamarse.
  const entra = espera(j, 'aux_logon_ack');
  j.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'Tarde', matchId: '', groupCode: grupo, playerId: 'p-tarde' }));
  assert.equal((await entra).value, true);
  let volvieron = false;
  j.on('te_llaman', () => (volvieron = true));
  j.emit('cliente_presente', JSON.stringify({ puuid: 'p-tarde' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(volvieron, false, 'ya está dentro: no se le vuelve a llamar');

  // Una lista vacía cancela la llamada a quien falte.
  obs.emit('llamar_jugadores', JSON.stringify({ puuids: [] }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(servidor.central.grupoPendiente('p-nunca'), undefined);
});

test('"Call players" lleva el código de la sala de Riot cuando ya existe', async () => {
  const grupo = 'CONCODIGO';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  const jugador = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => jugador.once('connect', () => r()));
  jugador.emit('cliente_presente', JSON.stringify({ puuid: 'p-codigo' }));
  await new Promise((r) => setTimeout(r, 100));

  // Sin sala todavía: sólo el grupo.
  const sinSala = espera(jugador, 'te_llaman');
  obs.emit('llamar_jugadores', JSON.stringify({ puuids: ['p-codigo'] }));
  assert.deepEqual(await sinSala, { groupCode: grupo });

  // El observador crea la sala (el lector manda su código): la siguiente llamada lo lleva.
  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: { codigo: 'ABC123', equipoUno: [], equipoDos: [] } }));
  await new Promise((r) => setTimeout(r, 100));
  const conSala = espera(jugador, 'te_llaman');
  obs.emit('llamar_jugadores', JSON.stringify({ puuids: ['p-codigo'] }));
  assert.deepEqual(await conSala, { groupCode: grupo, inviteCode: 'ABC123' });

  // Y el reintento por latido también.
  const porLatido = espera(jugador, 'te_llaman');
  jugador.emit('cliente_presente', JSON.stringify({ puuid: 'p-codigo' }));
  assert.deepEqual(await porLatido, { groupCode: grupo, inviteCode: 'ABC123' });
});

test('"Call players" insiste con el código vigente hasta que el jugador está DENTRO de la sala de Riot', async () => {
  const grupo = 'REINSISTE';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  // El jugador tiene el programa abierto y ya entró al grupo (conectado al servidor).
  const jugador = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => jugador.once('connect', () => r()));
  jugador.emit('cliente_presente', JSON.stringify({ puuid: 'p-sala' }));
  const entra = espera(jugador, 'aux_logon_ack');
  jugador.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'Sala', matchId: '', groupCode: grupo, playerId: 'p-sala' }));
  assert.equal((await entra).value, true);

  // Hay una sala de Riot y él NO está en ella: se le llama.
  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: { codigo: 'VIEJA1', equipoUno: [], equipoDos: [] } }));
  await new Promise((r) => setTimeout(r, 100));
  const acuse = espera(obs, 'llamar_jugadores_ack');
  obs.emit('llamar_jugadores', JSON.stringify({ puuids: ['p-sala'] }));
  await acuse;

  // El operador cierra esa sala y crea otra: el aviso siguiente lleva el código NUEVO.
  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: { codigo: 'NUEVA2', equipoUno: [], equipoDos: [] } }));
  await new Promise((r) => setTimeout(r, 100));
  const otra = espera(jugador, 'te_llaman', (d) => d.inviteCode === 'NUEVA2');
  servidor.central.insiste();
  assert.deepEqual(await otra, { groupCode: grupo, inviteCode: 'NUEVA2' });

  // En cuanto aparece en la lista de la sala, deja de llamársele.
  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: { codigo: 'NUEVA2', equipoUno: [{ puuid: 'p-sala' }], equipoDos: [] } }));
  await new Promise((r) => setTimeout(r, 100));
  let volvio = false;
  jugador.on('te_llaman', () => (volvio = true));
  servidor.central.insiste();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(volvio, false, 'ya está dentro de la sala: no se le insiste');
});

test('diagnóstico por la red: el exe late con su estado, recibe el acuse y el panel ve el veredicto y los paquetes', async () => {
  const grupo = 'DIAGRED';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  const j = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => j.once('connect', () => r()));
  const estado = {
    version: '0.3.5', gep: 'listo', gepVersion: '315.0.2', juegoAbierto: true, juegoDetectado: true, eventosHace: 1500,
    datos: 'cerrada', red: '', riot: 'signed in', camara: { permitida: false, publicando: false, error: '' },
    enviados: {}, errores: [],
  };
  // Con acuse: el servidor contesta al latido.
  const acuse = await new Promise<{ ok: boolean; servidor: string }>((resolve) =>
    j.emit('cliente_presente', JSON.stringify({ puuid: 'p-diag', estado }), resolve),
  );
  assert.equal(acuse.ok, true);
  assert.ok(acuse.servidor.length > 0);

  // Entra al grupo y manda datos: el servidor cuenta los paquetes por tipo.
  const entra = espera(j, 'aux_logon_ack');
  j.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'Diag', matchId: '', groupCode: grupo, playerId: 'p-diag' }));
  assert.equal((await entra).value, true);
  j.emit('aux_data', JSON.stringify({ playerId: 'p-diag', groupCode: grupo, type: 'aux_health', data: 100 }));
  j.emit('aux_data', JSON.stringify({ playerId: 'p-diag', groupCode: grupo, type: 'aux_health', data: 90 }));
  // El observador manda un marcador suyo.
  obs.emit('obs_data', JSON.stringify({ obsName: 'o', groupCode: grupo, type: 'scoreboard', data: { name: 'Diag', tagline: 'T', playerId: 'p-diag', startTeam: 0, money: 800 } }));
  await new Promise((r) => setTimeout(r, 200));

  const mando = conecta(servidor.puertos.salida, '/operador');
  await new Promise<void>((r) => mando.once('connect', () => r()));
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
  await listo;
  const respuesta = espera(mando, 'presencia');
  mando.emit('presencia_consulta', JSON.stringify({ puuids: ['p-diag', 'p-vacio'] }));
  const r = (await respuesta) as {
    estado: Record<string, { veredicto: string; dentro: boolean; diag: { version: string; haceMs: number } | null; paquetes: Record<string, { n: number }>; marcador: { n: number } | null }>;
  };
  assert.equal(r.estado['p-diag'].veredicto, 'ok');
  assert.equal(r.estado['p-diag'].dentro, true);
  assert.equal(r.estado['p-diag'].diag?.version, '0.3.5');
  assert.equal(r.estado['p-diag'].paquetes.aux_health.n, 2);
  assert.equal(r.estado['p-diag'].marcador?.n, 1);
  assert.equal(r.estado['p-vacio'].veredicto, 'sin-programa');
});

test('sala nula: el observador dice que ya no hay sala y el panel deja de ver la vieja', async () => {
  const grupo = 'SALANULA';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: { codigo: 'VIEJA9', equipoUno: [{ puuid: 'p1' }], equipoDos: [] } }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(servidor.central.codigoSala(grupo), 'VIEJA9');

  // El panel escucha las salas del grupo (como los overlays: por el logon de salida).
  const mirada = conecta(servidor.puertos.salida);
  await new Promise<void>((r) => mirada.once('connect', () => r()));
  const dentro = espera(mirada, 'logon_success');
  mirada.emit('logon', JSON.stringify({ groupCode: grupo, token }));
  await dentro;
  const vacia = espera(mirada, 'sala', (d) => d.codigo === '');

  obs.emit('obs_lobby', JSON.stringify({ obsName: 'o', groupCode: grupo, sala: null }));
  const s = (await vacia) as { codigo: string; equipoUno: unknown[]; conectados: unknown[] };
  assert.equal(s.codigo, '');
  assert.deepEqual(s.equipoUno, []);
  assert.equal(servidor.central.codigoSala(grupo), '', 'el servidor ya no recuerda la sala vieja');
});

test('caja negra: el operador pide el informe, el programa lo manda, se guarda en disco y el panel lo ve', async () => {
  const grupo = 'CAJANEGRA';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  const puuid = '11111111-2222-3333-4444-555555555555';
  const j = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => j.once('connect', () => r()));
  const acuse = await new Promise<{ ok: boolean }>((resolve) => j.emit('cliente_presente', JSON.stringify({ puuid }), resolve));
  assert.equal(acuse.ok, true);

  // El operador pide el informe de ese jugador (y de otro que no tiene el programa abierto).
  const mando = conecta(servidor.puertos.salida, '/operador');
  await new Promise<void>((r) => mando.once('connect', () => r()));
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
  await listo;
  const piden = espera(j, 'pide_informe');
  const respuesta = espera(mando, 'informe_pedido', (d) => d.puuid === puuid);
  mando.emit('orden', JSON.stringify({ tipo: 'pideInforme', datos: { puuid } }));
  await piden;
  assert.equal(((await respuesta) as { ok: boolean }).ok, true);
  const ausente = espera(mando, 'informe_pedido', (d) => d.puuid === 'ffffffff-0000-0000-0000-000000000000');
  mando.emit('orden', JSON.stringify({ tipo: 'pideInforme', datos: { puuid: 'ffffffff-0000-0000-0000-000000000000' } }));
  assert.equal(((await ausente) as { ok: boolean }).ok, false, 'sin programa abierto no llega');

  // El programa manda su informe: se guarda y el panel lo ve.
  const informe = { formato: 1, estado: { gep: 'listo' }, conclusiones: [{ id: 'overwolf-no-entrega', certeza: 'confirmada', texto: 'Overwolf no genera la vida en este PC.' }, { id: 'malo', certeza: 'inventada', texto: 'x' }] };
  const guardado = await new Promise<{ ok: boolean }>((resolve) =>
    j.emit('informe_cliente', JSON.stringify({ puuid, informe: JSON.stringify(informe) }), resolve),
  );
  assert.equal(guardado.ok, true);
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const enDisco = JSON.parse(readFileSync(join(carpeta, 'informes', `${puuid}.json`), 'utf8'));
  assert.equal(enDisco.formato, 1);
  assert.ok((servidor.central.estadoJugadores(grupo, [puuid])[puuid].informe?.bytes ?? 0) > 0);
  assert.deepEqual(servidor.central.estadoJugadores(grupo, [puuid])[puuid].informe?.conclusiones, [{ id: 'overwolf-no-entrega', certeza: 'confirmada', texto: 'Overwolf no genera la vida en este PC.' }], 'sólo las conclusiones válidas llegan al panel');

  // Un informe que no es suyo o demasiado grande se rechaza.
  const grande = await new Promise<{ ok: boolean }>((resolve) =>
    j.emit('informe_cliente', JSON.stringify({ puuid, informe: 'x'.repeat(700 * 1024) }), resolve),
  );
  assert.equal(grande.ok, false);
  const raro = await new Promise<{ ok: boolean }>((resolve) =>
    j.emit('informe_cliente', JSON.stringify({ puuid: '../../etc/passwd', informe: '{}' }), resolve),
  );
  assert.equal(raro.ok, false, 'un puuid con rutas raras no escribe nada');
  obs.close();
});

test('orden remota a un jugador: sólo «reconecta» está permitida, y sólo llega a quien tiene el programa abierto', async () => {
  const grupo = 'ORDENREMOTA';
  const token = firmaToken(grupo, 1, 'c', SECRETO);
  const { socket: obs, ack } = await intentaObservador(grupo, token);
  assert.equal(ack.value, true);

  const puuid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const j = conecta(servidor.puertos.ingesta);
  await new Promise<void>((r) => j.once('connect', () => r()));
  await new Promise<{ ok: boolean }>((resolve) => j.emit('cliente_presente', JSON.stringify({ puuid }), resolve));

  const mando = conecta(servidor.puertos.salida, '/operador');
  await new Promise<void>((r) => mando.once('connect', () => r()));
  const listo = espera(mando, 'operador_listo');
  mando.emit('operador_logon', JSON.stringify({ groupCode: grupo, token }));
  await listo;

  const llega = espera(j, 'orden_remota');
  const resp = espera(mando, 'orden_jugador', (d) => d.accion === 'reconecta');
  mando.emit('orden', JSON.stringify({ tipo: 'ordenJugador', datos: { puuid, accion: 'reconecta' } }));
  assert.deepEqual(await llega, { accion: 'reconecta' });
  assert.equal(((await resp) as { ok: boolean }).ok, true);

  // Una acción que no está en la lista no se envía.
  let recibida = false;
  j.on('orden_remota', () => (recibida = true));
  const mala = espera(mando, 'orden_jugador', (d) => d.accion === 'borra-todo');
  mando.emit('orden', JSON.stringify({ tipo: 'ordenJugador', datos: { puuid, accion: 'borra-todo' } }));
  assert.equal(((await mala) as { ok: boolean }).ok, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(recibida, false, 'una orden fuera de la lista no llega al programa');
  obs.close();
});
