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

const servidor = await arranca(config);

async function apaga(senal: string) {
  log(`${senal}: apagando`);
  await servidor.cierra();
  process.exit(0);
}
process.on('SIGINT', () => void apaga('SIGINT'));
process.on('SIGTERM', () => void apaga('SIGTERM'));
