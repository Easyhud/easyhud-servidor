/**
 * Salida (puerto 5200): lo que ven los overlays y el panel, y el mando del operador.
 *
 * Espacio por defecto: `logon` a un grupo → el socket entra en la sala
 * socket.io con ese nombre y recibe `match_data` y `sala` de ese grupo. La
 * pertenencia sobrevive a los partidos: al empezar otro mapa en el mismo
 * grupo, los overlays ya suscritos lo reciben sin repetir el logon.
 *
 * Espacio `/operador`: el panel manda órdenes (`orden`) y parches de
 * configuración (`configura`) al grupo con el que hizo `operador_logon`, y
 * sólo a ése: el grupo sale del token validado, nunca del mensaje.
 */

import type { Server, Socket } from 'socket.io';
import type { Central, Difusion } from './central.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { emite, leeCarga, respondeYCorta } from './mensajes.ts';
import { type Veredicto, validaToken } from './token.ts';

/** Orden del panel → tipo de paquete equivalente. */
const ORDENES: Record<string, string> = {
  pausaTecnica: 'tech_pause',
  tiempoMuertoIzq: 'left_timeout',
  tiempoMuertoDer: 'right_timeout',
  kdaCreditos: 'switch_kda_credits',
  intercambiaLados: 'swap_left_right',
  intercambiaBandos: 'swap_attacker_defender',
  intercambiaEquipos: 'swap_identity',
  rotulo: 'toast',
};

export function montaSalida(io: Server, central: Central, config: Config): Omit<Difusion, 'expulsaGrupo'> {
  /** Puerta de los overlays: sólo exige token si REQUIRE_OVERLAY_TOKEN=true. */
  const validaMirada = (token: unknown, grupo: string): Veredicto => {
    if (config.sinAutenticacion) return { valido: true, motivo: 'sin autenticación (desarrollo)' };
    if (!config.exigirTokenOverlay) return { valido: true, motivo: 'no se exige token' };
    return validaToken(token, grupo, config.secretoToken);
  };

  /** Puerta del mando: siempre estricta (salvo en modo desarrollo). */
  const validaMando = (token: unknown, grupo: string): Veredicto => {
    if (config.sinAutenticacion) return { valido: true, motivo: 'sin autenticación (desarrollo)' };
    return validaToken(token, grupo, config.secretoToken);
  };

  /* ── Mirar ─────────────────────────────────────────────────────────────── */

  io.on('connection', (socket: Socket) => {
    let hecho = false;
    socket.on('logon', (msg) => {
      if (hecho) return;
      const d = leeCarga(msg);
      if (!d) {
        log('logon de salida ilegible');
        return;
      }
      hecho = true;
      const grupo = typeof d.groupCode === 'string' ? d.groupCode : '';
      const v = grupo === '' ? { valido: false, motivo: 'sin groupCode' } : validaMirada(d.token, grupo);
      if (!v.valido) {
        log(`logon de overlay denegado (${grupo}): ${v.motivo}`);
        respondeYCorta(socket, 'logon_denied', { reason: v.motivo });
        return;
      }
      void socket.join(grupo);
      emite(socket, 'logon_success', { groupCode: grupo, msg: `Logon succeeded for group code ${grupo}` });
      central.enviaAhora(grupo);
      central.difundeSala(grupo);
    });
  });

  /* ── Mandar ────────────────────────────────────────────────────────────── */

  io.of('/operador').on('connection', (socket: Socket) => {
    let grupo: string | null = null;

    socket.on('operador_logon', (msg) => {
      const d = leeCarga(msg);
      if (!d) return;
      const g = typeof d.groupCode === 'string' ? d.groupCode : '';
      const v = g === '' ? { valido: false, motivo: 'sin groupCode' } : validaMando(d.token, g);
      if (!v.valido) {
        log(`operador denegado (${g}): ${v.motivo}`);
        grupo = null;
        respondeYCorta(socket, 'operador_denegado', { reason: v.motivo });
        return;
      }
      grupo = g;
      log(`operador en ${g}`);
      emite(socket, 'operador_listo', { groupCode: g });
    });

    socket.on('orden', (msg) => {
      if (grupo === null) return;
      const d = leeCarga(msg);
      if (!d) return;
      const tipo = d.tipo;
      const equivalente = typeof tipo === 'string' && Object.hasOwn(ORDENES, tipo) ? ORDENES[tipo] : undefined;
      if (!equivalente || !central.partido(grupo)) {
        emite(socket, 'operador_error', { reason: `orden no aplicada: ${String(tipo)}` });
        return;
      }
      const paquete = {
        obsName: 'operador',
        groupCode: grupo,
        type: equivalente,
        data: tipo === 'rotulo' ? datosRotulo(d.datos) : null,
        timestamp: Date.now(),
      };
      central.graba(grupo, paquete);
      central.procesa(grupo, paquete);
    });

    socket.on('configura', (msg) => {
      if (grupo === null) return;
      const parche = leeCarga(msg);
      if (!parche) return;
      if (!central.configura(grupo, parche)) {
        emite(socket, 'operador_error', { reason: 'sin partido para configurar' });
      }
    });
  });

  return {
    estado(grupo, json) {
      io.to(grupo).emit('match_data', json);
    },
    sala(grupo, carga) {
      io.to(grupo).emit('sala', JSON.stringify(carga));
    },
  };
}

/**
 * Los datos del rótulo tal como los espera el reductor. El panel manda la
 * duración en segundos (o `null` = hasta que se quite). Se conservan `title`
 * y `active` (antes se descartaba el título y se forzaba `active`).
 */
function datosRotulo(datos: unknown): Record<string, unknown> {
  const d = typeof datos === 'object' && datos !== null ? (datos as Record<string, unknown>) : {};
  return {
    active: typeof d.active === 'boolean' ? d.active : undefined,
    title: typeof d.title === 'string' ? d.title : '',
    message: typeof d.message === 'string' ? d.message : '',
    duration: typeof d.duration === 'number' && Number.isFinite(d.duration) ? d.duration * 1000 : null,
    eventLogoEnabled: d.eventLogoEnabled !== false,
    selectedTeam: d.selectedTeam,
  };
}
