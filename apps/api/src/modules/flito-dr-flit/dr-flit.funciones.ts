// FLITO — Dr. Flit: las guardas de sus cuatro funciones (HU #13941, decisión de David del 2026-10-24).
//
// Dr. Flit está disponible para cualquier usuario: no excluye por tipo de usuario ni por enlace. Lo que cada
// quien puede hacer en él lo dice el permiso «Dr. Flit» (`pagina.flito_dr_flit`, General) con cuatro acciones,
// cada una con la operación que exige su ruta (`arbol/acciones-dr-flit.ts`):
//   · `drflit.manuales.ver`      — la IA solo responde con manuales (sonda en `dr-flit-ia.contexto.ts`, AC5).
//   · `drflit.ia.usar`           — POST /chat y GET/POST /autorizacion con `finalidad=ia`.
//   · `drflit.soporte.radicar`   — POST /casos-soporte y GET/POST /autorizacion con `finalidad=soporte`.
//   · `drflit.gestion.consultar` — los POST /buscar de trámites, SOAT, impuestos y derechos, ANTES de su
//                                  `<m>.cola.ver` (la frontera de datos sigue siendo la de su módulo).
//
// RN-DRF-F1  Cada guarda pide su código con `tieneFuncion(req, '<literal>')` (lo lee `inventario-guardas.ts`;
//            una variable no se puede inventariar), que registra el intento en `permisos_intentos_denegados`.
// RN-DRF-F2  Sin la función: 403 `{ error, codigo: 'drflit-funcion-no-habilitada', funcion }` (AC4). Sin
//            mensajes del motor ni nombres de rol: la web pinta el copy por `funcion`.
// RN-DRF-F3  Falla cerrado: si el motor de permisos falla, `tieneFuncion` responde `false` (o lanza y sigue
//            al errorHandler); nunca se deja pasar.
import type { NextFunction, Request, Response } from 'express';
import {
  FUNCIONES_DRFLIT, type ErrorFuncionNoHabilitadaDrFlit, type FinalidadDrFlit, type FuncionDrFlit,
} from '@operaciones/shared-types';
import { tieneFuncion } from '../../shared/middleware/exigir-funcion.js';

const MENSAJE: Readonly<Record<FuncionDrFlit, string>> = Object.freeze({
  [FUNCIONES_DRFLIT.verManuales]: 'Su rol no tiene habilitada la consulta de manuales en Dr. Flit.',
  [FUNCIONES_DRFLIT.usarIa]: 'Su rol no tiene habilitada la IA de Dr. Flit.',
  [FUNCIONES_DRFLIT.consultarGestion]: 'Su rol no tiene habilitada la consulta de gestión en Dr. Flit.',
  [FUNCIONES_DRFLIT.radicarSoporte]: 'Su rol no tiene habilitado radicar casos de soporte en Dr. Flit.',
});

/** 403 de AC4. */
export function responderFuncionNoHabilitada(res: Response, funcion: FuncionDrFlit): void {
  const cuerpo: ErrorFuncionNoHabilitadaDrFlit = { error: MENSAJE[funcion], codigo: 'drflit-funcion-no-habilitada', funcion };
  res.status(403).json(cuerpo);
}

/** La guarda: `tiene` decide (y registra el denegado); sin ella, 403 drflit. */
function guarda(funcion: FuncionDrFlit, tiene: (req: Request) => Promise<boolean>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await tiene(req)) { next(); return; }
      responderFuncionNoHabilitada(res, funcion);
    } catch (e) {
      next(e);
    }
  };
}

// Un literal por función (y uno solo por código: el inventario cuenta un montaje por `tieneFuncion`).
const tieneIa = (req: Request): Promise<boolean> => tieneFuncion(req, 'drflit.ia.usar');
const tieneSoporte = (req: Request): Promise<boolean> => tieneFuncion(req, 'drflit.soporte.radicar');
const tieneConsultaGestion = (req: Request): Promise<boolean> => tieneFuncion(req, 'drflit.gestion.consultar');

/** POST /chat. */
export const exigirIaDrFlit = guarda(FUNCIONES_DRFLIT.usarIa, tieneIa);

/** POST /casos-soporte. Va ANTES del limiter y de multer (RN-DRF-R7: no se parsea el cuerpo de quien no puede). */
export const exigirSoporteDrFlit = guarda(FUNCIONES_DRFLIT.radicarSoporte, tieneSoporte);

/** Los POST /buscar que consulta Dr. Flit: va PRIMERO, antes de `<m>.cola.ver`. */
export const exigirConsultaGestionDrFlit = guarda(FUNCIONES_DRFLIT.consultarGestion, tieneConsultaGestion);

/** La función que pide la autorización de cada finalidad. */
export const FUNCION_DE_FINALIDAD: Readonly<Record<FinalidadDrFlit, FuncionDrFlit>> = Object.freeze({
  ia: FUNCIONES_DRFLIT.usarIa,
  soporte: FUNCIONES_DRFLIT.radicarSoporte,
});

/** GET/POST /autorizacion: la función de la finalidad pedida, con la misma guarda de su ruta (RN-DRF-F1). */
export async function tieneFuncionDrFlitPorFinalidad(req: Request, finalidad: FinalidadDrFlit): Promise<boolean> {
  switch (finalidad) {
    case 'ia': return tieneIa(req);
    case 'soporte': return tieneSoporte(req);
  }
}
