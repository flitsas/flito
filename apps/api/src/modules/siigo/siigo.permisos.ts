// Siigo — quién puede cada acción de facturación electrónica (HU #11342, Feature #11244).
//
// ESTE ES EL ÚNICO SITIO donde se decide qué rol puede emitir, reintentar, corregir o anular una
// factura. Las rutas no deciden: piden `exigirAccionSiigo('<accion>')` y se acabó. Cambiar la
// respuesta —hoy abierta— es editar `ROLES_POR_ACCION` y su prueba, sin abrir un solo router.
//
// POR QUÉ EXISTE ASÍ. La pregunta «¿quién emite: financiera, admin o ambos?» (pregunta 16 del
// diseño de la Feature) sigue sin cerrarse. Repartir la respuesta en `requireRole(...)` dentro de
// cada ruta la habría enterrado en N sitios que hay que encontrar y cambiar a la vez. Aquí se
// implementa el valor CONSERVADOR de hoy y se deja el cambio a una línea.
//
// EL VALOR CONSERVADOR NO ES UN INVENTO: es la separación que el repo ya aplica en
// `finanzas.routes.ts` (`requireRole('financiera','admin','auditor')` para leer) y en
// `flito-liquidacion.routes.ts` (`ESCRITURA = admin + financiera`, `LECTURA = + auditor`). Se
// hereda, no se reinventa: el dinero de FLITO ya se opera así.
//
// ALCANCE. Esta tabla cubre las acciones de OPERACIÓN sobre facturas. NO cubre la parametrización
// (mapeo de conceptos, configuración de emisión, credenciales, compuerta), que son otro trabajo,
// otra pantalla (`siigo_parametrizacion`) y ya tienen sus propias guardas. No unificar las dos
// cosas: parametrizar se hace una vez, operar se hace todos los días.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';

/**
 * Catálogo de acciones. Están TODAS declaradas, incluidas aquellas cuyo flujo lo implementa otra
 * Feature: `emitir`, `corregir` y `anular` no tienen ruta todavía y aun así figuran aquí con su rol.
 * Cuando esa ruta aparezca solo tendrá que consultar la tabla, y mientras tanto la decisión sobre
 * quién puede corregir o anular queda tomada y visible en un solo archivo —lo que además aísla la
 * pregunta 8 del diseño (nota crédito frente a anulación), que también sigue abierta: cambie lo que
 * cambie la respuesta, cambia el flujo, no el sitio donde se decide el permiso—.
 */
export const ACCIONES_SIIGO = [
  // Lectura: bandeja, línea de tiempo y estado de una factura.
  'consultar',
  // Operación: mueven una factura o su relación con la DIAN.
  'emitir',
  'reintentar',
  'reenviar_correo',
  'marcar_fallido',
  'reactivar',
  'corregir',
  'anular',
] as const;

export type AccionSiigo = (typeof ACCIONES_SIIGO)[number];

/**
 * Lectura para auditoría también. Ver la bandeja, la línea de tiempo o el estado de una factura es
 * justamente lo que hace un revisor fiscal; negárselo no protege nada y le obliga a pedir capturas.
 */
const LECTURA: readonly UserRole[] = ['admin', 'financiera', 'auditor'];

/**
 * Escritura sin auditoría. `auditor` mira y no toca: es la misma línea que ya trazan
 * `flito-liquidacion.routes.ts` y `finanzas.routes.ts`.
 */
const OPERACION: readonly UserRole[] = ['admin', 'financiera'];

/**
 * LA TABLA. Una fila por acción; cambiar quién puede algo es cambiar su fila.
 *
 * `Record<AccionSiigo, …>` y no un objeto suelto a propósito: si mañana se agrega una acción a
 * `ACCIONES_SIIGO` y se olvida asignarle roles, el compilador lo para. Una acción sin fila no puede
 * existir por descuido.
 */
export const ROLES_POR_ACCION: Record<AccionSiigo, readonly UserRole[]> = {
  consultar: LECTURA,
  emitir: OPERACION,
  reintentar: OPERACION,
  reenviar_correo: OPERACION,
  marcar_fallido: OPERACION,
  reactivar: OPERACION,
  corregir: OPERACION,
  anular: OPERACION,
};

/** Única acción de lectura. El resto modifica algo y por eso se le niega a `auditor`. */
export const ACCION_DE_LECTURA: AccionSiigo = 'consultar';

export function esAccionSiigo(valor: string): valor is AccionSiigo {
  return (ACCIONES_SIIGO as readonly string[]).includes(valor);
}

/**
 * Roles que pueden una acción. Una acción NO declarada devuelve lista vacía, es decir, se niega a
 * todo el mundo. Negar por defecto y no permitir por defecto es lo que hace que declarar de más
 * (acciones sin ruta) sea seguro y declarar de menos (una ruta con un nombre mal escrito) sea un
 * 403 evidente en vez de una puerta abierta.
 */
export function rolesDe(accion: string): readonly UserRole[] {
  return esAccionSiigo(accion) ? ROLES_POR_ACCION[accion] : [];
}

/** ¿Este rol puede esta acción? Sin rol (petición sin autenticar) nunca puede nada. */
export function puedeEjecutar(role: string | null | undefined, accion: string): boolean {
  if (!role) return false;
  return (rolesDe(accion) as readonly string[]).includes(role);
}

/** Acción que modifica algo. `consultar` no lo es; una acción desconocida tampoco (no existe). */
export function esAccionDeOperacion(accion: string): boolean {
  return esAccionSiigo(accion) && accion !== ACCION_DE_LECTURA;
}

/**
 * El texto del 403. Distingue los dos casos porque el usuario hace cosas distintas con cada uno:
 * ante «es una acción de operación» sabe que su acceso de lectura está bien y que debe pedirla a
 * quien opera; ante una acción desconocida lo que hay es un error de la aplicación que llama.
 */
export function motivoDenegacion(accion: string): string {
  if (esAccionDeOperacion(accion)) {
    return 'Esta es una acción de operación de facturación electrónica y su rol es de consulta. '
      + 'Puede ver la factura y su historial, pero no ejecutarla.';
  }
  if (esAccionSiigo(accion)) {
    return 'Su rol no tiene acceso a la facturación electrónica.';
  }
  return 'Acción de facturación electrónica no reconocida.';
}

/** `ruta` es varchar(300) y la query string puede traer datos del cliente: se corta y se descarta. */
function rutaDe(req: Request): string {
  return (req.originalUrl || req.url || '').split('?')[0]!.slice(0, 300);
}

/**
 * Deja constancia en la bitácora WORM de la HU #11251. Se registra el id numérico del usuario y su
 * ROL, nunca su correo ni ningún dato personal: esa tabla prohíbe UPDATE y DELETE por disparador,
 * así que un dato personal escrito por error ya no se podría rectificar ni suprimir (Ley 1581,
 * art. 8). El id ya está en `created_by`, que es una llave foránea a `users`.
 *
 * Nunca lanza —`registrarOperacion` se traga sus errores— para que un problema de bitácora no
 * convierta un 403 correcto en un 500.
 */
async function registrarIntentoDenegado(req: Request, accion: string): Promise<void> {
  await registrarOperacion({
    operacion: 'permiso_denegado',
    metodo: req.method,
    ruta: rutaDe(req),
    entidadTipo: 'accion',
    entidadId: accion.slice(0, 60),
    ambiente: env.SIIGO_AMBIENTE,
    modo: env.SIIGO_MODE,
    statusHttp: 403,
    // Es un rechazo por permisos, no una avería: `error_negocio` es lo que ya usa el resto del
    // módulo para «la operación no procede», y así el tablero de fallos técnicos no se ensucia.
    resultado: 'error_negocio',
    codigo: 'PERMISO_DENEGADO',
    mensaje: `Rol «${req.user?.role ?? 'sin-rol'}» intentó la acción «${accion}» sin permiso.`,
    createdBy: req.user?.sub ?? null,
  });
}

/**
 * Guarda HTTP de una acción. Se monta DESPUÉS de `authMiddleware`.
 *
 * La evaluación ocurre entera en el servidor y a partir del rol del JWT verificado: un cliente que
 * llame al endpoint saltándose la interfaz recibe el mismo 403, porque aquí no se lee nada que el
 * navegador pueda decidir.
 *
 * El intento rechazado se registra ANTES de responder pero sin bloquear la respuesta a que la
 * escritura termine bien: quien es rechazado no debe esperar a la bitácora.
 */
export function exigirAccionSiigo(accion: AccionSiigo): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Token requerido' });
      return;
    }
    if (!puedeEjecutar(req.user.role, accion)) {
      // El `.catch` es cinturón sobre tirantes: `registrarOperacion` ya se traga sus errores, pero
      // si algún día dejara de hacerlo, una promesa rechazada y sin dueño es un `unhandledRejection`
      // que en Node ≥ 15 tumba el proceso entero. Un 403 no puede poder tumbar la API.
      void registrarIntentoDenegado(req, accion).catch(() => undefined);
      res.status(403).json({ error: motivoDenegacion(accion), accion });
      return;
    }
    next();
  };
}

/** Lo que una ruta añade sobre la atribución: qué entidad tocó y cómo le fue. */
export interface AtribucionAccion {
  entidadTipo?: string | null;
  entidadId?: string | null;
  resultado?: 'ok' | 'error_negocio' | 'error_tecnico' | 'timeout';
  statusHttp?: number | null;
  codigo?: string | null;
  mensaje?: string | null;
  duracionMs?: number | null;
}

/**
 * Atribución de una acción ejecutada: quién la hizo queda en `created_by`.
 *
 * Lo llaman las rutas de operación cuando existan. Está aquí y no en cada ruta para que la acción
 * que se registra sea la MISMA que se verificó —el nombre viene del mismo catálogo— y no una
 * cadena suelta que un día se escriba distinto y rompa la trazabilidad.
 */
export async function registrarAccionSiigo(
  req: Request,
  accion: AccionSiigo,
  extra: AtribucionAccion = {},
): Promise<void> {
  await registrarOperacion({
    operacion: accion.slice(0, 40),
    metodo: req.method,
    ruta: rutaDe(req),
    entidadTipo: extra.entidadTipo ?? null,
    entidadId: extra.entidadId ?? null,
    ambiente: env.SIIGO_AMBIENTE,
    modo: env.SIIGO_MODE,
    statusHttp: extra.statusHttp ?? null,
    resultado: extra.resultado ?? 'ok',
    codigo: extra.codigo ?? null,
    mensaje: extra.mensaje ?? null,
    duracionMs: extra.duracionMs ?? null,
    createdBy: req.user?.sub ?? null,
  });
}
