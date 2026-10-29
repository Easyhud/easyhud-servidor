/**
 * Los parches de configuración que manda el panel (`configura`).
 *
 * Todo parche es parcial: sólo se toca lo que viene. Hay dos destinos:
 *  - la memoria del grupo (serie y nombres de equipos), que se actualiza
 *    AUNQUE no haya partido, para que el panel pueda preparar la emisión antes
 *    de que conecte el observador y para que el siguiente mapa herede la serie;
 *  - el partido en curso, si lo hay.
 */

import { aplicaHerramientas, fusionaRecuerdo, normalizaParche } from './saneado.ts';
import type { EntradaMapa, EquipoGuardado, MemoriaGrupo, Partido } from './tipos.ts';
import { vinculaPorRoster } from './vinculo.ts';

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const textoNoVacio = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** `puuids` de un equipo del parche: lista de textos no vacíos, o undefined si no viene. */
function puuidsDe(e: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(e.puuids)) return undefined;
  return [...new Set(e.puuids.filter(textoNoVacio))];
}

export function memoriaVacia(): MemoriaGrupo {
  return { equipos: [null, null] };
}

/**
 * Aplica a la memoria del grupo la parte del parche que sobrevive a los mapas. El parche se normaliza antes
 * (`normalizaParche`): sólo entra lo que tiene el tipo y el tamaño correctos.
 */
export function aplicaParcheGrupo(m: MemoriaGrupo, parche: Record<string, unknown>): void {
  const { limpio } = normalizaParche(parche);

  const serie = limpio.seriesInfo;
  if (serie) {
    m.serie ??= { needed: 1, wonLeft: 0, wonRight: 0, mapInfo: [] };
    if (serie.needed !== undefined) m.serie.needed = serie.needed;
    if (serie.wonLeft !== undefined) m.serie.wonLeft = serie.wonLeft;
    if (serie.wonRight !== undefined) m.serie.wonRight = serie.wonRight;
    if (serie.mapInfo !== undefined) m.serie.mapInfo = structuredClone(serie.mapInfo) as EntradaMapa[];
  }

  // Tiempos muertos: sin esto, cada mapa nuevo volvía al máximo y la duración
  // que manda el logon del cliente (2 y 60 s fijos), y lo que el operador
  // configuró antes de que hubiera partido se perdía.
  if (limpio.timeoutDuration !== undefined) m.tiempos = { ...m.tiempos, duracion: limpio.timeoutDuration };
  if (limpio.timeoutCounter?.max !== undefined) m.tiempos = { ...m.tiempos, max: limpio.timeoutCounter.max };

  const camaras = limpio.playercamsInfo;
  if (camaras) {
    m.camaras ??= {};
    if (camaras.enable !== undefined) m.camaras.enable = camaras.enable;
    if (camaras.identifier !== undefined) m.camaras.identifier = camaras.identifier;
  }

  if (limpio.equipos) {
    for (const i of [0, 1] as const) {
      const e = limpio.equipos[i];
      if (!e) continue;
      const guardado: EquipoGuardado = m.equipos[i] ?? {};
      if (e.name !== undefined) guardado.name = e.name;
      if (e.tricode !== undefined) guardado.tricode = e.tricode;
      if (e.url !== undefined) guardado.url = e.url;
      if (e.puuids !== undefined) guardado.puuids = [...e.puuids];
      m.equipos[i] = guardado;
    }
  }

  m.herramientas ??= {};
  fusionaRecuerdo(m.herramientas, limpio);
}
/**
 * Pone nombre/tricode/logo guardados en los equipos del partido, por posición,
 * y los puuids registrados de cada lado (el vínculo por roster lo aplica quien llama).
 */
export function aplicaEquiposGuardados(p: Partido, equipos: ReadonlyArray<unknown>): void {
  for (const i of [0, 1] as const) {
    const e = equipos[i];
    if (!esObjeto(e)) continue;
    const t = p.teams[i];
    if (textoNoVacio(e.name)) t.teamName = e.name;
    if (textoNoVacio(e.tricode)) t.teamTricode = e.tricode;
    if (typeof e.url === 'string') t.teamUrl = e.url;
    const puuids = puuidsDe(e);
    if (puuids !== undefined) p.interno.registrados[i] = puuids;
  }
}

/**
 * Aplica el parche al partido (normalizado antes). Devuelve si cambió algo.
 *
 * Ajuste de `timeoutCounter.max`: si el máximo sube, los restantes de cada
 * equipo suben lo mismo, y si baja, se recortan al nuevo máximo.
 */
export function aplicaParchePartido(p: Partido, parche: Record<string, unknown>): boolean {
  const { limpio } = normalizaParche(parche);
  const t = p.tools;
  let cambio = aplicaHerramientas(t, limpio);

  const nuevo = limpio.timeoutCounter?.max;
  if (nuevo !== undefined) {
    const diferencia = nuevo - t.timeoutMax;
    const r = p.interno.tiempos.restantes;
    for (const i of [0, 1] as const) {
      r[i] = Math.min(nuevo, Math.max(0, r[i] + Math.max(0, diferencia)));
    }
    t.timeoutMax = nuevo;
    cambio = true;
  }

  if (limpio.equipos) {
    aplicaEquiposGuardados(p, limpio.equipos);
    vinculaPorRoster(p);
    cambio = true;
  }

  return cambio;
}