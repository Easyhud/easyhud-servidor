/**
 * Identidad de cada lado y vínculo por roster.
 *
 * El panel pone nombre/tricode/logo por LADO de pantalla (0 = izquierda). Qué
 * equipo REAL es el equipo de juego 0 lo decide la partida (el que empieza
 * atacando), no el panel: sin más datos, el nombre de la izquierda cae sobre
 * el equipo de juego 0 sea quien sea.
 *
 * Si el panel manda además los puuids de cada equipo registrado
 * (`equipos[i].puuids`), el servidor puede saber qué equipo de juego es cada
 * lado mirando el roster: si los jugadores registrados a la izquierda están
 * en el equipo de juego que hoy pinta la derecha, los EQUIPOS DE JUEGO cambian
 * de lado (con sus jugadores, marcador, historial, tiempos muertos y bando) y
 * la identidad de cada lado se queda donde está. Así el nombre, el logo y el
 * marcador de serie (que va por lado) siguen con el equipo de verdad.
 */

import type { Equipo, Partido } from './tipos.ts';

export function intercambiaIdentidad(a: Equipo, b: Equipo): void {
  [a.teamName, b.teamName] = [b.teamName, a.teamName];
  [a.teamTricode, b.teamTricode] = [b.teamTricode, a.teamTricode];
  [a.teamUrl, b.teamUrl] = [b.teamUrl, a.teamUrl];
}

/** Las órdenes de intercambio mueven también el vínculo, para que no se deshagan solas. */
export function intercambiaRegistrados(p: Partido): void {
  const r = p.interno.registrados;
  p.interno.registrados = [r[1], r[0]];
}

const coincidencias = (e: Equipo, puuids: readonly string[]): number =>
  e.players.reduce((n, j) => n + (puuids.includes(j.riotId) ? 1 : 0), 0);

/**
 * Coloca cada equipo de juego en el lado de sus registrados. Sólo cambia algo
 * si el cruce explica el roster MEJOR que el orden actual (mayoría estricta),
 * así que no oscila con rosters parciales ni con suplentes sin registrar.
 * Devuelve si cambió.
 */
export function vinculaPorRoster(p: Partido): boolean {
  const [izq, der] = p.interno.registrados;
  if (izq.length === 0 && der.length === 0) return false;
  const [a, b] = p.teams;
  const directo = coincidencias(a, izq) + coincidencias(b, der);
  const cruzado = coincidencias(a, der) + coincidencias(b, izq);
  if (cruzado <= directo) return false;
  p.teams = [b, a];
  // Los equipos de juego cambiaron de lado; la identidad de cada lado, no.
  intercambiaIdentidad(b, a);
  return true;
}
