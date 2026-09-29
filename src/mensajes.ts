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
