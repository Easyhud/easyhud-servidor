/**
 * La central: lo que el servidor sabe en cada momento, por grupo.
 *
 *  - los partidos vivos (estado, secreto de reconexión, grabación, observador dueño);
 *  - la memoria de cada grupo que sobrevive a los mapas (serie y equipos);
 *  - la sala de Riot que manda el observador y qué jugadores tienen cliente.
 *
 * No sabe de sockets: difunde a través de la interfaz `Difusion`, que le
 * pasan los transportes. El estado de cada partido sólo cambia pasando por el
 * reductor puro (`partida/reductor.ts`).
 */

import { leeDiagnostico, veredicto, type DiagnosticoCliente, type Veredicto } from './diagnostico.ts';
import { createHmac, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Grabadora } from './grabacion.ts';
import { log, error } from './log.ts';
import { creaPartido } from './partida/creacion.ts';
import { aplicaParcheGrupo, memoriaVacia } from './partida/configuracion.ts';
import { reduce } from './partida/reductor.ts';
import { jugadorPorId } from './partida/jugadores.ts';
import { serializa } from './partida/serializa.ts';
import type { DatosCreacion, Evento, MemoriaGrupo, Partido } from './partida/tipos.ts';
import type { Config } from './config.ts';

/**
 * Presencia: el cliente del jugador late cada 12 s. Tras ~2,5 latidos perdidos
 * (30 s) se da por cerrado y se re-emiten las salas que lo contienen. Si el
 * socket de presencia se cae, se deja un margen corto (por si reconecta) y no
 * se espera al plazo entero.
 */
export const PRESENCIA_VIVA_MS = 30_000;
export const GRACIA_DESCONEXION_MS = 5_000;
export const REVISION_PRESENCIA_MS = 5_000;
const TIC_MS = 100; // bucle de envío: como mucho 10 envíos por segundo y grupo
const LIMPIEZA_MS = 60_000;
const OLVIDO_GRUPO_MS = 48 * 3600_000;
/** Cuánto se sigue llamando a un jugador que aún no ha abierto el programa. */
const LLAMADA_MS = 30 * 60_000;
/** Cuánto tiempo se recuerda que un jugador estuvo en un grupo para volver a llamarlo solo en la partida siguiente. */
const CONOCIDO_MS = 6 * 60 * 60 * 1000;

/** Cada cuánto se repite el aviso a quien aún no está dentro de la sala de Riot. */
const INSISTENCIA_MS = 6_000;
const OLVIDO_LATIDO_MS = 10 * 60_000;
/** Saca del informe las conclusiones (validadas y acotadas): es texto que viene de un cliente. */
function leeConclusiones(texto: string): ConclusionInforme[] {
  try {
    const doc: unknown = JSON.parse(texto);
    const lista = typeof doc === 'object' && doc !== null ? (doc as { conclusiones?: unknown }).conclusiones : undefined;
    if (!Array.isArray(lista)) return [];
    const salida: ConclusionInforme[] = [];
    for (const c of lista.slice(0, 12)) {
      if (typeof c !== 'object' || c === null) continue;
      const { id, certeza, texto: t } = c as Record<string, unknown>;
      if (typeof id !== 'string' || typeof t !== 'string') continue;
      if (certeza !== 'confirmada' && certeza !== 'probable' && certeza !== 'info') continue;
      salida.push({ id: id.slice(0, 40), certeza, texto: t.slice(0, 400) });
    }
    return salida;
  } catch {
    return [];
  }
}

/** Tope del informe completo de un programa (es texto: unos cientos de KB). */
export const MAX_INFORME_BYTES = 600 * 1024;

/** Lo que el informe de un PC concluye (viene de su programa; el servidor sólo lo valida y lo muestra). */
export interface ConclusionInforme {
  id: string;
  certeza: 'confirmada' | 'probable' | 'info';
  texto: string;
}

/** Lo que el panel ve de cada jugador (ver `estadoJugadores`). */
export interface EstadoJugador {
  app: boolean;
  dentro: boolean;
  datosMs: number | null;
  camara: boolean;
  veredicto: Veredicto;
  diag: (DiagnosticoCliente & { haceMs: number }) | null;
  /** Paquetes de su exe, por tipo: cuántos y hace cuánto llegó el último. */
  paquetes: Record<string, { n: number; haceMs: number }>;
  /** Marcadores suyos que recibió el observador. */
  marcador: { n: number; haceMs: number } | null;
  /** El último informe completo que mandó su programa: cuándo, cuánto pesa y QUÉ CONCLUYE (la causa), o `null`. */
  informe: { haceMs: number; bytes: number; conclusiones: ConclusionInforme[] } | null;
}

export interface CamaraConfig {
  enable: boolean;
  room: string;
  base: string;
  params: string;
  clave: string;
}

export interface Difusion {
  /** `cam_config` a los jugadores del grupo (si están conectados). */
  camaras(grupo: string, config: CamaraConfig): void;
  /** `te_llaman` a un jugador por su canal de presencia (si lo tiene abierto). */
  llama(puuid: string, carga: { groupCode: string; inviteCode?: string }): void;
  /** Le pide a su programa el informe completo (la «caja negra»). `false` si no tiene el programa abierto. */
  pideInforme(puuid: string): boolean;
  /** Una orden remota del operador a su programa (de la lista permitida). `false` si no lo tiene abierto. */
  ordenJugador(puuid: string, accion: string): boolean;
  /**
   * `match_data` a todos los consumidores del grupo. `jsonAutenticado` es el mismo estado CON la clave de las cámaras:
   * sólo lo reciben los consumidores autenticados; `json` (sin ella) va al resto.
   */
  estado(grupo: string, json: string, jsonAutenticado?: string): void;
  /** `sala` a todos los consumidores del grupo. */
  sala(grupo: string, carga: Record<string, unknown>): void;
  /** Desconecta a observador y jugadores del grupo (el partido se acabó). */
  expulsaGrupo(grupo: string): void;
}

export interface PartidoVivo {
  grupo: string;
  estado: Partido;
  secreto: string;
  /** Socket del observador que manda ahora (null = huérfano). */
  dueno: string | null;
  version: number;
  enviada: number;
  ultimoEnvio: number;
  grabadora: Grabadora | null;
}

const ALFABETO_SECRETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function nuevoSecreto(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALFABETO_SECRETO[randomInt(ALFABETO_SECRETO.length)];
  return s;
}

export class Central {
  private readonly partidos = new Map<string, PartidoVivo>();
  private readonly memorias = new Map<string, MemoriaGrupo>();
  private readonly usoGrupo = new Map<string, number>();
  private readonly salas = new Map<string, Record<string, unknown>>();
  private readonly conectados = new Map<string, Set<string>>();
  private readonly latidos = new Map<string, number>();
  /** "Call players": grupo → a quién se sigue llamando hasta que conecte, y hasta cuándo. */
  private readonly pendientes = new Map<string, { puuids: Set<string>; hasta: number }>();
  /** Cámaras: grupo → (clave del emisor → "Nombre#TAG"). Solo vive mientras el emisor está conectado. */
  private readonly camaras = new Map<string, Map<string, string>>();
  /** Cuándo llegó el último dato de juego de cada jugador (`grupo|puuid`), para depurar en el panel. */
  private readonly ultimoDato = new Map<string, number>();
  /**
   * Lo último que mandó cada jugador conectado de sus datos propios (habilidades), por `grupo|puuid|tipo`. Sirve para
   * que NO se pierda al recrearse su ficha (partida nueva, reinicio del operador): sus programas sólo reenvían lo que
   * cambia, y sin esto el jugador se quedaba «sin dato de vida» hasta que algo cambiara.
   */
  private readonly auxGuardado = new Map<string, Evento>();
  /** Quién estuvo conectado a cada grupo y cuándo (sobrevive a que acabe la partida): a esos se les llama solos en la siguiente. */
  private readonly conocidos = new Map<string, Map<string, number>>();
  /** Paquetes recibidos por jugador y tipo (`grupo|puuid` → tipo → cuenta y último instante). */
  private readonly paquetes = new Map<string, Map<string, { n: number; ultimo: number }>>();
  /** Marcadores que el OBSERVADOR recibió de cada jugador (`grupo|puuid`). */
  private readonly marcadores = new Map<string, { n: number; ultimo: number }>();
  /** Lo que cada exe cuenta de sí mismo en su latido (por puuid). */
  private readonly diagnosticos = new Map<string, { recibido: number; d: DiagnosticoCliente }>();
  /** Los informes completos que mandaron los programas (último de cada jugador). */
  private readonly informes = new Map<string, { recibido: number; bytes: number; conclusiones: ConclusionInforme[] }>();
  /** puuids que la última difusión dio por vivos (para saber cuándo caducan). */
  private readonly vivos = new Set<string>();
  private bucle: NodeJS.Timeout | null = null;
  private readonly limpieza: NodeJS.Timeout;
  private readonly revision: NodeJS.Timeout;
  private readonly insistencia: NodeJS.Timeout;
  private difusion: Difusion | null = null;
  private readonly config: Config;
  private readonly ahora: () => number;

  constructor(config: Config, ahora: () => number = Date.now) {
    this.config = config;
    this.ahora = ahora;
    this.limpieza = setInterval(() => this.limpia(), LIMPIEZA_MS);
    this.limpieza.unref();
    this.revision = setInterval(() => this.revisaPresencias(), REVISION_PRESENCIA_MS);
    this.revision.unref();
    this.insistencia = setInterval(() => this.insiste(), INSISTENCIA_MS);
    this.insistencia.unref();
  }

  conecta(difusion: Difusion): void {
    this.difusion = difusion;
  }

  /* ── Partidos ────────────────────────────────────────────────────────── */

  partido(grupo: string): PartidoVivo | undefined {
    return this.partidos.get(grupo);
  }

  get numeroDePartidos(): number {
    return this.partidos.size;
  }

  /** El primer partido cuyo matchId sea ése. Un matchId vacío no casa con nada. */
  partidoPorMatchId(matchId: string): PartidoVivo | undefined {
    if (matchId === '') return undefined;
    for (const p of this.partidos.values()) if (p.estado.matchId === matchId) return p;
    return undefined;
  }

  /** Crea el partido del grupo. `cabecera` es lo que encabeza la grabación. */
  crea(datos: DatosCreacion, cabecera: Record<string, unknown>, dueno: string): PartidoVivo {
    const grupo = datos.groupCode;
    const estado = creaPartido(datos, this.memorias.get(grupo), { extraProrroga: this.config.extraProrroga });
    let grabadora: Grabadora | null = null;
    if (this.config.grabar) {
      try {
        grabadora = new Grabadora(this.config.carpetaGrabaciones, grupo, cabecera, this.ahora());
      } catch (e) {
        error(`no se pudo abrir la grabación del grupo ${grupo}`, e);
      }
    }
    const vivo: PartidoVivo = {
      grupo,
      estado,
      secreto: nuevoSecreto(),
      dueno,
      version: 1,
      enviada: 0, // así el primer tic ya hace un envío
      ultimoEnvio: this.ahora(),
      grabadora,
    };
    this.partidos.set(grupo, vivo);
    this.usoGrupo.set(grupo, this.ahora());
    this.arrancaBucle();
    this.actualizaCamaras(grupo);
    log(`partido creado para el grupo ${grupo}`);
    return vivo;
  }

  /**
   * Otro observador (autenticado para el grupo) retoma un partido huérfano.
   * El estado SIGUE: antes se destruía y se creaba uno nuevo, y con él se
   * perdían a mitad de mapa los rosters (GEP no los repite), el marcador, el
   * historial, los tiempos muertos y las órdenes del operador (lados e
   * identidad intercambiados), así que los equipos «se cambiaban» al
   * reconectar. Si lo que llega es otra partida, el `match_start` con otro
   * matchId la reinicia (ver `reiniciaParaPartidaNueva`). Devuelve el secreto nuevo.
   */
  retoma(grupo: string, dueno: string): string | undefined {
    const p = this.partidos.get(grupo);
    if (!p) return undefined;
    p.dueno = dueno;
    p.secreto = nuevoSecreto();
    p.version += 1;
    this.usoGrupo.set(grupo, this.ahora());
    log(`partido del grupo ${grupo} retomado por otro observador (el estado se conserva)`);
    return p.secreto;
  }

  /** Destruye el partido: cierra la grabación y echa a observador y jugadores del grupo. */
  destruye(grupo: string, motivo: string): void {
    const p = this.partidos.get(grupo);
    if (!p) return;
    this.partidos.delete(grupo);
    p.grabadora?.cierra();
    this.salas.delete(grupo);
    this.conectados.delete(grupo);
    this.camaras.delete(grupo);
    for (const k of [...this.ultimoDato.keys()]) if (k.startsWith(`${grupo}|`)) this.ultimoDato.delete(k);
    for (const k of [...this.auxGuardado.keys()]) if (k.startsWith(`${grupo}|`)) this.auxGuardado.delete(k);
    for (const k of [...this.paquetes.keys()]) if (k.startsWith(`${grupo}|`)) this.paquetes.delete(k);
    for (const k of [...this.marcadores.keys()]) if (k.startsWith(`${grupo}|`)) this.marcadores.delete(k);
    log(`partido del grupo ${grupo} destruido (${motivo})`);
    this.difusion?.expulsaGrupo(grupo);
    if (this.partidos.size === 0) this.paraBucle();
  }

  /** Graba un paquete en la grabación del partido (antes de procesarlo). */
  graba(grupo: string, paquete: unknown): void {
    this.partidos.get(grupo)?.grabadora?.anota(paquete);
  }

  /** Pasa un evento por el reductor del partido del grupo. */
  procesa(grupo: string, evento: Evento): void {
    const p = this.partidos.get(grupo);
    if (!p) return;
    let r;
    try {
      r = reduce(p.estado, evento);
    } catch (e) {
      error(`paquete ${evento.type} del grupo ${grupo} no se pudo aplicar`, e);
      return;
    }
    this.guardaAux(grupo, evento);
    if (!r.cambiado) return;
    p.estado = r.estado;
    p.version += 1;
    if (evento.type !== 'aux_health' && evento.type !== 'aux_abilities') this.restauraAux(grupo, p);
    // «Switch teams»: la identidad cambiada vale también para el partido
    // siguiente del grupo (el panel ya intercambia la serie a la vez).
    if (evento.type === 'swap_identity') intercambiaEquiposGuardados(this.memorias.get(grupo));
    if (r.finDeMapa) {
      // El estado final SÍ se emite (antes el partido se destruía sin mandarlo).
      this.envia(p);
      this.destruye(grupo, 'fin de mapa');
    }
  }

  private guardaAux(grupo: string, evento: Evento): void {
    if (evento.type !== 'aux_abilities') return;
    const id = (evento as { playerId?: unknown }).playerId;
    if (typeof id === 'string' && id !== '') this.auxGuardado.set(`${grupo}|${id}|${evento.type}`, evento);
  }

  /**
   * Tras cualquier cambio del partido: a cada jugador que sigue conectado mandando sus datos propios y al que se le
   * ha perdido la marca (su ficha se recreó), se le devuelve. Barato: sólo recorre a los conectados y sólo actúa si falta.
   */
  private restauraAux(grupo: string, p: { estado: Partido; version: number }): void {
    const dentro = this.conectados.get(grupo);
    if (!dentro || dentro.size === 0) return;
    for (const puuid of dentro) {
      const r = jugadorPorId(p.estado, puuid);
      if (!r) continue;
      const eventos: Evento[] = [];
      if (!r.jugador.auxiliaryAvailable.health) eventos.push({ type: '@aux_disponible', timestamp: this.ahora(), playerId: puuid });
      const hab = this.auxGuardado.get(`${grupo}|${puuid}|aux_abilities`);
      if (hab && !r.jugador.auxiliaryAvailable.abilities) eventos.push({ ...hab, timestamp: this.ahora() } as Evento);
      for (const e of eventos) {
        try {
          const rr = reduce(p.estado, e);
          if (rr.cambiado) {
            p.estado = rr.estado;
            p.version += 1;
          }
        } catch (err) {
          error(`restaurando los datos propios de ${puuid} en ${grupo}`, err);
        }
      }
    }
  }

  /**
   * Parche del panel. La parte de grupo se guarda siempre; la de partido,
   * si lo hay. Devuelve si había partido.
   */
  configura(grupo: string, parche: Record<string, unknown>): boolean {
    const memoria = this.memorias.get(grupo) ?? memoriaVacia();
    aplicaParcheGrupo(memoria, parche);
    this.memorias.set(grupo, memoria);
    this.usoGrupo.set(grupo, this.ahora());
    if (!this.partidos.has(grupo)) {
      if (parche.playercamsInfo !== undefined) this.difundeCamaras(grupo);
      return false;
    }
    this.procesa(grupo, { type: '@configura', timestamp: this.ahora(), parche });
    if (parche.playercamsInfo !== undefined) this.difundeCamaras(grupo);
    return true;
  }

  /* ── Cámaras ─────────────────────────────────────────────────────────── */

  /** Quién publica cámara en el grupo, en orden estable. */
  publicando(grupo: string): string[] {
    return [...new Set(this.camaras.get(grupo)?.values() ?? [])].sort();
  }

  /** Contraseña de la sala de vídeo del grupo: derivada del secreto, no hay que guardarla. */
  private claveCamaras(grupo: string): string {
    const secreto = this.config.secretoToken ?? 'sin-secreto';
    return createHmac('sha256', secreto).update(`camaras|${grupo}`).digest('base64url').slice(0, 16);
  }

  /** Mete en el partido quién publica y cómo llegar a la web de vídeo. */
  private actualizaCamaras(grupo: string): void {
    const { base, params } = this.config.camaras;
    this.procesa(grupo, {
      type: '@camaras',
      timestamp: this.ahora(),
      publicando: this.publicando(grupo),
      conexion: { base, params, clave: this.claveCamaras(grupo) },
    });
    this.difundeCamaras(grupo);
  }

  /** Lo que necesita un jugador para publicar su cámara. Sin partido, lo guardado en la memoria. */
  camaraConfig(grupo: string): CamaraConfig {
    const t = this.partidos.get(grupo)?.estado.tools.playercamsInfo;
    const m = this.memorias.get(grupo)?.camaras;
    const { base, params } = this.config.camaras;
    return {
      enable: t?.enable ?? m?.enable ?? false,
      room: t?.identifier ?? m?.identifier ?? '',
      base,
      params,
      clave: this.claveCamaras(grupo),
    };
  }

  private difundeCamaras(grupo: string): void {
    this.difusion?.camaras(grupo, this.camaraConfig(grupo));
  }

  /** Un jugador conectado empieza (`nombre`) o deja (`null`) de publicar su cámara. */
  camara(grupo: string, clave: string, nombre: string | null): void {
    let m = this.camaras.get(grupo);
    if (nombre === null) {
      if (!m?.delete(clave)) return;
      if (m.size === 0) this.camaras.delete(grupo);
    } else {
      if (!m) this.camaras.set(grupo, (m = new Map()));
      m.set(clave, nombre);
    }
    this.usoGrupo.set(grupo, this.ahora());
    this.actualizaCamaras(grupo);
  }

  /** Envío completo inmediato (lo pide un `logon` de salida). */
  enviaAhora(grupo: string): void {
    const p = this.partidos.get(grupo);
    if (p) this.envia(p);
  }

  private envia(p: PartidoVivo): void {
    p.enviada = p.version;
    p.ultimoEnvio = this.ahora();
    this.difusion?.estado(p.grupo, serializa(p.estado), serializa(p.estado, true));
  }

  /* ── Bucle de envío y reloj ──────────────────────────────────────────── */

  private arrancaBucle(): void {
    if (this.bucle) return;
    this.bucle = setInterval(() => this.tic(), TIC_MS);
  }

  private paraBucle(): void {
    if (this.bucle) clearInterval(this.bucle);
    this.bucle = null;
  }

  /** Un paso del bucle: reloj de tiempos muertos y rótulos, envíos pendientes, inactividad. */
  tic(): void {
    const ahora = this.ahora();
    const limiteInactividad = this.config.minutosInactividad * 60_000;
    for (const p of [...this.partidos.values()]) {
      this.procesa(p.grupo, { type: '@reloj', timestamp: ahora });
      if (!this.partidos.has(p.grupo)) continue;
      if (p.version > p.enviada) this.envia(p);
      // Sólo caduca el partido ABANDONADO (sin observador). Con el observador conectado, que no lleguen
      // datos es normal (menú, lobby, rango): echarlo lo dejaba sin conexión y sin poder llamar a nadie.
      else if (p.dueno === null && ahora - p.ultimoEnvio > limiteInactividad) this.destruye(p.grupo, 'inactividad');
    }
  }

  /* ── Sala de Riot y presencia ────────────────────────────────────────── */

  guardaSala(grupo: string, sala: Record<string, unknown>): void {
    const antes = this.codigoSala(grupo);
    if (typeof sala.codigo === 'string' && sala.codigo !== antes) log(`sala de ${grupo}: código ${antes || '(ninguno)'} → ${sala.codigo}`);
    this.salas.set(grupo, sala);
    this.podaPendientes(grupo);
    this.difundeSala(grupo);
  }

  /**
   * Ya no hay sala de Riot (el observador salió de la party): se olvida la vieja y se avisa con una sala
   * vacía. Sin esto el servidor seguía repitiendo la sala de antes cada vez que cambiaba la presencia de
   * alguien, y el panel enseñaba jugadores y código que ya no existen.
   */
  limpiaSala(grupo: string): void {
    if (!this.salas.has(grupo)) return;
    log(`sala de ${grupo}: ya no hay sala (código ${this.codigoSala(grupo) || '(ninguno)'} → ninguno)`);
    this.salas.delete(grupo);
    this.podaPendientes(grupo);
    this.difusion?.sala(grupo, {
      codigo: '',
      equipoUno: [],
      equipoDos: [],
      observadores: [],
      coachesUno: [],
      coachesDos: [],
      coaches: [],
      conectados: [],
    });
  }

  /** El código de invitación de la sala de Riot del grupo (lo manda el observador), o `''`. */
  codigoSala(grupo: string): string {
    const codigo = this.salas.get(grupo)?.codigo;
    return typeof codigo === 'string' ? codigo : '';
  }

  /**
   * Lo que se le manda a un jugador al llamarlo: el grupo y, si la sala de Riot
   * ya existe, su código para que el exe se una solo a ella.
   */
  llamada(grupo: string): { groupCode: string; inviteCode?: string } {
    const inviteCode = this.codigoSala(grupo);
    return inviteCode === '' ? { groupCode: grupo } : { groupCode: grupo, inviteCode };
  }

  haySala(grupo: string): boolean {
    return this.salas.has(grupo);
  }

  /** Emite la sala del grupo con la lista `conectados` recalculada. */
  difundeSala(grupo: string): void {
    const sala = this.salas.get(grupo);
    if (!sala) return;
    const conectados: string[] = [];
    const conCliente = this.conectados.get(grupo);
    for (const puuid of puuidsDeSala(sala)) {
      if (conCliente?.has(puuid) || this.presenciaViva(puuid)) conectados.push(puuid);
    }
    this.difusion?.sala(grupo, { ...sala, conectados });
  }

  jugadorConectado(grupo: string, puuid: string): void {
    if (puuid === '') return;
    let s = this.conectados.get(grupo);
    if (!s) this.conectados.set(grupo, (s = new Set()));
    s.add(puuid);
    let c = this.conocidos.get(grupo);
    if (!c) this.conocidos.set(grupo, (c = new Map()));
    c.set(puuid, this.ahora());
    this.podaPendientes(grupo);
    this.difundeSala(grupo);
  }

  jugadorDesconectado(grupo: string, puuid: string): void {
    if (puuid === '') return;
    this.auxGuardado.delete(`${grupo}|${puuid}|aux_abilities`);
    // Primero se le saca de los conectados: si no, la restauración de datos propios le devolvería la marca al instante.
    const estaba = this.conectados.get(grupo)?.delete(puuid) === true;
    this.procesa(grupo, { type: '@jugador_desconectado', timestamp: this.ahora(), playerId: puuid });
    if (estaba) this.difundeSala(grupo);
  }

  /**
   * El operador llama a estos jugadores: se sigue llamando (cada latido de su
   * presencia) hasta que conecten al grupo o pasen `LLAMADA_MS`. Una lista vacía
   * cancela la llamada.
   */
  llamaHasta(grupo: string, puuids: string[]): void {
    const limpios = puuids.filter((p) => p !== '' && !this.atendido(grupo, p));
    if (limpios.length === 0) this.pendientes.delete(grupo);
    else this.pendientes.set(grupo, { puuids: new Set(limpios), hasta: this.ahora() + LLAMADA_MS });
  }

  /**
   * ¿Ya está servido este jugador? Conectado al grupo y, si la sala de Riot ya existe, DENTRO de ella
   * (la lista de la sala la lee el observador). Mientras no lo esté se le sigue llamando.
   */
  private atendido(grupo: string, puuid: string): boolean {
    if (!this.conectados.get(grupo)?.has(puuid)) return false;
    const sala = this.salas.get(grupo);
    return this.codigoSala(grupo) === '' || (sala !== undefined && puuidsDeSala(sala).includes(puuid));
  }

  /** Saca de las llamadas pendientes a quien ya está servido. */
  private podaPendientes(grupo: string): void {
    const p = this.pendientes.get(grupo);
    if (p === undefined) return;
    for (const puuid of [...p.puuids]) if (this.atendido(grupo, puuid)) p.puuids.delete(puuid);
    if (p.puuids.size === 0) this.pendientes.delete(grupo);
  }

  /**
   * Repite el aviso (con el código de sala VIGENTE) a los llamados que tienen el programa abierto pero
   * aún no están dentro de la sala. Así, si el exe del jugador estaba ocupado con otra sala o descartó
   * una llamada, la siguiente sí se atiende; sin tocar nada en el programa del jugador.
   */
  insiste(): void {
    for (const [grupo, p] of [...this.pendientes]) {
      if (p.hasta < this.ahora()) {
        this.pendientes.delete(grupo);
        continue;
      }
      if (!this.partidos.has(grupo)) continue;
      this.podaPendientes(grupo);
      for (const puuid of this.pendientes.get(grupo)?.puuids ?? []) {
        if (this.presenciaViva(puuid)) this.difusion?.llama(puuid, this.llamada(grupo));
      }
    }
  }

  /** ¿A qué grupo hay que mandar a este jugador ahora mismo? (hay partido y aún no está dentro) */
  grupoPendiente(puuid: string): string | undefined {
    for (const [grupo, p] of this.pendientes) {
      if (p.hasta < this.ahora()) {
        this.pendientes.delete(grupo);
        continue;
      }
      if (p.puuids.has(puuid) && this.partidos.has(grupo) && !this.atendido(grupo, puuid)) return grupo;
    }
    return this.grupoDeRegistrado(puuid);
  }

  /**
   * Un jugador REGISTRADO en un equipo del partido entra solo al grupo en cuanto abre su programa, sin que el
   * operador tenga que volver a pulsar «Call players». Es lo que hace que reconectar sea automático: cerró y
   * abrió el programa, salió del juego, se le cayó internet… su programa vuelve a latir y el servidor lo llama.
   * Sólo con partido vivo y si todavía no está dentro. Si no es de ningún equipo, no se le llama.
   */
  private grupoDeRegistrado(puuid: string): string | undefined {
    for (const grupo of this.partidos.keys()) {
      const equipos = this.memorias.get(grupo)?.equipos ?? [];
      const registrado = equipos.some((e) => e?.puuids?.includes(puuid) === true);
      // También los que ya estuvieron en este grupo hace poco (la partida anterior): su programa vuelve a entrar solo.
      const desde = this.conocidos.get(grupo)?.get(puuid);
      const conocido = desde !== undefined && this.ahora() - desde < CONOCIDO_MS;
      if ((registrado || conocido) && !this.atendido(grupo, puuid)) return grupo;
    }
    return undefined;
  }

  /** El operador le manda una orden remota (permitida) al programa de un jugador. */
  ordenJugador(puuid: string, accion: string): boolean {
    return this.difusion?.ordenJugador(puuid, accion) ?? false;
  }

  /** De estos puuids, los que tienen el programa abierto (presencia viva o ya conectados al grupo). */
  activos(grupo: string, puuids: string[]): string[] {
    const dentro = this.conectados.get(grupo);
    return puuids.filter((p) => dentro?.has(p) || this.presenciaViva(p));
  }

  /** Anota que ese jugador acaba de mandar datos de juego. */
  datoDeJugador(grupo: string, puuid: string, tipo = ''): void {
    if (puuid === '') return;
    const clave = `${grupo}|${puuid}`;
    const ahora = this.ahora();
    this.ultimoDato.set(clave, ahora);
    if (tipo === '') return;
    let m = this.paquetes.get(clave);
    if (!m) this.paquetes.set(clave, (m = new Map()));
    const f = m.get(tipo) ?? { n: 0, ultimo: 0 };
    f.n += 1;
    f.ultimo = ahora;
    m.set(tipo, f);
  }

  /** El observador recibió el marcador de este jugador (para ver a quién no le llega). */
  marcadorDe(grupo: string, puuid: string): void {
    if (puuid === '') return;
    const clave = `${grupo}|${puuid}`;
    const f = this.marcadores.get(clave) ?? { n: 0, ultimo: 0 };
    f.n += 1;
    f.ultimo = this.ahora();
    this.marcadores.set(clave, f);
  }

  /**
   * Guarda el informe completo que mandó el programa de un jugador (su «caja negra»): en memoria quién y
   * cuándo, y el contenido en `<carpeta de grabaciones>/informes/<puuid>.json`, para leerlo después sin
   * tener que pedírselo al jugador. Un solo informe por jugador (el último). Devuelve si se guardó.
   */
  guardaInforme(puuid: string, texto: string): boolean {
    if (!/^[0-9a-f-]{8,64}$/i.test(puuid) || texto.length === 0 || texto.length > MAX_INFORME_BYTES) return false;
    try {
      const carpeta = join(this.config.carpetaGrabaciones, 'informes');
      mkdirSync(carpeta, { recursive: true });
      writeFileSync(join(carpeta, `${puuid}.json`), texto);
    } catch (e) {
      error(`no se pudo guardar el informe de ${puuid.slice(0, 8)}…`, e);
      return false;
    }
    this.informes.set(puuid, { recibido: this.ahora(), bytes: Buffer.byteLength(texto), conclusiones: leeConclusiones(texto) });
    log(`informe completo de ${puuid.slice(0, 8)}… recibido (${Math.round(Buffer.byteLength(texto) / 1024)} KB)`);
    return true;
  }

  /** El operador pide el informe completo de un jugador. */
  pideInforme(puuid: string): boolean {
    return this.difusion?.pideInforme(puuid) ?? false;
  }

  /** Lo que el exe cuenta de sí mismo en su latido. Devuelve si era válido. */
  diagnostico(puuid: string, carga: unknown): boolean {
    if (puuid === '') return false;
    const d = leeDiagnostico(carga);
    if (d === null) return false;
    this.diagnosticos.set(puuid, { recibido: this.ahora(), d });
    return true;
  }

  /**
   * Para depurar desde el panel, por jugador: programa abierto, dentro del grupo, ms desde su último
   * dato de juego (`null` si nunca), si su cámara está publicando, el veredicto de lo que el exe cuenta
   * de sí mismo, ese diagnóstico, y los paquetes que han llegado de él (de su exe y del observador).
   */
  estadoJugadores(grupo: string, puuids: string[]): Record<string, EstadoJugador> {
    const dentro = this.conectados.get(grupo);
    const cams = this.camaras.get(grupo);
    const ahora = this.ahora();
    const salida: Record<string, EstadoJugador> = {};
    for (const puuid of puuids) {
      const clave = `${grupo}|${puuid}`;
      const t = this.ultimoDato.get(clave);
      const enGrupo = dentro?.has(puuid) === true;
      const app = enGrupo || this.presenciaViva(puuid);
      const dg = this.diagnosticos.get(puuid);
      // Un diagnóstico más viejo que dos latidos ya no describe al exe de ahora.
      const diag = dg !== undefined && ahora - dg.recibido < 3 * 12_000 ? dg : undefined;
      const paquetes: EstadoJugador['paquetes'] = {};
      for (const [tipo, f] of this.paquetes.get(clave) ?? []) paquetes[tipo] = { n: f.n, haceMs: ahora - f.ultimo };
      const mk = this.marcadores.get(clave);
      salida[puuid] = {
        app,
        dentro: enGrupo,
        datosMs: t === undefined ? null : ahora - t,
        camara: cams?.has(puuid) === true,
        veredicto: veredicto(diag?.d ?? null, app),
        diag: diag === undefined ? null : { ...diag.d, haceMs: ahora - diag.recibido },
        paquetes,
        marcador: mk === undefined ? null : { n: mk.n, haceMs: ahora - mk.ultimo },
        informe: this.informes.has(puuid)
          ? { haceMs: ahora - (this.informes.get(puuid)?.recibido ?? ahora), bytes: this.informes.get(puuid)?.bytes ?? 0, conclusiones: this.informes.get(puuid)?.conclusiones ?? [] }
          : null,
      };
    }
    return salida;
  }

  presenciaViva(puuid: string): boolean {
    const t = this.latidos.get(puuid);
    return t !== undefined && this.ahora() - t < PRESENCIA_VIVA_MS;
  }

  /** Latido de presencia. Si el puuid "revive", se re-emiten las salas que lo contienen. */
  late(puuid: string): void {
    if (puuid === '') return;
    const estabaVivo = this.presenciaViva(puuid);
    this.latidos.set(puuid, this.ahora());
    this.vivos.add(puuid);
    if (!estabaVivo) this.difundeSalasCon(new Set([puuid]));
  }

  /**
   * El socket de presencia de ese puuid se cayó (o cambió de puuid). No se
   * borra en el acto: se deja caducar en `GRACIA_DESCONEXION_MS` por si
   * reconecta enseguida (un corte de red no hace parpadear el "No app").
   */
  presenciaCaida(puuid: string): void {
    const t = this.latidos.get(puuid);
    if (t === undefined) return;
    const caduca = this.ahora() - PRESENCIA_VIVA_MS + GRACIA_DESCONEXION_MS;
    if (t > caduca) this.latidos.set(puuid, caduca);
  }

  /**
   * Revisión periódica: los puuids que estaban vivos y ya no lo están se
   * sacan de `conectados` re-emitiendo sus salas (antes la caducidad sólo se
   * notaba cuando el observador volvía a mandar la sala).
   */
  revisaPresencias(): void {
    const caidos = new Set<string>();
    for (const puuid of this.vivos) {
      if (!this.presenciaViva(puuid)) caidos.add(puuid);
    }
    if (caidos.size === 0) return;
    for (const puuid of caidos) this.vivos.delete(puuid);
    this.difundeSalasCon(caidos);
  }

  private difundeSalasCon(puuids: ReadonlySet<string>): void {
    for (const [grupo, sala] of this.salas) {
      if (puuidsDeSala(sala).some((p) => puuids.has(p))) this.difundeSala(grupo);
    }
  }

  /* ── Limpieza ────────────────────────────────────────────────────────── */

  /** Olvida latidos viejos y grupos que llevan días sin usarse (antes crecían sin límite). */
  private limpia(): void {
    const ahora = this.ahora();
    for (const [puuid, t] of this.latidos) {
      if (ahora - t > OLVIDO_LATIDO_MS) {
        this.latidos.delete(puuid);
        this.vivos.delete(puuid);
      }
    }
    for (const [grupo, t] of this.usoGrupo) {
      if (this.partidos.has(grupo)) {
        this.usoGrupo.set(grupo, ahora);
      } else if (ahora - t > OLVIDO_GRUPO_MS) {
        this.usoGrupo.delete(grupo);
        this.memorias.delete(grupo);
      }
    }
  }

  cierra(): void {
    for (const grupo of [...this.partidos.keys()]) this.destruye(grupo, 'apagado');
    this.paraBucle();
    clearInterval(this.limpieza);
    clearInterval(this.revision);
    clearInterval(this.insistencia);
  }
}

function intercambiaEquiposGuardados(m: MemoriaGrupo | undefined): void {
  if (m) m.equipos = [m.equipos[1], m.equipos[0]];
}

/** Los puuids de las listas de la sala, en orden y con repeticiones. */
function puuidsDeSala(sala: Record<string, unknown>): string[] {
  const salida: string[] = [];
  for (const lista of ['equipoUno', 'equipoDos', 'observadores', 'coaches']) {
    const v = sala[lista];
    if (!Array.isArray(v)) continue;
    for (const j of v) {
      const puuid = (j as { puuid?: unknown } | null)?.puuid;
      if (typeof puuid === 'string') salida.push(puuid);
    }
  }
  return salida;
}
