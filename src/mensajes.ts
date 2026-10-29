/**
 * Utilidades de mensajería comunes a los dos puertos socket.io.
 *
 * Contrato: todos los eventos de aplicación llevan UN argumento que es una
 * cadena JSON, en los dos sentidos. Al leer se tolera también un objeto ya
 * decodificado (algunos consumidores lo mandan así); al escribir se manda
 * siempre texto, porque el cliente de escritorio hace `JSON.parse` sobre lo
 * que recibe.
 */

import type { Socket } from 'socket.io';
import { error, log } from './log.ts';

/** Decodifica la carga de un evento. `undefined` si no es un objeto JSON legible. */
export function leeCarga(msg: unknown): Record<string, unknown> | undefined {
  let valor: unknown = msg;
  if (typeof msg === 'string' || Buffer.isBuffer(msg)) {
    try {
      valor = JSON.parse(msg.toString());
    } catch {
      return undefined;
    }
  }
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

export function emite(socket: Socket, evento: string, carga: unknown): void {
  socket.emit(evento, JSON.stringify(carga));
}

/**
 * Responde y corta. Se deja un respiro antes de cerrar para que la respuesta
 * salga del búfer antes que el cierre.
 */
export function respondeYCorta(socket: Socket, evento: string, carga: unknown): void {
  emite(socket, evento, carga);
  setTimeout(() => socket.disconnect(true), 50).unref();
}


/* ── Protección del directo: límites por socket y manejadores a prueba de fallos ── */

/**
 * Un cubo de fichas: `capacidad` de golpe y `porSegundo` de recarga. Cada mensaje gasta una; sin fichas, se descarta.
 * Un cliente sano no lo nota; uno roto que repite el mismo mensaje en bucle no puede ahogar al servidor ni a los demás.
 */
export class Limitador {
  descartados = 0;
  private fichas: number;
  private ultimo: number;
  private avisado = Number.NEGATIVE_INFINITY;
  private readonly capacidad: number;
  private readonly porSegundo: number;
  private readonly ahora: () => number;

  constructor(capacidad: number, porSegundo: number, ahora: () => number = Date.now) {
    this.capacidad = capacidad;
    this.porSegundo = porSegundo;
    this.ahora = ahora;
    this.fichas = capacidad;
    this.ultimo = ahora();
  }

  /** ¿Pasa este mensaje? */
  toma(): boolean {
    const t = this.ahora();
    this.fichas = Math.min(this.capacidad, this.fichas + ((t - this.ultimo) / 1000) * this.porSegundo);
    this.ultimo = t;
    if (this.fichas >= 1) {
      this.fichas -= 1;
      // Pasada la tormenta (el cubo vuelve a estar medio lleno), la cuenta de descartes empieza de nuevo: sólo un
      // cliente que NO para llega a que se le corte.
      if (this.fichas > this.capacidad / 2) this.descartados = 0;
      return true;
    }
    this.descartados += 1;
    return false;
  }

  /** Sólo una vez cada 10 s: para que un cliente roto no llene el registro. */
  debeAvisar(): boolean {
    const t = this.ahora();
    if (t - this.avisado < 10_000) return false;
    this.avisado = t;
    return true;
  }
}

/** Tras tantos mensajes descartados en total, el cliente se da por roto y se le corta (se reconecta solo con calma). */
export const CORTE_POR_DESCARTES = 3000;

/**
 * Como `socket.on`, pero: (1) un fallo dentro del manejador se registra y NO tumba el proceso, y (2) con `limite`, lo
 * que sobrepase el ritmo permitido se descarta (con aviso en el registro y, si hace falta, un aviso al cliente).
 */
export function escucha(
  socket: Socket,
  evento: string,
  manejador: (msg: unknown, ack?: unknown) => void,
  limite?: Limitador,
  alExceder?: () => void,
): void {
  socket.on(evento, (msg: unknown, ack?: unknown) => {
    if (limite && !limite.toma()) {
      if (limite.debeAvisar()) log(`${evento} de ${socket.id}: demasiados mensajes seguidos, se descartan (${limite.descartados} hasta ahora)`);
      alExceder?.();
      if (limite.descartados >= CORTE_POR_DESCARTES) {
        log(`${socket.id}: ${limite.descartados} mensajes descartados, se corta la conexión (cliente en bucle)`);
        socket.disconnect(true);
      }
      return;
    }
    try {
      manejador(msg, ack);
    } catch (e) {
      error(`${evento} de ${socket.id}`, e);
    }
  });
}

/** Un código de grupo o de jugador razonable: texto de 1 a 64 caracteres sin caracteres de control. */
export function identificadorValido(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length >= 1 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);
}

/**
 * El motivo de que se rechace un permiso (`validaToken`), dicho como «qué pasó y qué hacer», para quien maneja
 * el panel o los overlays. El texto técnico original va aparte, en `codigo`.
 */
export function explicaPermiso(motivo: string, clase?: 'caducado' | 'invalido'): string {
  if (motivo === 'sin token') {
    return 'Falta el permiso de emisión. Inicia sesión en Easy HUD (o copia otra vez la dirección de la fuente de OBS, que lleva el permiso).';
  }
  if (motivo === 'sin groupCode') {
    return 'Falta el código de grupo. Abre el panel o la fuente de OBS desde tu cuenta de Easy HUD.';
  }
  if (clase === 'caducado' || motivo === 'caducado') {
    return 'El permiso de emisión ha caducado. Inicia sesión de nuevo en Easy HUD para renovarlo y copia la dirección nueva en OBS.';
  }
  if (motivo.startsWith('es para el grupo')) {
    return `${motivo[0].toUpperCase()}${motivo.slice(1)}: estás usando el permiso de otra cuenta o de otro evento. Inicia sesión con la cuenta correcta.`;
  }
  if (motivo === 'mal configurado') {
    return 'El servidor no puede comprobar permisos (le falta su secreto). Avisa al organizador: no es cosa tuya.';
  }
  return 'El permiso de emisión no es válido (está incompleto o se ha modificado). Inicia sesión de nuevo en Easy HUD y copia otra vez la dirección.';
}