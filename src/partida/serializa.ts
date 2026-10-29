/**
 * De estado interno a `match_data`.
 *
 * Se construye el objeto de salida campo a campo (en vez de volcar el estado
 * entero) para que sea imposible que se escape algo interno: el secreto del
 * grupo ni siquiera vive en el estado, y `interno` no se copia nunca.
 *
 * Reglas de `JSON.stringify` que el contrato aprovecha: los campos
 * `undefined` no aparecen, y los números no finitos salen como `null`.
 */

import { contadorTiemposMuertos, estadoTiempoMuerto, graciaSuperada } from './tiempos.ts';
import type { Partido } from './tipos.ts';

/**
 * `conClave`: incluir la clave de la sala de cámaras. Sólo para los consumidores AUTENTICADOS (panel, overlays con
 * token); el estado público, que ve cualquiera que conozca el grupo si no se exige token, NUNCA la lleva.
 * El resto de `playercamsInfo` (sala, base, parámetros, quién publica) sí viaja: el overlay arma con ello cada cámara.
 */
/**
 * Con `playercamsInfo.removeTricodes`, el nombre que se emite de cada jugador pierde el tricode de su equipo si lo
 * lleva al principio («ABC Nombre» → «Nombre»). Sólo cambia lo que SALE: dentro se queda el nombre real, que es el
 * que casa con el killfeed (el original lo cambiaba dentro y perdía esa coincidencia). Si el resultado quedara
 * vacío, se conserva el nombre.
 * Adaptado de ValoSpectra/Spectra-Server (Elastic License 2.0) — model/Player.ts (removeTricodeFromName)
 */
function equiposParaSalida(p: Partido): Partido['teams'] {
  if (p.tools.playercamsInfo.removeTricodes !== true) return p.teams;
  const vista = structuredClone(p.teams);
  for (const equipo of vista) {
    const tri = equipo.teamTricode;
    if (tri === '') continue;
    for (const j of equipo.players) {
      if (!j.name.startsWith(tri)) continue;
      const sin = j.name.slice(tri.length).trim();
      if (sin !== '') j.name = sin;
    }
  }
  return vista;
}

export function aSalida(p: Partido, conClave = false) {
  const t = p.tools;
  const { clave, ...camarasPublicas } = t.playercamsInfo;
  return {
    matchId: p.matchId,
    matchType: p.matchType,
    switchRound: p.switchRound,
    firstOtRound: p.firstOtRound,
    groupCode: p.groupCode,
    isRunning: p.isRunning,
    agentSelectStartTime: p.agentSelectStartTime,
    roundNumber: p.roundNumber,
    roundPhase: p.roundPhase,
    roundTimeoutTime: p.roundTimeoutTime,
    wasTimeout: p.wasTimeout,
    spikeDetonationTime: p.spikeDetonationTime,
    teams: equiposParaSalida(p),
    map: p.map,
    spikeState: p.spikeState,
    attackersWon: p.attackersWon,
    showAliveKDA: p.showAliveKDA,
    timeoutState: estadoTiempoMuerto(p),
    timeoutGracePeriodPassed: graciaSuperada(p),
    toastInfo: p.toastInfo,
    hasEnteredOvertime: p.interno.tiempos.prorrogaConcedida,
    tools: {
      seriesInfo: t.seriesInfo,
      tournamentInfo: t.tournamentInfo,
      timeoutDuration: t.timeoutDuration,
      timeoutCounter: contadorTiemposMuertos(p),
      timeoutCancellationGracePeriod: t.timeoutCancellationGracePeriod,
      sponsorInfo: t.sponsorInfo,
      watermarkInfo: t.watermarkInfo,
      playercamsInfo: conClave && clave !== undefined ? { ...camarasPublicas, clave } : camarasPublicas,
      seedingInfo: t.seedingInfo,
      nameOverrides: t.nameOverrides,
      roundWinBox: t.roundWinBox,
      minimal: t.minimal,
    },
  };
}

/** La cadena JSON que viaja (todos los eventos llevan un único argumento de texto). */
export function serializa(p: Partido, conClave = false): string {
  return JSON.stringify(aSalida(p, conClave));
}
