/**
 * Emisión de tokens desde el propio servidor, para emergencias (el emisor
 * normal es el servicio de cuentas).
 *
 *   npm run token -- --secreto
 *       Imprime un secreto nuevo. Cambiarlo invalida TODOS los tokens emitidos.
 *
 *   npm run token -- --grupo <G|*> [--cliente <nombre>] [--dias <n>]
 *       Firma un token con OVERLAY_TOKEN_SECRET (entorno o .env).
 *
 * Códigos de salida: 2 = argumentos mal; 1 = secreto ausente o corto.
 */

import { randomBytes } from 'node:crypto';
import { cargaFicheroEnv } from '../config.ts';
import { LONGITUD_MINIMA_SECRETO, firmaToken, secretoValido } from '../token.ts';

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

cargaFicheroEnv();

if (process.argv.includes('--secreto')) {
  console.log(randomBytes(48).toString('base64url'));
  console.error('Aviso: poner este secreto en OVERLAY_TOKEN_SECRET invalida todos los tokens emitidos con el anterior.');
  process.exit(0);
}

const grupo = argumento('--grupo');
const cliente = argumento('--cliente') ?? 'sin nombre';
const dias = Number(argumento('--dias') ?? 30);

if (!grupo) {
  console.error('Falta --grupo <código> (o "*" para cualquier grupo).');
  process.exit(2);
}
if (!Number.isFinite(dias) || dias <= 0) {
  console.error('--dias debe ser un número mayor que 0.');
  process.exit(2);
}

const secreto = process.env.OVERLAY_TOKEN_SECRET;
if (!secretoValido(secreto)) {
  console.error(`OVERLAY_TOKEN_SECRET falta o tiene menos de ${LONGITUD_MINIMA_SECRETO} caracteres.`);
  process.exit(1);
}

const token = firmaToken(grupo, dias, cliente, secreto);
const exp = Math.floor(Date.now() / 1000) + Math.round(dias * 86400);
const consulta = new URLSearchParams({ groupCode: grupo, token });

console.log(token);
console.log(`Caduca: ${new Date(exp * 1000).toISOString()} (UTC)`);
console.log(`URL de ejemplo para OBS: http://localhost:5310/?${consulta.toString()}`);
if (process.env.REQUIRE_OVERLAY_TOKEN !== 'true') {
  console.log('Nota: REQUIRE_OVERLAY_TOKEN no está a "true": los overlays entran aunque no lleven token.');
}
