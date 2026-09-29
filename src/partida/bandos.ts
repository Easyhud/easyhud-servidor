/**
 * Quién ataca y quién defiende: se DEDUCE de la ronda, no se va alternando.
 *
 * GEP numera los equipos de forma fija: el equipo de juego 0 es el que empieza
 * atacando y el 1 el que empieza defendiendo, pase lo que pase después
 * (documentación del marcador de VALORANT en GEP). Con eso y el número de
 * ronda, el bando de cada uno es una cuenta, no un estado:
 *
 *   - rondas 1 … switchRound−1: ataca el equipo 0;
 *   - rondas switchRound … firstOtRound−1: ataca el equipo 1;
 *   - prórroga: cambian en cada ronda; la primera la ataca el equipo 0.
 *
 * Antes se invertía `isAttacking` al ver el `shopping` de la ronda de cambio.
 * Eso dejaba el bando mal PARA EL RESTO DEL MAPA en cuanto se perdía ese único
 * paquete: un `round_number` de GEP que llega detrás de su `round_phase` (el
 * cliente manda el último que vio), un observador que se reconecta en la
 * segunda mitad y retoma un partido recién creado, un `shopping` que no
 * llega. Y con el bando mal, el overlay pinta los colores al revés y apunta
 * cada ronda al motivo contrario. Deducido, el siguiente paquete lo arregla.
 */

import type { Partido } from './tipos.ts';

/** ¿Ataca el equipo de juego 0 en esta ronda? (sin la inversión manual) */
export function atacaEquipoCero(p: Partido, ronda: number): boolean {
  if (ronda >= p.firstOtRound) return (ronda - p.firstOtRound) % 2 === 0;
  return ronda < p.switchRound;
}

/**
 * La ronda que se está jugando, con la mejor pista que haya.
 *
 * El `roundNumber` es el último `round_number` que vio el cliente y puede ir
 * una ronda por detrás de la fase. El marcador de rondas (`score`) no se
 * desfasa: las jugadas más uno. Se toma la mayor de las dos.
 */
export function rondaEnJuego(p: Partido): number {
  const [a, b] = p.interno.ultimoMarcador;
  return Math.max(p.roundNumber, a + b + 1, 1);
}

/**
 * Pone a cada equipo en el bando que le toca en `ronda`. Devuelve si alguno
 * cambió (el reinicio de ronda lo usa para devolver el dinero a 800).
 */
export function fijaBandos(p: Partido, ronda: number): boolean {
  const ataca0 = atacaEquipoCero(p, ronda) !== p.interno.bandosInvertidos;
  let cambio = false;
  for (const equipo of p.teams) {
    const ataca = (equipo.ingameTeamId === 0) === ataca0;
    if (equipo.isAttacking !== ataca) {
      equipo.isAttacking = ataca;
      cambio = true;
    }
  }
  if (cambio) p.interno.ultimoCambioLado = ronda;
  return cambio;
}
