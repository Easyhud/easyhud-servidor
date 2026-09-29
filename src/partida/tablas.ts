/**
 * Tablas de traducción: de los códigos internos que da el GEP de VALORANT a
 * los nombres visibles que pintan el overlay y el panel.
 *
 * Los nombres visibles son parte del contrato: el overlay los compara (en
 * minúsculas) con sus propias tablas de precios e iconos, así que no se
 * "arreglan" por estética. Si Riot añade un agente o un arma, se añade aquí.
 */

/* ── Agentes ─────────────────────────────────────────────────────────────── */

/** Nombre interno → nombre visible. */
const AGENTES: Record<string, string> = {
  Clay: 'Raze',
  Pandemic: 'Viper',
  Wraith: 'Omen',
  Hunter: 'Sova',
  Thorne: 'Sage',
  Phoenix: 'Phoenix',
  Wushu: 'Jett',
  Gumshoe: 'Cypher',
  Sarge: 'Brimstone',
  Breach: 'Breach',
  Vampire: 'Reyna',
  Killjoy: 'Killjoy',
  Guide: 'Skye',
  Stealth: 'Yoru',
  Rift: 'Astra',
  Grenadier: 'KAYO',
  Deadeye: 'Chamber',
  Sprinter: 'Neon',
  BountyHunter: 'Fade',
  Mage: 'Harbor',
  Aggrobot: 'Gekko',
  Cable: 'Deadlock',
  Sequoia: 'Iso',
  Smonk: 'Clove',
  Nox: 'Vyse',
  Cashew: 'Tejo',
  Terra: 'Waylay',
  Pine: 'Veto',
  Iris: 'Miks',
};

/** Quita el sufijo `_PC_C` con el que a veces llega el código del agente. */
function codigoBase(codigo: string): string {
  return codigo.endsWith('_PC_C') ? codigo.slice(0, -'_PC_C'.length) : codigo;
}

/** Nombre visible de un agente. Vacío = aún no ha elegido; desconocido = el propio código. */
export function nombreAgente(interno: string | undefined): string {
  if (interno === undefined || interno === '') return 'No Agent selected';
  return AGENTES[codigoBase(interno)] ?? interno;
}

/** El nombre interno normalizado (sin sufijo), que es lo que se compara entre jugadores. */
export function agenteNormalizado(interno: string | undefined): string {
  return interno === undefined ? '' : codigoBase(interno);
}

/**
 * Icono del killfeed (lo que llega en las asistencias) → nombre interno del
 * agente. Se deriva de la tabla de agentes: `TX_Killfeed_<Visible>` → interno.
 * Así Miks (interno `Iris`) casa como los demás, cosa que antes no pasaba.
 */
const ICONOS_KILLFEED: Record<string, string> = Object.fromEntries(
  Object.entries(AGENTES).map(([interno, visible]) => [`TX_Killfeed_${visible}`, interno]),
);
// Miks tiene el icono con el nombre interno, no con el visible.
ICONOS_KILLFEED['TX_Killfeed_Iris'] = 'Iris';

export function agenteDeIconoKillfeed(icono: string): string | undefined {
  return ICONOS_KILLFEED[icono];
}

/* ── Armas y habilidades ─────────────────────────────────────────────────── */

const ARMAS: Record<string, string> = {
  TX_Hud_Pistol_Classic: 'Classic',
  TX_Hud_Pistol_Glock_S: 'Classic',
  TX_Hud_Pistol_Slim: 'Shorty',
  TX_Hud_Pistol_SawedOff_S: 'Shorty',
  TX_Hud_Pistol_AutoPistol: 'Frenzy',
  TX_Hud_AutoPistol: 'Frenzy',
  TX_Hud_Pistol_Luger: 'Ghost',
  TX_Hud_Pistol_Luger_S: 'Ghost',
  TX_Hud_Pistol_Sheriff: 'Sheriff',
  TX_Hud_Pistol_Revolver_S: 'Sheriff',
  TX_Hud_Pistol_Compact: 'Bandit',
  TX_Hud_Pistol_Compact_S: 'Bandit',
  TX_Hud_Shotguns_Pump: 'Bucky',
  TX_Hud_Pump: 'Bucky',
  TX_Hud_Shotguns_Persuader: 'Judge',
  TX_Hud_Shotguns_Spas12_S: 'Judge',
  TX_Hud_SMGs_Vector: 'Stinger',
  TX_Hud_Vector: 'Stinger',
  TX_Hud_SMGs_Ninja: 'Spectre',
  TX_Hud_SMG_MP5_S: 'Spectre',
  TX_Hud_Rifles_Burst: 'Bulldog',
  TX_Hud_Burst: 'Bulldog',
  TX_Hud_Rifles_DMR: 'Guardian',
  tx_hud_dmr: 'Guardian',
  TX_Hud_Rifles_Ghost: 'Phantom',
  TX_Hud_Assault_AR10A2_S: 'Phantom',
  TX_Hud_Rifles_Volcano: 'Vandal',
  TX_Hud_Volcano: 'Vandal',
  TX_Hud_Sniper_Bolt: 'Marshal',
  TX_Hud_Sniper_BoltAction_S: 'Marshal',
  TX_Hud_Sniper_Operater: 'Operator',
  TX_Hud_Operator: 'Operator',
  TX_Hud_Sniper_DoubleSniper: 'Outlaw',
  TX_Hud_DoubleSniper: 'Outlaw',
  TX_Hud_LMG: 'Ares',
  TX_Hud_HMG: 'Odin',
  knife: 'Knife',
  TX_Hud_Knife_Standard_S: 'Knife',
  unknown: 'Unknown',
  TX_Breach_FusionBlast: 'Aftershock',
  TX_Sarge_MolotovLauncher: 'Incendiary',
  TX_Sarge_OrbitalStrike: 'Orbital Strike (ULT)',
  TX_Pheonix_FireWall: 'Blaze',
  TX_Pheonix_Molotov: 'Hot Hands',
  TX_Hunter_ShockArrow: 'Shock Bolt',
  TX_Hunter_BowBlast: 'Hunters Fury',
  TX_Hud_Deadeye_Q_Pistol: 'Headhunter',
  TX_Hud_Deadeye_X_GiantSlayer: 'Tour de Force (ULT)',
  TX_Cable_FishingHook: 'Annihilation (ULT)',
  TX_Hud_Wushu_X_Dagger: 'Blade Storm (ULT)',
  TX_Neon_Ult: 'Overdrive (ULT)',
  TX_Thorne_Heal: 'Resurrection (ULT)',
  TX_Gumshoe_Tripwire: 'Trapwire',
  TX_Gren_Icon: 'Frag/ment',
  TX_Aggrobot_Bubbles: 'Mosh Pit',
  TX_KJ_Bees: 'Nanoswarm',
  tx_KJ_turret: 'Turret',
  TX_Clay_Boomba: 'Boom bot',
  TX_Clay_ClusterBomb: 'Paint Shells',
  TX_Clay_RocketLauncher: 'Show stopper (ULT)',
  TX_Guide4: 'Trail blazer',
  TX_Pandemic_AcidLauncher: 'Snake bite',
};

/** Nombre visible del arma; `undefined` si el código no está (el campo no sale). */
export function nombreArma(codigo: unknown): string | undefined {
  return typeof codigo === 'string' && Object.hasOwn(ARMAS, codigo) ? ARMAS[codigo] : undefined;
}

/* ── Mapas ───────────────────────────────────────────────────────────────── */

const MAPAS: Record<string, string> = {
  Infinityy: 'Abyss',
  Triad: 'Haven',
  Duality: 'Bind',
  Bonsai: 'Split',
  Ascent: 'Ascent',
  Port: 'Icebox',
  Foxtrot: 'Breeze',
  Canyon: 'Fracture',
  Pitt: 'Pearl',
  Jam: 'Lotus',
  Juliett: 'Sunset',
  Range: 'Practice Range',
  HURM_Alley: 'District',
  HURM_Yard: 'Piazza', // antes salía con un espacio final; el panel ya recortaba
  HURM_Bowl: 'Kasbah',
  HURM_Helix: 'Drift',
  Rook: 'Corrode',
};

/** Nombre visible del mapa. Un código desconocido da `Corrode` (el más reciente). */
export function nombreMapa(codigo: unknown): string {
  return typeof codigo === 'string' && Object.hasOwn(MAPAS, codigo) ? MAPAS[codigo] : 'Corrode';
}

/* ── Escudo ──────────────────────────────────────────────────────────────── */

const ESCUDOS = ['None', 'Light', 'Heavy', 'None', 'Regen'];

/** Nombre del escudo por índice; `undefined` si el índice no existe. */
export function nombreEscudo(indice: unknown): string | undefined {
  const i = typeof indice === 'string' && indice !== '' ? Number(indice) : indice;
  return typeof i === 'number' && Number.isInteger(i) ? ESCUDOS[i] : undefined;
}
