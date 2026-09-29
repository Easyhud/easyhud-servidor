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

import { randomInt } from 'node:crypto';
import { Grabadora } from './grabacion.ts';
import { log, error } from './log.ts';
import { creaPartido } from './partida/creacion.ts';
import { aplicaParcheGrupo, memoriaVacia } from './partida/configuracion.ts';
import { reduce } from './partida/reductor.ts';
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
const OLVIDO_LATIDO_MS = 10 * 60_000;

export interface Difusion {
  /** `match_data` a todos los consumidores del grupo. */
  estado(grupo: string, json: string): void;
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
  /** puuids que la última difusión dio por vivos (para saber cuándo caducan). */
  private readonly vivos = new Set<string>();
  private bucle: NodeJS.Timeout | null = null;
  private readonly limpieza: NodeJS.Timeout;
  private readonly revision: NodeJS.Timeout;
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
    log(`partido creado para el grupo ${grupo}`);
    return vivo;
  }

  /** Destruye el partido: cierra la grabación y echa a observador y jugadores del grupo. */
  destruye(grupo: string, motivo: string): void {
    const p = this.partidos.get(grupo);
    if (!p) return;
    this.partidos.delete(grupo);
    p.grabadora?.cierra();
    this.salas.delete(grupo);
    this.conectados.delete(grupo);
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
    if (!r.cambiado) return;
    p.estado = r.estado;
    p.version += 1;
    if (r.finDeMapa) {
      // El estado final SÍ se emite (antes el partido se destruía sin mandarlo).
      this.envia(p);
      this.destruye(grupo, 'fin de mapa');
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
    if (!this.partidos.has(grupo)) return false;
    this.procesa(grupo, { type: '@configura', timestamp: this.ahora(), parche });
    return true;
  }

  /** Envío completo inmediato (lo pide un `logon` de salida). */
  enviaAhora(grupo: string): void {
    const p = this.partidos.get(grupo);
    if (p) this.envia(p);
  }

  private envia(p: PartidoVivo): void {
    p.enviada = p.version;
    p.ultimoEnvio = this.ahora();
    this.difusion?.estado(p.grupo, serializa(p.estado));
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
      else if (ahora - p.ultimoEnvio > limiteInactividad) this.destruye(p.grupo, 'inactividad');
    }
  }

  /* ── Sala de Riot y presencia ────────────────────────────────────────── */

  guardaSala(grupo: string, sala: Record<string, unknown>): void {
    this.salas.set(grupo, sala);
    this.difundeSala(grupo);
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
    this.difundeSala(grupo);
  }

  jugadorDesconectado(grupo: string, puuid: string): void {
    if (puuid === '') return;
    this.procesa(grupo, { type: '@jugador_desconectado', timestamp: this.ahora(), playerId: puuid });
    if (this.conectados.get(grupo)?.delete(puuid)) this.difundeSala(grupo);
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
  }
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
