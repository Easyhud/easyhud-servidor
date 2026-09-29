import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { firmaToken, leeCaducidad, validaToken } from '../src/token.ts';
import { clienteCompatible, motivoIncompatible } from '../src/version.ts';

const SECRETO = 'x'.repeat(40);
const AHORA = Date.UTC(2026, 8, 26);

test('un token bien firmado vale para su grupo', () => {
  const t = firmaToken('TORNEO1', 30, 'Estudio', SECRETO, AHORA);
  const v = validaToken(t, 'TORNEO1', SECRETO, AHORA);
  assert.equal(v.valido, true);
  assert.equal(v.cliente, 'Estudio');
  assert.equal(v.exp, Math.floor(AHORA / 1000) + 30 * 86400);
});

test('comodín "*" vale para cualquier grupo', () => {
  const t = firmaToken('*', 1, 'Todo', SECRETO, AHORA);
  assert.equal(validaToken(t, 'LOQUESEA', SECRETO, AHORA).valido, true);
});

test('rechazos: otro grupo, caducado, firma, forma y secreto', () => {
  const t = firmaToken('A', 1, 'c', SECRETO, AHORA);
  const otro = validaToken(t, 'B', SECRETO, AHORA);
  assert.deepEqual([otro.valido, otro.motivo, otro.clase], [false, 'es para el grupo A', 'invalido']);

  const caducado = validaToken(t, 'A', SECRETO, AHORA + 2 * 86400_000);
  assert.deepEqual([caducado.valido, caducado.motivo, caducado.clase], [false, 'caducado', 'caducado']);

  const manipulado = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(validaToken(manipulado, 'A', SECRETO, AHORA).motivo, 'firma no válida');
  assert.equal(validaToken(t, 'A', 'y'.repeat(40), AHORA).motivo, 'firma no válida');
  assert.equal(validaToken('sinpunto', 'A', SECRETO, AHORA).motivo, 'token mal formado');
  assert.equal(validaToken('.firma', 'A', SECRETO, AHORA).motivo, 'token mal formado');
  assert.equal(validaToken('', 'A', SECRETO, AHORA).motivo, 'sin token');
  assert.equal(validaToken(undefined, 'A', SECRETO, AHORA).motivo, 'sin token');

  // Sin secreto (o corto) se cierra, no se abre.
  const sinSecreto = validaToken(t, 'A', 'corto', AHORA);
  assert.deepEqual([sinSecreto.valido, sinSecreto.motivo], [false, 'mal configurado']);
});

test('contenido ilegible con firma correcta', async () => {
  const { createHmac } = await import('node:crypto');
  const cuerpo = Buffer.from('no es json').toString('base64url');
  const firma = createHmac('sha256', SECRETO).update(cuerpo).digest('base64url');
  assert.equal(validaToken(`${cuerpo}.${firma}`, 'A', SECRETO, AHORA).motivo, 'contenido ilegible');
});

test('leeCaducidad lee exp sin validar', () => {
  const t = firmaToken('A', 2, 'c', SECRETO, AHORA);
  assert.equal(leeCaducidad(t), Math.floor(AHORA / 1000) + 2 * 86400);
  assert.equal(leeCaducidad('basura'), undefined);
});

// Si el servicio de cuentas está al lado (mismo espacio de trabajo), se
// comprueba que lo que firma él lo acepta este servidor.
const rutaCuentas = fileURLToPath(new URL('../../cuentas/app/overlay.ts', import.meta.url));
test('interoperable con el firmador del servicio de cuentas', { skip: !existsSync(rutaCuentas) && 'cuentas no está al lado' }, async () => {
  const { firmaOverlay } = (await import(new URL('../../cuentas/app/overlay.ts', import.meta.url).href)) as {
    firmaOverlay: (g: string, dias: number, c: string, s: string) => string;
  };
  const t = firmaOverlay('GRUPO9', 7, 'Cuentas', SECRETO);
  const v = validaToken(t, 'GRUPO9', SECRETO);
  assert.equal(v.valido, true);
  assert.equal(v.cliente, 'Cuentas');
});

test('versiones de cliente compatibles', () => {
  for (const v of ['0.3.3', '0.3.4', '0.3.24', 'v0.3.10']) assert.equal(clienteCompatible(v), true, v);
  for (const v of ['0.3.2', '0.3.25', '0.4.0', '1.0.0', '0.3.4-beta', 'basura', undefined, 3]) {
    assert.equal(clienteCompatible(v), false, String(v));
  }
  assert.match(motivoIncompatible('0.1.0'), /^Client version 0\.1\.0 is not compatible with server version \d+\.\d+\.\d+\.$/);
});
