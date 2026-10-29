/**
 * Ingesta (puerto 5100): el observador, los jugadores y los latidos de presencia.
 *
 * Cada socket empieza sin rol. Con `obs_logon` pasa a observador de un grupo;
 * con `aux_logon`, a jugador de un grupo. A partir de ahí TODO lo que mande se
 * enruta al grupo con el que se autenticó: el `groupCode`/`matchId` que venga
 * dentro de los paquetes no se usa para enrutar (antes sí, y cualquier socket
 * podía escribir en el grupo de otro).
 *
 * Qué puede mandar cada rol:
 *   observador → obs_data, aux_data, obs_lobby, llamar_jugadores
 *   jugador    → aux_data
 *   cualquiera → cliente_presente
 */

import type { Server, Socket } from 'socket.io';
import type { CamaraConfig, Central } from './central.ts';
import type { Config } from './config.ts';
import { alarma, error, log } from './log.ts';
import { Limitador, emite, escucha, identificadorValido, leeCarga, respondeYCorta } from './mensajes.ts';
import { logonCompleto } from './partida/creacion.ts';
import { TIPOS_CONOCIDOS } from './partida/reductor.ts';
import type { DatosCreacion, Paquete } from './partida/tipos.ts';
import { validaToken } from './token.ts';
import { VERSION_SERVIDOR, clienteCompatible, motivoIncompatible } from './version.ts';

type Rol = 'observador' | 'jugador';

interface Sesion {
  socket: Socket;
  rol: Rol;
  grupo: string;
  nombre: string;
  /** puuid del jugador; vacío en el observador. */
  playerId: string;
  /** Corte programado a la caducidad del token del observador. */
  corte?: NodeJS.Timeout;
}

const MAX_TEMPORIZADOR_MS = 2 ** 31 - 1; // ~24,8 días: tope de setTimeout

/** Jugadores (sockets) que puede tener a la vez un grupo: 10 jugadores, algún suplente y las reconexiones a medias. */
const MAX_JUGADORES_POR_GRUPO = 30;
/** Lo más grande que puede ser la sala de Riot que manda el observador (en texto JSON). */
const MAX_SALA_BYTES = 64 * 1024;
/** A cuántos jugadores como máximo se puede llamar de una vez. */
const MAX_LLAMADOS = 60;

/** "Nombre#TAG" de Riot: nombre 3–16 (con espacios), tag 3–5 alfanuméricos. Con holgura. */
const NOMBRE_CAMARA = /^[^#\r\n]{1,32}#[A-Za-z0-9]{2,8}$/;

export interface Ingesta {
  /** Desconecta a todos los autenticados de un grupo (fin del partido). */
  expulsaGrupo(grupo: string): void;
  /** Manda `cam_config` a los jugadores del grupo. */
  camaras(grupo: string, config: CamaraConfig): void;
  /** Manda `te_llaman` a un jugador por su canal de presencia. */
  llama(puuid: string, carga: { groupCode: string; inviteCode?: string }): void;
  /** Pide a su programa el informe completo; `false` si no lo tiene abierto. */
  pideInforme(puuid: string): boolean;
  /** Una orden remota (de la lista permitida) al programa de un jugador. */
  ordenJugador(puuid: string, accion: string): boolean;
}

export function montaIngesta(io: Server, central: Central, config: Config): Ingesta {
  const sesiones = new Map<string, Sesion>(); // por id de socket
  const presencia = new Map<string, Socket>(); // puuid → socket que late

  io.on('connection', (socket) => {
    let logonIntentado = false;
    let puuidPresencia = '';
    /** Descartes ya anotados en el log de este socket (uno por motivo y tipo: un cliente roto no llena el log). */
    const avisados = new Set<string>();
    /** Ritmo de los mensajes de control (logon, presencia, sala…) y de los de datos de juego. Ver Limitador. */
    const general = new Limitador(60, 20);
    const ritmoDatos = new Limitador(600, 300);
    const en = (evento: string, fn: (msg: unknown, ack?: unknown) => void) => escucha(socket, evento, fn, general);
    const enLibre = (evento: string, fn: (msg: unknown, ack?: unknown) => void) => escucha(socket, evento, fn);

    /* ── Presencia ─────────────────────────────────────────────────────── */

    en('cliente_presente', (msg, ack) => {
      const d = leeCarga(msg);
      const puuid = d?.puuid;
      if (!identificadorValido(puuid)) return;
      // Lo que el exe cuenta de sí mismo (los antiguos no mandan nada: salen «sin diagnóstico»).
      if (d?.estado !== undefined) central.diagnostico(puuid, d.estado);
      // El mismo socket late ahora con otro puuid (cambio de cuenta): el viejo se deja caer.
      if (puuidPresencia !== '' && puuidPresencia !== puuid && presencia.get(puuidPresencia) === socket) {
        presencia.delete(puuidPresencia);
        central.presenciaCaida(puuidPresencia);
      }
      central.late(puuid);
      if (presencia.get(puuid) !== socket) log(`presencia: ${puuid.slice(0, 8)}… conectada`);
      presencia.set(puuid, socket);
      puuidPresencia = puuid;
      // "Call players" sigue en pie: cada latido repite el aviso hasta que entre (el exe ignora los repetidos).
      const pendiente = central.grupoPendiente(puuid);
      if (pendiente !== undefined) emite(socket, 'te_llaman', central.llamada(pendiente));
      // Acuse: el exe lo usa para saber que el servidor le oye de verdad (y no sólo que el socket está abierto).
      if (typeof ack === 'function') ack({ ok: true, servidor: VERSION_SERVIDOR });
    });

    // El programa del jugador manda su informe completo (la «caja negra»), a petición o por su botón.
    en('informe_cliente', (msg, ack) => {
      const d = leeCarga(msg);
      const puuid = typeof d?.puuid === 'string' && d.puuid !== '' ? d.puuid : puuidPresencia;
      const informe = d?.informe;
      const texto = typeof informe === 'string' ? informe : informe !== undefined ? JSON.stringify(informe) : '';
      const ok = puuid !== '' && central.guardaInforme(puuid, texto);
      if (typeof ack === 'function') ack({ ok });
    });

    /* ── Logon del observador ──────────────────────────────────────────── */

    en('obs_logon', (msg) => {
      if (logonIntentado || sesiones.has(socket.id)) return;
      const d = leeCarga(msg);
      if (!d) {
        log(`obs_logon ilegible desde ${socket.id}`);
        return;
      }
      logonIntentado = true;
      const rechaza = (reason: string) => {
        log(`obs_logon rechazado (${String(d.groupCode)}): ${reason}`);
        respondeYCorta(socket, 'obs_logon_ack', { type: 'authenticate', value: false, reason });
      };

      if (d.type !== 'authenticate' || !logonCompleto(d)) return rechaza('Invalid packet.');
      if (!clienteCompatible(d.clientVersion)) return rechaza(motivoIncompatible(d.clientVersion));
      if (!identificadorValido(d.groupCode)) {
        return rechaza('Group code not accepted: it is empty, longer than 64 characters or has hidden characters. Copy it again from your Easy HUD account.');
      }

      const grupo = d.groupCode as string;
      let caducidad: number | undefined;
      if (config.sinAutenticacion) {
        alarma(`EASY_DEV_SIN_AUTH: observador aceptado SIN comprobar token en el grupo ${grupo}`);
      } else {
        const v = validaToken(d.key, grupo, config.secretoToken);
        if (!v.valido) {
          log(`token del observador no válido para ${grupo}: ${v.motivo}`);
          // Textos que el cliente ya sabe traducir ("expired" / "invalid").
          return rechaza(v.clase === 'caducado' ? 'Expired Key' : 'Invalid Key');
        }
        caducidad = v.exp;
      }

      // Un logon mal montado se dice claro AHORA, no se descubre a mitad del directo con un equipo vacío.
      const [izq, der] = [d.leftTeam, d.rightTeam] as [{ attackStart?: unknown }, { attackStart?: unknown }];
      if (izq.attackStart === der.attackStart) {
        return rechaza('Both teams start on the same side. One team must start attacking and the other defending: check the team setup in Easy HUD and open the observer again.');
      }

      // Crear, reconectar o retomar.
      let reason = '';
      try {
        const existente = central.partido(grupo);
        if (!existente && central.completo(grupo)) {
          return rechaza(`The server is at its limit of ${config.maxPartidos ?? 100} live matches. Wait a few minutes and try again; if it keeps happening, tell the organizer.`);
        }
        if (!existente) {
          reason = central.crea(datosCreacion(d), cabeceraGrabacion(d), socket.id).secreto;
        } else if (typeof d.groupSecret === 'string' && d.groupSecret !== '' && d.groupSecret === existente.secreto) {
          // El mismo observador que vuelve: el estado no se toca. Si el socket anterior sigue abierto (medio muerto, o el
          // proceso viejo aún vivo) se corta: dos sockets escribiendo en el mismo partido mezclarían dos GEP distintos.
          const anterior = existente.dueno;
          if (anterior !== null && anterior !== socket.id) {
            log(`observador de ${grupo}: el socket anterior se cierra, lo sustituye el que vuelve con el secreto`);
            sesiones.get(anterior)?.socket.disconnect(true);
          }
          existente.dueno = socket.id;
          reason = 'reconnected';
        } else if (existente.dueno !== null) {
          return rechaza(`Game with Group Code ${grupo} exists and is still live.`);
        } else {
          // Huérfano: lo retoma este observador, conservando el estado.
          reason = central.retoma(grupo, socket.id) ?? central.crea(datosCreacion(d), cabeceraGrabacion(d), socket.id).secreto;
        }
      } catch (e) {
        error(`no se pudo montar el partido del grupo ${grupo}`, e);
        return rechaza('The server could not start the match for this group. Try again in a moment; if it keeps failing, tell the organizer.');
      }

      const sesion: Sesion = {
        socket,
        rol: 'observador',
        grupo,
        nombre: typeof d.obsName === 'string' ? d.obsName.slice(0, 64) : '',
        playerId: '',
      };
      if (caducidad !== undefined) {
        const quedan = Math.min(MAX_TEMPORIZADOR_MS, Math.max(0, caducidad * 1000 - Date.now()));
        sesion.corte = setTimeout(() => {
          log(`token del observador ${sesion.nombre} (${grupo}) caducado: se corta la ingesta`);
          socket.disconnect(true);
        }, quedan);
        sesion.corte.unref();
      }
      sesiones.set(socket.id, sesion);
      log(`observador ${sesion.nombre} en ${grupo} (${reason === 'reconnected' ? 'reconexión' : 'nuevo'})`);
      emite(socket, 'obs_logon_ack', { type: 'authenticate', value: true, reason });
    });

    /* ── Logon del jugador ─────────────────────────────────────────────── */

    en('aux_logon', (msg) => {
      if (logonIntentado || sesiones.has(socket.id)) return;
      const d = leeCarga(msg);
      if (!d) {
        log(`aux_logon ilegible desde ${socket.id}`);
        return;
      }
      logonIntentado = true;
      // Los rechazos llevan `aux_authenticate`: con `authenticate` el cliente los ignoraba.
      const rechaza = (reason: string) => {
        log(`aux_logon rechazado: ${reason}`);
        respondeYCorta(socket, 'aux_logon_ack', { type: 'aux_authenticate', value: false, reason });
      };

      if (d.type !== 'aux_authenticate') return rechaza('Invalid packet.');
      if (!clienteCompatible(d.clientVersion)) return rechaza(motivoIncompatible(d.clientVersion));

      // "Call players" trae groupCode: manda sobre el matchId (que ahí va vacío).
      // Y un matchId vacío ya no casa con partidos de otros grupos.
      const matchId = typeof d.matchId === 'string' ? d.matchId : '';
      const porGrupo = typeof d.groupCode === 'string' && d.groupCode !== '' ? central.partido(d.groupCode) : undefined;
      const partido = porGrupo ?? central.partidoPorMatchId(matchId);
      if (!partido) return rechaza(`Game with Match ID ${String(d.matchId)} not found.`);

      let jugadoresDelGrupo = 0;
      for (const s of sesiones.values()) if (s.grupo === partido.grupo && s.rol === 'jugador') jugadoresDelGrupo += 1;
      if (jugadoresDelGrupo >= MAX_JUGADORES_POR_GRUPO) {
        return rechaza(`This group already has ${MAX_JUGADORES_POR_GRUPO} players connected. Close any extra copies of Easy HUD and try again.`);
      }

      const sesion: Sesion = {
        socket,
        rol: 'jugador',
        grupo: partido.grupo,
        nombre: typeof d.name === 'string' ? d.name.slice(0, 64) : '',
        playerId: identificadorValido(d.playerId) ? d.playerId : '',
      };
      sesiones.set(socket.id, sesion);
      log(`jugador ${sesion.nombre} en ${sesion.grupo}`);
      central.jugadorConectado(sesion.grupo, sesion.playerId);
      emite(socket, 'aux_logon_ack', { type: 'aux_authenticate', value: true });
      emite(socket, 'cam_config', central.camaraConfig(sesion.grupo));
    });

    /* ── Datos ─────────────────────────────────────────────────────────── */

    const recibeDatos = (msg: unknown, canal: 'obs_data' | 'aux_data') => {
      const s = sesiones.get(socket.id);
      if (!s) return;
      if (canal === 'obs_data' && s.rol !== 'observador') {
        log(`obs_data de un jugador (${s.nombre}, ${s.grupo}): descartado`);
        return;
      }
      const d = leeCarga(msg);
      if (!d) {
        log(`${canal} ilegible de ${s.nombre}`);
        return;
      }
      const esPaquete =
        ('obsName' in d || 'playerId' in d) && ('groupCode' in d || 'matchId' in d) && 'type' in d && 'data' in d;
      if (!esPaquete || typeof d.type !== 'string') return;
      if (typeof d.groupCode === 'string' && d.groupCode !== s.grupo) {
        log(`paquete de ${s.nombre} para el grupo ${d.groupCode}, pero está autenticado en ${s.grupo}: descartado`);
        return;
      }

      // Un jugador sólo manda sus datos propios (aux_*). Antes podía mandar
      // cualquier tipo conocido (roster, score, swap_left_right…) y mover los
      // equipos del partido entero.
      if (s.rol === 'jugador' && !d.type.startsWith('aux_')) {
        log(`${d.type} de un jugador (${s.nombre}, ${s.grupo}): descartado`);
        return;
      }

      // Cámara: no pasa por el reductor del partido, la gestiona el servidor.
      if (d.type === 'aux_cam') {
        if (s.rol === 'jugador') {
          const dato = d.data as { publishing?: unknown; id?: unknown } | null;
          const id = typeof dato?.id === 'string' ? dato.id.trim() : '';
          const valido = dato?.publishing === true && NOMBRE_CAMARA.test(id);
          central.camara(s.grupo, s.playerId || socket.id, valido ? id : null);
        }
        return;
      }

      const paquete: Paquete = { ...d, type: d.type, data: d.data, timestamp: Date.now() };
      if (s.rol === 'jugador') {
        // Un jugador sólo escribe en SU ficha: el `playerId` efectivo es el de su logon, nunca el del cuerpo del paquete
        // (un cliente modificado podía cambiar dinero, kills o vida de otro). Y el servidor no aprende ni cambia el
        // `playerId` de un socket a partir de un paquete: sólo del logon.
        const rechazo = identidadAjena(s, d);
        if (rechazo !== null) {
          if (!avisados.has(`${rechazo}|${d.type}`)) {
            avisados.add(`${rechazo}|${d.type}`);
            log(`${d.type} de ${s.nombre} (${s.grupo}) descartado: ${rechazo}`);
          }
          return;
        }
        paquete.playerId = s.playerId;
        // El marcador propio lleva el puuid dentro del dato: se fija al del logon.
        if (d.type === 'aux_scoreboard' && typeof d.data === 'object' && d.data !== null && !Array.isArray(d.data)) {
          paquete.data = { ...(d.data as Record<string, unknown>), playerId: s.playerId };
        }
      }
      // El tipo de paquete es texto del cliente: sólo los conocidos se cuentan por separado (no se llena la memoria con tipos inventados).
      if (s.rol === 'jugador') central.datoDeJugador(s.grupo, s.playerId, TIPOS_CONOCIDOS.has(d.type) ? d.type : 'otro');
      else if (d.type === 'scoreboard' && typeof (d.data as { playerId?: unknown } | null)?.playerId === 'string') {
        central.marcadorDe(s.grupo, (d.data as { playerId: string }).playerId);
      }
      try {
        central.graba(s.grupo, paquete);
        central.procesa(s.grupo, paquete);
      } catch (e) {
        error(`procesando ${canal} de ${s.nombre}`, e);
      }
    };
    escucha(socket, 'obs_data', (msg) => recibeDatos(msg, 'obs_data'), ritmoDatos);
    escucha(socket, 'aux_data', (msg) => recibeDatos(msg, 'aux_data'), ritmoDatos);

    en('obs_lobby', (msg) => {
      const s = sesiones.get(socket.id);
      if (!s || s.rol !== 'observador') return;
      const d = leeCarga(msg);
      const sala = d?.sala;
      // `sala: null` = el observador ya no ve ninguna sala (salió de la party): se olvida la vieja.
      if (d && 'sala' in d && sala === null) {
        central.limpiaSala(s.grupo);
        return;
      }
      if (typeof sala !== 'object' || sala === null || Array.isArray(sala)) return;
      if (JSON.stringify(sala).length > MAX_SALA_BYTES) {
        log(`obs_lobby de ${s.grupo} descartado: la sala pesa más de ${MAX_SALA_BYTES / 1024} KB`);
        return;
      }
      central.guardaSala(s.grupo, sala as Record<string, unknown>);
    });

    en('llamar_jugadores', (msg) => {
      const s = sesiones.get(socket.id);
      if (!s || s.rol !== 'observador') {
        log('llamar_jugadores de un socket que no es observador: ignorado');
        return;
      }
      const d = leeCarga(msg);
      if (!d || !Array.isArray(d.puuids)) return;
      // Se sigue llamando a quien aún no tenga el programa abierto; una lista vacía cancela.
      const puuids = d.puuids.slice(0, MAX_LLAMADOS);
      central.llamaHasta(s.grupo, puuids.filter(identificadorValido));
      const avisados: string[] = [];
      for (const puuid of puuids) {
        if (typeof puuid !== 'string') continue;
        const destino = presencia.get(puuid);
        if (!destino) continue;
        emite(destino, 'te_llaman', central.llamada(s.grupo));
        avisados.push(puuid);
      }
      log(`llamada en ${s.grupo}: ${avisados.length}/${puuids.length} jugadores con el programa abierto, sala ${central.codigoSala(s.grupo) || '(sin código aún)'}`);
      emite(socket, 'llamar_jugadores_ack', { avisados });
    });

    /* ── Desconexión ───────────────────────────────────────────────────── */

    enLibre('disconnect', () => {
      if (puuidPresencia !== '' && presencia.get(puuidPresencia) === socket) {
        log(`presencia: ${puuidPresencia.slice(0, 8)}… desconectada`);
        presencia.delete(puuidPresencia);
        central.presenciaCaida(puuidPresencia);
      }
      const s = sesiones.get(socket.id);
      if (!s) return;
      sesiones.delete(socket.id);
      if (s.corte) clearTimeout(s.corte);
      if (s.rol === 'jugador') {
        central.camara(s.grupo, s.playerId || socket.id, null);
        central.camara(s.grupo, socket.id, null);
      }
      if (s.playerId !== '') central.jugadorDesconectado(s.grupo, s.playerId);
      if (s.rol === 'observador') {
        const p = central.partido(s.grupo);
        // Sólo cuenta si es el dueño actual (un socket viejo que cae tarde no deja huérfano a nadie).
        if (p && p.dueno === socket.id) {
          p.dueno = null;
          log(`observador de ${s.grupo} desconectado: el partido queda a la espera`);
        }
      }
    });
  });

  return {
    expulsaGrupo(grupo) {
      for (const s of [...sesiones.values()]) {
        if (s.grupo === grupo) s.socket.disconnect(true);
      }
    },
    llama(puuid, carga) {
      const s = presencia.get(puuid);
      if (s) emite(s, 'te_llaman', carga);
    },
    pideInforme(puuid) {
      const s = presencia.get(puuid);
      if (!s) return false;
      emite(s, 'pide_informe', {});
      return true;
    },
    ordenJugador(puuid, accion) {
      const s = presencia.get(puuid);
      if (!s) return false;
      emite(s, 'orden_remota', { accion });
      return true;
    },
    camaras(grupo, config) {
      for (const s of sesiones.values()) {
        if (s.grupo === grupo && s.rol === 'jugador') emite(s.socket, 'cam_config', config);
      }
    },
  };
}

/**
 * ¿Escribe este paquete de jugador en una ficha que no es la suya? Devuelve el motivo del descarte, o `null` si vale.
 * Se mira el `playerId` del paquete y, en el marcador propio, el del dato.
 */
function identidadAjena(s: Sesion, d: Record<string, unknown>): string | null {
  if (s.playerId === '') return 'su logon no trajo playerId';
  const ajeno = (v: unknown) => typeof v === 'string' && v !== '' && v !== s.playerId;
  if (ajeno(d.playerId)) return 'el playerId del paquete no es el de su logon';
  const dato = d.data;
  if (d.type === 'aux_scoreboard' && typeof dato === 'object' && dato !== null && ajeno((dato as Record<string, unknown>).playerId)) {
    return 'el playerId del marcador no es el de su logon';
  }
  return null;
}

/* ── Del logon a lo que necesita la central ─────────────────────────────── */

function datosCreacion(d: Record<string, unknown>): DatosCreacion {
  return {
    groupCode: d.groupCode as string,
    leftTeam: d.leftTeam as DatosCreacion['leftTeam'],
    rightTeam: d.rightTeam as DatosCreacion['rightTeam'],
    toolsData: (typeof d.toolsData === 'object' && d.toolsData !== null ? d.toolsData : {}) as Record<string, unknown>,
  };
}

/** Cabecera de la grabación: el logon sin la credencial ni el tipo. */
function cabeceraGrabacion(d: Record<string, unknown>): Record<string, unknown> {
  const { key: _clave, type: _tipo, ...resto } = d;
  return { serverVersion: VERSION_SERVIDOR, ...resto, logStartTime: Date.now() };
}
