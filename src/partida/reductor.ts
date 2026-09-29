/**
 * El reductor del partido: (estado, evento) → estado nuevo.
 *
 * Es una función pura: no lee el reloj (la hora viene en el evento), no
 * programa temporizadores (el transporte le manda `@reloj`), no sabe nada de
 * sockets. Por eso se puede probar entero con `node --test` alimentándole
 * paquetes a mano o desde una grabación.
 *
 * Trabaja sobre una copia profunda del estado que recibe; el original no se
 * toca nunca. Devuelve además:
 *  - `cambiado`: si hay algo nuevo que difundir;
 *  - `finDeMapa`: si el mapa terminó (el transporte difunde el estado final y
 *    después destruye el partido).
 */

import {
  aplicaHabilidades,
  aplicaIconoEspecial,
  aplicaInformeRonda,
  aplicaKillfeed,
  aplicaMarcadorCompaneros,
  aplicaMarcadorObservador,
  aplicaMarcadorPropio,
  aplicaRoster,
  aplicaVida,
  marcaObservado,
  plantaSpike,
  quitaDisponibilidad,
  reiniciaRonda,
  revisaAgentesDuplicados,
} from './jugadores.ts';
import { aplicaParchePartido } from './configuracion.ts';
import {
  alternaPausaTecnica,
  alternaTiempoMuerto,
  avanzaReloj,
  concedeProrroga,
  detenTodo,
  necesitaReloj,
} from './tiempos.ts';
import {
  PRIMERA_PRORROGA_BOMB,
  PRIMERA_PRORROGA_SWIFT,
  RONDA_CAMBIO_BOMB,
  RONDA_CAMBIO_SWIFT,
} from './creacion.ts';
import { nombreMapa } from './tablas.ts';
import { fijaBandos, rondaEnJuego } from './bandos.ts';
import type { Equipo, Evento, Paquete, Partido, TipoRonda } from './tipos.ts';

const LIMITE_RONDA_MS = 99_000;

export interface Resultado {
  estado: Partido;
  cambiado: boolean;
  finDeMapa: boolean;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Tipos de paquete que el reductor entiende (el resto se graba y se ignora). */
export const TIPOS_CONOCIDOS = new Set([
  'roster', 'scoreboard', 'killfeed', 'observing', 'match_start', 'map', 'game_mode',
  'round_info', 'score', 'spike_planted', 'spike_detonated', 'spike_defused',
  'switch_kda_credits', 'tech_pause', 'left_timeout', 'right_timeout', 'toast',
  'swap_left_right', 'swap_attacker_defender', 'swap_identity',
  'aux_health', 'aux_abilities', 'aux_round_report', 'aux_scoreboard', 'aux_scoreboard_team',
  'aux_astra_targeting', 'aux_cypher_cam',
]);

export function reduce(estado: Partido, evento: Evento): Resultado {
  // El reloj pasa muchas veces por segundo: si no hay nada que contar, ni se copia.
  if (evento.type === '@reloj' && !necesitaReloj(estado) && !rotuloCaduca(estado, evento.timestamp)) {
    return { estado, cambiado: false, finDeMapa: false };
  }
  if (evento.type !== '@reloj' && evento.type !== '@configura' && evento.type !== '@jugador_desconectado') {
    if (!TIPOS_CONOCIDOS.has(evento.type)) return { estado, cambiado: false, finDeMapa: false };
  }

  const p = structuredClone(estado);
  const r = aplica(p, evento);
  if (!r.cambiado) return { estado, cambiado: false, finDeMapa: false };
  return { estado: p, cambiado: true, finDeMapa: r.finDeMapa };
}

interface Efecto {
  cambiado: boolean;
  finDeMapa: boolean;
}

const HECHO: Efecto = { cambiado: true, finDeMapa: false };
const NADA: Efecto = { cambiado: false, finDeMapa: false };
const si = (c: boolean): Efecto => (c ? HECHO : NADA);

function aplica(p: Partido, e: Evento): Efecto {
  const t = e.timestamp;
  switch (e.type) {
    case '@reloj':
      return si(avanzaRotulo(p, t) || avanzaReloj(p, t));
    case '@configura':
      return si(aplicaParchePartido(p, (e as { parche: Record<string, unknown> }).parche));
    case '@jugador_desconectado':
      return si(quitaDisponibilidad(p, String((e as { playerId: string }).playerId)));
  }

  const paquete = e as Paquete;
  const d = paquete.data;
  const dato = esObjeto(d) ? d : {};

  switch (paquete.type) {
    case 'roster':
      return si(aplicaRoster(p, dato, t));
    case 'scoreboard':
      return si(aplicaMarcadorObservador(p, dato, t));
    case 'killfeed':
      aplicaKillfeed(p, dato);
      return HECHO;
    case 'observing':
      marcaObservado(p, d);
      return HECHO;

    case 'match_start':
      p.matchId = typeof d === 'string' ? d : String(d ?? '');
      p.isRunning = true;
      return HECHO;
    case 'map':
      p.map = nombreMapa(d);
      return HECHO;
    case 'game_mode':
      aplicaModo(p, d);
      return HECHO;

    case 'round_info':
      return aplicaFase(p, dato, t);
    case 'score':
      aplicaMarcadorRondas(p, dato, t);
      return HECHO;

    case 'spike_planted':
      return si(plantaSpike(p, t));
    case 'spike_detonated':
      p.spikeState.detonated = true;
      p.spikeDetonationTime = undefined;
      return HECHO;
    case 'spike_defused':
      p.spikeState.defused = true;
      return HECHO;

    case 'switch_kda_credits':
      p.showAliveKDA = !p.showAliveKDA;
      return HECHO;
    case 'tech_pause':
      return si(alternaPausaTecnica(p, t));
    case 'left_timeout':
      return si(alternaTiempoMuerto(p, 0, t));
    case 'right_timeout':
      return si(alternaTiempoMuerto(p, 1, t));
    case 'toast':
      aplicaRotulo(p, dato, t);
      return HECHO;

    case 'swap_left_right':
      p.teams = [p.teams[1], p.teams[0]];
      return HECHO;
    case 'swap_attacker_defender':
      intercambiaBandos(p);
      return HECHO;
    case 'swap_identity':
      intercambiaIdentidad(p.teams[0], p.teams[1]);
      return HECHO;

    case 'aux_health':
      return si(aplicaVida(p, paquete.playerId, d));
    case 'aux_abilities':
      return si(aplicaHabilidades(p, paquete.playerId, d));
    case 'aux_round_report':
      return si(aplicaInformeRonda(p, paquete.playerId, d));
    case 'aux_scoreboard':
      return si(aplicaMarcadorPropio(p, dato, t));
    case 'aux_scoreboard_team':
      return si(aplicaMarcadorCompaneros(p, paquete.playerId, d, t));
    case 'aux_astra_targeting':
      return si(aplicaIconoEspecial(p, paquete.playerId, d, 'Rift', 'Targeting'));
    case 'aux_cypher_cam':
      return si(aplicaIconoEspecial(p, paquete.playerId, d, 'Gumshoe', 'Cam'));
  }
  return NADA;
}

/* ── Modo de juego ──────────────────────────────────────────────────────── */

function aplicaModo(p: Partido, d: unknown): void {
  p.matchType = typeof d === 'string' ? d : String(d);
  if (p.matchType === 'swift') {
    p.switchRound = RONDA_CAMBIO_SWIFT;
    p.firstOtRound = PRIMERA_PRORROGA_SWIFT;
  } else {
    p.switchRound = RONDA_CAMBIO_BOMB;
    p.firstOtRound = PRIMERA_PRORROGA_BOMB;
  }
}

/* ── Fases de la ronda ──────────────────────────────────────────────────── */

function aplicaFase(p: Partido, d: Record<string, unknown>, ahora: number): Efecto {
  const faseAnterior = p.roundPhase;
  if (esNumero(d.roundNumber)) p.roundNumber = d.roundNumber;
  if (typeof d.roundPhase === 'string') p.roundPhase = d.roundPhase;

  switch (p.roundPhase) {
    case 'shopping': {
      p.spikeState = { planted: false, detonated: false, defused: false };
      // Un `shopping` repetido (sin pasar por otra fase) no vuelve a reiniciar
      // la ronda ni a cambiar de lado.
      if (faseAnterior === 'shopping') break;

      // La ronda que empieza: el `roundNumber` de GEP puede ir una por detrás
      // de la fase; el marcador de rondas, no (ver `bandos.ts`).
      const enJuego = rondaEnJuego(p);
      // Y la que se difunde es esa: el overlay rotulaba «compra 12» en la 13.
      p.roundNumber = enJuego;
      if (enJuego >= p.firstOtRound) concedeProrroga(p);

      // El bando se deduce de la ronda (antes se invertía al ver la ronda de
      // cambio, y perder ese paquete dejaba el resto del mapa al revés).
      const cambio = fijaBandos(p, enJuego);
      reiniciaRonda(p, cambio);
      break;
    }
    case 'combat':
      // Por si no llegó el `shopping` (observador que entra a mitad de ronda):
      // el bando se corrige aquí, sin tocar el dinero.
      p.roundNumber = rondaEnJuego(p);
      fijaBandos(p, p.roundNumber);
      revisaAgentesDuplicados(p);
      p.roundTimeoutTime = ahora + LIMITE_RONDA_MS;
      p.interno.limiteRonda = p.roundTimeoutTime;
      p.interno.finRonda = undefined;
      p.toastInfo.active = false; // el rótulo se retira al empezar el combate
      p.interno.rotuloHasta = undefined;
      break;
    case 'end':
      if (faseAnterior !== 'end') p.interno.finRonda = ahora;
      p.roundTimeoutTime = undefined;
      p.spikeDetonationTime = undefined;
      break;
    case 'game_end':
      p.isRunning = false;
      detenTodo(p);
      return { cambiado: true, finDeMapa: true };
  }
  return HECHO;
}

/* ── Marcador de rondas e historial ─────────────────────────────────────── */

/**
 * `score`: rondas por equipo del juego. Si un equipo sube, ganó la ronda que
 * acaba de terminar y se apunta en el historial de los dos AHORA (antes se
 * apuntaba al empezar la ronda siguiente, así que la última del mapa nunca
 * llegaba). El número de ronda sale del propio marcador (total jugadas), que
 * no se desfasa como el `roundNumber` del GEP.
 */
function aplicaMarcadorRondas(p: Partido, d: Record<string, unknown>, ahora: number): void {
  const e0 = p.teams.find((x) => x.ingameTeamId === 0);
  const e1 = p.teams.find((x) => x.ingameTeamId === 1);
  const r0 = esNumero(d.team_0) ? d.team_0 : p.interno.ultimoMarcador[0];
  const r1 = esNumero(d.team_1) ? d.team_1 : p.interno.ultimoMarcador[1];
  const [previo0, previo1] = p.interno.ultimoMarcador;

  let ganador: Equipo | undefined;
  if (r0 > previo0) ganador = e0;
  else if (r1 > previo1) ganador = e1;

  // ¿Terminó por tiempo? Se mira la hora del `end` si ya llegó (antes sólo se
  // detectaba si el `score` llegaba ANTES que el `end`).
  const limite = p.roundTimeoutTime ?? p.interno.limiteRonda;
  const porTiempo = limite !== undefined && (p.interno.finRonda ?? ahora) >= limite;

  if (ganador) {
    p.attackersWon = ganador.isAttacking;
    p.wasTimeout = porTiempo;
    const ronda = r0 + r1;
    for (const equipo of p.teams) apuntaRonda(equipo, ronda, motivoPara(p, equipo, ganador));
  } else {
    p.wasTimeout = porTiempo;
  }

  if (e0) e0.roundsWon = r0;
  if (e1) e1.roundsWon = r1;
  p.interno.ultimoMarcador = [r0, r1];
  p.spikeState.planted = false;
}

function motivoPara(p: Partido, equipo: Equipo, ganador: Equipo): TipoRonda {
  if (equipo !== ganador) return 'lost';
  if (ganador.isAttacking) return p.spikeState.detonated ? 'detonated' : 'kills';
  if (p.spikeState.defused) return 'defused';
  return p.wasTimeout ? 'timeout' : 'kills';
}

/** Apunta la ronda `ronda` y deja las cinco siguientes como pendientes. */
function apuntaRonda(equipo: Equipo, ronda: number, tipo: TipoRonda): void {
  if (!Number.isInteger(ronda) || ronda < 1) return;
  const h = equipo.roundRecord;
  const ataca = equipo.isAttacking;
  h[ronda - 1] = { type: tipo, wasAttack: ataca, round: ronda };
  for (let k = 1; k <= 5; k++) {
    const i = ronda - 1 + k;
    const existente = h[i];
    if (existente === undefined || existente.type === 'upcoming') {
      h[i] = { type: 'upcoming', wasAttack: ataca, round: ronda + k };
    }
  }
  // Rellena huecos si el marcador saltó rondas (paquetes perdidos).
  for (let i = 0; i < h.length; i++) {
    h[i] ??= { type: 'upcoming', wasAttack: ataca, round: i + 1 };
  }
}

/* ── Rótulo ──────────────────────────────────────────────────────────────── */

function rotuloCaduca(p: Partido, ahora: number): boolean {
  return p.toastInfo.active && p.interno.rotuloHasta !== undefined && ahora >= p.interno.rotuloHasta;
}

function avanzaRotulo(p: Partido, ahora: number): boolean {
  if (!rotuloCaduca(p, ahora)) return false;
  p.toastInfo.active = false;
  p.interno.rotuloHasta = undefined;
  return true;
}

/**
 * `toast`. Si el dato dice `active: true`, se pone (o se sustituye el que
 * hubiera); con `active: false`, se quita. Sin `active` se comporta como un
 * interruptor (quita si hay uno; si no, pone). El `title` se guarda.
 */
function aplicaRotulo(p: Partido, d: Record<string, unknown>, ahora: number): void {
  const pedido = typeof d.active === 'boolean' ? d.active : !p.toastInfo.active;
  if (!pedido) {
    p.toastInfo.active = false;
    p.interno.rotuloHasta = undefined;
    return;
  }
  const duracion = esNumero(d.duration) && d.duration > 0 ? d.duration : null;
  p.toastInfo = {
    active: true,
    title: typeof d.title === 'string' ? d.title : '',
    message: typeof d.message === 'string' ? d.message : '',
    duration: duracion,
    eventLogoEnabled: d.eventLogoEnabled !== false,
    selectedTeam: typeof d.selectedTeam === 'string' ? d.selectedTeam : undefined,
  };
  p.interno.rotuloHasta = duracion === null ? undefined : ahora + duracion;
}

/* ── Intercambios ────────────────────────────────────────────────────────── */

function intercambiaBandos(p: Partido): void {
  // Los bandos se deducen de la ronda: la inversión manual se recuerda para
  // que no la deshaga el siguiente `shopping`.
  p.interno.bandosInvertidos = !p.interno.bandosInvertidos;
  const [a, b] = p.teams;
  a.isAttacking = !a.isAttacking;
  b.isAttacking = !b.isAttacking;
  [a.roundsWon, b.roundsWon] = [b.roundsWon, a.roundsWon];
  [a.roundRecord, b.roundRecord] = [b.roundRecord, a.roundRecord];
}

function intercambiaIdentidad(a: Equipo, b: Equipo): void {
  [a.teamName, b.teamName] = [b.teamName, a.teamName];
  [a.teamTricode, b.teamTricode] = [b.teamTricode, a.teamTricode];
  [a.teamUrl, b.teamUrl] = [b.teamUrl, a.teamUrl];
}
