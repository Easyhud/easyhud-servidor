/**
 * Rama `copia-funcional`, por socket de verdad: los rechazos claros y accionables, los límites que protegen el directo
 * (tamaño, ritmo, número de partidos y de jugadores) y que nada de eso tumba al servidor.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { arranca, type Servidor } from '../src/servidor.ts';
import { firmaToken } from '../src/token.ts';
import { Limitador, escucha, explicaPermiso, identificadorValido } from '../src/mensajes.ts';
import { silencia } from '../src/log.ts';
import type { Config } from '../src/config.ts';

const SECRETO = 'f'.repeat(48);
const TOKEN = (grupo: string) => firmaToken(grupo, 1, 'Pruebas', SECRETO);

let servidor: Servidor;
let carpeta: string;
const abiertos: Socket[] = [];

before(async () => {
  silencia(true);
  carpeta = mkdtempSync(join(tmpdir(), 'easyhud-cf-'));
  const config: Config = {
    inseguro: true,
    secretoToken: SECRETO,
    sinAutenticacion: false,
    exigirTokenOverlay: false,
    grabar: false,
    carpetaGrabaciones: carpeta,
    extraProrroga: 1,
    minutosInactividad: 30,
    maxPartidos: 50,
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

function espera<T = any>(s: Socket, evento: string, cumple: (d: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const reloj = setTimeout(() => {
      s.off(evento, oyente);
      reject(new Error(`no llegó ${evento} a tiempo`));
    }, ms);
    const oyente = (msg: unknown) => {
      const d = typeof msg === 'string' ? JSON.parse(msg) : msg;
      if (!cumple(d as T)) return;
      clearTimeout(reloj);
      s.off(evento, oyente);
      resolve(d as T);
    };
    s.on(evento, oyente);
  });
}

const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const logonObs = (grupo: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'authenticate',
    clientVersion: '0.3.3',
    obsName: 'Obs',
    key: TOKEN(grupo),
    groupCode: grupo,
    groupSecret: '',
    leftTeam: { name: '', tricode: '', url: '', attackStart: true },
    rightTeam: { name: '', tricode: '', url: '', attackStart: false },
    toolsData: {},
    ...extra,
  });

async function observador(grupo: string, extra: Record<string, unknown> = {}) {
  const s = conecta(servidor.puertos.ingesta);
  const ack = espera(s, 'obs_logon_ack');
  s.emit('obs_logon', logonObs(grupo, extra));
  return { socket: s, ack: await ack };
}

async function operador(grupo: string) {
  const m = conecta(servidor.puertos.salida, '/operador');
  const listo = espera(m, 'operador_listo');
  m.emit('operador_logon', JSON.stringify({ groupCode: grupo, token: TOKEN(grupo) }));
  await listo;
  return m;
}

const estado = async () => (await (await fetch(`http://localhost:${servidor.puertos.extras}/status`)).json()) as { status: string };

/* ── Rechazos claros en el logon ────────────────────────────────────────── */

test('obs_logon: dos equipos que empiezan del mismo lado → rechazo que dice qué corregir', async () => {
  const { ack } = await observador('MISMO', {
    leftTeam: { name: 'A', tricode: 'A', url: '', attackStart: true },
    rightTeam: { name: 'B', tricode: 'B', url: '', attackStart: true },
  });
  assert.equal(ack.value, false);
  assert.match(ack.reason, /same side.*attacking.*defending/);
  assert.doesNotMatch(ack.reason, /invalid|not found|expired/i, 'no debe caer en los textos que el cliente traduce a otra cosa');
});

test('obs_logon: un código de grupo con caracteres ocultos o demasiado largo se rechaza diciendo qué hacer', async () => {
  for (const grupo of ['A'.repeat(65), 'GRU\u0001PO', 'MAL\nGRUPO']) {
    const { ack } = await observador(grupo);
    assert.equal(ack.value, false, JSON.stringify(grupo));
    assert.match(ack.reason, /^Group code not accepted: .*Copy it again from your Easy HUD account\.$/);
  }
});

test('obs_logon: con el servidor lleno el logon nuevo se rechaza con un aviso claro y los grupos vivos reconectan', async () => {
  // Un servidor aparte con tope de 3 partidos (los de las demás pruebas siguen vivos en el principal).
  const lleno = await arranca({
    inseguro: true, secretoToken: SECRETO, sinAutenticacion: false, exigirTokenOverlay: false, grabar: false,
    carpetaGrabaciones: carpeta, extraProrroga: 1, minutosInactividad: 30, maxPartidos: 3,
    puertos: { ingesta: 0, salida: 0, extras: 0 }, camaras: { base: 'https://vdo.ninja', params: '' },
  });
  try {
    const entra = async (grupo: string, extra: Record<string, unknown> = {}) => {
      const s = conecta(lleno.puertos.ingesta);
      const ack = espera(s, 'obs_logon_ack');
      s.emit('obs_logon', logonObs(grupo, extra));
      return { socket: s, ack: await ack };
    };
    const uno = await entra('LLENO1');
    const dos = await entra('LLENO2');
    const tres = await entra('LLENO3');
    for (const o of [uno, dos, tres]) assert.equal(o.ack.value, true);

    const cuatro = await entra('LLENO4');
    assert.equal(cuatro.ack.value, false);
    assert.match(cuatro.ack.reason, /limit of 3 live matches.*try again/);

    // El que ya tiene su partido puede volver con su secreto aunque esté lleno.
    const vuelta = await entra('LLENO1', { groupSecret: uno.ack.reason });
    assert.deepEqual(vuelta.ack, { type: 'authenticate', value: true, reason: 'reconnected' });
  } finally {
    await lleno.cierra();
  }
});

test('overlay y operador: sin permiso o con otro grupo, un texto que dice qué pasó y qué hacer', async () => {
  const caducado = conecta(servidor.puertos.salida, '/operador');
  const denegado = espera(caducado, 'operador_denegado');
  caducado.emit('operador_logon', JSON.stringify({ groupCode: 'G1', token: firmaToken('G1', 1, 'c', SECRETO, Date.now() - 3 * 86400_000) }));
  const d = await denegado;
  assert.equal(d.codigo, 'caducado');
  assert.match(d.reason, /caducado.*Inicia sesión de nuevo/);

  const m = conecta(servidor.puertos.salida, '/operador');
  const den = espera(m, 'operador_denegado');
  m.emit('operador_logon', JSON.stringify({ groupCode: 'G1', token: TOKEN('OTRO') }));
  const o = await den;
  assert.match(o.reason, /otra cuenta o de otro evento/);

  const sinGrupo = conecta(servidor.puertos.salida);
  const d3 = espera(sinGrupo, 'logon_denied');
  sinGrupo.emit('logon', JSON.stringify({ groupCode: 'x'.repeat(100), token: '' }));
  assert.equal((await d3).codigo, 'sin groupCode');
});

test('explicaPermiso: cada motivo de rechazo tiene su frase', () => {
  for (const motivo of ['sin token', 'caducado', 'firma no válida', 'token mal formado', 'contenido ilegible', 'es para el grupo X', 'mal configurado', 'sin groupCode']) {
    const frase = explicaPermiso(motivo, motivo === 'caducado' ? 'caducado' : 'invalido');
    assert.ok(frase.length > 30 && /[.]$/.test(frase), `${motivo}: ${frase}`);
  }
});

/* ── El panel: lo que no vale se dice, lo que vale se aplica ────────────── */

test('configura: lo corregido se aplica y el panel recibe un aviso con QUÉ se corrigió', async () => {
  const grupo = 'CONF1';
  const { socket: obs } = await observador(grupo);
  const mirada = conecta(servidor.puertos.salida);
  const exito = espera(mirada, 'logon_success');
  mirada.emit('logon', JSON.stringify({ groupCode: grupo, token: '' }));
  await exito;
  const mando = await operador(grupo);

  const aviso = espera<{ codigo?: string; reason: string; avisos: string[] }>(mando, 'operador_error', (e) => e.codigo === 'ajuste_corregido');
  const visto = espera(mirada, 'match_data', (m) => m.tools.seedingInfo.left === '#1');
  mando.emit('configura', JSON.stringify({
    seedingInfo: { left: '#1' },
    tournamentInfo: { name: 'Copa', logoUrl: 'javascript:alert(1)' },
    seriesInfo: { needed: 500 },
  }));
  const a = await aviso;
  assert.equal(a.codigo, 'ajuste_corregido');
  assert.match(a.reason, /no se ha aplicado tal cual/);
  assert.ok(a.avisos.some((x: string) => x.includes('tournamentInfo.logoUrl')));
  const m = await visto;
  assert.equal(m.tools.tournamentInfo.name, 'Copa');
  assert.equal(m.tools.tournamentInfo.logoUrl, '');
  assert.equal(m.tools.seriesInfo.needed, 20, 'se ajusta al tope en vez de aceptarlo');
  obs.close();
});

test('orden conocida sin partido: dice que el observador aún no ha conectado', async () => {
  const mando = await operador('SINOBS');
  const r = espera(mando, 'operador_error');
  mando.emit('orden', JSON.stringify({ tipo: 'pausaTecnica' }));
  const e = await r;
  assert.equal(e.codigo, 'sin_partido');
  assert.match(e.reason, /todavía no hay partido.*observador/);
});

/* ── Límites ────────────────────────────────────────────────────────────── */

test('un panel en bucle: el servidor ignora el exceso, avisa al panel y sigue vivo', async () => {
  const grupo = 'BUCLE1';
  const { socket: obs } = await observador(grupo);
  const mando = await operador(grupo);
  const aviso = espera<{ codigo?: string; reason: string }>(mando, 'operador_error', (e) => e.codigo === 'demasiado_rapido');
  for (let i = 0; i < 400; i++) mando.emit('orden', JSON.stringify({ tipo: 'kdaCreditos' }));
  const a = await aviso;
  assert.match(a.reason, /Demasiadas órdenes seguidas/);
  assert.equal((await estado()).status, 'UP');
  obs.close();
});

test('un observador roto que inunda de paquetes: se descarta el exceso y, si no para, se le corta', async () => {
  const grupo = 'INUNDA1';
  const { socket: obs } = await observador(grupo);
  const corte = new Promise<void>((r) => obs.once('disconnect', () => r()));
  const paquete = JSON.stringify({ obsName: 'Obs', groupCode: grupo, type: 'killfeed', data: { attacker: 'a', victim: 'b' } });
  for (let i = 0; i < 6000; i++) obs.emit('obs_data', paquete);
  await Promise.race([corte, pausa(6000)]);
  assert.equal(obs.connected, false, 'el cliente en bucle se queda sin conexión');
  assert.equal((await estado()).status, 'UP', 'y el servidor sigue');
});

test('un mensaje enorme al canal del panel corta esa conexión y nada más', async () => {
  const grupo = 'ENORME1';
  const { socket: obs } = await observador(grupo);
  const mando = await operador(grupo);
  const corte = new Promise<void>((r) => mando.once('disconnect', () => r()));
  mando.emit('configura', JSON.stringify({ tournamentInfo: { name: 'x'.repeat(400_000) } }));
  await Promise.race([corte, pausa(3000)]);
  assert.equal(mando.connected, false);
  assert.equal((await estado()).status, 'UP');
  assert.equal(obs.connected, true, 'el observador no se entera');
  obs.close();
});

test('jugadores: un grupo no admite más de 30 a la vez', async () => {
  const grupo = 'JUGS1';
  const { socket: obs } = await observador(grupo);
  const entran: Socket[] = [];
  for (let i = 0; i < 30; i++) {
    const j = conecta(servidor.puertos.ingesta);
    const ack = espera(j, 'aux_logon_ack');
    j.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: `J${i}`, matchId: '', groupCode: grupo, playerId: `p-${i}` }));
    assert.equal((await ack).value, true);
    entran.push(j);
  }
  const extra = conecta(servidor.puertos.ingesta);
  const ack = espera(extra, 'aux_logon_ack');
  extra.emit('aux_logon', JSON.stringify({ type: 'aux_authenticate', clientVersion: '0.3.3', name: 'Sobra', matchId: '', groupCode: grupo, playerId: 'p-extra' }));
  const r = await ack;
  assert.equal(r.value, false);
  assert.match(r.reason, /already has 30 players connected.*Close any extra copies/);
  for (const j of entran) j.close();
  obs.close();
});

/* ── Piezas sueltas ─────────────────────────────────────────────────────── */

test('Limitador: deja pasar la ráfaga, descarta el exceso y se recarga con el tiempo', () => {
  let t = 0;
  const l = new Limitador(5, 10, () => t);
  assert.deepEqual(Array.from({ length: 7 }, () => l.toma()), [true, true, true, true, true, false, false]);
  assert.equal(l.descartados, 2);
  t += 300; // 3 fichas
  assert.deepEqual(Array.from({ length: 4 }, () => l.toma()), [true, true, true, false]);
  assert.equal(l.debeAvisar(), true);
  assert.equal(l.debeAvisar(), false, 'el aviso sale una vez cada 10 s');
  t += 11_000;
  assert.equal(l.debeAvisar(), true);
});

test('escucha: un fallo dentro del manejador no sale al exterior y los siguientes mensajes siguen entrando', () => {
  const oyentes = new Map<string, (...a: unknown[]) => void>();
  const falso = { id: 'x', on: (e: string, f: (...a: unknown[]) => void) => oyentes.set(e, f), disconnect: () => undefined } as unknown as Parameters<typeof escucha>[0];
  let vistos = 0;
  escucha(falso, 'cosa', (m) => {
    vistos += 1;
    if (m === 'mal') throw new Error('roto');
  });
  const f = oyentes.get('cosa')!;
  assert.doesNotThrow(() => f('mal'));
  f('bien');
  assert.equal(vistos, 2);
});

test('identificadorValido: de 1 a 64 caracteres sin controles', () => {
  assert.equal(identificadorValido('ABC-123'), true);
  assert.equal(identificadorValido(''), false);
  assert.equal(identificadorValido('a'.repeat(65)), false);
  assert.equal(identificadorValido('a\u0000b'), false);
  assert.equal(identificadorValido(5), false);
});
