/**
 * Reproductor de grabaciones: un observador falso que hace `obs_logon` con los
 * datos de la cabecera y luego manda cada paquete grabado por `obs_data`.
 *
 *   npm run reproduce -- -game <fichero.replay> [-server http://localhost:5100]
 *                        [-instant | -delay <ms> | -timestamps | -manual] [-token <t>]
 *
 * Modos: -instant todo de golpe (defecto); -delay a intervalos fijos (500 ms
 * por defecto); -timestamps respetando los tiempos grabados; -manual por
 * teclado (Intro = siguiente, un número N = los N siguientes, "go" = el resto,
 * "exit" = salir).
 *
 * Token: `-token`, o si no se da, se firma uno para el grupo de la cabecera con
 * OVERLAY_TOKEN_SECRET (entorno o .env). Necesita `socket.io-client`
 * (dependencia de desarrollo).
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { io } from 'socket.io-client';
import { cargaFicheroEnv } from '../config.ts';
import { leeGrabacion } from '../grabacion.ts';
import { firmaToken, secretoValido } from '../token.ts';

const args = process.argv.slice(2);
const valor = (nombre: string): string | undefined => {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[i + 1] : undefined;
};

cargaFicheroEnv();

const fichero = valor('-game') ?? 'customGameTest.replay';
const servidor = valor('-server') ?? 'http://localhost:5100/';
const modo = args.includes('-manual') ? 'manual' : args.includes('-timestamps') ? 'timestamps' : args.includes('-delay') ? 'delay' : 'instant';
const retardo = Number(valor('-delay') ?? 500);

const { cabecera, paquetes } = leeGrabacion(readFileSync(fichero, 'utf8'));
const grupo = String(cabecera.groupCode ?? '');
const secreto = process.env.OVERLAY_TOKEN_SECRET;
const token = valor('-token') ?? (secretoValido(secreto) ? firmaToken(grupo, 1, 'reproductor', secreto) : '');

const socket = io(servidor, { transports: ['websocket'], rejectUnauthorized: false });
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

socket.on('connect', () => {
  socket.emit(
    'obs_logon',
    JSON.stringify({
      type: 'authenticate',
      clientVersion: cabecera.clientVersion,
      obsName: cabecera.obsName,
      key: token,
      groupCode: grupo,
      leftTeam: cabecera.leftTeam,
      rightTeam: cabecera.rightTeam,
      toolsData: cabecera.toolsData ?? {},
    }),
  );
});

socket.once('obs_logon_ack', async (msg: string) => {
  const ack = JSON.parse(msg);
  if (ack.value !== true) {
    console.error(`logon rechazado: ${ack.reason}`);
    process.exit(1);
  }
  console.log(`conectado al grupo ${grupo}; ${paquetes.length} paquetes (${modo})`);
  await reproduce();
  await espera(300); // que salga lo último antes de cerrar
  socket.close();
  process.exit(0);
});

function envia(p: Record<string, unknown>): boolean {
  socket.emit('obs_data', JSON.stringify(p));
  const d = p.data as { roundPhase?: unknown } | undefined;
  return p.type === 'round_info' && d?.roundPhase === 'game_end';
}

async function reproduce(): Promise<void> {
  if (modo === 'manual') return manual();
  let anterior: number | undefined;
  for (const p of paquetes) {
    if (modo === 'delay') await espera(retardo);
    if (modo === 'timestamps') {
      const t = typeof p.timestamp === 'number' ? p.timestamp : undefined;
      if (anterior !== undefined && t !== undefined) await espera(Math.max(0, t - anterior));
      anterior = t ?? anterior;
    }
    if (envia(p)) return;
  }
}

async function manual(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  let i = 0;
  for await (const linea of rl) {
    const orden = linea.trim();
    if (orden === 'exit') break;
    const n = orden === 'go' ? paquetes.length : orden === '' ? 1 : Number(orden) || 1;
    for (let k = 0; k < n && i < paquetes.length; k++, i++) {
      if (envia(paquetes[i])) i = paquetes.length;
    }
    console.log(`${i}/${paquetes.length}`);
    if (i >= paquetes.length) break;
  }
  rl.close();
}
