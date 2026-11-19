// Contrato `ia-consumo` v1, regla 7 (ADR-0047) — contexto de negocio de las llamadas a IA.
//
// El código que llama abre el ámbito con `conContextoIa({ ... }, fn)`; el cliente HTTP lo lee con
// `leerContextoIa()`. Es anidable: el ámbito interior hereda del exterior y pisa solo lo que declara.
// El `correlacionId` (misma operación de negocio: reintentos, Haiku → Sonnet) nace en el primer ámbito
// que declara un `proceso` y lo heredan los interiores. Sin ámbito, el registro sale con
// `modulo = proceso = 'desconocido'`: nunca falla por falta de contexto.
//
// Usuario y tenant los pone `authMiddleware` con `ejecutarConUsuarioIa` (`req.user.sub`, `username`,
// `transitoCodigo`). Ninguna función de aquí lanza ni toca la BD.
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { EventEmitter } from 'node:events';
import type { OrigenIa, TipoTareaIa } from './catalogo.js';
import { uuidv7 } from './uuid7.js';

export interface ArchivoIa {
  mime?: string | null;
  bytes?: number | null;
  paginas?: number | null;
  sha256?: string | null;
}

export interface ContextoIa {
  modulo?: string;
  proceso?: string;
  tipoTarea?: TipoTareaIa;
  origen?: OrigenIa;
  placa?: string | null;
  entidadTipo?: string | null;
  entidadId?: string | number | null;
  promptCodigo?: string | null;
  promptVersion?: string | null;
  /** 1 = primera pasada; 2 = segunda pasada (Haiku → Sonnet) o failover. */
  pasada?: number;
  archivo?: ArchivoIa;
  usuarioId?: string | null;
  usuarioLogin?: string | null;
  tenantId?: string | null;
  correlacionId?: string;
  metadatos?: Record<string, unknown>;
}

const almacen = new AsyncLocalStorage<ContextoIa>();

/** Placa del contrato: MAYÚSCULAS, sin espacios ni guiones (ni nada que no sea letra o dígito). */
export function normalizarPlacaIa(placa: string | null | undefined): string | null {
  if (!placa) return null;
  const p = String(placa).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return p.length > 0 && p.length <= 10 ? p : null;
}

function sinIndefinidos(c: ContextoIa): ContextoIa {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (v !== undefined) out[k] = v;
  return out as ContextoIa;
}

/** Ejecuta `fn` dentro de un ámbito de IA que hereda del actual. Devuelve lo que devuelva `fn`. */
export function conContextoIa<T>(parcial: ContextoIa, fn: () => T): T {
  const padre = almacen.getStore() ?? {};
  const propio = sinIndefinidos(parcial);
  const nuevo: ContextoIa = {
    ...padre,
    ...propio,
    archivo: propio.archivo ? { ...padre.archivo, ...propio.archivo } : padre.archivo,
    metadatos: propio.metadatos ? { ...padre.metadatos, ...propio.metadatos } : padre.metadatos,
  };
  if ('placa' in propio) nuevo.placa = normalizarPlacaIa(propio.placa);
  if (!nuevo.correlacionId && propio.proceso) nuevo.correlacionId = uuidv7();
  return almacen.run(nuevo, fn);
}

/** El ámbito vigente (copia superficial) o `{}`. */
export function leerContextoIa(): ContextoIa {
  return { ...(almacen.getStore() ?? {}) };
}

interface UsuarioDePeticion {
  user?: { sub: number; username?: string; transitoCodigo?: string };
}

/**
 * Abre el ámbito con el usuario de la petición y ejecuta `fn` (lo llama `authMiddleware` al terminar
 * de autenticar). Además ata los eventos del `req` a este ámbito: `multer` entrega el `next()` desde el
 * evento `finish` del parser, que nace en el contexto del socket y no en este; sin atarlos, el handler
 * que sigue al upload perdería el usuario (mismo truco que `bindEmitter` de cls-hooked).
 */
export function ejecutarConUsuarioIa<T>(req: UsuarioDePeticion & Partial<EventEmitter>, fn: () => T): T {
  const u = req.user;
  return conContextoIa({
    usuarioId: u ? String(u.sub) : null,
    usuarioLogin: u?.username ?? null,
    tenantId: u?.transitoCodigo ?? null,
  }, () => {
    try {
      if (typeof req.emit === 'function') {
        const original = req.emit;
        req.emit = AsyncResource.bind(original as (...a: unknown[]) => boolean, 'IaConsumoReq', req) as typeof req.emit;
      }
    } catch { /* atar eventos es una mejora; nunca rompe la petición */ }
    return fn();
  });
}
