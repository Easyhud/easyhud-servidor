/**
 * Diagnóstico de los programas de jugador.
 *
 * Cada exe de jugador cuenta al servidor, en su latido de presencia, cómo está por dentro: si Overwolf
 * (GEP) está listo, si ve el juego, si le llegan eventos, si su conexión de datos está abierta, qué
 * paquetes ha mandado y qué errores tiene. El panel lo enseña por jugador, para ver QUÉ falla antes de
 * empezar y no a media transmisión.
 *
 * Es información que viene de un cliente: se valida y se acota todo (tamaños, tipos, número de
 * claves). Un exe antiguo no manda nada de esto y simplemente sale como «sin diagnóstico».
 */

export type EstadoGep = 'esperando' | 'listo' | 'caido' | 'sin-api';
export type EstadoDatos = 'cerrada' | 'conectando' | 'conectada';

export interface DiagnosticoCliente {
  /** Versión del programa. */
  version: string;
  /** Estado del paquete GEP de Overwolf. */
  gep: EstadoGep;
  gepVersion: string;
  /** VALORANT está abierto en el PC (proceso), lo vea GEP o no. */
  juegoAbierto: boolean;
  /** GEP detectó VALORANT en esta sesión. */
  juegoDetectado: boolean;
  /** Milisegundos desde el último evento de GEP; `null` = ninguno desde que arrancó. */
  eventosHace: number | null;
  /** El programa se considera espectador (no manda vida ni habilidades). */
  espectador: boolean;
  /** Otros programas que compiten por el mismo GEP (se reparten los datos del juego). */
  conflictos: string[];
  /** Las claves que GEP dice tener del juego ahora (`getInfo`). */
  infoClaves: string[];
  /** Datos de GEP recibidos por clave (para ver qué entrega Overwolf). */
  claves: Record<string, number>;
  /** La conexión de datos con la partida. */
  datos: EstadoDatos;
  /** Último motivo de fallo de red visto por el cliente (vacío = sin fallos). */
  red: string;
  /** Si el cliente de Riot local respondió y qué dijo la última vez que intentó unirse a la sala. */
  riot: string;
  camara: { permitida: boolean; publicando: boolean; error: string };
  /** Cuántos paquetes de cada tipo ha mandado desde que arrancó. */
  enviados: Record<string, number>;
  /** Últimos errores (los más recientes al final). */
  errores: string[];
}

const GEP: readonly EstadoGep[] = ['esperando', 'listo', 'caido', 'sin-api'];
const DATOS: readonly EstadoDatos[] = ['cerrada', 'conectando', 'conectada'];

const MAX_TEXTO = 160;
const MAX_ERRORES = 6;
const MAX_TIPOS = 24;

const texto = (v: unknown, max = MAX_TEXTO): string => (typeof v === 'string' ? v.slice(0, max) : '');
const logico = (v: unknown): boolean => v === true;

/** Valida y acota lo que manda un cliente. `null` si no es utilizable. */
export function leeDiagnostico(carga: unknown): DiagnosticoCliente | null {
  if (typeof carga !== 'object' || carga === null || Array.isArray(carga)) return null;
  const c = carga as Record<string, unknown>;

  const gep = GEP.find((g) => g === c.gep);
  const datos = DATOS.find((d) => d === c.datos);
  if (gep === undefined || datos === undefined) return null;

  const eventos = typeof c.eventosHace === 'number' && Number.isFinite(c.eventosHace) && c.eventosHace >= 0 ? Math.round(c.eventosHace) : null;

  const enviados: Record<string, number> = {};
  if (typeof c.enviados === 'object' && c.enviados !== null && !Array.isArray(c.enviados)) {
    for (const [tipo, n] of Object.entries(c.enviados as Record<string, unknown>).slice(0, MAX_TIPOS)) {
      if (/^[a-z_0-9]{1,40}$/.test(tipo) && typeof n === 'number' && Number.isFinite(n) && n >= 0) enviados[tipo] = Math.round(n);
    }
  }

  const claves: Record<string, number> = {};
  if (typeof c.claves === 'object' && c.claves !== null && !Array.isArray(c.claves)) {
    for (const [k, n] of Object.entries(c.claves as Record<string, unknown>).slice(0, 30)) {
      if (/^[a-z_0-9]{1,40}$/.test(k) && typeof n === 'number' && Number.isFinite(n) && n >= 0) claves[k] = Math.round(n);
    }
  }

  const cam = typeof c.camara === 'object' && c.camara !== null ? (c.camara as Record<string, unknown>) : {};
  const errores = Array.isArray(c.errores) ? c.errores.filter((e): e is string => typeof e === 'string').slice(-MAX_ERRORES).map((e) => e.slice(0, MAX_TEXTO)) : [];

  return {
    version: texto(c.version, 24),
    gep,
    gepVersion: texto(c.gepVersion, 24),
    juegoAbierto: logico(c.juegoAbierto),
    juegoDetectado: logico(c.juegoDetectado),
    eventosHace: eventos,
    espectador: logico(c.espectador),
    infoClaves: Array.isArray(c.infoClaves) ? c.infoClaves.filter((x): x is string => typeof x === 'string' && /^[a-z_0-9]{1,40}$/.test(x)).slice(0, 40) : [],
    conflictos: Array.isArray(c.conflictos) ? c.conflictos.filter((x): x is string => typeof x === 'string').slice(0, 6).map((x) => x.slice(0, 80)) : [],
    claves,
    datos,
    red: texto(c.red),
    riot: texto(c.riot),
    camara: { permitida: logico(cam.permitida), publicando: logico(cam.publicando), error: texto(cam.error) },
    enviados,
    errores,
  };
}

/** Un solo veredicto por jugador, para la insignia del panel. */
export type Veredicto =
  | 'ok' // todo en orden: eventos de GEP llegando
  | 'sin-programa' // no hay latido
  | 'sin-diagnostico' // exe antiguo: abierto, pero no cuenta cómo está
  | 'gep-esperando' // Overwolf aún no está listo
  | 'gep-caido' // el paquete de Overwolf falló
  | 'sin-juego' // VALORANT no está abierto
  | 'juego-no-detectado' // VALORANT abierto pero GEP no lo ve
  | 'sin-eventos' // GEP lo ve pero no llegan eventos
  | 'espectador' // el programa se cree espectador: no manda vida ni habilidades
  | 'conflicto'; // otro programa usa Overwolf a la vez y se reparten los datos

/** Pasado este tiempo sin eventos de GEP se da por parado (en el menú pueden pasar minutos sin eventos: por eso es tan largo; dentro de la partida lo vigilan DATA/NO DATA). */
export const EVENTOS_VIVOS_MS = 600_000;

export function veredicto(d: DiagnosticoCliente | null, hayLatido: boolean): Veredicto {
  if (!hayLatido) return 'sin-programa';
  if (d === null) return 'sin-diagnostico';
  if (d.gep === 'caido' || d.gep === 'sin-api') return 'gep-caido';
  if (d.gep === 'esperando') return 'gep-esperando';
  if (!d.juegoAbierto && !d.juegoDetectado) return 'sin-juego';
  if (d.juegoAbierto && !d.juegoDetectado) return 'juego-no-detectado';
  if (d.eventosHace === null || d.eventosHace > EVENTOS_VIVOS_MS) return 'sin-eventos';
  if (d.conflictos.length > 0) return 'conflicto';
  if (d.espectador) return 'espectador';
  return 'ok';
}
