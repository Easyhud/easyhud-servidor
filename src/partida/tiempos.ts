/**
 * Tiempos muertos tácticos y pausa técnica.
 *
 * Reglas:
 *
 *  - Los contadores van con el EQUIPO (su `ingameTeamId`), no con la posición
 *    en pantalla: si se intercambian lados, cada equipo se lleva los suyos.
 *    Al serializar se proyectan a `timeoutCounter.left/right` según quién esté
 *    a cada lado en ese momento, que es lo que pinta el overlay.
 *  - Se descuenta AL EMPEZAR. Si se cancela dentro del periodo de gracia, se
 *    devuelve; pasada la gracia, queda gastado.
 *  - Cualquier forma de cortar un tiempo muerto en curso (cancelarlo, pedir
 *    uno el otro equipo, activar la pausa técnica) sigue esa misma regla.
 *  - Sin restantes, pedir uno no hace nada (ni siquiera genera un envío).
 *  - La cuenta atrás no la lleva un temporizador del servidor, sino el reloj
 *    que el transporte inyecta como evento `@reloj`: así todo esto es puro.
 */

import type { Lado, Partido } from './tipos.ts';

const MS = 1000;

function equipoEn(p: Partido, lado: Lado): Lado {
  return p.teams[lado].ingameTeamId;
}

/** Corta el táctico en curso, devolviéndolo si aún estaba en gracia. */
function cortaTactico(p: Partido, ahora: number): void {
  const t = p.interno.tiempos;
  if (t.activo === null) return;
  const transcurrido = ahora - t.activo.inicio;
  if (transcurrido < p.tools.timeoutCancellationGracePeriod * MS) {
    const e = t.activo.equipo;
    t.restantes[e] = Math.min(p.tools.timeoutMax, t.restantes[e] + 1);
  }
  t.activo = null;
  t.segundosRestantes = 0;
}

/**
 * Interruptor del tiempo muerto del equipo que está en la posición `lado`.
 * Devuelve si cambió el estado.
 */
export function alternaTiempoMuerto(p: Partido, lado: Lado, ahora: number): boolean {
  const t = p.interno.tiempos;
  const equipo = equipoEn(p, lado);

  // Ese equipo ya tiene uno en marcha: es una cancelación.
  if (t.activo !== null && t.activo.equipo === equipo) {
    cortaTactico(p, ahora);
    return true;
  }

  if (t.restantes[equipo] <= 0) return false;

  cortaTactico(p, ahora); // el del otro equipo, si lo había
  t.pausaTecnica = false;
  t.restantes[equipo] -= 1;
  t.activo = { equipo, inicio: ahora };
  t.segundosRestantes = p.tools.timeoutDuration;
  return true;
}

/** Interruptor de la pausa técnica. */
export function alternaPausaTecnica(p: Partido, ahora: number): boolean {
  const t = p.interno.tiempos;
  if (t.pausaTecnica) {
    t.pausaTecnica = false;
    t.segundosRestantes = 0;
    return true;
  }
  cortaTactico(p, ahora);
  t.pausaTecnica = true;
  // La pausa técnica no tiene fin; el overlay muestra su cuenta desde la duración entera.
  t.segundosRestantes = p.tools.timeoutDuration;
  return true;
}

/** Avance del reloj: baja la cuenta atrás y termina el táctico al llegar a cero. */
export function avanzaReloj(p: Partido, ahora: number): boolean {
  const t = p.interno.tiempos;
  if (t.activo === null) return false;
  const duracion = p.tools.timeoutDuration;
  const transcurrido = ahora - t.activo.inicio;
  if (transcurrido >= duracion * MS) {
    t.activo = null;
    t.segundosRestantes = 0;
    return true;
  }
  const quedan = duracion - Math.floor(transcurrido / MS);
  if (quedan === t.segundosRestantes) return false;
  t.segundosRestantes = quedan;
  return true;
}

/** ¿Hace falta que el reloj pase por este partido? */
export function necesitaReloj(p: Partido): boolean {
  return p.interno.tiempos.activo !== null;
}

/** Al entrar en prórroga, una vez por mapa: cada equipo recibe el extra, sin pasar del máximo. */
export function concedeProrroga(p: Partido): boolean {
  const t = p.interno.tiempos;
  if (t.prorrogaConcedida) return false;
  t.prorrogaConcedida = true;
  const extra = p.interno.extraProrroga;
  if (extra <= 0) return true;
  const tope = Math.max(p.tools.timeoutMax, extra);
  for (const e of [0, 1] as const) t.restantes[e] = Math.min(tope, t.restantes[e] + extra);
  return true;
}

/** Fin de mapa: nada queda corriendo. */
export function detenTodo(p: Partido): void {
  const t = p.interno.tiempos;
  t.activo = null;
  t.pausaTecnica = false;
  t.segundosRestantes = 0;
}

/* ── Proyección a lo que viaja ──────────────────────────────────────────── */

export function estadoTiempoMuerto(p: Partido) {
  const t = p.interno.tiempos;
  return {
    techPause: t.pausaTecnica,
    leftTeam: t.activo !== null && t.activo.equipo === equipoEn(p, 0),
    rightTeam: t.activo !== null && t.activo.equipo === equipoEn(p, 1),
    timeRemaining: t.segundosRestantes,
  };
}

export function contadorTiemposMuertos(p: Partido) {
  const r = p.interno.tiempos.restantes;
  return { max: p.tools.timeoutMax, left: r[equipoEn(p, 0)], right: r[equipoEn(p, 1)] };
}

export function graciaSuperada(p: Partido): boolean {
  const t = p.interno.tiempos;
  if (t.activo === null) return false;
  return p.tools.timeoutDuration - t.segundosRestantes >= p.tools.timeoutCancellationGracePeriod;
}
