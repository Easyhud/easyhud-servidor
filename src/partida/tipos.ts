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
  playercamsInfo: { enable: boolean; identifier: string; enabledPlayers: string[] };
}

export interface Rotulo {
  active: boolean;
  title: string;
  message: string;
  duration: number | null;
  eventLogoEnabled: boolean;
  selectedTeam?: string;
}

/** Tiempos muertos y pausa técnica. Los contadores van por EQUIPO DE JUEGO. */
export interface EstadoTiempos {
  /** Restantes por `ingameTeamId` (no por posición en pantalla). */
  restantes: [number, number];
  /** Tiempo muerto táctico en curso: de qué equipo de juego y desde cuándo (ms). */
  activo: { equipo: Lado; inicio: number } | null;
  pausaTecnica: boolean;
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
  | { type: '@jugador_desconectado'; timestamp: number; playerId: string };

export type Evento = Paquete | EventoInterno;

/* ── Lo que sobrevive entre mapas (por grupo) ───────────────────────────── */

export interface EquipoGuardado {
  name?: string;
  tricode?: string;
  url?: string;
}

export interface MemoriaGrupo {
  serie?: { needed: number; wonLeft: number; wonRight: number; mapInfo: EntradaMapa[] };
  /** Lo que el panel configuró de los tiempos muertos: vale para los mapas siguientes. */
  tiempos?: { max?: number; duracion?: number };
  equipos: [EquipoGuardado | null, EquipoGuardado | null];
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
