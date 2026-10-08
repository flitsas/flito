// Siigo — quién puede cada acción de facturación electrónica (HU #11342, Feature #11244).
//
// Las rutas no deciden: piden `exigirAccionSiigo('<accion>')` y se acabó. Desde la HU #13423 (Épica
// #13411, ADR-0023) quien decide es el MOTOR de permisos: cada acción es una función
// `siigo.factura.<accion>` sembrada por la migración 0230 a los roles de la fila que tenía en la vieja
// tabla de roles por acción de shared-types (consultar → admin, auditor, financiera; las siete de operación → admin y
// financiera). Esa tabla ya no existe: cambiar quién emite es repartir `siigo.factura.emitir` desde
// el panel de roles, sin tocar código. El nombre del rol solo queda en el texto de la bitácora.
//
// Lo que se conserva de la #11342: el registro del intento denegado en la bitácora WORM de Siigo
// (además del de `permisos_intentos_denegados`, que pone `tieneFuncion`) y el texto del 403, que
// distingue «acción de operación» de «sin acceso».
//
// ALCANCE. Esto cubre las acciones de OPERACIÓN sobre facturas. La parametrización (mapeo de
// conceptos, configuración de emisión, credenciales, compuerta) tiene sus propias guardas
// (`siigo.parametrizacion.*`, `siigo.emision.ver`, `siigo.conceptos.confirmar`).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ACCIONES_SIIGO, ACCION_DE_LECTURA,
  esAccionDeOperacion, esAccionSiigo,
  type AccionSiigo,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';

/**
 * Catálogo de acciones. Están TODAS declaradas, incluidas aquellas cuyo flujo lo implementa otra
 * Feature: `emitir`, `corregir` y `anular` no tienen ruta todavía y aun así figuran aquí con su rol.
 * Cuando esa ruta aparezca solo tendrá que consultar la tabla, y mientras tanto la decisión sobre
 * quién puede corregir o anular queda tomada y visible en un solo archivo —lo que además aísla la
 * pregunta 8 del diseño (nota crédito frente a anulación), que también sigue abierta: cambie lo que
 * cambie la respuesta, cambia el flujo, no el sitio donde se decide el permiso—.
 */
// El catálogo vive en `@operaciones/shared-types` desde la HU #11337, porque tiene DOS
// consumidores: este servidor, que decide el 403, y la pantalla, que decide si pinta el botón.
// Mientras estuvo solo aquí, la interfaz reimplementaba la regla y eran dos definiciones de lo
// mismo que coincidían por costumbre. Se reexporta para que todo lo que ya lo importaba de este
// archivo siga funcionando sin tocar un solo router.
export {
  ACCIONES_SIIGO, ACCION_DE_LECTURA,
  esAccionDeOperacion, esAccionSiigo,
  type AccionSiigo,
};

/**
 * La decisión del motor para cada acción. Un `switch` con el código LITERAL en cada rama, y no un
 * `\`siigo.factura.${accion}\``: el lector de guardas (`inventario-guardas.ts`) solo acepta literales
 * y así cada función queda montada y en la foto (`inventario.generado.ts`, guardas en línea).
 * Una acción no declarada no llega aquí (el tipo lo impide); si llegara, se niega.
 */
async function puedeAccion(req: Request, accion: AccionSiigo): Promise<boolean> {
  switch (accion) {
    case 'consultar': return tieneFuncion(req, 'siigo.factura.consultar');
    case 'emitir': return tieneFuncion(req, 'siigo.factura.emitir');
    case 'reintentar': return tieneFuncion(req, 'siigo.factura.reintentar');
    case 'reenviar_correo': return tieneFuncion(req, 'siigo.factura.reenviar_correo');
    case 'marcar_fallido': return tieneFuncion(req, 'siigo.factura.marcar_fallido');
    case 'reactivar': return tieneFuncion(req, 'siigo.factura.reactivar');
    case 'corregir': return tieneFuncion(req, 'siigo.factura.corregir');
    case 'anular': return tieneFuncion(req, 'siigo.factura.anular');
    default: return false;
  }
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
    mensaje: `Rol «${req.user?.role ?? 'sin-rol'}» intentó la acción «${accion}» sin la función siigo.factura.${accion}.`,
    createdBy: req.user?.sub ?? null,
  });
}

/**
 * Guarda HTTP de una acción. Se monta DESPUÉS de `authMiddleware`.
 *
 * La evaluación ocurre entera en el servidor, con la identidad verificada (`sub`) contra el motor de
 * permisos: un cliente que llame al endpoint saltándose la interfaz recibe el mismo 403.
 *
 * El intento rechazado se registra ANTES de responder pero sin bloquear la respuesta a que la
 * escritura termine bien: quien es rechazado no debe esperar a la bitácora.
 */
export function exigirAccionSiigo(accion: AccionSiigo): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Token requerido' });
      return;
    }
    if (!(await puedeAccion(req, accion))) {
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
