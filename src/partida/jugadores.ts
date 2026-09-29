/**
 * Lo que les pasa a los jugadores: alta por roster, marcadores (del
 * observador y de los propios jugadores), killfeed, datos auxiliares y el
 * reinicio al empezar cada ronda.
 *
 * Todo muta el partido que recibe; quien llama (el reductor) ya trabaja sobre
 * una copia.
 */

import { agenteDeIconoKillfeed, agenteNormalizado, nombreAgente, nombreArma, nombreEscudo } from './tablas.ts';
import { nuevoJugador } from './creacion.ts';
import { atacaEquipoCero } from './bandos.ts';
import type { Equipo, Jugador, Partido } from './tipos.ts';

const MAX_JUGADORES = 5;
const SPIKE_MS = 45_000;
const PREMIO_PLANTAR = 300;

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, defecto = 0): number => (esNumero(v) ? v : defecto);
const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/* ── Búsquedas ──────────────────────────────────────────────────────────── */

/** El equipo del juego 0/1; `startTeam` a veces llega como texto ("1"). */
export function equipoDeJuego(p: Partido, startTeam: unknown): Equipo | undefined {
  const id = typeof startTeam === 'string' && startTeam !== '' ? Number(startTeam) : startTeam;
  return p.teams.find((t) => t.ingameTeamId === id);
}

export function jugadorPorId(p: Partido, playerId: unknown): { jugador: Jugador; equipo: Equipo } | undefined {
  if (typeof playerId !== 'string' || playerId === '') return undefined;
  for (const equipo of p.teams) {
    const jugador = equipo.players.find((j) => j.riotId === playerId);
    if (jugador) return { jugador, equipo };
  }
  return undefined;
}

/** ¿Tiene este jugador marcador (de cualquier fuente) en la ronda en curso? */
const tieneMarcador = (j: Jugador): boolean => j.scoreboardAvailable || j.auxiliaryAvailable.scoreboard;

/* ── Spike ───────────────────────────────────────────────────────────────── */

export function plantaSpike(p: Partido, ahora: number): boolean {
  if (p.spikeState.planted || p.roundPhase !== 'combat') return false;
  p.spikeState.planted = true;
  p.roundTimeoutTime = undefined;
  p.interno.limiteRonda = undefined;
  p.spikeDetonationTime = ahora + SPIKE_MS;
  return true;
}

/** Plantar da 300 créditos al que planta: si el dinero sube justo eso en combate, se plantó. */
function detectaPlantadoPorDinero(p: Partido, previo: Jugador | undefined, dineroNuevo: unknown, ahora: number): void {
  const antes = previo ? previo.money : 9999;
  if (p.roundPhase === 'combat' && esNumero(dineroNuevo) && dineroNuevo - antes === PREMIO_PLANTAR) {
    plantaSpike(p, ahora);
  }
}

/* ── Iconos especiales de agente ────────────────────────────────────────── */

function reglasDeIcono(j: Jugador, d: { kills: number; deaths: number; assists: number; currUltPoints: number }): void {
  if (d.kills === 0 && d.deaths === 0 && d.assists === 0) return;
  const agente = agenteNormalizado(j.agentInternal);
  if (agente === 'Smonk') {
    if (d.currUltPoints === 0 && j.ultReady) j.iconNameSuffix = 'NotDeadYet';
    if (d.kills > j.kills) j.iconNameSuffix = '';
    if (d.assists > j.assists) j.iconNameSuffix = '';
  } else if (agente === 'Pine') {
    if (d.currUltPoints === 0 && j.ultReady) j.iconNameSuffix = 'Evolution';
  }
}

function alMorir(j: Jugador): void {
  const agente = agenteNormalizado(j.agentInternal);
  if (agente === 'Rift' || agente === 'Smonk' || agente === 'Pine') j.iconNameSuffix = '';
}

/* ── Marcador compartido ────────────────────────────────────────────────── */

/** El agente cambió: la capacidad de habilidades vista ya no vale. */
function cambiaAgente(j: Jugador, agente: string): void {
  if (agenteNormalizado(agente) !== agenteNormalizado(j.agentInternal)) {
    j.abilitiesMax = { grenade: 0, ability1: 0, ability2: 0 };
  }
  j.agentInternal = agente;
  j.agentProper = nombreAgente(agente);
}

/**
 * La actualización común a todos los marcadores (observador, jugador,
 * compañeros). `d` es el dato del marcador tal como llega; `fase`, la fase de
 * la ronda en curso.
 */
function actualizaMarcador(j: Jugador, d: Record<string, unknown>, fase: string): void {
  const kills = num(d.kills, j.kills);
  const deaths = num(d.deaths, j.deaths);
  const assists = num(d.assists, j.assists);
  const ult = num(d.currUltPoints, j.currUltPoints);
  const ultMax = num(d.maxUltPoints, j.maxUltPoints);

  if (kills > j.kills) j.killsThisRound += 1;
  if (deaths > j.deaths) j.deathsThisRound += 1;

  if (typeof d.agentInternal === 'string') cambiaAgente(j, d.agentInternal);

  reglasDeIcono(j, { kills, deaths, assists, currUltPoints: ult });

  j.kills = kills;
  j.deaths = deaths;
  j.assists = assists;
  j.currUltPoints = ult;
  j.maxUltPoints = ultMax;
  j.ultReady = ult >= ultMax;

  // Gasto de la ronda (se mantiene la cuenta heredada: puede bajar si entra dinero).
  if (esNumero(d.money)) {
    if (!j.spentMoneyThisRound && d.money < j.money) j.spentMoneyThisRound = true;
    if (j.spentMoneyThisRound && d.money !== j.money) j.moneySpent += j.money - d.money;
    j.money = d.money;
  }

  // Un marcador que no trae el campo no borra lo que se sabía (antes dejaba
  // al jugador sin escudo ni arma hasta el siguiente marcador completo).
  if ('initialArmor' in d) j.armorName = nombreEscudo(d.initialArmor);
  if ('scoreboardWeaponInternal' in d) j.highestWeapon = nombreArma(d.scoreboardWeaponInternal);

  const vivo = typeof d.isAlive === 'boolean' ? d.isAlive : j.isAlive;
  if (j.isAlive && !vivo) {
    alMorir(j);
    j.health = 0;
  } else if (!j.isAlive && vivo) {
    j.health = 100;
  }
  j.isAlive = vivo;
  // El escudo se pierde al morir. GEP puede seguir mandando el de inicio de
  // ronda en los marcadores del muerto, y el overlay lo pintaba intacto.
  if (!vivo) j.armorName = 'None';

  // En compra reaparece todo el mundo: quien sigue muerto ahí no está en el
  // mapa (abandonó o se cayó). Se le quita la marca en cuanto vuelve vivo.
  if (typeof d.isAlive === 'boolean') {
    if (d.isAlive) j.disconnected = false;
    else if (fase === 'shopping') j.disconnected = true;
  }
  if (typeof d.hasSpike === 'boolean') j.hasSpike = d.hasSpike;
}

function recalculaGasto(e: Equipo): void {
  e.spentThisRound = e.players.reduce((s, j) => s + j.moneySpent, 0);
}

/* ── Paquetes ───────────────────────────────────────────────────────────── */

/** `roster`: alta o actualización de un jugador. Devuelve false si el equipo no existe. */
export function aplicaRoster(p: Partido, d: Record<string, unknown>, ahora: number): boolean {
  if (!p.interno.hayRoster) {
    p.interno.hayRoster = true;
    p.agentSelectStartTime = ahora;
  }
  const equipo = equipoDeJuego(p, d.startTeam);
  if (!equipo) return false;

  const playerId = typeof d.playerId === 'string' ? d.playerId : '';
  const nombre = typeof d.name === 'string' ? d.name : '';
  const tag = typeof d.tagline === 'string' ? d.tagline : '';
  if (playerId === '' || nombre === '' || tag === '') return true;

  const agente = typeof d.agentInternal === 'string' ? d.agentInternal : '';
  const existente = equipo.players.find((j) => j.riotId === playerId);
  if (existente) {
    existente.name = nombre;
    existente.tagline = tag;
    cambiaAgente(existente, agente);
    existente.locked = d.locked === true;
    if (esNumero(d.rank) && d.rank > 0) existente.rank = d.rank;
    return true;
  }

  if (equipo.players.length >= MAX_JUGADORES) return true;

  equipo.players.push(
    nuevoJugador({
      name: nombre,
      tagline: tag,
      playerId,
      position: num(d.position),
      locked: d.locked === true,
      agentInternal: agente,
      rank: num(d.rank),
    }),
  );
  equipo.playerCount += 1;

  // En selección de agentes el equipo del juego 0 empieza atacando. Un alta
  // tardía (con rondas ya jugadas) ya no toca el bando: antes lo devolvía al
  // inicial, que en la segunda mitad es el equivocado.
  const rondasJugadas = p.interno.ultimoMarcador[0] + p.interno.ultimoMarcador[1];
  if (rondasJugadas === 0 && p.interno.ultimoCambioLado === 0) {
    const ataca0 = atacaEquipoCero(p, 1) !== p.interno.bandosInvertidos;
    equipo.isAttacking = (equipo.ingameTeamId === 0) === ataca0;
  }
  return true;
}

/** `scoreboard` del observador. Devuelve false si el equipo no existe. */
export function aplicaMarcadorObservador(p: Partido, d: Record<string, unknown>, ahora: number): boolean {
  const equipo = equipoDeJuego(p, d.startTeam);
  if (!equipo) return false;
  const j = equipo.players.find((x) => x.riotId === d.playerId);
  detectaPlantadoPorDinero(p, j, d.money, ahora);
  if (!j) return true;
  actualizaMarcador(j, d, p.roundPhase);
  j.scoreboardAvailable = true;
  recalculaGasto(equipo);
  return true;
}

/** `aux_scoreboard`: el marcador del propio jugador, sólo si el observador no lo dio ya. */
export function aplicaMarcadorPropio(p: Partido, d: Record<string, unknown>, ahora: number): boolean {
  const equipo = equipoDeJuego(p, d.startTeam);
  if (!equipo) return false;
  const j = equipo.players.find((x) => x.riotId === d.playerId);
  detectaPlantadoPorDinero(p, j, d.money, ahora);
  if (!j || j.scoreboardAvailable) return true;
  actualizaMarcador(j, d, p.roundPhase);
  j.auxiliaryAvailable.scoreboard = true;
  return true;
}

/**
 * `aux_scoreboard_team`: los marcadores de los compañeros de quien lo manda.
 * El equipo es el del REMITENTE (antes se elegía con un campo inexistente y
 * siempre caía en el equipo derecho).
 */
export function aplicaMarcadorCompaneros(p: Partido, remitente: unknown, dato: unknown, ahora: number): boolean {
  let lista: unknown = dato;
  if (typeof dato === 'string') {
    try {
      lista = JSON.parse(dato);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(lista)) return false;
  const origen = jugadorPorId(p, remitente);
  if (!origen) return false;

  let cambio = false;
  for (const entrada of lista) {
    if (!esObjeto(entrada)) continue;
    const j = origen.equipo.players.find((x) => x.riotId === entrada.playerId);
    detectaPlantadoPorDinero(p, j, entrada.money, ahora);
    if (!j || j.scoreboardAvailable) continue;
    actualizaMarcador(j, entrada, p.roundPhase);
    j.auxiliaryAvailable.scoreboard = true;
    cambio = true;
  }
  return cambio;
}

/** `killfeed`: una muerte. Respalda kills/deaths/asistencias de quien no tenga marcador. */
export function aplicaKillfeed(p: Partido, d: Record<string, unknown>): void {
  const atacante = typeof d.attacker === 'string' ? d.attacker : undefined;
  const victima = typeof d.victim === 'string' ? d.victim : undefined;

  for (const equipo of p.teams) {
    const a = atacante === undefined ? undefined : equipo.players.find((j) => j.name === atacante);
    if (a) {
      if (victima !== undefined) a.killedPlayerNames.push(victima);
      if (d.headshotKill === true) a.headshotKills += 1;
      if (d.isTeamkill === true) a.teamKills += 1;

      if (!tieneMarcador(a)) {
        reglasDeIcono(a, { kills: a.kills + 1, deaths: a.deaths, assists: a.assists, currUltPoints: a.currUltPoints });
        a.kills += 1;
        a.killsThisRound += 1;
      }

      if (!equipo.hasDuplicateAgents && Array.isArray(d.assists)) {
        for (const icono of d.assists) {
          if (typeof icono !== 'string') continue;
          const agente = agenteDeIconoKillfeed(icono);
          if (agente === undefined) continue;
          const ayudante = equipo.players.find((j) => agenteNormalizado(j.agentInternal) === agente);
          if (ayudante && !tieneMarcador(ayudante)) ayudante.assists += 1;
        }
      }
    }

    const v = victima === undefined ? undefined : equipo.players.find((j) => j.name === victima);
    if (v && !tieneMarcador(v)) {
      v.isAlive = false;
      v.health = 0;
      v.armorName = 'None';
      v.deaths += 1;
      v.deathsThisRound += 1;
    }
  }
}

/* ── Datos auxiliares del propio jugador ────────────────────────────────── */

export function aplicaVida(p: Partido, playerId: unknown, dato: unknown): boolean {
  const r = jugadorPorId(p, playerId);
  if (!r || !esNumero(dato)) return false;
  r.jugador.health = dato;
  r.jugador.auxiliaryAvailable.health = true;
  return true;
}

/**
 * Cargas de un hueco. GEP las manda como número, pero según la versión llegan
 * como texto (`"2"`) o como booleano (hay / no hay): antes esos dos casos
 * salían siempre 0 y el overlay pintaba el kit entero gastado.
 */
function cargas(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return esNumero(n) && n > 0 ? Math.floor(n) : 0;
}

export function aplicaHabilidades(p: Partido, playerId: unknown, dato: unknown): boolean {
  const r = jugadorPorId(p, playerId);
  if (!r || !esObjeto(dato)) return false;
  const j = r.jugador;
  j.abilities = {
    grenade: cargas(dato.grenade),
    ability1: cargas(dato.ability_1),
    ability2: cargas(dato.ability_2),
  };
  // La capacidad del kit: el máximo visto con este agente. Es lo que deja
  // pintar la carga GASTADA (rombo apagado) en vez de quitar el rombo.
  const m = j.abilitiesMax;
  j.abilitiesMax = {
    grenade: Math.max(m.grenade, j.abilities.grenade),
    ability1: Math.max(m.ability1, j.abilities.ability1),
    ability2: Math.max(m.ability2, j.abilities.ability2),
  };
  j.auxiliaryAvailable.abilities = true;
  return true;
}

/**
 * `aux_round_report`: daño de la ronda. Si el GEP repite el informe en la
 * misma ronda, el nuevo sustituye al anterior en los totales en vez de sumarse
 * otra vez.
 */
export function aplicaInformeRonda(p: Partido, playerId: unknown, dato: unknown): boolean {
  const r = jugadorPorId(p, playerId);
  if (!r || !esObjeto(dato)) return false;
  const j = r.jugador;
  const dano = num(dato.damage);
  const recibido = num(dato.damageReceived);
  const cabezas = num(dato.headshots);
  j.totalDamage += dano - j.damageThisRound;
  j.totalDamageReceived += recibido - j.damageReceivedThisRound;
  j.totalHeadshots += cabezas - j.headshotsThisRound;
  j.damageThisRound = dano;
  j.damageReceivedThisRound = recibido;
  j.headshotsThisRound = cabezas;
  return true;
}

/** `aux_astra_targeting` / `aux_cypher_cam`: sufijo de icono si el agente cuadra. */
export function aplicaIconoEspecial(p: Partido, playerId: unknown, dato: unknown, agente: string, sufijo: string): boolean {
  const r = jugadorPorId(p, playerId);
  if (!r || typeof dato !== 'boolean') return false;
  if (agenteNormalizado(r.jugador.agentInternal) !== agente) return false;
  r.jugador.iconNameSuffix = dato ? sufijo : '';
  return true;
}

/** Un jugador cerró su cliente: deja de aportar datos propios. */
export function quitaDisponibilidad(p: Partido, playerId: string): boolean {
  const r = jugadorPorId(p, playerId);
  if (!r) return false;
  r.jugador.auxiliaryAvailable = { health: false, abilities: false, scoreboard: false };
  return true;
}

/* ── Fases ───────────────────────────────────────────────────────────────── */

/** Reinicio de cada jugador al empezar una ronda. */
export function reiniciaRonda(p: Partido, cambioDeLado: boolean): void {
  for (const equipo of p.teams) {
    for (const j of equipo.players) {
      j.killsThisRound = 0;
      j.deathsThisRound = 0;
      j.killedPlayerNames = [];
      j.moneySpent = 0;
      j.spentMoneyThisRound = false;
      j.damageThisRound = 0;
      j.damageReceivedThisRound = 0;
      j.headshotsThisRound = 0;
      if (cambioDeLado) j.money = 800;
      j.scoreboardAvailable = false;
      j.auxiliaryAvailable.scoreboard = false;
      // Quien no está en el mapa no reaparece: sigue fuera hasta que un
      // marcador lo dé vivo otra vez.
      j.isAlive = !j.disconnected;
      j.health = j.disconnected ? 0 : 100;
    }
    equipo.spentThisRound = 0;
  }
}

/** Al empezar el combate: ¿hay dos jugadores del mismo equipo con el mismo agente? */
export function revisaAgentesDuplicados(p: Partido): void {
  for (const equipo of p.teams) {
    const vistos = new Set<string>();
    let duplicado = false;
    for (const j of equipo.players) {
      const a = agenteNormalizado(j.agentInternal);
      if (a === '') continue;
      if (vistos.has(a)) duplicado = true;
      vistos.add(a);
    }
    equipo.hasDuplicateAgents = duplicado;
  }
}

export function marcaObservado(p: Partido, dato: unknown): void {
  for (const equipo of p.teams) {
    for (const j of equipo.players) j.isObserved = j.searchName === dato;
  }
}
