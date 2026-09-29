import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Banco, partidoNuevo } from './ayudas.ts';
import { aSalida } from '../src/partida/serializa.ts';
import { aplicaParcheGrupo, memoriaVacia } from '../src/partida/configuracion.ts';

const cuenta = (b: Banco) => aSalida(b.estado).tools.timeoutCounter;
const estado = (b: Banco) => aSalida(b.estado).timeoutState;

test('se descuenta al empezar y termina solo a los D segundos', () => {
  const b = new Banco();
  b.manda('left_timeout');
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 2 });
  assert.deepEqual(estado(b), { techPause: false, leftTeam: true, rightTeam: false, timeRemaining: 60 });
  b.espera(1_000);
  assert.equal(estado(b).timeRemaining, 59);
  b.espera(20_000);
  assert.equal(estado(b).timeRemaining, 39);
  assert.equal(aSalida(b.estado).timeoutGracePeriodPassed, true);
  b.espera(39_500);
  assert.equal(estado(b).leftTeam, false);
  assert.equal(estado(b).timeRemaining, 0);
  assert.equal(cuenta(b).left, 1);
});

test('el reloj sólo provoca envío cuando cambia el segundo', () => {
  const b = new Banco().manda('left_timeout');
  b.espera(300);
  assert.equal(b.ultimo.cambiado, false);
  b.espera(800);
  assert.equal(b.ultimo.cambiado, true);
});

test('cancelar dentro de la gracia lo devuelve; fuera, no', () => {
  const b = new Banco();
  b.manda('right_timeout').espera(5_000).manda('right_timeout');
  assert.equal(cuenta(b).right, 2);
  assert.equal(estado(b).rightTeam, false);
  assert.equal(estado(b).timeRemaining, 0);

  b.manda('right_timeout').espera(15_000).manda('right_timeout');
  assert.equal(cuenta(b).right, 1);
});

test('pedirlo el otro equipo corta el primero con la misma regla de gracia', () => {
  const b = new Banco();
  b.manda('left_timeout').espera(20_000).manda('right_timeout');
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 1 }, 'el izquierdo ya pasó la gracia: gastado');
  assert.equal(estado(b).rightTeam, true);
  assert.equal(estado(b).leftTeam, false);

  const c = new Banco();
  c.manda('left_timeout').espera(3_000).manda('right_timeout');
  assert.deepEqual(cuenta(c), { max: 2, left: 2, right: 1 }, 'dentro de la gracia: devuelto');
});

test('la pausa técnica corta el táctico con la regla de gracia y reinicia la cuenta', () => {
  const b = new Banco();
  b.manda('left_timeout').espera(30_000).manda('tech_pause');
  assert.equal(cuenta(b).left, 1, 'pasada la gracia no se regala');
  assert.deepEqual(estado(b), { techPause: true, leftTeam: false, rightTeam: false, timeRemaining: 60 });
  b.manda('tech_pause');
  assert.deepEqual(estado(b), { techPause: false, leftTeam: false, rightTeam: false, timeRemaining: 0 });
});

test('sin restantes no hace nada, ni envío', () => {
  const b = new Banco(partidoNuevo({ timeoutCounter: { max: 1 } }));
  b.manda('left_timeout').espera(61_000);
  assert.equal(cuenta(b).left, 0);
  b.manda('left_timeout');
  assert.equal(b.ultimo.cambiado, false);
  assert.equal(estado(b).leftTeam, false);
});

test('los contadores van con el equipo al intercambiar lados (también el activo)', () => {
  const b = new Banco();
  b.manda('left_timeout'); // equipo del juego 0, a la izquierda
  b.manda('swap_left_right');
  assert.deepEqual(cuenta(b), { max: 2, left: 2, right: 1 });
  assert.equal(estado(b).rightTeam, true);
  assert.equal(estado(b).leftTeam, false);
  // Cancelar ahora es pulsar el de la derecha, que es donde está ese equipo.
  b.manda('right_timeout');
  assert.deepEqual(cuenta(b), { max: 2, left: 2, right: 2 });
});

test('subir el máximo sube los restantes; bajarlo los recorta', () => {
  const b = new Banco();
  b.manda('left_timeout').espera(61_000);
  b.evento({ type: '@configura', timestamp: b.t, parche: { timeoutCounter: { max: 3 } } });
  assert.deepEqual(cuenta(b), { max: 3, left: 2, right: 3 });
  b.evento({ type: '@configura', timestamp: b.t, parche: { timeoutCounter: { max: 1 } } });
  assert.deepEqual(cuenta(b), { max: 1, left: 1, right: 1 });
});

test('la duración configurada manda en la cuenta', () => {
  const b = new Banco(partidoNuevo({ timeoutDuration: 30 }));
  b.manda('left_timeout');
  assert.equal(estado(b).timeRemaining, 30);
  b.espera(30_000);
  assert.equal(estado(b).leftTeam, false);
});

test('el fin de mapa detiene todo', () => {
  const b = new Banco().manda('left_timeout').fase(1, 'game_end');
  assert.deepEqual(estado(b), { techPause: false, leftTeam: false, rightTeam: false, timeRemaining: 0 });
});

/* ── Cuentas a lo largo de un mapa entero ─────────────────────────────────── */

/** Juega las rondas `desde..hasta` alternando ganador; devuelve el banco. */
function juega(b: Banco, desde: number, hasta: number): Banco {
  for (let n = desde; n <= hasta; n++) {
    const [a, d] = b.estado.interno.ultimoMarcador;
    b.ronda(n, n % 2 === 1 ? [a + 1, d] : [a, d + 1]);
  }
  return b;
}

/** Un tiempo muerto entero (pedido y dejado correr) del lado indicado. */
function tiempoEntero(b: Banco, lado: 'left' | 'right'): void {
  b.manda(`${lado}_timeout`);
  b.espera(61_000);
}

test('medio tiempo: cada equipo conserva sus restantes al cambiar de bando', () => {
  const b = new Banco();
  juega(b, 1, 5);
  tiempoEntero(b, 'left');
  juega(b, 6, 12);
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 2 });
  const atacaIzq = b.estado.teams[0].isAttacking;
  b.fase(13, 'shopping'); // cambio de lado
  assert.notEqual(b.estado.teams[0].isAttacking, atacaIzq, 'cambió de bando');
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 2 }, 'el cambio de bando no mueve los contadores');
  tiempoEntero(b, 'right');
  tiempoEntero(b, 'left');
  assert.deepEqual(cuenta(b), { max: 2, left: 0, right: 1 });
  // Sin restantes, el izquierdo no puede pedir más.
  b.manda('left_timeout');
  assert.equal(estado(b).leftTeam, false);
  assert.deepEqual(cuenta(b), { max: 2, left: 0, right: 1 });
});

test('prórroga: un extra por equipo una sola vez, con tope, y no se mueve con los cambios de lado', () => {
  const b = new Banco();
  juega(b, 1, 12);
  tiempoEntero(b, 'left');
  tiempoEntero(b, 'left');
  juega(b, 13, 24);
  tiempoEntero(b, 'right');
  assert.deepEqual(cuenta(b), { max: 2, left: 0, right: 1 });
  b.fase(25, 'shopping'); // primera de prórroga
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 2 }, '+1 a cada uno, sin pasar de 2');
  assert.equal(aSalida(b.estado).hasEnteredOvertime, true);
  b.manda('score', { team_0: 13, team_1: 12 });
  b.fase(26, 'shopping');
  b.manda('score', { team_0: 13, team_1: 13 });
  b.fase(27, 'shopping');
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 2 }, 'las rondas siguientes de prórroga no dan más');
  tiempoEntero(b, 'left');
  assert.deepEqual(cuenta(b), { max: 2, left: 0, right: 2 });
});

test('prórroga con TIEMPOS_MUERTOS_PRORROGA=0 no da nada', () => {
  const b = new Banco(partidoNuevo({}, undefined, 0));
  tiempoEntero(b, 'left');
  juega(b, 1, 24);
  b.fase(25, 'shopping');
  assert.deepEqual(cuenta(b), { max: 2, left: 1, right: 2 });
});

test('órdenes del operador: intercambiar lados a mitad de mapa y pausa técnica no descuadran', () => {
  const b = new Banco();
  tiempoEntero(b, 'left'); // equipo del juego 0 gasta uno
  b.manda('swap_left_right'); // el operador pone al equipo 0 a la derecha
  assert.deepEqual(cuenta(b), { max: 2, left: 2, right: 1 });
  b.manda('swap_attacker_defender');
  b.manda('swap_identity');
  assert.deepEqual(cuenta(b), { max: 2, left: 2, right: 1 }, 'ni bandos ni identidad mueven los contadores');
  b.manda('tech_pause').espera(90_000).manda('tech_pause');
  assert.deepEqual(cuenta(b), { max: 2, left: 2, right: 1 }, 'la pausa técnica no gasta');
  b.manda('right_timeout').espera(2_000).manda('right_timeout'); // pulsación doble: devuelto
  assert.deepEqual(cuenta(b), { max: 2, left: 2, right: 1 });
});

test('lo que el panel configura se conserva para el mapa siguiente (y antes de haber partido)', () => {
  const memoria = memoriaVacia();
  aplicaParcheGrupo(memoria, { timeoutCounter: { max: 1 }, timeoutDuration: 45 });
  const b = new Banco(partidoNuevo({ timeoutCounter: { max: 2, left: 2, right: 2 }, timeoutDuration: 60 }, memoria));
  assert.deepEqual(cuenta(b), { max: 1, left: 1, right: 1 }, 'manda el panel, no el 2 fijo del logon');
  b.manda('left_timeout');
  assert.equal(estado(b).timeRemaining, 45);

  // Sin configuración del panel, lo del logon.
  const c = new Banco(partidoNuevo({ timeoutCounter: { max: 3 } }, memoriaVacia()));
  assert.deepEqual(cuenta(c), { max: 3, left: 3, right: 3 });
});
