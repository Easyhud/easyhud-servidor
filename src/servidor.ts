/**
 * Montaje del servidor: los tres puertos y quién habla con quién.
 *
 *   5200  salida   (socket.io)  overlays, panel y /operador
 *   5100  ingesta  (socket.io)  observador, jugadores, presencia
 *   5101  extras   (HTTP)       GET /status (sonda de salud)
 *
 * Se arrancan en ese orden: la salida antes que la ingesta, para que nada
 * que entre se quede sin a quién difundirse.
 *
 * `arranca()` devuelve los puertos reales (con puerto 0 el sistema elige uno
 * libre, que es lo que hacen las pruebas de integración) y una función para
 * apagarlo todo.
 */

import { readFileSync } from 'node:fs';
import { createServer as creaHttp, type IncomingMessage, type Server as ServidorHttp, type ServerResponse } from 'node:http';
import { createServer as creaHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Server, type ServerOptions } from 'socket.io';
import { Central } from './central.ts';
import type { Config } from './config.ts';
import { montaIngesta } from './ingesta.ts';
import { log } from './log.ts';
import { montaSalida } from './salida.ts';
import { VERSION_SERVIDOR } from './version.ts';

export interface Servidor {
  puertos: { ingesta: number; salida: number; extras: number };
  central: Central;
  cierra(): Promise<void>;
}

const OPCIONES_SOCKET: Partial<ServerOptions> = {
  cors: { origin: '*' },
  // match_data es grande y frecuente: compresión por mensaje a partir de 1 KiB.
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { chunkSize: 1024, level: 3, memLevel: 7 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
  },
};

function creaServidorHttp(config: Config, manejador?: (req: IncomingMessage, res: ServerResponse) => void): ServidorHttp {
  if (config.inseguro) return creaHttp(manejador);
  const opciones = { key: readFileSync(config.claveTls as string), cert: readFileSync(config.certTls as string) };
  return creaHttps(opciones, manejador) as unknown as ServidorHttp;
}

function escucha(s: ServidorHttp, puerto: number): Promise<number> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(puerto, () => {
      s.off('error', reject);
      resolve((s.address() as AddressInfo).port);
    });
  });
}

function cierraHttp(s: ServidorHttp): Promise<void> {
  return new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

/** Rutas HTTP auxiliares. Hoy sólo la sonda de salud. */
function rutasExtras(central: Central) {
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const ruta = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && ruta === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'UP', matchesRunning: central.numeroDePartidos, version: VERSION_SERVIDOR }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

export async function arranca(config: Config): Promise<Servidor> {
  const central = new Central(config);

  const httpSalida = creaServidorHttp(config);
  const ioSalida = new Server(httpSalida, OPCIONES_SOCKET);
  const salida = montaSalida(ioSalida, central, config);

  const httpIngesta = creaServidorHttp(config);
  const ioIngesta = new Server(httpIngesta, OPCIONES_SOCKET);
  const ingesta = montaIngesta(ioIngesta, central, config);

  central.conecta({ ...salida, expulsaGrupo: ingesta.expulsaGrupo });

  const httpExtras = creaServidorHttp(config, rutasExtras(central));

  const puertos = {
    salida: await escucha(httpSalida, config.puertos.salida),
    ingesta: await escucha(httpIngesta, config.puertos.ingesta),
    extras: await escucha(httpExtras, config.puertos.extras),
  };
  log(
    `Easy HUD servidor de partidas ${VERSION_SERVIDOR} — ingesta :${puertos.ingesta}, salida :${puertos.salida}, ` +
      `extras :${puertos.extras} (${config.inseguro ? 'HTTP' : 'HTTPS'})`,
  );

  return {
    puertos,
    central,
    async cierra() {
      central.cierra();
      ioIngesta.disconnectSockets(true);
      ioSalida.disconnectSockets(true);
      ioSalida.of('/operador').disconnectSockets(true);
      await Promise.all([
        new Promise<void>((r) => ioIngesta.close(() => r())),
        new Promise<void>((r) => ioSalida.close(() => r())),
        cierraHttp(httpExtras),
      ]);
    },
  };
}
