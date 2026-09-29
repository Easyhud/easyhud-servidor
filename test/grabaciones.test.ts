/**
 * Regresión con grabaciones reales: cada `.replay` de `fixtures/` se pasa
 * entero por el reductor (sin red) y se comprueban algunos resultados.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { leeGrabacion } from '../src/grabacion.ts';
import { creaPartido } from '../src/partida/creacion.ts';
import { reduce } from '../src/partida/reductor.ts';
import { aSalida } from '../src/partida/serializa.ts';
import type { EquipoLogon, Paquete, Partido } from '../src/partida/tipos.ts';

const carpeta = new URL('./fixtures/', import.meta.url);

function reproduce(nombre: string): Partido {
  const { cabecera, paquetes } = leeGrabacion(readFileSync(new URL(nombre, carpeta), 'utf8'));
  let p = creaPartido(
    {
      groupCode: String(cabecera.groupCode),
      leftTeam: cabecera.leftTeam as EquipoLogon,
      rightTeam: cabecera.rightTeam as EquipoLogon,
      toolsData: (cabecera.toolsData ?? {}) as Record<string, unknown>,
    },
    undefined,
    { extraProrroga: 1 },
  );
  for (const paquete of paquetes) p = reduce(p, paquete as Paquete).estado;
  return p;
}

for (const nombre of readdirSync(carpeta).filter((n) => n.endsWith('.replay'))) {
  test(`grabación ${nombre}: se reproduce entera y se serializa`, () => {
    const p = reproduce(nombre);
    const salida = JSON.parse(JSON.stringify(aSalida(p)));
    assert.equal(Array.isArray(salida.teams), true);
    assert.equal(salida.teams.length, 2);
  });
}

test('TEST01: vida, habilidades e informe de ronda del jugador', () => {
  const p = reproduce('Match_TEST01_1790381478569.replay');
  const j = p.teams[0].players[0];
  assert.equal(p.matchId, 'TEST-MATCH-1790381478037');
  assert.equal(j.health, 67);
  assert.deepEqual(j.abilities, { grenade: 1, ability1: 0, ability2: 1 });
  assert.equal(j.damageThisRound, 145);
  assert.equal(j.totalDamage, 145);
});

test('TORNEO2: cuatro rondas del equipo derecho, con historial', () => {
  const p = reproduce('Match_TORNEO2_1788925164030.replay');
  assert.equal(p.teams[1].roundsWon, 4);
  assert.equal(p.roundNumber, 5);
  const jugadas = p.teams[1].roundRecord.filter((r) => r.type !== 'upcoming');
  assert.deepEqual(jugadas.map((r) => r.round), [1, 2, 3, 4]);
  assert.equal(p.teams[0].roundRecord.slice(0, 4).every((r) => r.type === 'lost'), true);
});

test('TORNEO1: muchas pulsaciones de tiempo muerto sin pasar nunca de los límites', () => {
  const p = reproduce('Match_TORNEO1_1788923963126.replay');
  const c = aSalida(p).tools.timeoutCounter;
  for (const n of [c.left, c.right]) assert.ok(n >= 0 && n <= c.max, `restantes ${n} fuera de [0, ${c.max}]`);
});
