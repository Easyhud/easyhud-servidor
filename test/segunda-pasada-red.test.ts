/**
 * Segunda pasada (rama copia-funcional): dos observadores en el mismo grupo y fin de mapa repetido, contra el servidor
 * de verdad (puertos libres).
 *
 * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — connector/websocketIncoming.ts y
 * controller/MatchController.ts (createMatch: mismo secreto = reconexión, otro secreto con dueño vivo = rechazo).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import { arranca, type Servidor } from '../src/servidor.ts';
import { Central, type Difusion } from '../src/central.ts';
import { firmaToken } from '../src/token.ts';
import { silencia } from '../src/log.ts';
import type { Config } from '../src/config.ts';

const SECRETO = 's'.repeat(48);

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
  camaras: { base: 'https://vdo.ninja', params: '' },
};

let servidor: Servidor;
const abiertos: Socket[] = [];

before(async () => {
  silencia(true);
  servidor = await arranca(config);
});

after(async () => {
  for (const s of abiertos) s.close();
  await servidor.cierra();
});

function conecta(puerto: number): Socket {
  const s = io(`http://localhost:${puerto}`, { transports: ['websocket'], reconnection: false, forceNew: true });
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

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      toolsData: {},
    }),
  );
  const a = await ack;
  const manda = (type: string, data: unknown) => s.emit('obs_data', JSON.stringify({ obsName: 'o', groupCode: grupo, type, data }));
  return { socket: s, ack: a, manda };
}

async function overlayDe(grupo: string, token: string) {
  const overlay = conecta(servidor.puertos.salida);
  const ok = espera(overlay, 'logon_success');
  overlay.emit('logon', JSON.stringify({ groupCode: grupo, token }));
  await ok;
  return overlay;
}

test('N1 dos observadores en el mismo grupo: el que vuelve con el secreto sustituye al viejo, que se corta; el intruso sin secreto no entra', async () => {
  const grupo = 'DOSOBS';
  const token = firmaToken(grupo, 1, 'Pruebas', SECRETO);
  const overlay = await overlayDe(grupo, token);
  const viejo = await observador(grupo, token);
  assert.equal(viejo.ack.value, true);
  const secreto = viejo.ack.reason as string;
  viejo.manda('round_info', { roundNumber: 3, roundPhase: 'shopping' });
  await espera(overlay, 'match_data', (m) => m.roundNumber === 3);

  const cae = new Promise<void>((r) => viejo.socket.once('disconnect', () => r()));
  const nuevo = await observador(grupo, token, secreto);
  assert.equal(nuevo.ack.reason, 'reconnected');
  await Promise.race([cae, pausa(2000).then(() => assert.fail('el socket viejo debía cortarse'))]);
  assert.equal(viejo.socket.connected, false);

  // El intruso (sin secreto) sigue sin poder entrar mientras el nuevo está vivo.
  const intruso = await observador(grupo, token, '');
  assert.equal(intruso.ack.value, false);
  assert.match(String(intruso.ack.reason), /still live/);

  // El nuevo manda y el overlay lo ve.
  nuevo.manda('round_info', { roundNumber: 4, roundPhase: 'shopping' });
  await espera(overlay, 'match_data', (m) => m.roundNumber === 4);

  // El viejo ya no deja huérfano al partido: si cae el nuevo, entonces sí se puede retomar.
  nuevo.socket.disconnect();
  await pausa(100);
  const relevo = await observador(grupo, token, '');
  assert.equal(relevo.ack.value, true, 'partido huérfano retomado');
  const m = await (async () => {
    relevo.manda('round_info', { roundNumber: 5, roundPhase: 'shopping' });
    return espera(overlay, 'match_data', (d) => d.roundNumber === 5);
  })();
  assert.equal(m.groupCode, grupo);
  relevo.socket.disconnect();
});

test('N2 game_end repetido y paquetes tras el fin: el partido se destruye una vez, se emite el estado final una vez y nada revienta', () => {
  let t = 1_000_000;
  const finales: string[] = [];
  const difusion: Difusion = {
    estado: (_g, json) => void finales.push(json),
    sala: () => undefined,
    expulsaGrupo: () => undefined,
    camaras: () => undefined,
    llama: () => undefined,
    pideInforme: () => false,
    ordenJugador: () => false,
  };
  const central = new Central(config, () => t);
  central.conecta(difusion);
  try {
    central.crea(
      { groupCode: 'FIN', leftTeam: { name: '', tricode: '', url: '', attackStart: true }, rightTeam: { name: '', tricode: '', url: '', attackStart: false }, toolsData: {} },
      {},
      'sock-1',
    );
    central.procesa('FIN', { type: 'match_start', data: 'M-FIN', timestamp: t });
    central.procesa('FIN', { type: 'round_info', data: { roundNumber: 13, roundPhase: 'game_end' }, timestamp: t });
    assert.equal(central.numeroDePartidos, 0);
    const emitidos = finales.length;
    assert.ok(emitidos >= 1, 'el estado final sí se emite');
    // Un segundo game_end, y más datos del observador tras el fin, no hacen nada.
    central.procesa('FIN', { type: 'round_info', data: { roundNumber: 13, roundPhase: 'game_end' }, timestamp: t + 5 });
    central.procesa('FIN', { type: 'score', data: { team_0: 13, team_1: 4 }, timestamp: t + 10 });
    assert.equal(finales.length, emitidos);
    assert.equal(central.numeroDePartidos, 0);
  } finally {
    central.cierra();
  }
});