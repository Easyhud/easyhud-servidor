/**
 * Ayudas para las pruebas del reductor: un partido recién creado y una forma
 * corta de pasarle paquetes.
 */

import { creaPartido } from '../src/partida/creacion.ts';
import { reduce } from '../src/partida/reductor.ts';
import type { Evento, MemoriaGrupo, Partido } from '../src/partida/tipos.ts';

export function partidoNuevo(toolsData: Record<string, unknown> = {}, memoria?: MemoriaGrupo, extraProrroga = 1): Partido {
  return creaPartido(
    {
      groupCode: 'PRUEBA',
      leftTeam: { name: 'Izquierda', tricode: 'IZQ', url: '', attackStart: true },
      rightTeam: { name: 'Derecha', tricode: 'DER', url: '', attackStart: false },
      toolsData,
    },
    memoria,
    { extraProrroga },
  );
}

/** Mantiene un estado y le va pasando eventos, como hace la central. */
export class Banco {
  estado: Partido;
  ultimo = { cambiado: false, finDeMapa: false };
  t = 1_000_000;

  constructor(estado: Partido = partidoNuevo()) {
    this.estado = estado;
  }

  /** Paquete de datos con la hora actual del banco. */
  manda(type: string, data: unknown = null, extra: Record<string, unknown> = {}): this {
    return this.evento({ type, data, timestamp: this.t, ...extra });
  }

  evento(e: Evento): this {
    const r = reduce(this.estado, e);
    this.estado = r.estado;
    this.ultimo = { cambiado: r.cambiado, finDeMapa: r.finDeMapa };
    return this;
  }

  /** Avanza el reloj `ms` y pasa un `@reloj`. */
  espera(ms: number): this {
    this.t += ms;
    return this.evento({ type: '@reloj', timestamp: this.t });
  }

  fase(roundNumber: number, roundPhase: string): this {
    return this.manda('round_info', { roundNumber, roundPhase });
  }

  /** Alta de un jugador por roster. */
  alta(playerId: string, startTeam: 0 | 1, name: string, agentInternal = 'Wushu'): this {
    return this.manda('roster', {
      name,
      tagline: 'TAG',
      startTeam,
      agentInternal,
      playerId,
      position: 0,
      locked: true,
      rank: 10,
    });
  }

  /** Juega una ronda completa: compra, combate, fin y marcador. */
  ronda(n: number, marcador: [number, number]): this {
    this.fase(n, 'shopping');
    this.t += 30_000;
    this.fase(n, 'combat');
    this.t += 40_000;
    this.fase(n, 'end');
    this.t += 300;
    this.manda('score', { team_0: marcador[0], team_1: marcador[1] });
    this.t += 7_000;
    return this;
  }
}
