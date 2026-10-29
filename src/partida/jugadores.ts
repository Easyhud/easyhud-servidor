/**
 * Lo que les pasa a los jugadores: alta por roster, marcadores (del
 * observador y de los propios jugadores), killfeed, datos auxiliares y el
 * reinicio al empezar cada ronda.
 *
 * Todo muta el partido que recibe; quien llama (el reductor) ya trabaja sobre
 * una copia.
 */

import { agenteDeIconoKillfeed, agenteNormalizado, nombreAgente, nombreArma, nombreEscudo } from './tablas.ts';
import { historialInicial, nuevoJugador, type AltaJugador } from './creacion.ts';
import { atacaEquipoCero } from './bandos.ts';
import { LIMITES, linea } from './saneado.ts';
import type { Equipo, Jugador, Partido } from './tipos.ts';

const MAX_JUGADORES = 5;
const SPIKE_MS = 45_000;
const PREMIO_PLANTAR = 300;
/** Tiempo mínimo (de partida) muerto en la compra para darlo por desconectado. */
const DESCONEXION_MS = 3_000;
/** Más dinero que esto en una cuenta es un dato roto (el tope del juego son 9000 más lo que se gane en la ronda). */
const MAX_DINERO = 99_999;

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, defecto = 0): number => (esNumero(v) ? v : defecto);
/** Un contador del marcador (bajas, muertes, ulti…): entero entre 0 y `max`; si no, se queda lo que había. */
const contador = (v: unknown, previo: number, max = 999): number =>
  esNumero(v) && Number.isInteger(v) && v >= 0 && v <= max ? v : previo;
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
 * compañeros). `d` es el dato del marcador tal como llega; `ahora`, la hora
 * del paquete (para la evidencia de desconexión).
 */
function actualizaMarcador(p: Partido, j: Jugador, d: Record<string, unknown>, ahora: number): void {
  const fase = p.roundPhase;
  const kills = contador(d.kills, j.kills);
  const deaths = contador(d.deaths, j.deaths);
  const assists = contador(d.assists, j.assists);
  const ult = contador(d.currUltPoints, j.currUltPoints, 99);
  const ultMax = contador(d.maxUltPoints, j.maxUltPoints, 99);

  if (kills > j.kills) j.killsThisRound += 1;
  if (deaths > j.deaths) j.deathsThisRound += 1;

  if (typeof d.agentInternal === 'string' && d.agentInternal.length <= LIMITES.agente) cambiaAgente(j, d.agentInternal);

  reglasDeIcono(j, { kills, deaths, assists, currUltPoints: ult });

  j.kills = kills;
  j.deaths = deaths;
  j.assists = assists;
  j.currUltPoints = ult;
  j.maxUltPoints = ultMax;
  // Sin los dos datos (o con un máximo de 0) no hay ulti lista: antes `0 >= 0` la daba por cargada.
  j.ultReady = ult >= ultMax && ultMax > 0;

  // Gasto de la ronda (se mantiene la cuenta heredada: puede bajar si entra dinero).
  if (esNumero(d.money) && d.money >= 0 && d.money <= MAX_DINERO) {
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
  // mapa (abandonó o se cayó). Se le quita la marca en cuanto vuelve vivo. Pero un marcador rezagado de la ronda
  // anterior (o el primero tras `match_start`) también llega «muerto» en la compra: sólo se marca con evidencia
  // sostenida, más de 3 s de tiempo de partida Y al menos dos marcadores seguidos así.
  if (typeof d.isAlive === 'boolean') {
    const visto = p.interno.muertoEnCompra;
    if (d.isAlive || fase !== 'shopping') {
      delete visto[j.riotId];
      if (d.isAlive) j.disconnected = false;
    } else {
      const e = (visto[j.riotId] ??= { desde: ahora, n: 0 });
      e.n += 1;
      if (e.n >= 2 && ahora - e.desde > DESCONEXION_MS) j.disconnected = true;
    }
  }
  if (typeof d.hasSpike === 'boolean') j.hasSpike = d.hasSpike;
}

function recalculaGasto(e: Equipo): void {
  e.spentThisRound = e.players.reduce((s, j) => s + j.moneySpent, 0);
}

/* ── Altas ───────────────────────────────────────────────────────────────── */

/**
 * ¿Es de una partida anterior? Nadie le ha visto en un roster (ni dado de
 * alta por marcador) desde el último paquete de juego. Sin juego todavía,
 * nadie lo es.
 */
function esDeOtraPartida(p: Partido, j: Jugador): boolean {
  const ultima = p.interno.ultimaJugada;
  if (ultima === undefined) return false;
  const visto = p.interno.rosterVisto[j.riotId];
  return visto === undefined || visto <= ultima;
}

/**
 * Hace sitio en `equipo` para un jugador nuevo. Lleno de jugadores de esta
 * partida, no hay sitio (tope de cinco); si alguno es de una partida anterior
 * (partido viejo que recibe una partida nueva), se le saca.
 */
function haySitio(p: Partido, equipo: Equipo): boolean {
  if (equipo.players.length < MAX_JUGADORES) return true;
  const viejo = equipo.players.findIndex((j) => esDeOtraPartida(p, j));
  if (viejo === -1) return false;
  equipo.players.splice(viejo, 1);
  equipo.playerCount = equipo.players.length;
  return true;
}

/**
 * Un jugador que aparece en `equipo` y está apuntado en el OTRO equipo de
 * juego: en una misma partida nadie cambia de equipo, así que lo apuntado es
 * de una partida anterior (remake tras una desconexión, grupo retomado). Se
 * le saca del otro para que no salga dos veces ni con el equipo equivocado.
 */
function sacaDelOtroEquipo(p: Partido, equipo: Equipo, playerId: string): void {
  for (const otro of p.teams) {
    if (otro === equipo) continue;
    const i = otro.players.findIndex((j) => j.riotId === playerId);
    if (i === -1) continue;
    otro.players.splice(i, 1);
    otro.playerCount = otro.players.length;
  }
}

/** Alta de un jugador en su equipo de juego. Devuelve el jugador, o undefined si no cabe. */
function daDeAlta(p: Partido, equipo: Equipo, a: AltaJugador, ahora: number): Jugador | undefined {
  sacaDelOtroEquipo(p, equipo, a.playerId);
  if (!haySitio(p, equipo)) return undefined;
  const j = nuevoJugador(a);
  equipo.players.push(j);
  equipo.playerCount = equipo.players.length;
  p.interno.rosterVisto[a.playerId] = ahora;

  // En selección de agentes el equipo del juego 0 empieza atacando. Un alta
  // tardía (con rondas ya jugadas) ya no toca el bando: antes lo devolvía al
  // inicial, que en la segunda mitad es el equivocado.
  const rondasJugadas = p.interno.ultimoMarcador[0] + p.interno.ultimoMarcador[1];
  if (rondasJugadas === 0 && p.interno.ultimoCambioLado === 0) {
    const ataca0 = atacaEquipoCero(p, 1) !== p.interno.bandosInvertidos;
    equipo.isAttacking = (equipo.ingameTeamId === 0) === ataca0;
  }
  return j;
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

  const playerId = typeof d.playerId === 'string' && d.playerId.length <= LIMITES.idJugador ? d.playerId : '';
  const nombre = linea(d.name, LIMITES.nombreJugador) ?? '';
  const tag = linea(d.tagline, 16) ?? '';
  if (playerId === '' || nombre === '' || tag === '') return true;

  const agente = typeof d.agentInternal === 'string' && d.agentInternal.length <= LIMITES.agente ? d.agentInternal : '';
  const existente = equipo.players.find((j) => j.riotId === playerId);
  if (existente) {
    existente.name = nombre;
    existente.tagline = tag;
    cambiaAgente(existente, agente);
    existente.locked = d.locked === true;
    if (esNumero(d.rank) && d.rank > 0) existente.rank = d.rank;
    p.interno.rosterVisto[playerId] = ahora;
    return true;
  }

  daDeAlta(
    p,
    equipo,
    { playerId, name: nombre, tagline: tag, agentInternal: agente, position: num(d.position), locked: d.locked === true, rank: num(d.rank) },
    ahora,
  );
  return true;
}

/**
 * `scoreboard` del observador. Devuelve false si el equipo no existe.
 *
 * Si el jugador no tiene roster, el marcador lo da de alta: un observador que
 * retoma el grupo a mitad de mapa no vuelve a recibir los rosters (GEP sólo
 * los manda al cambiar), y sin esto el overlay se quedaba sin jugadores el
 * resto del mapa. El marcador trae lo necesario (puuid, nombre, equipo, agente).
 */
export function aplicaMarcadorObservador(p: Partido, d: Record<string, unknown>, ahora: number): boolean {
  const equipo = equipoDeJuego(p, d.startTeam);
  if (!equipo) return false;
  const previo = equipo.players.find((x) => x.riotId === d.playerId);
  detectaPlantadoPorDinero(p, previo, d.money, ahora);
  let j = previo;
  const nombreAlta = linea(d.name, LIMITES.nombreJugador) ?? '';
  if (!j && typeof d.playerId === 'string' && d.playerId !== '' && d.playerId.length <= LIMITES.idJugador && nombreAlta !== '') {
    j = daDeAlta(
      p,
      equipo,
      {
        playerId: d.playerId,
        name: nombreAlta,
        tagline: linea(d.tagline, 16) ?? '',
        agentInternal: typeof d.agentInternal === 'string' && d.agentInternal.length <= LIMITES.agente ? d.agentInternal : '',
        position: equipo.players.length,
        locked: true,
        rank: 0,
      },
      ahora,
    );
  }
  if (!j) return true;
  actualizaMarcador(p, j, d, ahora);
  j.scoreboardAvailable = true;
  recalculaGasto(equipo);
  return true;
}

/**
 * `aux_scoreboard`: el marcador del propio jugador, sólo si el observador no
 * lo dio ya. El jugador se busca por su puuid en los dos equipos: el `team`
 * que manda el GEP del jugador no tiene por qué ser el del observador, y un
 * aux_scoreboard nunca da de alta ni mueve a nadie.
 */
export function aplicaMarcadorPropio(p: Partido, d: Record<string, unknown>, ahora: number): boolean {
  const r = jugadorPorId(p, d.playerId);
  detectaPlantadoPorDinero(p, r?.jugador, d.money, ahora);
  if (!r) return false;
  if (r.jugador.scoreboardAvailable) return true;
  actualizaMarcador(p, r.jugador, d, ahora);
  r.jugador.auxiliaryAvailable.scoreboard = true;
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
  for (const entrada of lista.slice(0, 10)) {
    if (!esObjeto(entrada)) continue;
    // Sólo se actualiza a jugadores del MISMO equipo que el remitente: un cliente modificado no puede tocar al rival.
    const j = origen.equipo.players.find((x) => x.riotId === entrada.playerId);
    if (!j) continue;
    detectaPlantadoPorDinero(p, j, entrada.money, ahora);
    if (j.scoreboardAvailable) continue;
    /*
     * Fuera del COMBATE (compra, lobby, selección de agentes), el «vivo» de la lista de compañeros no es de fiar (en la
     * ronda 1 llega como `false` para todos, y en el lobby de las grabaciones reales también):
     * dejaba a los compañeros muertos y «desconectados» hasta que mandaban su propio marcador. Ahí sólo se toma el resto
     * (dinero, arma, escudo, ulti); quien está vivo en compra lo deciden el observador y el marcador propio.
     */
    const dato = p.roundPhase !== 'combat' && p.roundPhase !== 'end' && entrada.isAlive === false ? { ...entrada, isAlive: undefined } : entrada;
    actualizaMarcador(p, j, dato, ahora);
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
      if (victima !== undefined && a.killedPlayerNames.length < 10) a.killedPlayerNames.push(victima.slice(0, LIMITES.nombreJugador));
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
  r.jugador.health = Math.min(100, Math.max(0, dato));
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

/**
 * El jugador SIGUE conectado mandando sus datos propios, pero su ficha se recreó (partida nueva, reinicio del
 * operador, reentrada al partido): se le devuelve la marca de «manda vida». Sólo la marca, no un valor: la vida
 * sigue siendo la que dice el partido (100 al empezar) hasta que su programa mande la real.
 */
export function restauraVida(p: Partido, playerId: string): boolean {
  const r = jugadorPorId(p, playerId);
  if (!r || r.jugador.auxiliaryAvailable.health) return false;
  r.jugador.auxiliaryAvailable.health = true;
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
  // Empieza otra compra: la evidencia de «muerto en compra» de la anterior no cuenta, y el motivo de la ronda que acaba de terminar queda fijo.
  p.interno.muertoEnCompra = {};
  p.interno.rondaAbierta = undefined;
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

/**
 * El operador pide empezar de cero el estado de JUEGO (la lobby nueva, «Quick match», crear sala): ronda,
 * marcador, historial y TODOS los jugadores salen —los que vuelvan a entrar lo harán por su roster—. No toca
 * la configuración (equipos, torneo, serie, tiempos muertos). Sirve para quitar lo que quedó de una partida
 * anterior (p. ej. «ronda 2, LLL 2-0») sin esperar al `match_start` de la siguiente.
 */
export function reiniciaPorOrden(p: Partido): void {
  p.interno.ultimaJugada = Number.MAX_SAFE_INTEGER; // todos los jugadores cuentan como «de la partida anterior»
  recuerdaTerminada(p, p.matchId); // el observador puede reenviar su match_start más tarde: ya no vale
  reiniciaParaPartidaNueva(p);
  p.matchId = '';
  p.isRunning = false;
}

/* ── Partida nueva en un partido viejo ──────────────────────────────────── */

/** Anota un matchId como terminado o descartado (tope de 8: sólo importan los últimos). */
export function recuerdaTerminada(p: Partido, matchId: string): void {
  if (matchId === '') return;
  const lista = p.interno.idsTerminados;
  if (!lista.includes(matchId)) lista.push(matchId);
  while (lista.length > 8) lista.shift();
}

/**
 * Llegó una partida de VALORANT distinta (otro matchId) a un partido que ya
 * tenía una: remake tras una desconexión (el observador vuelve al menú sin
 * `game_end` y el partido sigue vivo, o vuelve a entrar con su secreto), o un
 * grupo huérfano que se retoma. Se empieza el mapa de cero: marcador,
 * historial, bandos, tiempos muertos y estadísticas. Se conservan la
 * configuración, la identidad de cada lado y los jugadores que ya mandaron
 * roster de la partida nueva (llega en la selección de agentes, antes del
 * `match_start`); los demás se van y, si siguen jugando, vuelven con su marcador.
 */
export function reiniciaParaPartidaNueva(p: Partido): void {
  const max = p.tools.timeoutMax;
  for (const equipo of p.teams) {
    const ataca = equipo.ingameTeamId === 0;
    equipo.isAttacking = ataca;
    equipo.roundsWon = 0;
    equipo.spentThisRound = 0;
    equipo.roundRecord = historialInicial(ataca);
    equipo.hasDuplicateAgents = false;
    equipo.players = equipo.players
      .filter((j) => !esDeOtraPartida(p, j))
      .map((j) =>
        nuevoJugador({
          name: j.name,
          tagline: j.tagline,
          playerId: j.riotId,
          position: j.position,
          locked: j.locked,
          agentInternal: j.agentInternal,
          rank: j.rank,
        }),
      );
    equipo.playerCount = equipo.players.length;
  }
  p.roundNumber = 0;
  p.roundPhase = 'LOBBY';
  p.roundTimeoutTime = undefined;
  p.wasTimeout = false;
  p.spikeDetonationTime = undefined;
  p.spikeState = { planted: false, detonated: false, defused: false };
  p.attackersWon = false;
  const i = p.interno;
  i.tiempos = { restantes: [max, max], activo: null, pausaTecnica: false, segundosRestantes: 0, prorrogaConcedida: false };
  i.ultimoMarcador = [0, 0];
  i.limiteRonda = undefined;
  i.finRonda = undefined;
  i.ultimoCambioLado = 0;
  i.bandosInvertidos = false;
  i.ultimaJugada = undefined;
  i.rondaAbierta = undefined;
  i.ultimaCompra = undefined;
  i.combateRonda = undefined;
  i.muertoEnCompra = {};
  // La selección de agentes de la partida anterior no vale: si ya hay jugadores de ESTA (su roster llegó antes del
  // `match_start`), el arranque es el roster más antiguo que se les ha visto; si no, vuelve a empezar de cero.
  const vistos = p.teams.flatMap((e) => e.players.map((j) => i.rosterVisto[j.riotId])).filter((t): t is number => t !== undefined);
  if (vistos.length > 0) {
    p.agentSelectStartTime = Math.min(...vistos);
  } else {
    p.agentSelectStartTime = undefined;
    i.hayRoster = false;
  }
}
