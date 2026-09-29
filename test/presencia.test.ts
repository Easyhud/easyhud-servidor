/**
 * Presencia de los clientes de jugador en la sala (`sala.conectados`):
 * entra con el primer latido, sale sola al dejar de latir (sin esperar a que
 * el observador reenvíe la sala) y sale pronto si el socket se cae.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Central, GRACIA_DESCONEXION_MS, PRESENCIA_VIVA_MS, type Difusion } from '../src/central.ts';
import type { Config } from '../src/config.ts';

const config: Config = {
  inseguro: true,
  sinAutenticacion: true,
  exigirTokenOverlay: false,
  grabar: false,
  carpetaGrabaciones: '.',
  extraProrroga: 1,
  minutosInactividad: 30,
  puertos: { ingesta: 0, salida: 0, extras: 0 },
};

function banco() {
  let t = 1_000_000;
  const salas: Array<{ grupo: string; conectados: string[] }> = [];
  const difusion: Difusion = {
    estado: () => undefined,
    sala: (grupo, carga) => salas.push({ grupo, conectados: carga.conectados as string[] }),
    expulsaGrupo: () => undefined,
  };
  const central = new Central(config, () => t);
  central.conecta(difusion);
  const sala = {
    equipoUno: [{ puuid: 'p1' }, { puuid: 'p2' }],
    equipoDos: [{ puuid: 'p3' }],
    observadores: [],
    coaches: [],
  };
  return {
    central,
    salas,
    ultima: () => salas.at(-1)?.conectados,
    avanza: (ms: number) => {
      t += ms;
      central.revisaPresencias();
    },
    sala,
  };
}

test('el primer latido mete al jugador en conectados al momento', () => {
  const b = banco();
  b.central.guardaSala('G', b.sala);
  assert.deepEqual(b.ultima(), []);
  b.central.late('p1');
  assert.deepEqual(b.ultima(), ['p1']);
  const n = b.salas.length;
  b.central.late('p1'); // latido de un vivo: no re-emite
  assert.equal(b.salas.length, n);
  b.central.cierra();
});

test('sin latidos caduca a los 30 s y se re-emite la sala sin que el observador la reenvíe', () => {
  const b = banco();
  b.central.guardaSala('G', b.sala);
  b.central.late('p1');
  b.central.late('p3');
  // Latidos cada 12 s de p3; p1 deja de latir (cerró el programa).
  for (let s = 0; s < 3; s++) {
    b.avanza(12_000);
    b.central.late('p3');
  }
  assert.ok(36_000 >= PRESENCIA_VIVA_MS);
  assert.deepEqual(b.ultima(), ['p3'], 'p1 ya no está; p3 sigue');
  b.central.cierra();
});

test('dos latidos perdidos (24 s) todavía no lo tiran', () => {
  const b = banco();
  b.central.guardaSala('G', b.sala);
  b.central.late('p2');
  const n = b.salas.length;
  b.avanza(24_000);
  assert.equal(b.salas.length, n);
  assert.equal(b.central.presenciaViva('p2'), true);
  b.avanza(7_000);
  assert.deepEqual(b.ultima(), []);
  b.central.cierra();
});

test('socket de presencia caído: fuera tras la gracia corta, salvo que vuelva a latir', () => {
  const b = banco();
  b.central.guardaSala('G', b.sala);
  b.central.late('p1');
  b.central.late('p2');
  b.central.presenciaCaida('p1');
  b.central.presenciaCaida('p2');
  b.avanza(1_000);
  b.central.late('p2'); // p2 reconectó enseguida
  b.avanza(GRACIA_DESCONEXION_MS);
  assert.deepEqual(b.ultima(), ['p2']);
  assert.equal(b.central.presenciaViva('p1'), false);
  b.central.cierra();
});

test('un latido tras caducar vuelve a meterlo', () => {
  const b = banco();
  b.central.guardaSala('G', b.sala);
  b.central.late('p3');
  b.avanza(PRESENCIA_VIVA_MS + 1);
  assert.deepEqual(b.ultima(), []);
  b.central.late('p3');
  assert.deepEqual(b.ultima(), ['p3']);
  b.central.cierra();
});
