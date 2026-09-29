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
import { error } from './log.ts';

export interface Grabacion {
  cabecera: Record<string, unknown>;
  paquetes: Record<string, unknown>[];
}

export class Grabadora {
  private flujo: WriteStream | null;
  readonly ruta: string;

  constructor(carpeta: string, grupo: string, cabecera: Record<string, unknown>, ahora = Date.now()) {
    mkdirSync(carpeta, { recursive: true });
    // El grupo lo elige el cliente: fuera todo lo que no sea seguro en un nombre de fichero.
    const seguro = grupo.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    this.ruta = join(carpeta, `Match_${seguro}_${ahora}.replay`);
    this.flujo = createWriteStream(this.ruta, { flags: 'w' });
    this.flujo.on('error', (e) => {
      error(`grabación ${this.ruta}`, e);
      this.flujo = null;
    });
    this.flujo.write(JSON.stringify(cabecera));
  }

  anota(paquete: unknown): void {
    this.flujo?.write(`,\n${JSON.stringify(paquete)}`);
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
