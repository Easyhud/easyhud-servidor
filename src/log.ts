/**
 * Registro mínimo: una línea por suceso, con hora ISO. Sin librería: el
 * contenedor ya recoge stdout/stderr.
 */

let silencio = false;

/** Las pruebas lo callan para no ensuciar la salida de `node --test`. */
export function silencia(si: boolean): void {
  silencio = si;
}

export function log(texto: string): void {
  if (!silencio) process.stdout.write(`[${new Date().toISOString()}] ${texto}\n`);
}

export function error(texto: string, e?: unknown): void {
  if (silencio) return;
  const detalle = e instanceof Error ? ` — ${e.message}` : e !== undefined ? ` — ${String(e)}` : '';
  process.stderr.write(`[${new Date().toISOString()}] ERROR ${texto}${detalle}\n`);
}

/** Para avisos que no pueden pasar desapercibidos (arranque sin autenticación). */
export function alarma(texto: string): void {
  const linea = '!'.repeat(78);
  process.stderr.write(`${linea}\n!! ${texto}\n${linea}\n`);
}
