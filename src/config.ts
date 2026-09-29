/**
 * Configuración del servidor, leída del entorno (y de un `.env` en el
 * directorio de trabajo, si existe; lo que ya esté en el entorno manda).
 *
 * Arranque cerrado por defecto: sin un `OVERLAY_TOKEN_SECRET` de al menos 32
 * caracteres el servidor NO arranca, porque sin él no hay forma de comprobar
 * quién emite. La única salida es `EASY_DEV_SIN_AUTH=true`, pensada para
 * desarrollo local, que abre todas las puertas y lo dice a gritos en el log.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { LONGITUD_MINIMA_SECRETO, secretoValido } from './token.ts';

export interface Config {
  /** HTTP plano (`INSECURE=true`) o HTTPS con `SERVER_KEY`/`SERVER_CERT`. */
  inseguro: boolean;
  claveTls?: string;
  certTls?: string;
  /** Secreto HMAC compartido con el servicio de cuentas. */
  secretoToken?: string;
  /** Modo desarrollo: no se comprueba ningún token. */
  sinAutenticacion: boolean;
  /** Exigir token también en el `logon` de los overlays (puerto 5200). */
  exigirTokenOverlay: boolean;
  /** Grabar cada partido en `carpetaGrabaciones`. */
  grabar: boolean;
  carpetaGrabaciones: string;
  /** Tiempos muertos extra por equipo al entrar en prórroga. */
  extraProrroga: number;
  /** Minutos sin envíos tras los que un partido se da por abandonado. */
  minutosInactividad: number;
  puertos: { ingesta: number; salida: number; extras: number };
}

export class ErrorDeConfiguracion extends Error {}

/** Carga `.env` sin pisar lo que ya viene del entorno. */
export function cargaFicheroEnv(ruta = '.env'): void {
  if (!existsSync(ruta)) return;
  const valores = parseEnv(readFileSync(ruta, 'utf8'));
  for (const [k, v] of Object.entries(valores)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const activado = (v: string | undefined): boolean => v === 'true';

function entero(v: string | undefined, defecto: number, nombre: string): number {
  if (v === undefined || v === '') return defecto;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ErrorDeConfiguracion(`${nombre} debe ser un entero >= 0 (vale "${v}")`);
  return n;
}

export function leeConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sinAutenticacion = activado(env.EASY_DEV_SIN_AUTH);
  const secreto = env.OVERLAY_TOKEN_SECRET;

  if (!sinAutenticacion && !secretoValido(secreto)) {
    throw new ErrorDeConfiguracion(
      `OVERLAY_TOKEN_SECRET falta o tiene menos de ${LONGITUD_MINIMA_SECRETO} caracteres. ` +
        'Sin él no se puede validar a los observadores y el servidor no arranca. ' +
        '(Sólo para desarrollo local: EASY_DEV_SIN_AUTH=true.)',
    );
  }

  const inseguro = activado(env.INSECURE);
  if (!inseguro && (!env.SERVER_KEY || !env.SERVER_CERT)) {
    throw new ErrorDeConfiguracion('Con INSECURE distinto de "true" hacen falta SERVER_KEY y SERVER_CERT (rutas a los PEM).');
  }

  return {
    inseguro,
    claveTls: env.SERVER_KEY,
    certTls: env.SERVER_CERT,
    secretoToken: secretoValido(secreto) ? secreto : undefined,
    sinAutenticacion,
    exigirTokenOverlay: activado(env.REQUIRE_OVERLAY_TOKEN),
    grabar: env.GRABAR_PARTIDAS !== 'false',
    carpetaGrabaciones: env.CARPETA_GRABACIONES || './replays',
    extraProrroga: entero(env.TIEMPOS_MUERTOS_PRORROGA, 1, 'TIEMPOS_MUERTOS_PRORROGA'),
    minutosInactividad: entero(env.MINUTOS_INACTIVIDAD, 30, 'MINUTOS_INACTIVIDAD'),
    // Fijos a propósito: el cliente deriva el 5200 sustituyendo ":5100" en su URL.
    puertos: { ingesta: 5100, salida: 5200, extras: 5101 },
  };
}
