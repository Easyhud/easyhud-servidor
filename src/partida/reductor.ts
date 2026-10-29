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
  recuerdaTerminada,
  restauraVida,
  reiniciaParaPartidaNueva,
  reiniciaPorOrden,
  reiniciaRonda,
  revisaAgentesDuplicados,
} from './jugadores.ts';
import { aplicaParchePartido } from './configuracion.ts';
import {
  alternaPausaTecnica,
  pausaVisual,
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
import { LIMITES, linea, texto } from './saneado.ts';
import { fijaBandos, rondaEnJuego } from './bandos.ts';
import { intercambiaIdentidad, intercambiaRegistrados, vinculaPorRoster } from './vinculo.ts';
import type { Equipo, Evento, Paquete, Partido, TipoRonda } from './tipos.ts';

const LIMITE_RONDA_MS = 99_000;
/** Lo más alto que puede valer una ronda o un marcador de rondas. Un número mayor es un cliente roto, no una partida. */
const MAX_RONDAS = 99;
/** Un `map`, un `game_mode` y un `match_start` dentro de este margen forman una «ráfaga» (la reenvía el observador al reconectar). */
const RAFAGA_MS = 5_000;
const MAX_ID_PARTIDA = 64;
const MAX_MODO = 20;
const MAX_MAPA = 40;
const MAX_ROTULO_MS = 3_600_000;
const FASE_VALIDA = /^[A-Za-z_]{1,24}$/;

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

const EVENTOS_INTERNOS = new Set(['@reloj', '@configura', '@jugador_desconectado', '@camaras', '@reinicia_partida', '@pausa_visual', '@aux_disponible']);

export function reduce(estado: Partido, evento: Evento): Resultado {
  // El reloj pasa muchas veces por segundo: si no hay nada que contar, ni se copia.
  if (evento.type === '@reloj' && !necesitaReloj(estado) && !rotuloCaduca(estado, evento.timestamp)) {
    return { estado, cambiado: false, finDeMapa: false };
  }
  if (!EVENTOS_INTERNOS.has(evento.type)) {
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
    case '@reinicia_partida':
      reiniciaPorOrden(p);
      return HECHO;
    case '@aux_disponible':
      return si(restauraVida(p, String((e as { playerId: string }).playerId)));
    case '@pausa_visual':
      return si(pausaVisual(p, (e as Extract<Evento, { type: '@pausa_visual' }>).activa === true, t));
    case '@jugador_desconectado':
      return si(quitaDisponibilidad(p, String((e as { playerId: string }).playerId)));
    case '@camaras': {
      const { publicando: nueva, conexion } = e as Extract<Evento, { type: '@camaras' }>;
      const cam = p.tools.playercamsInfo;
      let cambio = false;
      if (nueva.length !== cam.enabledPlayers.length || nueva.some((x, i) => x !== cam.enabledPlayers[i])) {
        cam.enabledPlayers = [...nueva];
        cambio = true;
      }
      if (conexion && (cam.base !== conexion.base || cam.params !== conexion.params || cam.clave !== conexion.clave)) {
        Object.assign(cam, conexion);
        cambio = true;
      }
      return si(cambio);
    }
  }

  const paquete = e as Paquete;
  const d = paquete.data;
  const dato = esObjeto(d) ? d : {};

  switch (paquete.type) {
    // Tras cada roster o marcador, el vínculo por puuid (si el panel los mandó).
    case 'roster': {
      const c = aplicaRoster(p, dato, t);
      return si(vinculaPorRoster(p) || c);
    }
    case 'scoreboard': {
      const c = aplicaMarcadorObservador(p, dato, t);
      return si(vinculaPorRoster(p) || c);
    }
    case 'killfeed':
      aplicaKillfeed(p, dato);
      return HECHO;
    case 'observing':
      marcaObservado(p, d);
      return HECHO;

    case 'match_start': {
      const id = typeof d === 'string' ? d : typeof d === 'number' && Number.isFinite(d) ? String(d) : '';
      if (id.length > MAX_ID_PARTIDA) return NADA; // un id de partida de VALORANT es un UUID: esto no lo es
      // Tras el menú, el observador puede reenviar el `match_start` (y el mapa y el modo) de una partida que ya
      // terminó o que el operador descartó: no vale, y lo que llegó en la misma ráfaga tampoco.
      if (id !== '' && p.interno.idsTerminados.includes(id)) return si(restauraRafaga(p, t));
      // Otra partida en el mismo partido (remake sin game_end, grupo retomado):
      // se empieza de cero. El mismo id (reconexión) no toca nada, y uno
      // vacío no borra el que hay: los jugadores entran por matchId.
      if (id !== '' && p.matchId !== '' && id !== p.matchId) {
        recuerdaTerminada(p, p.matchId);
        reiniciaParaPartidaNueva(p);
        vinculaPorRoster(p);
      }
      if (id !== '') p.matchId = id;
      p.isRunning = true;
      // La partida EMPEZÓ: si el juego aún figuraba en el lobby/selección (el `round_info` de la compra puede llegar
      // después, o perderse si hubo un reinicio entre medias), se pasa ya a la compra. El original lo dejaba en «combat»;
      // aquí es la compra de la ronda 1, que es lo que ocurre de verdad tras el match_start.
      if (p.roundPhase === 'LOBBY') p.roundPhase = 'shopping';
      return HECHO;
    }
    case 'map':
      guardaAntesDeRafaga(p, t);
      p.map = nombreMapa(d).slice(0, MAX_MAPA);
      return HECHO;
    case 'game_mode':
      if (typeof d !== 'string' || d === '' || d.length > MAX_MODO) return NADA;
      guardaAntesDeRafaga(p, t);
      aplicaModo(p, d);
      return HECHO;
    case 'round_info':
      return aplicaFase(p, dato, t);
    case 'score':
      p.interno.ultimaJugada = t;
      aplicaMarcadorRondas(p, dato, t);
      return HECHO;

    case 'spike_planted':
      return si(plantaSpike(p, t));
    case 'spike_detonated':
      p.spikeState.detonated = true;
      p.spikeDetonationTime = undefined;
      corrigeMotivoRonda(p); // si llegó DESPUÉS del `score`, la ronda ya apuntada se corrige
      return HECHO;
    case 'spike_defused':
      p.spikeState.defused = true;
      corrigeMotivoRonda(p);
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
      intercambiaRegistrados(p);
      return HECHO;
    case 'swap_attacker_defender':
      intercambiaBandos(p);
      return HECHO;
    case 'swap_identity':
      intercambiaIdentidad(p.teams[0], p.teams[1]);
      intercambiaRegistrados(p);
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

function aplicaModo(p: Partido, d: string): void {
  p.matchType = d;
  if (p.matchType === 'swift') {
    p.switchRound = RONDA_CAMBIO_SWIFT;
    p.firstOtRound = PRIMERA_PRORROGA_SWIFT;
  } else {
    p.switchRound = RONDA_CAMBIO_BOMB;
    p.firstOtRound = PRIMERA_PRORROGA_BOMB;
  }
}

/* ── Mapa y modo reenviados por un observador que vuelve del menú ───────── */

/** Antes de aplicar un `map`/`game_mode`, se recuerda lo que había (sólo al abrirse una ráfaga nueva). */
function guardaAntesDeRafaga(p: Partido, ahora: number): void {
  const a = p.interno.antesDeRafaga;
  if (a !== undefined && ahora - a.en <= RAFAGA_MS) return;
  p.interno.antesDeRafaga = { map: p.map, matchType: p.matchType, switchRound: p.switchRound, firstOtRound: p.firstOtRound, en: ahora };
}

/** Un `match_start` caducado: el mapa y el modo de su misma ráfaga eran de la partida vieja. Devuelve si cambió algo. */
function restauraRafaga(p: Partido, ahora: number): boolean {
  const a = p.interno.antesDeRafaga;
  p.interno.antesDeRafaga = undefined;
  if (a === undefined || ahora - a.en > RAFAGA_MS) return false;
  const cambio = p.map !== a.map || p.matchType !== a.matchType;
  p.map = a.map;
  p.matchType = a.matchType;
  p.switchRound = a.switchRound;
  p.firstOtRound = a.firstOtRound;
  return cambio;
}

/* ── Fases de la ronda ──────────────────────────────────────────────────── */

function aplicaFase(p: Partido, d: Record<string, unknown>, ahora: number): Efecto {
  const faseAnterior = p.roundPhase;
  if (esNumero(d.roundNumber) && Number.isInteger(d.roundNumber) && d.roundNumber >= 0 && d.roundNumber <= MAX_RONDAS) p.roundNumber = d.roundNumber;
  if (typeof d.roundPhase === 'string' && FASE_VALIDA.test(d.roundPhase)) {
    p.roundPhase = d.roundPhase;
    // La pausa detectada por pantalla no puede sobrevivir a la compra: si el juego pasó a combate, ya no hay pausa.
    if (d.roundPhase !== 'shopping') pausaVisual(p, false, ahora);
  }

  if (p.roundPhase === 'shopping' || p.roundPhase === 'combat' || p.roundPhase === 'end') p.interno.ultimaJugada = ahora;

  switch (p.roundPhase) {
    case 'shopping': {
      p.spikeState = { planted: false, detonated: false, defused: false };
      // La ronda que empieza: el `roundNumber` de GEP puede ir una por detrás
      // de la fase; el marcador de rondas, no (ver `bandos.ts`).
      const enJuego = rondaEnJuego(p);
      // Un `shopping` repetido (sin pasar por otra fase) no vuelve a reiniciar la ronda ni a cambiar de lado. Pero si
      // el número de ronda es MAYOR que el de la última compra procesada, se perdieron `combat` y `end` entre dos
      // rondas distintas: es ronda nueva aunque no se hayan visto las fases intermedias.
      if (faseAnterior === 'shopping' && !(p.interno.ultimaCompra !== undefined && enJuego > p.interno.ultimaCompra)) {
        p.interno.ultimaCompra ??= enJuego;
        break;
      }
      p.interno.ultimaCompra = enJuego;
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
      p.interno.rondaAbierta = undefined; // si se perdió la compra, el combate también cierra la corrección de la ronda anterior
      // Por si no llegó el `shopping` (observador que entra a mitad de ronda):
      // el bando se corrige aquí, sin tocar el dinero.
      p.roundNumber = rondaEnJuego(p);
      fijaBandos(p, p.roundNumber);
      revisaAgentesDuplicados(p);
      // Un `combat` repetido de la MISMA ronda (el observador que reconecta reenvía el último estado) no vuelve a
      // empezar la cuenta de la ronda: el tope de 99 s se alargaba (una ronda ganada por tiempo salía «por kills»), volvía
      // a ponerse tras plantar la spike y se retiraba el rótulo que el operador acababa de poner. El original sí lo hace.
      // Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — model/Match.ts (case "combat"), corregido.
      if (faseAnterior === 'combat' && p.interno.combateRonda === p.roundNumber) break;
      p.interno.combateRonda = p.roundNumber;
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
      corrigeMotivoRonda(p); // el `score` llegó antes que el `end`: ahora se sabe si fue por tiempo
      break;
    case 'game_end':
      p.isRunning = false;
      recuerdaTerminada(p, p.matchId);
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
  // Un marcador fuera de rango (negativo, con decimales o pasado de MAX_RONDAS) es un dato roto: se queda el anterior.
  const enRango = (v: unknown, anterior: number): number => (esNumero(v) && Number.isInteger(v) && v >= 0 && v <= MAX_RONDAS ? v : anterior);
  const r0 = enRango(d.team_0, p.interno.ultimoMarcador[0]);
  const r1 = enRango(d.team_1, p.interno.ultimoMarcador[1]);
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
    // Queda abierta hasta que empiece la compra siguiente: un evento de spike tardío corrige su motivo.
    p.interno.rondaAbierta = { ronda, ganador: ganador.ingameTeamId };
  } else {
    p.wasTimeout = porTiempo;
  }

  if (e0) e0.roundsWon = r0;
  if (e1) e1.roundsWon = r1;
  p.interno.ultimoMarcador = [r0, r1];
  p.spikeState.planted = false;
}

/**
 * El evento de spike (detonada/desactivada) o el `end` pueden llegar unos instantes después del `score`. Mientras la
 * ronda recién apuntada siga siendo la última y no haya empezado la compra siguiente, se recalcula su motivo en el
 * historial de los dos equipos. Después queda fijo.
 */
function corrigeMotivoRonda(p: Partido): void {
  const abierta = p.interno.rondaAbierta;
  if (!abierta) return;
  const ganador = p.teams.find((x) => x.ingameTeamId === abierta.ganador);
  if (!ganador) return;
  const fin = p.interno.finRonda;
  const limite = p.roundTimeoutTime ?? p.interno.limiteRonda;
  if (fin !== undefined && limite !== undefined) p.wasTimeout = fin >= limite;
  for (const equipo of p.teams) {
    const entrada = equipo.roundRecord[abierta.ronda - 1];
    if (entrada && entrada.round === abierta.ronda && entrada.type !== 'upcoming') entrada.type = motivoPara(p, equipo, ganador);
  }
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
  const duracion = esNumero(d.duration) && d.duration > 0 ? Math.min(MAX_ROTULO_MS, d.duration) : null;
  p.toastInfo = {
    active: true,
    title: linea(d.title, LIMITES.tituloRotulo) ?? '',
    message: texto(d.message, LIMITES.mensajeRotulo) ?? '',
    duration: duracion,
    eventLogoEnabled: d.eventLogoEnabled !== false,
    selectedTeam: d.selectedTeam === 'left' || d.selectedTeam === 'right' || d.selectedTeam === 'none' ? d.selectedTeam : undefined,
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
