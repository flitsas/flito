// HU #12171 / ADR-0014 — El escritor del historial de cambios de usuarios, roles y permisos (CF-19).
//
// Vive en `shared/historial/` y no en un módulo por el mismo motivo que `estado-historial.ts`: lo
// escriben tres (`users/`, `permisos/` y el seed de la #12086), y colgarlo de cualquiera de ellos
// crearía una dependencia entre módulos hermanos.
//
// ── Convive con `permisos-intentos-denegados.ts` y es su OPUESTO deliberado ─────────────────────
//
// Que se parezcan por fuera —dos bitácoras de permisos, dos ficheros vecinos— no significa que
// compartan criterio. Esta tabla lo fija para que nadie los «unifique»:
//
//   | | intentos-denegados (bitácora de 403)          | permisos-auditoria (esta)                    |
//   |---|-----------------------------------------------|----------------------------------------------|
//   | Qué es      | señal operativa, un contador          | evidencia: el antes y el después de un acto  |
//   | Cuándo      | FUERA de toda transacción, sin await  | DENTRO de la transacción del cambio, await   |
//   | Si falla    | log.warn y sigue (un 403 no es 500)   | LANZA: el cambio no se confirma              |
//   | Ejecutor    | `db` directo                          | `Ejecutor` recibido (`tx`, o `db` en un seed) |
//   | Bandera env | PERMISOS_SKIP_BITACORA_INTENTOS       | NINGUNA                                      |
//   | PII         | sin columna de texto libre            | lista blanca de campo + ValorAuditable + CHECK |
//
// ── Sin datos personales del titular, por construcción (RN-A10, AC4) ────────────────────────────
//
// Del TITULAR solo entran su id y su rol (`usuarioAfectado: { id, rol }`). No hay parámetro que
// acepte un objeto libre: `ValorAuditable` no incluye `Record<string, unknown>`, así que la fila
// entera del usuario —con su correo y su hash— no compila como «estado anterior». Del ACTOR se guarda
// el correo: es el autor del acto y así funciona una bitácora.
//
// ── Sin try/catch, a propósito ──────────────────────────────────────────────────────────────────
//
// `audit()` se traga sus errores porque una auditoría caída no debe tumbar la petición. Aquí el
// criterio es el contrario y es el mismo de `estado-historial.ts`: si el historial no se puede
// escribir, el cambio tampoco debe confirmarse. Una fila que falta en silencio es justo el agujero
// que esta HU viene a tapar.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type {
  AccionAuditable, CampoAuditable, EntidadAuditable, ValorAuditable,
} from '@operaciones/shared-types';
import type { db } from '../../db/client.js';
import { permisosAuditoria } from '../../db/schema.js';

/** Cualquier cosa con `.insert()`: la conexión o una transacción abierta. */
export type Ejecutor = Pick<typeof db, 'insert'>;

export interface ActorAuditoria {
  /** null ⇒ `origen: 'sistema'` (seed, migración, cron). No es «se desconoce». */
  userId: number | null;
  /** El correo del AUTOR. RN-A10 lo autoriza expresamente; el del titular nunca entra aquí. */
  email: string | null;
  rol: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CambioAuditable {
  entidad: EntidadAuditable;
  accion: AccionAuditable;
  /** null solo si `accion === 'borrar'`. */
  campo: CampoAuditable | null;
  valorAntes: ValorAuditable | null;
  valorDespues: ValorAuditable | null;
  /** El titular cuando la entidad es un usuario: su id interno y su rol EN EL MOMENTO. Nada más. */
  usuarioAfectado?: { id: number; rol: string };
  /** El rol cuando la entidad es un rol o su cuadro de funciones. */
  rolAfectadoCodigo?: string;
  motivo?: string | null;
}

/** El actor tal como se copia en cada fila. Recorta a los anchos de las columnas. */
function columnasDelActor(actor: ActorAuditoria) {
  return {
    actorUserId: actor.userId,
    actorEmail: actor.email?.slice(0, 150) ?? null,
    actorRol: actor.rol?.slice(0, 40) ?? null,
    ipAddress: actor.ip?.slice(0, 45) ?? null,
    userAgent: actor.userAgent?.slice(0, 500) ?? null,
    origen: actor.userId === null ? 'sistema' : 'usuario',
  };
}

/**
 * Escribe N filas con un mismo `lote_id`. Un lote es UN acto administrativo: un PATCH que toca tres
 * campos son tres filas y un lote, y es lo que permite que la pantalla muestre un cambio y no tres.
 *
 * Recibe el ejecutor para participar de la transacción que YA hizo el cambio: el historial y el
 * cambio entran o se quedan fuera juntos. Con la lista vacía no escribe nada (y no viaja a la base).
 */
export async function registrarCambiosPermisos(
  ex: Ejecutor, actor: ActorAuditoria, cambios: CambioAuditable[],
): Promise<void> {
  if (cambios.length === 0) return;
  const loteId = randomUUID();
  const comun = columnasDelActor(actor);
  await ex.insert(permisosAuditoria).values(cambios.map((c) => ({
    loteId,
    entidad: c.entidad,
    accion: c.accion,
    campo: c.campo,
    valorAntes: c.valorAntes,
    valorDespues: c.valorDespues,
    usuarioAfectadoId: c.usuarioAfectado?.id ?? null,
    usuarioAfectadoRol: c.usuarioAfectado?.rol.slice(0, 40) ?? null,
    rolAfectadoCodigo: c.rolAfectadoCodigo ?? null,
    motivo: c.motivo ?? null,
    ...comun,
  })));
}

/** Azúcar para el caso de un solo campo. */
export async function registrarCambioPermisos(
  ex: Ejecutor, actor: ActorAuditoria, cambio: CambioAuditable,
): Promise<void> {
  await registrarCambiosPermisos(ex, actor, [cambio]);
}

/**
 * El par antes/después de un CONJUNTO (páginas, organismos, funciones): el conjunto completo en cada
 * lado y, en el «después», qué entró y qué salió. Se calcula AL ESCRIBIR, no al leer: la pantalla no
 * tiene que volver a restar dos listas. Orden estable por código: el orden de llegada no es un cambio.
 */
export function diffConjunto(antes: string[], despues: string[]): {
  antes: ValorAuditable; despues: ValorAuditable;
} {
  const a = new Set(antes);
  const d = new Set(despues);
  return {
    antes: { conjunto: [...a].sort() },
    despues: {
      conjunto: [...d].sort(),
      concedidas: [...d].filter((x) => !a.has(x)).sort(),
      revocadas: [...a].filter((x) => !d.has(x)).sort(),
    },
  };
}

/** ¿Los dos arrays son el mismo conjunto? El orden no es un cambio. */
export function mismoConjunto(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((v) => s.has(v));
}

/**
 * El actor a partir de la petición autenticada. Es un HELPER de las rutas, no parte de la firma del
 * escritor: `registrarCambiosPermisos` recibe el actor como dato para que un cron o un seed puedan
 * escribir con `userId: null` (origen 'sistema') sin fabricarse un `Request`. Mismo criterio de IP
 * que `audit()`: el primer salto de `x-forwarded-for`, si lo hay.
 */
export function actorDeRequest(req: Request): ActorAuditoria {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.ip || null;
  return {
    userId: req.user?.sub ?? null,
    email: req.user?.username ?? null,
    rol: req.user?.role ?? null,
    ip,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}
