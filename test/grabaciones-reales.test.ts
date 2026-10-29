/**
 * Grabaciones REALES de directos (opcional): si la variable de entorno `REPLAYS_REALES` apunta a una carpeta con
 * ficheros `.replay`, cada una se pasa entera por el reductor y se comprueban invariantes que cualquier directo real
 * debe cumplir. Sin la variable, el test se omite (las grabaciones pesan megas y no están en el repositorio).
 *
 *   $env:REPLAYS_REALES = 'C:\ruta\a\replays'; npm test
 *
 * Nació de la segunda pasada de auditoría: tres directos del VPS (5000–20000 paquetes cada uno) pasados por el
 * original (ValoSpectra) y por este reductor dieron las mismas rondas, bandos, marcadores, kills y gasto; lo único
 * distinto era lo que aquí se hace a propósito. Estos invariantes guardan eso.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leeGrabacion } from '../src/grabacion.ts';
import { creaPartido } from '../src/partida/creacion.ts';
import { reduce } from '../src/partida/reductor.ts';
import { aSalida, serializa } from '../src/partida/serializa.ts';
import type { DatosCreacion, Partido } from '../src/partida/tipos.ts';

const carpeta = process.env.REPLAYS_REALES;
const omite = carpeta === undefined || !existsSync(carpeta) ? 'sin REPLAYS_REALES' : false;
const ficheros = omite ? [] : readdirSync(carpeta as string).filter((f) => f.endsWith('.replay'));

for (const nombre of ficheros) {
  test(`grabación real ${nombre}: invariantes de principio a fin`, { skip: omite }, () => {
    const { cabecera, paquetes } = leeGrabacion(readFileSync(join(carpeta as string, nombre), 'utf8'));
    let p: Partido = creaPartido(cabecera as unknown as DatosCreacion, undefined, { extraProrroga: 1 });
    let ultimoMarcador = 0;
    paquetes.forEach((paquete, i) => {
      p = reduce(p, paquete as never).estado;
      assert.ok(p.roundNumber >= 0 && p.roundNumber <= 99, `#${i}: ronda ${p.roundNumber}`);
      for (const e of p.teams) {
        assert.ok(e.roundsWon >= 0 && e.roundsWon <= 99);
        assert.ok(e.players.length <= 5, `#${i}: más de cinco jugadores`);
        for (const j of e.players) {
          assert.ok(j.health >= 0 && j.health <= 100, `#${i}: vida ${j.health}`);
          assert.ok(Number.isFinite(j.money) && Number.isFinite(j.kills), `#${i}: número roto`);
        }
      }
      const total = p.teams[0].roundsWon + p.teams[1].roundsWon;
      assert.ok(total >= 0);
      ultimoMarcador = total;
      if (i % 500 === 0) JSON.parse(serializa(p)); // la salida siempre es JSON válido
    });
    // El historial del final cuadra con el marcador: lo ganado por uno es lo perdido por el otro.
    const [a, b] = p.teams;
    const ganadas = (e: typeof a) => e.roundRecord.filter((r) => ['kills', 'detonated', 'defused', 'timeout'].includes(r.type)).length;
    const perdidas = (e: typeof a) => e.roundRecord.filter((r) => r.type === 'lost').length;
    assert.equal(ganadas(a), a.roundsWon, 'rondas ganadas del equipo 0 en el historial');
    assert.equal(ganadas(b), b.roundsWon, 'rondas ganadas del equipo 1 en el historial');
    assert.equal(perdidas(a), b.roundsWon);
    assert.equal(perdidas(b), a.roundsWon);
    assert.equal(ultimoMarcador, a.roundsWon + b.roundsWon);
    assert.equal(typeof aSalida(p).teams[0].teamName, 'string');
  });
}

if (ficheros.length === 0) test('grabaciones reales: sin REPLAYS_REALES se omite', { skip: omite || 'sin ficheros' }, () => undefined);