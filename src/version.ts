/**
 * Versión del servidor y compatibilidad con el cliente de escritorio.
 *
 * El cliente manda su versión en cada logon; se aceptan las del rango
 * `>= 0.3.3 y < 0.3.25`, que es el de la línea actual del cliente. Una
 * versión mal formada (o una prerelease) no entra.
 */

import { readFileSync } from 'node:fs';

const paquete = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION_SERVIDOR: string = paquete.version;

type Tripleta = [number, number, number];

const MINIMA: Tripleta = [0, 3, 3]; // incluida
const TOPE: Tripleta = [0, 3, 25]; // excluida

function lee(v: string): Tripleta | undefined {
  const m = /^[v=]?(\d+)\.(\d+)\.(\d+)(\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compara(a: Tripleta, b: Tripleta): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function clienteCompatible(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const v = lee(version);
  return v !== undefined && compara(v, MINIMA) >= 0 && compara(v, TOPE) < 0;
}

/** El texto exacto que el cliente reconoce (busca "not compatible"). */
export function motivoIncompatible(version: unknown): string {
  return `Client version ${String(version)} is not compatible with server version ${VERSION_SERVIDOR}.`;
}
