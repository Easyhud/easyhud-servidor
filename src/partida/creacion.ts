/**
 * Cómo nace un partido: valores iniciales del estado, de los equipos y de los
 * jugadores, y la configuración (`tools`) a partir del logon del observador y
 * de lo que el grupo recuerda de mapas anteriores.
 */

import { nombreAgente } from './tablas.ts';
import { aplicaEquiposGuardados } from './configuracion.ts';
import type {
  DatosCreacion,
  EntradaRonda,
  Equipo,
  EquipoLogon,
  Herramientas,
  Jugador,
  Lado,
  MemoriaGrupo,
  Partido,
} from './tipos.ts';

export const RONDA_CAMBIO_BOMB = 13;
export const PRIMERA_PRORROGA_BOMB = 25;
export const RONDA_CAMBIO_SWIFT = 5;
export const PRIMERA_PRORROGA_SWIFT = 99; // swift no tiene prórroga

const RONDAS_INICIALES = 25;

/* ── Utilidades de saneado ──────────────────────────────────────────────── */

export const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const texto = (v: unknown, defecto = ''): string => (typeof v === 'string' ? v : defecto);
const numero = (v: unknown, defecto: number): number => (esNumero(v) ? v : defecto);
const booleano = (v: unknown, defecto: boolean): boolean => (typeof v === 'boolean' ? v : defecto);

/* ── Configuración ──────────────────────────────────────────────────────── */

export function herramientasPorDefecto(): Herramientas {
  return {
    seriesInfo: { needed: 1, wonLeft: 0, wonRight: 0, mapInfo: [] },
    tournamentInfo: { name: '', logoUrl: '', backdropUrl: '' },
    timeoutDuration: 60,
    timeoutMax: 2,
    timeoutCancellationGracePeriod: 10,
    sponsorInfo: { enabled: false, duration: 5, sponsors: [] },
    watermarkInfo: { brandWatermark: false, customTextEnabled: false, customText: '' },
    playercamsInfo: { enable: false, identifier: '', enabledPlayers: [] },
  };
}

/**
 * Configuración inicial: los valores por defecto con lo que traiga el logon
 * encima, subobjeto a subobjeto. Los campos que falten en el logon se quedan
 * con el valor por defecto (antes quedaban ausentes), y los que lleguen con
 * un tipo que no toca se descartan.
 */
export function construyeHerramientas(toolsData: Record<string, unknown>): Herramientas {
  const h = herramientasPorDefecto();

  const serie = toolsData.seriesInfo;
  if (esObjeto(serie)) {
    h.seriesInfo = {
      needed: numero(serie.needed, 1),
      wonLeft: numero(serie.wonLeft, 0),
      wonRight: numero(serie.wonRight, 0),
      mapInfo: Array.isArray(serie.mapInfo) ? structuredClone(serie.mapInfo) : [],
    };
  }

  const torneo = toolsData.tournamentInfo;
  if (esObjeto(torneo)) {
    h.tournamentInfo = {
      name: texto(torneo.name),
      logoUrl: texto(torneo.logoUrl),
      backdropUrl: texto(torneo.backdropUrl),
    };
  }

  h.timeoutDuration = numero(toolsData.timeoutDuration, h.timeoutDuration);
  h.timeoutCancellationGracePeriod = numero(
    toolsData.timeoutCancellationGracePeriod,
    h.timeoutCancellationGracePeriod,
  );

  const contador = toolsData.timeoutCounter;
  if (esObjeto(contador) && esNumero(contador.max) && contador.max >= 0) {
    h.timeoutMax = Math.floor(contador.max);
  }

  const patrocinio = toolsData.sponsorInfo;
  if (esObjeto(patrocinio)) {
    h.sponsorInfo = {
      enabled: booleano(patrocinio.enabled, false),
      duration: numero(patrocinio.duration, 5),
      sponsors: Array.isArray(patrocinio.sponsors) ? structuredClone(patrocinio.sponsors) : [],
    };
  }

  const marca = toolsData.watermarkInfo;
  if (esObjeto(marca)) {
    h.watermarkInfo = {
      brandWatermark: false, // Easy HUD no lleva marca de agua de terceros, se mande lo que se mande
      customTextEnabled: booleano(marca.customTextEnabled, false),
      customText: texto(marca.customText),
    };
  }

  const camaras = toolsData.playercamsInfo;
  if (esObjeto(camaras)) {
    // `secret` y `endTime` se descartan aquí mismo: no hay backend de cámaras.
    h.playercamsInfo = {
      enable: booleano(camaras.enable, false),
      identifier: texto(camaras.identifier),
      enabledPlayers: Array.isArray(camaras.enabledPlayers)
        ? camaras.enabledPlayers.filter((p): p is string => typeof p === 'string')
        : [],
    };
  }

  return h;
}

/* ── Equipos y jugadores ────────────────────────────────────────────────── */

export function historialInicial(ataca: boolean): EntradaRonda[] {
  return Array.from({ length: RONDAS_INICIALES }, (_, i) => ({
    type: 'upcoming' as const,
    wasAttack: ataca,
    round: i + 1,
  }));
}

export function nuevoEquipo(logon: EquipoLogon): Equipo {
  const ataca = logon.attackStart === true;
  return {
    teamName: texto(logon.name),
    teamTricode: texto(logon.tricode),
    teamUrl: texto(logon.url),
    ingameTeamId: (ataca ? 0 : 1) as Lado,
    isAttacking: ataca,
    hasHandledTeam: false,
    roundsWon: 0,
    spentThisRound: 0,
    roundRecord: historialInicial(ataca),
    players: [],
    playerCount: 0,
    hasDuplicateAgents: false,
  };
}

export interface AltaJugador {
  name: string;
  tagline: string;
  playerId: string;
  position: number;
  locked: boolean;
  agentInternal: string;
  rank: number;
}

export function nuevoJugador(a: AltaJugador): Jugador {
  return {
    name: a.name,
    tagline: a.tagline,
    riotId: a.playerId,
    searchName: `${a.name} #${a.tagline}`,
    fullName: `${a.name}#${a.tagline}`,
    position: a.position,
    locked: a.locked,
    agentInternal: a.agentInternal,
    agentProper: nombreAgente(a.agentInternal),
    isAlive: true,
    hasSpike: false,
    isObserved: false,
    health: 100,
    abilities: { grenade: 0, ability1: 0, ability2: 0 },
    abilitiesMax: { grenade: 0, ability1: 0, ability2: 0 },
    kills: 0,
    deaths: 0,
    assists: 0,
    killsThisRound: 0,
    deathsThisRound: 0,
    killedPlayerNames: [],
    damageThisRound: 0,
    damageReceivedThisRound: 0,
    headshotsThisRound: 0,
    totalDamage: 0,
    totalDamageReceived: 0,
    totalHeadshots: 0,
    currUltPoints: 0,
    maxUltPoints: 0,
    ultReady: false,
    money: 0,
    moneySpent: 0,
    spentMoneyThisRound: false,
    armorName: 'None',
    highestWeapon: 'Unknown',
    rank: a.rank,
    teamKills: 0,
    headshotKills: 0,
    scoreboardAvailable: false,
    auxiliaryAvailable: { health: false, abilities: false, scoreboard: false },
    iconNameSuffix: '',
    disconnected: false,
  };
}

/* ── El partido ─────────────────────────────────────────────────────────── */

export interface OpcionesPartido {
  /** Tiempos muertos extra por equipo al entrar en prórroga (0 = ninguno). */
  extraProrroga: number;
}

/** ¿Tiene el logon lo mínimo para montar los dos equipos? */
export function logonCompleto(d: Record<string, unknown>): boolean {
  const equipoValido = (e: unknown) => esObjeto(e) && typeof e.attackStart === 'boolean';
  return typeof d.groupCode === 'string' && d.groupCode !== '' && equipoValido(d.leftTeam) && equipoValido(d.rightTeam);
}

export function creaPartido(d: DatosCreacion, memoria: MemoriaGrupo | undefined, op: OpcionesPartido): Partido {
  const tools = construyeHerramientas(esObjeto(d.toolsData) ? d.toolsData : {});
  // Lo configurado en el panel para este grupo manda sobre los fijos del logon.
  if (memoria?.tiempos?.max !== undefined) tools.timeoutMax = memoria.tiempos.max;
  if (memoria?.tiempos?.duracion !== undefined) tools.timeoutDuration = memoria.tiempos.duracion;
  const max = tools.timeoutMax;

  const p: Partido = {
    matchId: '',
    matchType: 'bomb',
    switchRound: RONDA_CAMBIO_BOMB,
    firstOtRound: PRIMERA_PRORROGA_BOMB,
    groupCode: d.groupCode,
    isRunning: false,
    roundNumber: 0,
    roundPhase: 'LOBBY',
    wasTimeout: false,
    teams: [nuevoEquipo(d.leftTeam), nuevoEquipo(d.rightTeam)],
    map: 'Loading',
    spikeState: { planted: false, detonated: false, defused: false },
    attackersWon: false,
    showAliveKDA: false,
    toastInfo: { active: false, title: '', message: '', duration: null, eventLogoEnabled: true },
    tools,
    interno: {
      tiempos: {
        restantes: [max, max],
        activo: null,
        pausaTecnica: false,
        segundosRestantes: 0,
        prorrogaConcedida: false,
      },
      ultimoMarcador: [0, 0],
      ultimoCambioLado: 0,
      bandosInvertidos: false,
      extraProrroga: op.extraProrroga,
      hayRoster: false,
    },
  };

  // Lo que el grupo recuerda de antes: la serie y los nombres de los equipos.
  if (memoria?.serie) {
    p.tools.seriesInfo.wonLeft = memoria.serie.wonLeft;
    p.tools.seriesInfo.wonRight = memoria.serie.wonRight;
    p.tools.seriesInfo.mapInfo = structuredClone(memoria.serie.mapInfo);
    p.tools.seriesInfo.needed = memoria.serie.needed;
  }
  if (memoria) aplicaEquiposGuardados(p, memoria.equipos);

  return p;
}
