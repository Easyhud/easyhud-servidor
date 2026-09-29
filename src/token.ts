/**
 * El token de emisión de Easy HUD: `<cuerpo>.<firma>`.
 *
 *   cuerpo = base64url(JSON {g, exp, c})      g = grupo (o "*"), exp = segundos Unix, c = cliente
 *   firma  = base64url(HMAC-SHA256(secreto, cuerpo))
 *
 * Lo firma el servicio de cuentas (cuentas/app/overlay.ts) con el mismo
 * secreto `OVERLAY_TOKEN_SECRET`, así que no hace falta base de datos
 * compartida: el token se valida solo. Es un billete al portador; para
 * revocar, se cambia el secreto (y caen todos).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const LONGITUD_MINIMA_SECRETO = 32;

export interface Veredicto {
  valido: boolean;
  /** Motivo en castellano, para el log y para las respuestas que lo muestran tal cual. */
  motivo: string;
  cliente?: string;
  /** Caducidad (segundos Unix), si el cuerpo se pudo leer. */
  exp?: number;
  /** Clase del fallo, para elegir el texto que entiende cada consumidor. */
  clase?: 'caducado' | 'invalido';
}

const firma = (cuerpo: string, secreto: string): string =>
  createHmac('sha256', secreto).update(cuerpo).digest('base64url');

/** Emite un token (lo usan la herramienta de línea de comandos y las pruebas). */
export function firmaToken(grupo: string, dias: number, cliente: string, secreto: string, ahoraMs = Date.now()): string {
  const contenido = { g: grupo, exp: Math.floor(ahoraMs / 1000) + Math.round(dias * 86400), c: cliente };
  const cuerpo = Buffer.from(JSON.stringify(contenido)).toString('base64url');
  return `${cuerpo}.${firma(cuerpo, secreto)}`;
}

export function secretoValido(secreto: string | undefined): secreto is string {
  return typeof secreto === 'string' && secreto.length >= LONGITUD_MINIMA_SECRETO;
}

/**
 * Validación estricta: firma, caducidad y grupo. Con el secreto ausente o
 * corto NO deja pasar (antes sí): el servidor ni siquiera arranca así salvo
 * en modo desarrollo, y en ese modo esta función no se llega a llamar.
 */
export function validaToken(token: unknown, grupo: string, secreto: string | undefined, ahoraMs = Date.now()): Veredicto {
  if (!secretoValido(secreto)) return { valido: false, motivo: 'mal configurado', clase: 'invalido' };
  if (typeof token !== 'string' || token === '') return { valido: false, motivo: 'sin token', clase: 'invalido' };

  const punto = token.lastIndexOf('.');
  if (punto <= 0) return { valido: false, motivo: 'token mal formado', clase: 'invalido' };
  const cuerpo = token.slice(0, punto);
  const recibida = Buffer.from(token.slice(punto + 1));
  const esperada = Buffer.from(firma(cuerpo, secreto));
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) {
    return { valido: false, motivo: 'firma no válida', clase: 'invalido' };
  }

  let contenido: unknown;
  try {
    contenido = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
  } catch {
    return { valido: false, motivo: 'contenido ilegible', clase: 'invalido' };
  }
  if (typeof contenido !== 'object' || contenido === null) {
    return { valido: false, motivo: 'contenido ilegible', clase: 'invalido' };
  }
  const { g, exp, c } = contenido as { g?: unknown; exp?: unknown; c?: unknown };
  const cliente = typeof c === 'string' ? c : undefined;

  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < ahoraMs / 1000) {
    return { valido: false, motivo: 'caducado', cliente, exp: typeof exp === 'number' ? exp : undefined, clase: 'caducado' };
  }
  if (g !== '*' && g !== grupo) {
    return { valido: false, motivo: `es para el grupo ${String(g)}`, cliente, exp, clase: 'invalido' };
  }
  return { valido: true, motivo: 'válido', cliente, exp };
}

/** Caducidad leída sin comprobar la firma (sólo para programar un corte ya validado). */
export function leeCaducidad(token: unknown): number | undefined {
  if (typeof token !== 'string') return undefined;
  const punto = token.lastIndexOf('.');
  if (punto <= 0) return undefined;
  try {
    const { exp } = JSON.parse(Buffer.from(token.slice(0, punto), 'base64url').toString('utf8'));
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}
