/**
 * Saneado de todo lo que el operador (panel) o el observador (logon) pueden
 * mandar como configuración: tipos, rangos y tamaños.
 *
 * Una sola función, `normalizaParche`, convierte un parche cualquiera en un
 * parche LIMPIO: sólo claves conocidas, con el tipo correcto y dentro de los
 * límites; lo que no vale se descarta y se anota en `avisos` (frases cortas,
 * pensadas para enseñárselas al operador). Un parche limpio es idempotente:
 * volver a normalizarlo no cambia nada, así que se puede aplicar en varios
 * sitios (memoria del grupo, partido en curso, logon) sin miedo.
 *
 * Los campos `seedingInfo`, `nameOverrides` y `roundWinBox` llevan los MISMOS
 * nombres y formas que en el servidor original, para que el overlay los lea igual.
 * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — model/ToolsData.ts
 * (tipos ISeedingInfo, INameOverrides, IRoundWinBox e IRoundWinBoxSponsors).
 */

/* ── Límites (un cliente roto o un operador despistado no puede pasarse de aquí) ── */

export const LIMITES = {
  nombreEquipo: 40,
  tricode: 10,
  url: 4096,
  nombreTorneo: 80,
  textoMarca: 80,
  identificadorSala: 64,
  seeding: 20,
  claveAlias: 64,
  alias: 32,
  aliasMaximos: 100,
  patrocinadores: 20,
  cajaPatrocinadores: 10,
  ceremonias: 7,
  mapasSerie: 12,
  bytesMapa: 40_000,
  puuidsPorEquipo: 15,
  puuid: 64,
  serieNecesaria: 20,
  victoriasSerie: 20,
  duracionTiempoMuerto: 600,
  tiemposMuertos: 10,
  duracionPatrocinio: 120,
  tituloRotulo: 120,
  mensajeRotulo: 500,
  nombreJugador: 64,
  agente: 40,
  idJugador: 64,
  idPartida: 64,
} as const;

export const TIPOS_CAJA_VICTORIA = ['disabled', 'tournamentInfo', 'sponsors'] as const;
export const CEREMONIAS = ['all', 'normal', 'ace', 'clutch', 'teamAce', 'flawless', 'thrifty'] as const;
const EQUIPOS_CAJA = ['all', 'left', 'right'] as const;
const TIPOS_MAPA = new Set(['past', 'present', 'future', 'disabled']);

import type { Herramientas } from './tipos.ts';

export type TipoCajaVictoria = (typeof TIPOS_CAJA_VICTORIA)[number];

export interface PatrocinadorCaja {
  wonTeam: 'all' | 'left' | 'right';
  roundCeremony: (typeof CEREMONIAS)[number][];
  iconUrl: string;
  backdropUrl: string;
}

export interface CajaVictoria {
  type: TipoCajaVictoria;
  sponsors: PatrocinadorCaja[];
}

export interface EquipoParche {
  name?: string;
  tricode?: string;
  url?: string;
  puuids?: string[];
}

/** Un parche ya validado: todo opcional, nada fuera de tipo. */
export interface ParcheLimpio {
  tournamentInfo?: { name?: string; logoUrl?: string; backdropUrl?: string };
  seriesInfo?: { needed?: number; wonLeft?: number; wonRight?: number; mapInfo?: Record<string, unknown>[] };
  sponsorInfo?: { enabled?: boolean; duration?: number; sponsors?: string[] };
  watermarkInfo?: { customTextEnabled?: boolean; customText?: string };
  timeoutDuration?: number;
  timeoutCounter?: { max?: number };
  playercamsInfo?: { enable?: boolean; identifier?: string; removeTricodes?: boolean };
  equipos?: [EquipoParche | null, EquipoParche | null];
  seedingInfo?: { left?: string; right?: string };
  /** JSON de una lista de pares [Nombre#TAG, alias], como en el original. Sustituye a la lista anterior. */
  nameOverrides?: { overrides: string };
  roundWinBox?: { type?: TipoCajaVictoria; sponsors?: PatrocinadorCaja[] };
  minimal?: boolean;
}

/* ── Utilidades ─────────────────────────────────────────────────────────── */

export const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Caracteres de control (menos el salto de línea y el tabulador) y separadores de línea Unicode. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_Y_SALTOS = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** Texto de una línea: sin controles ni saltos, recortado a `max`. `undefined` si no es texto. */
export function linea(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const limpio = v.replace(CONTROL_Y_SALTOS, ' ').trim();
  return limpio.length > max ? limpio.slice(0, max).trimEnd() : limpio;
}

/** Texto con saltos de línea permitidos (mensajes), sin otros controles, recortado a `max`. */
export function texto(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const limpio = v.replace(CONTROL, '').trim();
  return limpio.length > max ? limpio.slice(0, max).trimEnd() : limpio;
}

/** Un número, o un texto numérico (los campos de formulario llegan como texto). */
function numeroDe(v: unknown): number | undefined {
  if (esNumero(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export class Recoge {
  readonly avisos: string[] = [];
  aviso(m: string): void {
    if (this.avisos.length < 20 && !this.avisos.includes(m)) this.avisos.push(m);
  }
}

function url(v: unknown, ruta: string, r: Recoge): string | undefined {
  if (typeof v !== 'string') return undefined;
  const u = v.replace(CONTROL_Y_SALTOS, '').trim();
  if (u.length > LIMITES.url) {
    r.aviso(`${ruta}: la dirección es demasiado larga (máximo ${LIMITES.url} caracteres), se ha ignorado`);
    return undefined;
  }
  if (/^(javascript|vbscript):/i.test(u)) {
    r.aviso(`${ruta}: dirección no permitida, se ha ignorado`);
    return undefined;
  }
  return u;
}

function textoLimitado(v: unknown, max: number, ruta: string, r: Recoge, multilinea = false): string | undefined {
  const t = multilinea ? texto(v, max + 1) : linea(v, max + 1);
  if (t === undefined) return undefined;
  if (t.length > max) {
    r.aviso(`${ruta}: texto demasiado largo (máximo ${max} caracteres), se ha recortado`);
    return t.slice(0, max).trimEnd();
  }
  return t;
}

function enteroEn(v: unknown, min: number, max: number, ruta: string, r: Recoge): number | undefined {
  const n = numeroDe(v);
  if (n === undefined) return undefined;
  const e = Math.floor(n);
  if (e < min || e > max) {
    r.aviso(`${ruta}: ${e} está fuera de rango (de ${min} a ${max}), se ha ajustado`);
    return Math.min(max, Math.max(min, e));
  }
  return e;
}

/* ── Piezas ─────────────────────────────────────────────────────────────── */

/** Lista de direcciones (patrocinadores): textos válidos, sin repetir, con tope. */
function listaUrls(v: unknown, tope: number, ruta: string, r: Recoge): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const salida: string[] = [];
  for (const e of v) {
    const u = url(e, ruta, r);
    if (u === undefined || u === '' || salida.includes(u)) continue;
    if (salida.length >= tope) {
      r.aviso(`${ruta}: máximo ${tope} elementos, el resto se ha ignorado`);
      break;
    }
    salida.push(u);
  }
  return salida;
}

/** Una entrada de la tira de mapas de la serie: un objeto con `type`; el resto es opaco pero acotado. */
function entradasMapa(v: unknown, r: Recoge): Record<string, unknown>[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const salida: Record<string, unknown>[] = [];
  for (const e of v) {
    if (!esObjeto(e) || typeof e.type !== 'string' || !TIPOS_MAPA.has(e.type)) {
      r.aviso('seriesInfo.mapInfo: una entrada sin tipo válido (past, present, future o disabled) se ha ignorado');
      continue;
    }
    let tamano: number;
    try {
      tamano = JSON.stringify(e).length;
    } catch {
      continue;
    }
    if (tamano > LIMITES.bytesMapa) {
      r.aviso('seriesInfo.mapInfo: una entrada es demasiado grande, se ha ignorado');
      continue;
    }
    if (salida.length >= LIMITES.mapasSerie) {
      r.aviso(`seriesInfo.mapInfo: máximo ${LIMITES.mapasSerie} mapas, el resto se ha ignorado`);
      break;
    }
    salida.push(structuredClone(e));
  }
  return salida;
}

function equipoParche(v: unknown, i: number, r: Recoge): EquipoParche | null {
  if (!esObjeto(v)) return null;
  const e: EquipoParche = {};
  const ruta = `equipos[${i}]`;
  const nombre = textoLimitado(v.name, LIMITES.nombreEquipo, `${ruta}.name`, r);
  if (nombre !== undefined && nombre !== '') e.name = nombre;
  const tri = textoLimitado(v.tricode, LIMITES.tricode, `${ruta}.tricode`, r);
  if (tri !== undefined && tri !== '') e.tricode = tri;
  const u = url(v.url, `${ruta}.url`, r);
  if (u !== undefined) e.url = u;
  if (Array.isArray(v.puuids)) {
    const lista: string[] = [];
    for (const p of v.puuids) {
      if (typeof p !== 'string' || p === '' || p.length > LIMITES.puuid || /[\u0000-\u001f\u007f]/.test(p) || lista.includes(p)) continue;
      if (lista.length >= LIMITES.puuidsPorEquipo) {
        r.aviso(`${ruta}.puuids: máximo ${LIMITES.puuidsPorEquipo} jugadores por equipo, el resto se ha ignorado`);
        break;
      }
      lista.push(p);
    }
    e.puuids = lista;
  }
  return e;
}

/**
 * Alias de visualización. Se aceptan los pares `[[«Nombre#TAG», alias], …]`, un objeto `{«Nombre#TAG»: alias}` y el
 * mismo contenido como texto JSON (así viaja en el original); sale siempre el texto JSON de la lista de pares.
 * Un alias vacío quita el alias de ese jugador.
 */
export function saneaAlias(v: unknown, r: Recoge = new Recoge()): string | undefined {
  let o: unknown = esObjeto(v) && 'overrides' in v ? v.overrides : v;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      r.aviso('nameOverrides: el texto no es un JSON válido, se ha ignorado');
      return undefined;
    }
  }
  let pares: [unknown, unknown][];
  if (Array.isArray(o)) {
    pares = o.filter((e): e is unknown[] => Array.isArray(e) && e.length >= 2).map((e) => [e[0], e[1]]);
  } else if (esObjeto(o)) {
    pares = Object.entries(o);
  } else {
    r.aviso('nameOverrides: se esperaba una lista de pares [Nombre#TAG, alias], se ha ignorado');
    return undefined;
  }
  const mapa = new Map<string, string>();
  for (const [k, a] of pares) {
    const clave = linea(k, LIMITES.claveAlias);
    const alias = linea(a, LIMITES.alias);
    if (clave === undefined || clave === '' || alias === undefined) continue;
    if (alias === '') {
      mapa.delete(clave);
      continue;
    }
    if (!mapa.has(clave) && mapa.size >= LIMITES.aliasMaximos) {
      r.aviso(`nameOverrides: máximo ${LIMITES.aliasMaximos} alias, el resto se ha ignorado`);
      break;
    }
    mapa.set(clave, alias);
  }
  return JSON.stringify([...mapa.entries()]);
}

function cajaVictoria(v: unknown, r: Recoge): ParcheLimpio['roundWinBox'] | undefined {
  if (!esObjeto(v)) return undefined;
  const c: NonNullable<ParcheLimpio['roundWinBox']> = {};
  if (v.type !== undefined) {
    if ((TIPOS_CAJA_VICTORIA as readonly unknown[]).includes(v.type)) c.type = v.type as TipoCajaVictoria;
    else r.aviso('roundWinBox.type: debe ser disabled, tournamentInfo o sponsors, se ha ignorado');
  }
  if (Array.isArray(v.sponsors)) {
    const lista: PatrocinadorCaja[] = [];
    for (const s of v.sponsors) {
      if (!esObjeto(s)) continue;
      if (lista.length >= LIMITES.cajaPatrocinadores) {
        r.aviso(`roundWinBox.sponsors: máximo ${LIMITES.cajaPatrocinadores} patrocinadores, el resto se ha ignorado`);
        break;
      }
      const ceremonias = (Array.isArray(s.roundCeremony) ? s.roundCeremony : [])
        .filter((x): x is (typeof CEREMONIAS)[number] => (CEREMONIAS as readonly unknown[]).includes(x))
        .slice(0, LIMITES.ceremonias);
      lista.push({
        wonTeam: (EQUIPOS_CAJA as readonly unknown[]).includes(s.wonTeam) ? (s.wonTeam as 'all' | 'left' | 'right') : 'all',
        roundCeremony: ceremonias.length > 0 ? [...new Set(ceremonias)] : ['all'],
        iconUrl: url(s.iconUrl, 'roundWinBox.sponsors.iconUrl', r) ?? '',
        backdropUrl: url(s.backdropUrl, 'roundWinBox.sponsors.backdropUrl', r) ?? '',
      });
    }
    c.sponsors = lista;
  }
  return c;
}

/* ── El parche entero ───────────────────────────────────────────────────── */

export function normalizaParche(parche: unknown): { limpio: ParcheLimpio; avisos: string[] } {
  const r = new Recoge();
  const limpio: ParcheLimpio = {};
  if (!esObjeto(parche)) return { limpio, avisos: r.avisos };

  const torneo = parche.tournamentInfo;
  if (esObjeto(torneo)) {
    const t: NonNullable<ParcheLimpio['tournamentInfo']> = {};
    const nombre = textoLimitado(torneo.name, LIMITES.nombreTorneo, 'tournamentInfo.name', r);
    if (nombre !== undefined) t.name = nombre;
    const logo = url(torneo.logoUrl, 'tournamentInfo.logoUrl', r);
    if (logo !== undefined) t.logoUrl = logo;
    const fondo = url(torneo.backdropUrl, 'tournamentInfo.backdropUrl', r);
    if (fondo !== undefined) t.backdropUrl = fondo;
    limpio.tournamentInfo = t;
  }

  const serie = parche.seriesInfo;
  if (esObjeto(serie)) {
    const s: NonNullable<ParcheLimpio['seriesInfo']> = {};
    const needed = enteroEn(serie.needed, 0, LIMITES.serieNecesaria, 'seriesInfo.needed', r);
    if (needed !== undefined) s.needed = needed;
    const izq = enteroEn(serie.wonLeft, 0, LIMITES.victoriasSerie, 'seriesInfo.wonLeft', r);
    if (izq !== undefined) s.wonLeft = izq;
    const der = enteroEn(serie.wonRight, 0, LIMITES.victoriasSerie, 'seriesInfo.wonRight', r);
    if (der !== undefined) s.wonRight = der;
    const mapas = entradasMapa(serie.mapInfo, r);
    if (mapas !== undefined) s.mapInfo = mapas;
    limpio.seriesInfo = s;
  }

  const patro = parche.sponsorInfo;
  if (esObjeto(patro)) {
    const p: NonNullable<ParcheLimpio['sponsorInfo']> = {};
    if (typeof patro.enabled === 'boolean') p.enabled = patro.enabled;
    const duracion = numeroDe(patro.duration);
    if (duracion !== undefined && duracion > 0) p.duration = Math.min(LIMITES.duracionPatrocinio, duracion);
    const lista = listaUrls(patro.sponsors, LIMITES.patrocinadores, 'sponsorInfo.sponsors', r);
    if (lista !== undefined) p.sponsors = lista;
    limpio.sponsorInfo = p;
  }

  const marca = parche.watermarkInfo;
  if (esObjeto(marca)) {
    const m: NonNullable<ParcheLimpio['watermarkInfo']> = {};
    if (typeof marca.customTextEnabled === 'boolean') m.customTextEnabled = marca.customTextEnabled;
    const t = textoLimitado(marca.customText, LIMITES.textoMarca, 'watermarkInfo.customText', r);
    if (t !== undefined) m.customText = t;
    limpio.watermarkInfo = m;
  }

  const duracionTm = numeroDe(parche.timeoutDuration);
  if (duracionTm !== undefined) {
    if (duracionTm > 0) limpio.timeoutDuration = Math.min(LIMITES.duracionTiempoMuerto, duracionTm);
    else r.aviso('timeoutDuration: debe ser mayor que 0, se ha ignorado');
  }

  const contador = parche.timeoutCounter;
  if (esObjeto(contador) && contador.max !== undefined && contador.max !== null) {
    const max = enteroEn(contador.max, 0, LIMITES.tiemposMuertos, 'timeoutCounter.max', r);
    if (max !== undefined) limpio.timeoutCounter = { max };
  }

  const camaras = parche.playercamsInfo;
  if (esObjeto(camaras)) {
    const c: NonNullable<ParcheLimpio['playercamsInfo']> = {};
    if (typeof camaras.enable === 'boolean') c.enable = camaras.enable;
    if (typeof camaras.identifier === 'string') {
      // El código de sala va dentro de una dirección: nada de espacios ni separadores que lo rompan.
      const id = camaras.identifier.trim();
      if (id.length > LIMITES.identificadorSala || /[\s&?#=%/\\\u0000-\u001f\u007f]/.test(id)) {
        r.aviso(`playercamsInfo.identifier: la sala no puede llevar espacios ni símbolos (& ? # = % /) ni pasar de ${LIMITES.identificadorSala} caracteres, se ha ignorado`);
      } else {
        c.identifier = id;
      }
    }
    if (typeof camaras.removeTricodes === 'boolean') c.removeTricodes = camaras.removeTricodes;
    limpio.playercamsInfo = c;
  }

  if (Array.isArray(parche.equipos)) {
    limpio.equipos = [equipoParche(parche.equipos[0], 0, r), equipoParche(parche.equipos[1], 1, r)];
  }

  const seeding = parche.seedingInfo;
  if (esObjeto(seeding)) {
    const s: NonNullable<ParcheLimpio['seedingInfo']> = {};
    const izq = textoLimitado(seeding.left, LIMITES.seeding, 'seedingInfo.left', r);
    if (izq !== undefined) s.left = izq;
    const der = textoLimitado(seeding.right, LIMITES.seeding, 'seedingInfo.right', r);
    if (der !== undefined) s.right = der;
    limpio.seedingInfo = s;
  }

  if (parche.nameOverrides !== undefined) {
    const alias = saneaAlias(parche.nameOverrides, r);
    if (alias !== undefined) limpio.nameOverrides = { overrides: alias };
  }

  if (parche.roundWinBox !== undefined) {
    const caja = cajaVictoria(parche.roundWinBox, r);
    if (caja !== undefined) limpio.roundWinBox = caja;
  }

  if (typeof parche.minimal === 'boolean') limpio.minimal = parche.minimal;

  return { limpio, avisos: r.avisos };
}

/* ── Aplicar un parche limpio a la configuración ────────────────────────── */

/**
 * Pone en `t` lo que trae el parche limpio, subobjeto a subobjeto (sólo las claves presentes). Devuelve si había algo
 * que aplicar. No toca los tiempos muertos restantes (eso lo hace el partido en curso) ni los equipos.
 */
export function aplicaHerramientas(t: Herramientas, l: ParcheLimpio): boolean {
  let cambio = false;
  if (l.tournamentInfo) {
    Object.assign(t.tournamentInfo, l.tournamentInfo);
    cambio = true;
  }
  if (l.seriesInfo) {
    const { mapInfo, ...numeros } = l.seriesInfo;
    Object.assign(t.seriesInfo, numeros);
    if (mapInfo !== undefined) t.seriesInfo.mapInfo = structuredClone(mapInfo) as typeof t.seriesInfo.mapInfo;
    cambio = true;
  }
  if (l.sponsorInfo) {
    const { sponsors, ...resto } = l.sponsorInfo;
    Object.assign(t.sponsorInfo, resto);
    if (sponsors !== undefined) t.sponsorInfo.sponsors = [...sponsors];
    cambio = true;
  }
  if (l.watermarkInfo) {
    Object.assign(t.watermarkInfo, l.watermarkInfo);
    t.watermarkInfo.brandWatermark = false; // Easy HUD no lleva marca de agua de terceros, se mande lo que se mande
    cambio = true;
  }
  if (l.timeoutDuration !== undefined) {
    t.timeoutDuration = l.timeoutDuration;
    cambio = true;
  }
  if (l.playercamsInfo) {
    // `enabledPlayers` NO se acepta del panel: lo decide el servidor según quién publica.
    Object.assign(t.playercamsInfo, l.playercamsInfo);
    cambio = true;
  }
  if (l.seedingInfo) {
    Object.assign(t.seedingInfo, l.seedingInfo);
    cambio = true;
  }
  if (l.nameOverrides) {
    t.nameOverrides = { overrides: l.nameOverrides.overrides };
    cambio = true;
  }
  if (l.roundWinBox) {
    if (l.roundWinBox.type !== undefined) t.roundWinBox.type = l.roundWinBox.type;
    if (l.roundWinBox.sponsors !== undefined) t.roundWinBox.sponsors = structuredClone(l.roundWinBox.sponsors);
    cambio = true;
  }
  if (l.minimal !== undefined) {
    t.minimal = l.minimal;
    cambio = true;
  }
  return cambio;
}

/** Suma `nuevo` a lo que el grupo ya recordaba (subobjeto a subobjeto): lo último que dijo el panel manda. */
export function fusionaRecuerdo(recuerdo: ParcheLimpio, nuevo: ParcheLimpio): void {
  const sub = <K extends 'tournamentInfo' | 'seriesInfo' | 'sponsorInfo' | 'watermarkInfo' | 'playercamsInfo' | 'seedingInfo' | 'roundWinBox'>(k: K): void => {
    const n = nuevo[k];
    if (n === undefined) return;
    recuerdo[k] = { ...(recuerdo[k] as object | undefined), ...structuredClone(n) } as ParcheLimpio[K];
  };
  sub('tournamentInfo');
  sub('sponsorInfo');
  sub('watermarkInfo');
  sub('seedingInfo');
  sub('roundWinBox');
  if (nuevo.playercamsInfo?.removeTricodes !== undefined) {
    recuerdo.playercamsInfo = { ...recuerdo.playercamsInfo, removeTricodes: nuevo.playercamsInfo.removeTricodes };
  }
  if (nuevo.nameOverrides) recuerdo.nameOverrides = { ...nuevo.nameOverrides };
  if (nuevo.minimal !== undefined) recuerdo.minimal = nuevo.minimal;
}