/**
 * Los parches de configuración que manda el panel (`configura`).
 *
 * Todo parche es parcial: sólo se toca lo que viene. Hay dos destinos:
 *  - la memoria del grupo (serie y nombres de equipos), que se actualiza
 *    AUNQUE no haya partido, para que el panel pueda preparar la emisión antes
 *    de que conecte el observador y para que el siguiente mapa herede la serie;
 *  - el partido en curso, si lo hay.
 */

import type { EquipoGuardado, MemoriaGrupo, Partido } from './tipos.ts';

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const textoNoVacio = (v: unknown): v is string => typeof v === 'string' && v !== '';

export function memoriaVacia(): MemoriaGrupo {
  return { equipos: [null, null] };
}

/** Aplica a la memoria del grupo la parte del parche que sobrevive a los mapas. */
export function aplicaParcheGrupo(m: MemoriaGrupo, parche: Record<string, unknown>): void {
  const serie = parche.seriesInfo;
  if (esObjeto(serie)) {
    m.serie ??= { needed: 1, wonLeft: 0, wonRight: 0, mapInfo: [] };
    if (esNumero(serie.needed)) m.serie.needed = serie.needed;
    if (esNumero(serie.wonLeft)) m.serie.wonLeft = serie.wonLeft;
    if (esNumero(serie.wonRight)) m.serie.wonRight = serie.wonRight;
    if (Array.isArray(serie.mapInfo)) m.serie.mapInfo = structuredClone(serie.mapInfo);
  }

  // Tiempos muertos: sin esto, cada mapa nuevo volvía al máximo y la duración
  // que manda el logon del cliente (2 y 60 s fijos), y lo que el operador
  // configuró antes de que hubiera partido se perdía.
  if (esNumero(parche.timeoutDuration) && parche.timeoutDuration > 0) {
    m.tiempos = { ...m.tiempos, duracion: parche.timeoutDuration };
  }
  const contador = parche.timeoutCounter;
  if (esObjeto(contador) && contador.max !== undefined && contador.max !== null) {
    const max = Math.floor(Number(contador.max));
    if (Number.isFinite(max) && max >= 0) m.tiempos = { ...m.tiempos, max };
  }

  const equipos = parche.equipos;
  if (Array.isArray(equipos)) {
    for (const i of [0, 1] as const) {
      const e = equipos[i];
      if (!esObjeto(e)) continue;
      const guardado: EquipoGuardado = m.equipos[i] ?? {};
      if (textoNoVacio(e.name)) guardado.name = e.name;
      if (textoNoVacio(e.tricode)) guardado.tricode = e.tricode;
      if (typeof e.url === 'string') guardado.url = e.url;
      m.equipos[i] = guardado;
    }
  }
}

/** Pone nombre/tricode/logo guardados en los equipos del partido, por posición. */
export function aplicaEquiposGuardados(p: Partido, equipos: ReadonlyArray<unknown>): void {
  for (const i of [0, 1] as const) {
    const e = equipos[i];
    if (!esObjeto(e)) continue;
    const t = p.teams[i];
    if (textoNoVacio(e.name)) t.teamName = e.name;
    if (textoNoVacio(e.tricode)) t.teamTricode = e.tricode;
    if (typeof e.url === 'string') t.teamUrl = e.url;
  }
}

/** Fusión superficial de un subobjeto de configuración (sin tocar las claves que no vienen). */
function fusiona(destino: Record<string, unknown>, origen: unknown): void {
  if (!esObjeto(origen)) return;
  for (const [k, v] of Object.entries(origen)) destino[k] = structuredClone(v);
}

/**
 * Aplica el parche al partido. Devuelve si cambió algo.
 *
 * Ajuste de `timeoutCounter.max`: si el máximo sube, los restantes de cada
 * equipo suben lo mismo, y si baja, se recortan al nuevo máximo.
 */
export function aplicaParchePartido(p: Partido, parche: Record<string, unknown>): boolean {
  let cambio = false;
  const t = p.tools;

  if (esObjeto(parche.tournamentInfo)) {
    fusiona(t.tournamentInfo, parche.tournamentInfo);
    cambio = true;
  }
  if (esObjeto(parche.seriesInfo)) {
    fusiona(t.seriesInfo, parche.seriesInfo);
    cambio = true;
  }
  if (esObjeto(parche.sponsorInfo)) {
    fusiona(t.sponsorInfo, parche.sponsorInfo);
    cambio = true;
  }
  if (esObjeto(parche.watermarkInfo)) {
    fusiona(t.watermarkInfo, parche.watermarkInfo);
    t.watermarkInfo.brandWatermark = false;
    cambio = true;
  }

  if (esNumero(parche.timeoutDuration) && parche.timeoutDuration > 0) {
    t.timeoutDuration = parche.timeoutDuration;
    cambio = true;
  }

  const contador = parche.timeoutCounter;
  if (esObjeto(contador) && contador.max !== undefined && contador.max !== null) {
    const nuevo = Math.floor(Number(contador.max));
    if (Number.isFinite(nuevo) && nuevo >= 0) {
      const diferencia = nuevo - t.timeoutMax;
      const r = p.interno.tiempos.restantes;
      for (const i of [0, 1] as const) {
        r[i] = Math.min(nuevo, Math.max(0, r[i] + Math.max(0, diferencia)));
      }
      t.timeoutMax = nuevo;
      cambio = true;
    }
  }

  const camaras = parche.playercamsInfo;
  if (esObjeto(camaras)) {
    if (typeof camaras.enable === 'boolean') t.playercamsInfo.enable = camaras.enable;
    if (typeof camaras.identifier === 'string') t.playercamsInfo.identifier = camaras.identifier;
    if (Array.isArray(camaras.enabledPlayers)) {
      t.playercamsInfo.enabledPlayers = camaras.enabledPlayers.filter((x): x is string => typeof x === 'string');
    }
    cambio = true;
  }

  if (Array.isArray(parche.equipos)) {
    aplicaEquiposGuardados(p, parche.equipos);
    cambio = true;
  }

  return cambio;
}
