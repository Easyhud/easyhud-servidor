/**
 * Servidor de partidas de Easy HUD.
 *
 *   node --experimental-strip-types src/index.ts
 *
 * Lee la configuración (entorno + `.env`), se niega a arrancar si falta el
 * secreto de los tokens (salvo modo desarrollo) y levanta los tres puertos.
 */

import { ErrorDeConfiguracion, cargaFicheroEnv, leeConfig } from './config.ts';
import { alarma, error, log } from './log.ts';
import { arranca } from './servidor.ts';

cargaFicheroEnv();

let config;
try {
  config = leeConfig();
} catch (e) {
  if (e instanceof ErrorDeConfiguracion) {
    error(`configuración: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

if (config.sinAutenticacion) {
  alarma(
    'EASY_DEV_SIN_AUTH=true — MODO DESARROLLO: no se comprueba NINGÚN token (observador, overlay ni operador). ' +
      'Nunca en producción.',
  );
}

// Un fallo inesperado en un manejador no debe llevarse por delante un directo: se registra y se sigue. Si pasa sin
// parar (más de 50 veces en un minuto) algo está roto de verdad y se sale para que Docker reinicie el servidor.
const FALLOS_POR_MINUTO = 50;
const fallos: number[] = [];
function fallo(origen: string, e: unknown): void {
  error(`fallo no controlado (${origen})`, e);
  const ahora = Date.now();
  fallos.push(ahora);
  while (fallos.length > 0 && ahora - fallos[0] > 60_000) fallos.shift();
  if (fallos.length > FALLOS_POR_MINUTO) {
    error('demasiados fallos seguidos: el servidor se reinicia');
    process.exit(1);
  }
}
process.on('uncaughtException', (e) => fallo('uncaughtException', e));
process.on('unhandledRejection', (e) => fallo('unhandledRejection', e));

const servidor = await arranca(config);

async function apaga(senal: string) {
  log(`${senal}: apagando`);
  await servidor.cierra();
  process.exit(0);
}
process.on('SIGINT', () => void apaga('SIGINT'));
process.on('SIGTERM', () => void apaga('SIGTERM'));
