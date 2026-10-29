/**
 * Los tipos del estado de un partido.
 *
 * Los objetos de equipo y de jugador guardan sus campos con el MISMO nombre
 * que viajan en `match_data`, porque son muchos y el overlay los lee casi
 * todos: traducir nombres en dos direcciones sería una fuente de errores sin
 * ganancia. Lo que es sólo del servidor (secreto, contadores de tiempos
 * muertos por equipo, marcas para deduplicar fases…) vive aparte, en
 * `Partido.interno`, y el serializador (`serializa.ts`) nunca lo saca.
 */

import type { CajaVictoria, ParcheLimpio } from './saneado.ts';

export type Lado = 0 | 1; // posición en pantalla: 0 = izquierda, 1 = derecha

export type TipoRonda = 'detonated' | 'defused' | 'kills' | 'timeout' | 'lost' | 'upcoming';

export interface EntradaRonda {
  type: TipoRonda;
  wasAttack: boolean;
  round: number;
}

export interface Habilidades {
  grenade: number;
  ability1: number;
  ability2: number;
}

export interface DisponibilidadAuxiliar {
  health: boolean;
  abilities: boolean;
  scoreboard: boolean;
}

export interface Jugador {
  name: string;
  tagline: string;
  riotId: string;
  searchName: string;
  fullName: string;
  position: number;
  locked: boolean;
  agentInternal: string;
  agentProper: string;
  isAlive: boolean;
  hasSpike: boolean;
  isObserved: boolean;
  health: number;
  abilities: Habilidades;
  /**
   * Las cargas más altas vistas por hueco con el agente actual en este mapa:
   * la capacidad del kit, para pintar un rombo por carga (gastada o no). Se
   * vuelve a cero si cambia el agente.
   */
  abilitiesMax: Habilidades;
  kills: number;
  deaths: number;
  assists: number;
  killsThisRound: number;
  deathsThisRound: number;
  killedPlayerNames: string[];
  damageThisRound: number;
  damageReceivedThisRound: number;
  headshotsThisRound: number;
  totalDamage: number;
  totalDamageReceived: number;
  totalHeadshots: number;
  currUltPoints: number;
  maxUltPoints: number;
  ultReady: boolean;
  money: number;
  moneySpent: number;
  spentMoneyThisRound: boolean;
  armorName?: string;
  highestWeapon?: string;
  rank: number;
  teamKills: number;
  headshotKills: number;
  scoreboardAvailable: boolean;
  auxiliaryAvailable: DisponibilidadAuxiliar;
  iconNameSuffix: string;
  /**
   * El jugador no está en el mapa (abandonó o se desconectó): el juego lo da
   * por muerto en plena fase de compra, cuando todo el mundo reaparece. Se
   * quita en cuanto un marcador lo vuelve a dar vivo.
   */
  disconnected: boolean;
}

export interface Equipo {
  teamName: string;
  teamTricode: string;
  teamUrl: string;
  ingameTeamId: Lado; // equipo del juego (0/1); no cambia nunca
  isAttacking: boolean;
  hasHandledTeam: boolean;
  roundsWon: number;
  spentThisRound: number;
  roundRecord: EntradaRonda[];
  players: Jugador[];
  playerCount: number;
  hasDuplicateAgents: boolean;
}

export interface EntradaMapa {
  type: string;
  [clave: string]: unknown;
}

export interface InfoSerie {
  needed: number;
  wonLeft: number;
  wonRight: number;
  mapInfo: EntradaMapa[];
  [clave: string]: unknown;
}

export interface Herramientas {
  seriesInfo: InfoSerie;
  tournamentInfo: { name: string; logoUrl: string; backdropUrl: string; [clave: string]: unknown };
  timeoutDuration: number;
  /** Máximo de tiempos muertos por equipo y mapa. Los restantes van en `interno`. */
  timeoutMax: number;
  timeoutCancellationGracePeriod: number;
  sponsorInfo: { enabled: boolean; duration: number; sponsors: unknown[]; [clave: string]: unknown };
  watermarkInfo: { brandWatermark: boolean; customTextEnabled: boolean; customText: string; [clave: string]: unknown };
  playercamsInfo: {
    enable: boolean;
    identifier: string;
    enabledPlayers: string[];
    /** Cómo llegar a la web de vídeo; los pone el servidor, no el panel. */
    base?: string;
    params?: string;
    clave?: string;
    /**
     * Quitar el tricode del equipo del principio del nombre de cada jugador al emitir (p. ej. «ABC Nombre» → «Nombre»).
     * Mismo nombre y sitio que en el servidor original; ausente = false. Lo pone el panel.
     * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — model/Team.ts, model/Player.ts
     */
    removeTricodes?: boolean;
  };
  /** Cabeza de serie bajo cada equipo (por LADO de pantalla). Lo pone el panel. */
  seedingInfo: { left: string; right: string };
  /**
   * Alias de visualización: JSON de una lista de pares [«Nombre#TAG», alias], igual que en el original (el overlay
   * lo parsea). Lo pone el panel con el parche `nameOverrides`; no hay backend externo.
   */
  nameOverrides: { overrides: string };
  /** Qué se pinta en la ceremonia de fin de ronda: nada, el torneo o patrocinadores por ceremonia/equipo. Lo pone el panel. */
  roundWinBox: CajaVictoria;
  /** Modo mínimo del overlay (tarjetas sin habilidades). Propio de Easy HUD; el original lo elegía con una ruta. Lo pone el panel. */
  minimal: boolean;
}

export interface Rotulo {
  active: boolean;
  title: string;
  message: string;
  duration: number | null;
  eventLogoEnabled: boolean;
  /**
   * `left`, `right` o `none` (aviso de un equipo concreto); ausente = general.
   * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — model/eventData.ts (IToastInfo)
   */
  selectedTeam?: 'left' | 'right' | 'none';
}

/** Tiempos muertos y pausa técnica. Los contadores van por EQUIPO DE JUEGO. */
export interface EstadoTiempos {
  /** Restantes por `ingameTeamId` (no por posición en pantalla). */
  restantes: [number, number];
  /** Tiempo muerto táctico en curso: de qué equipo de juego y desde cuándo (ms). */
  activo: { equipo: Lado; inicio: number } | null;
  pausaTecnica: boolean;
  /** La pausa técnica la puso la detección por pantalla (el juego se ve en gris), no el operador: la quita ella misma. */
  automatica?: boolean;
  /** La pantalla se ve en gris con el timer quieto AHORA (la detección sigue viva): cuando vuelve el color, lo que esté en marcha se acaba. */
  visual?: boolean;
  /** Lo que viaja como `timeoutState.timeRemaining` (segundos). */
  segundosRestantes: number;
  /** Si ya se concedió el extra de prórroga en este mapa. */
  prorrogaConcedida: boolean;
}

export interface Interno {
  tiempos: EstadoTiempos;
  /** Instante (ms) en que se retira solo el rótulo; ausente si no caduca. */
  rotuloHasta?: number;
  /** Último marcador recibido por equipo de juego, para saber quién ganó la ronda. */
  ultimoMarcador: [number, number];
  /** Límite por tiempo de la ronda en curso; no se borra en `end` (para `wasTimeout`). */
  limiteRonda?: number;
  /** Hora a la que llegó la fase `end` de la ronda en curso. */
  finRonda?: number;
  /** Ronda en la que ya se aplicó el cambio de lado (evita cambiar dos veces). */
  ultimoCambioLado: number;
  /**
   * El operador invirtió los bandos a mano (`swap_attacker_defender`). Los
   * bandos se DEDUCEN de la ronda (ver `bandos.ts`), y esto se aplica encima
   * para que la corrección manual no se pierda en la ronda siguiente.
   */
  bandosInvertidos: boolean;
  /** Tiempos muertos extra que se conceden al entrar en prórroga. */
  extraProrroga: number;
  hayRoster: boolean;
  /**
   * Los puuids que el panel registró para el equipo de cada LADO (0 =
   * izquierda). Si llegan, el nombre/logo de cada lado se queda con SUS
   * jugadores aunque en la partida sean el otro equipo de juego (ver
   * `vinculo.ts`). Vacíos = sin vínculo (el lado manda, como siempre).
   */
  registrados: [string[], string[]];
  /** Hora (ms) del último `roster` (o alta por marcador) de cada puuid. */
  rosterVisto: Record<string, number>;
  /**
   * Hora del último paquete de juego (fase de ronda o marcador de rondas). Un
   * jugador sin roster desde entonces es de una partida anterior: lo que deja
   * reconocer una partida nueva que llega a un partido viejo (remake sin
   * `game_end`, observador que retoma un grupo huérfano).
   */
  ultimaJugada?: number;
  /**
   * La última ronda apuntada en el historial y quién la ganó, mientras todavía pueda corregirse su motivo (un
   * `spike_defused`/`spike_detonated` o el `end` pueden llegar unos instantes DESPUÉS del `score`). Se cierra al
   * empezar la compra siguiente.
   */
  rondaAbierta?: { ronda: number; ganador: Lado };
  /** La ronda cuyo combate ya empezó: un `combat` repetido de la misma ronda (observador que reenvía) no reinicia sus relojes. */
  combateRonda?: number;
  /** La ronda (en juego) de la última compra procesada: una compra con número mayor es ronda nueva aunque falten fases. */
  ultimaCompra?: number;
  /**
   * Evidencia de «desconectado» por jugador (puuid): desde cuándo y cuántos marcadores seguidos lo dan muerto EN la
   * compra. Un marcador rezagado suelto no basta (ver `actualizaMarcador`).
   */
  muertoEnCompra: Record<string, { desde: number; n: number }>;
  /**
   * matchIds de partidas de VALORANT que ya terminaron (o que el operador descartó) en este grupo. Tras volver al
   * menú, el observador puede reenviar el `match_start` (y el mapa y el modo) de la partida VIEJA: un `match_start`
   * con uno de estos ids no vale. Tope de 8.
   */
  idsTerminados: string[];
  /**
   * El mapa y el modo que había justo ANTES de la última ráfaga `map`/`game_mode` (con su hora). Si esa ráfaga
   * acaba en un `match_start` caducado, se vuelve a lo anterior: el mapa y el modo venían de la partida vieja.
   */
  antesDeRafaga?: { map: string; matchType: string; switchRound: number; firstOtRound: number; en: number };
}

export interface Partido {
  matchId: string;
  matchType: string;
  switchRound: number;
  firstOtRound: number;
  groupCode: string;
  isRunning: boolean;
  agentSelectStartTime?: number;
  roundNumber: number;
  roundPhase: string;
  roundTimeoutTime?: number;
  wasTimeout: boolean;
  spikeDetonationTime?: number;
  teams: [Equipo, Equipo];
  map: string;
  spikeState: { planted: boolean; detonated: boolean; defused: boolean };
  attackersWon: boolean;
  showAliveKDA: boolean;
  toastInfo: Rotulo;
  tools: Herramientas;
  interno: Interno;
}

/* ── Lo que entra ────────────────────────────────────────────────────────── */

/** Un paquete de datos (del observador, de un jugador o de una orden del operador). */
export interface Paquete {
  type: string;
  data: unknown;
  /** Hora del servidor en ms (la del paquete original se ignora). */
  timestamp: number;
  playerId?: string;
  [clave: string]: unknown;
}

/** Eventos internos del servidor que también pasan por el reductor. */
export type EventoInterno =
  | { type: '@reloj'; timestamp: number }
  | { type: '@configura'; timestamp: number; parche: Record<string, unknown> }
  | { type: '@jugador_desconectado'; timestamp: number; playerId: string }
  /** El operador pide dejar el estado de JUEGO limpio (ronda, marcador, jugadores): empieza otra partida. */
  | { type: '@reinicia_partida'; timestamp: number }
  /** Un jugador sigue conectado mandando sus datos propios, pero su partida se recreó: se le devuelve la marca de «manda vida». */
  | { type: '@aux_disponible'; timestamp: number; playerId: string }
  /** La detección por pantalla del observador: el juego se ve en gris (timeout o pausa) o ha vuelto el color. */
  | { type: '@pausa_visual'; timestamp: number; activa: boolean }
  /** Quién está publicando cámara ahora mismo (lo calcula `Central`, no el panel). */
  | {
      type: '@camaras';
      timestamp: number;
      publicando: string[];
      conexion?: { base: string; params: string; clave: string };
    };

export type Evento = Paquete | EventoInterno;

/* ── Lo que sobrevive entre mapas (por grupo) ───────────────────────────── */

export interface EquipoGuardado {
  name?: string;
  tricode?: string;
  url?: string;
  /** puuids de los jugadores registrados de ese equipo (ver `Interno.registrados`). */
  puuids?: string[];
}

export interface MemoriaGrupo {
  serie?: { needed: number; wonLeft: number; wonRight: number; mapInfo: EntradaMapa[] };
  /** Lo que el panel configuró de los tiempos muertos: vale para los mapas siguientes. */
  tiempos?: { max?: number; duracion?: number };
  equipos: [EquipoGuardado | null, EquipoGuardado | null];
  /** Cámaras: activadas y sala. Sobrevive a los mapas y a configurarse antes del partido. */
  camaras?: { enable?: boolean; identifier?: string };
  /**
   * Lo que el panel configuró de torneo, patrocinio, marca, cabezas de serie, alias, caja de victoria y modo
   * mínimo: vale para los mapas siguientes aunque el logon del observador (que trae valores de fábrica) diga otra cosa.
   */
  herramientas?: ParcheLimpio;
  /** matchIds de partidas que ya terminaron en este grupo (ver `Interno.idsTerminados`). */
  terminadas?: string[];
}

/* ── El logon del observador (lo que hace falta para crear el partido) ──── */

export interface EquipoLogon {
  name: string;
  tricode: string;
  url: string;
  attackStart: boolean;
}

export interface DatosCreacion {
  groupCode: string;
  leftTeam: EquipoLogon;
  rightTeam: EquipoLogon;
  toolsData: Record<string, unknown>;
}
