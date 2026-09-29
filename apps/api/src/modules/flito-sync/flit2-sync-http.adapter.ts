// FLITO sync — adaptador HTTP del feed incremental de FLIT 2 (HU #13091, Feature #13059).
// Contrato: `docs/integraciones/flit2-api.md` v3.1 §3 (`GET /api/v1/external/tramites/sync`) y §4.
//
// - La base URL sale de `FLIT2_BASE_URL` (repo público: ningún host aquí). Sin ella → `no_configurado`.
// - La llamada va por `conPase` (RN-04 del pase: ante un 401 renueva el pase UNA vez).
// - `cursor` XOR `since`: nunca los dos (el contrato responde 400 `cursor_and_since_exclusive`).
// - Un sobre ≠ 200 o ilegible → `Flit2RespuestaError` con el estado y el código RFC 7807; el cuerpo de
//   FLIT 2 nunca se reenvía ni se loguea. La URL (lleva el cursor) tampoco va al log.
// - Cada ítem pasa por Zod: uno que no cumple el contrato se cuenta en `invalidos` y se salta, en vez
//   de envenenar la página entera.

import { z } from 'zod';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { motorYSerieParaVehiculo } from '../runt/vehiculo-motor-serie.js';
import { MAX_DATOS_VEHICULO } from './flit-http.adapter.js';
import { obtenerPase, conPase } from './flit2-pase.service.js';
import { Flit2Error, Flit2NoConfiguradoError, Flit2NoRespondeError, Flit2RespuestaError } from './flit2.errors.js';
import { rawSinPii } from './flit2-mapeo.js';
import type { CompradorFlit2, Flit2SyncPort, ItemFlit2, PaginaFlit2, PosicionLectura, VehiculoFlit2 } from './flit2-sync.port.js';

const log = loggerFor('flito-sync-flit2');

const RUTA_SYNC = '/api/v1/external/tramites/sync';
const TIMEOUT_MS = 30_000;
/** Ancho de las columnas de `vehicles` que no cubre `MAX_DATOS_VEHICULO`. */
const MAX_VEHICULO = { vin: 17, placa: 10, marca: 50, linea: 50 } as const;

const texto = z.string().nullish();
const compradorSchema = z.object({
  ordinal: z.number().int().nullish(),
  porcentajeParticipacion: z.number().nullish(),
  rolActor: texto,
  tipoPersona: texto,
  tipoDocumento: texto,
  numeroDocumento: texto,
  nombreCompleto: texto,
  direccion: texto,
  ciudad: texto,
  celular: texto,
  correo: texto,
}).passthrough();

const itemSchema = z.object({
  id: z.string().uuid(),
  radicado: z.string().trim().min(1).max(60),
  syncVersion: z.number().int().nonnegative().safe(),
  eliminado: z.boolean().default(false),
  estado: texto,
  tramite: z.object({ familia: texto }).passthrough().nullish(),
  fechaCreacion: texto,
  fechaAprobacion: texto,
  vehiculo: z.object({
    vin: texto,
    placa: texto,
    marca: texto,
    linea: texto,
    carroceria: texto,
    cilindraje: z.number().nullish(),
    cilindrajeTexto: texto,
    numeroMotor: texto,
    numeroSerie: texto,
    tipoServicio: z.object({ codigo: texto, nombre: texto }).passthrough().nullish(),
  }).passthrough().nullish(),
  organismo: z.object({ codigoSecretaria: texto, ciudad: texto, nombre: texto }).passthrough().nullish(),
  compradores: z.array(compradorSchema).nullish(),
  factura: z.object({ adjuntoId: texto }).passthrough().nullish(),
  companiaGestora: z.object({ nit: texto }).passthrough().nullish(),
}).passthrough();

const sobreSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().min(1).max(2000),
  hasMore: z.boolean(),
}).passthrough();

const s = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** `s()` + tope: lo que no cabe se descarta a null (misma regla que FLIT 1: truncar cambia el dato). */
function acotado(v: string | null | undefined, max: number, idFlit2: string, campo: string): string | null {
  const valor = s(v);
  if (valor === null || valor.length <= max) return valor;
  log.warn({ idFlit2, campo, longitud: valor.length, max }, 'valor de FLIT 2 más largo que su columna: se descarta');
  return null;
}

function aVehiculo(v: z.infer<typeof itemSchema>['vehiculo'], idFlit2: string): VehiculoFlit2 | null {
  const vin = acotado(v?.vin, MAX_VEHICULO.vin, idFlit2, 'vin');
  if (!v || !vin) return null;
  const ms = motorYSerieParaVehiculo({ numMotor: s(v.numeroMotor), numSerie: s(v.numeroSerie) }, log);
  const cilindraje = typeof v.cilindraje === 'number' && Number.isFinite(v.cilindraje)
    ? acotado(String(v.cilindraje), MAX_DATOS_VEHICULO.cilindraje, idFlit2, 'cilindraje')
    : acotado(v.cilindrajeTexto, MAX_DATOS_VEHICULO.cilindraje, idFlit2, 'cilindraje');
  return {
    vin,
    placa: acotado(v.placa, MAX_VEHICULO.placa, idFlit2, 'placa'),
    marca: acotado(v.marca, MAX_VEHICULO.marca, idFlit2, 'marca'),
    linea: acotado(v.linea, MAX_VEHICULO.linea, idFlit2, 'linea'),
    cilindraje,
    carroceria: acotado(v.carroceria, MAX_DATOS_VEHICULO.carroceria, idFlit2, 'carroceria'),
    tipoServicio: acotado(v.tipoServicio?.nombre, MAX_DATOS_VEHICULO.tipoServicio, idFlit2, 'tipoServicio'),
    numMotor: ms.numMotor ?? null,
    numSerie: ms.numSerie ?? null,
  };
}

function aComprador(c: z.infer<typeof compradorSchema>, i: number): CompradorFlit2 {
  return {
    ordinal: c.ordinal ?? i + 1,
    porcentajeParticipacion: c.porcentajeParticipacion ?? null,
    rolActor: c.rolActor ?? 'comprador',
    tipoPersona: c.tipoPersona ?? null,
    tipoDocumento: c.tipoDocumento ?? null,
    numeroDocumento: c.numeroDocumento ?? null,
    nombreCompleto: c.nombreCompleto ?? null,
    direccion: c.direccion ?? null,
    ciudad: c.ciudad ?? null,
    celular: c.celular ?? null,
    correo: c.correo ?? null,
  };
}

/** Ítem crudo → `ItemFlit2`, o null si no cumple el contrato (se cuenta como inválido). */
export function aItemFlit2(crudo: unknown): ItemFlit2 | null {
  const p = itemSchema.safeParse(crudo);
  if (!p.success) return null;
  const it = p.data;
  const org = it.organismo;
  return {
    idFlit2: it.id.toLowerCase(),
    radicado: it.radicado,
    syncVersion: it.syncVersion,
    eliminado: it.eliminado,
    estado: it.estado ?? '',
    familia: it.tramite?.familia ?? null,
    fechaCreacion: it.fechaCreacion ?? null,
    fechaAprobacion: it.fechaAprobacion ?? null,
    vehiculo: aVehiculo(it.vehiculo, it.id),
    organismo: org ? { codigoSecretaria: s(org.codigoSecretaria), ciudad: s(org.ciudad), nombre: s(org.nombre) } : null,
    companiaNit: s(it.companiaGestora?.nit),
    facturaAdjuntoId: s(it.factura?.adjuntoId),
    compradores: (it.compradores ?? []).map(aComprador),
    raw: rawSinPii(crudo as Record<string, unknown>),
  };
}

/** Código RFC 7807 de FLIT 2, solo si tiene forma de código (mismo criterio que el pase). */
async function codigoDeProblema(res: Response): Promise<string | null> {
  try {
    const cuerpo = await res.json() as Record<string, unknown>;
    for (const campo of ['code', 'error', 'type', 'title']) {
      const valor = cuerpo?.[campo];
      if (typeof valor !== 'string') continue;
      const codigo = valor.split('/').pop() ?? '';
      if (/^[a-z_]{1,40}$/.test(codigo)) return codigo;
    }
  } catch { /* cuerpo vacío o no JSON: manda el estado HTTP */ }
  return null;
}

/**
 * `Retry-After` en segundos enteros (el contrato v3.1 lo manda así) o como fecha HTTP; null si falta o
 * no se entiende. Exportada para el test. Quien la usa decide el valor por defecto (HU #13092, AC4).
 */
export function segundosRetryAfter(cabecera: string | null, ahora: Date = new Date()): number | null {
  if (!cabecera || !cabecera.trim()) return null;
  const n = Number(cabecera.trim());
  const segundos = Number.isFinite(n) ? n : Math.ceil((Date.parse(cabecera) - ahora.getTime()) / 1000);
  return Number.isFinite(segundos) && segundos >= 0 ? Math.ceil(segundos) : null;
}

/** URL de la página: `cursor` XOR `since`. Exportada para el test. */
export function urlDePagina(base: string, pos: PosicionLectura, pageSize: number): URL {
  const url = new URL(RUTA_SYNC, base);
  if ('cursor' in pos) url.searchParams.set('cursor', pos.cursor);
  else url.searchParams.set('since', pos.since.toISOString());
  url.searchParams.set('pageSize', String(pageSize));
  return url;
}

export function crearFlit2SyncHttp(): Flit2SyncPort {
  const base = (): string => {
    if (!env.FLIT2_BASE_URL) throw new Flit2NoConfiguradoError();
    return env.FLIT2_BASE_URL;
  };

  return {
    async verificarAcceso() {
      base();
      await obtenerPase();
    },

    async leerPagina(pos, pageSize): Promise<PaginaFlit2> {
      const url = urlDePagina(base(), pos, pageSize);
      let res: Response;
      try {
        res = await conPase((pase) => fetch(url, {
          headers: { Authorization: pase.authorization.unwrap(), Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }));
      } catch (e) {
        // Sin acceso, rechazado, bloqueado…: los lanza el pase y se propagan tal cual.
        if (e instanceof Flit2Error) throw e;
        // Solo el nombre del fallo: el mensaje podría arrastrar la URL con el cursor.
        log.warn({ causa: e instanceof Error ? e.name : typeof e }, 'FLIT 2 no respondió a la lectura de trámites');
        throw new Flit2NoRespondeError();
      }

      if (res.status !== 200) {
        const codigo = await codigoDeProblema(res);
        const reintentarEnS = res.status === 429 ? segundosRetryAfter(res.headers.get('retry-after')) : null;
        log.warn({ status: res.status, codigo, reintentarEnS }, 'FLIT 2 rechazó la lectura de trámites');
        throw new Flit2RespuestaError(res.status, codigo, reintentarEnS);
      }

      let cuerpo: unknown;
      try {
        cuerpo = await res.json();
      } catch {
        log.warn('FLIT 2 respondió 200 a la lectura con un cuerpo que no es JSON');
        throw new Flit2RespuestaError(200, null);
      }
      const sobre = sobreSchema.safeParse(cuerpo);
      if (!sobre.success) {
        log.warn('FLIT 2 respondió 200 a la lectura con un sobre que no cumple el contrato');
        throw new Flit2RespuestaError(200, null);
      }

      const items: ItemFlit2[] = [];
      let invalidos = 0;
      for (const crudo of sobre.data.items) {
        const item = aItemFlit2(crudo);
        if (item) items.push(item);
        else invalidos += 1;
      }
      if (invalidos > 0) log.warn({ invalidos }, 'ítems de FLIT 2 que no cumplen el contrato: se saltan');
      return { items, invalidos, nextCursor: sobre.data.nextCursor, hasMore: sobre.data.hasMore };
    },
  };
}
