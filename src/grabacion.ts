/**
 * Grabación de partidas en ficheros `.replay`.
 *
 * Formato (el mismo que ya existía, para poder reproducir grabaciones viejas):
 * una lista de objetos JSON separados por ",\n", SIN corchetes. El primero es
 * la cabecera (datos del logon sin la clave, versión del servidor y hora de
 * inicio); los demás, cada paquete tal como lo recibió el partido, con la hora
 * del servidor. Se lee envolviéndolo en corchetes.
 *
 * Sirve para depurar un directo y, sobre todo, como banco de pruebas de
 * regresión: `test/integracion.test.ts` reproduce grabaciones reales.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { error, log } from './log.ts';

export interface Grabacion {
  cabecera: Record<string, unknown>;
  paquetes: Record<string, unknown>[];
}

export class Grabadora {
  private flujo: WriteStream | null;
  readonly ruta: string;
  private bytes = 0;
  private readonly maxBytes: number;
  private llena = false;

  /** maxBytes: tamaño máximo del fichero; pasado, se deja de anotar (un cliente que inunda no llena el disco). */
  constructor(carpeta: string, grupo: string, cabecera: Record<string, unknown>, ahora = Date.now(), maxBytes = 64 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    mkdirSync(carpeta, { recursive: true });
    // El grupo lo elige el cliente: fuera todo lo que no sea seguro en un nombre de fichero.
    const seguro = grupo.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    this.ruta = join(carpeta, `Match_${seguro}_${ahora}.replay`);
    this.flujo = createWriteStream(this.ruta, { flags: 'w' });
    this.flujo.on('error', (e) => {
      error(`grabación ${this.ruta}`, e);
      this.flujo = null;
    });
    const inicio = JSON.stringify(cabecera);
    this.bytes = Buffer.byteLength(inicio);
    this.flujo.write(inicio);
  }

  anota(paquete: unknown): void {
    if (!this.flujo || this.llena) return;
    const linea = `,\n${JSON.stringify(paquete)}`;
    this.bytes += Buffer.byteLength(linea);
    if (this.bytes > this.maxBytes) {
      this.llena = true;
      log(`la grabación ${this.ruta} ha pasado de ${Math.round(this.maxBytes / 1024 / 1024)} MB: no se graba más de este partido`);
      return;
    }
    this.flujo.write(linea);
  }

  /** Antes el fichero no se cerraba nunca; ahora se cierra al acabar el partido. */
  cierra(): void {
    this.flujo?.end();
    this.flujo = null;
  }
}

/** Lee el texto de un `.replay`. Tolera una coma o espacios sobrantes al final. */
export function leeGrabacion(texto: string): Grabacion {
  const limpio = texto.trim().replace(/,\s*$/, '');
  const lista = JSON.parse(`[${limpio}]`) as Record<string, unknown>[];
  if (lista.length === 0) throw new Error('grabación vacía');
  const [cabecera, ...paquetes] = lista;
  return { cabecera, paquetes };
}
