// FLITO — sincronización (HTTP). Trigger MANUAL de la sincronización FLIT (Operaciones elige la fecha
// inicial; la final es hoy). Integración de solo lectura. Ver docs/integracion/integracionFlit.md.
//
// HU #13237 (interruptor por fuente, `flito-sync-interruptor.service.ts`):
//   - POST /sincronizar con FLIT 1 apagada → 409 `{ codigo: 'FUENTE_APAGADA', fuente: 'flit1' }` ANTES de
//     todo lo demás: no consulta FLIT 1, no escribe y no mueve la última sincronización (AC5).
//   - GET /estado añade `habilitada` y `motivoDeshabilitada` (AC9; FLIT 1 no tiene maestro).
//   - GET/PUT /interruptores viven en `flito-sync-interruptores.routes.ts`, montado al final.
//
// HU #13629 (decisión P-2): POST /sincronizar toma el MISMO candado que la lectura automática de FLIT 1
// (`[13_629, 1]`). Si está tomado → 409 `{ codigo: 'LECTURA_EN_CURSO' }` sin llamar a FLIT 1: una manual y
// una automática sobre el mismo radicado competirían (23505 → «falló» espurio en la Bitácora). El 500 ya no
// devuelve el mensaje del error (el cuerpo de FLIT 1 podía traer PII): devuelve un código técnico.
// La manual NO mueve `ultima_buena_en` (su rango es arbitrario).

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { loggerFor } from '../../shared/logger.js';
import type { SyncEstadoFlit1 } from '@operaciones/shared-types';
import { sincronizar, leerUltimaSincronizacion, guardarUltimaSincronizacion, hayTramites } from './flito-sync.service.js';
import { estadoHabilitacionFlit1, FuenteApagadaError, fuenteHabilitada } from './flito-sync-interruptor.service.js';
import interruptoresRouter from './flito-sync-interruptores.routes.js';
import { codigoFalloFlit1, conCandadoLecturaFlit1 } from './flit1-lectura-automatica.service.js';

const log = loggerFor('flito-sync-routes');
const router = Router();
router.use(authMiddleware);

/** Normaliza 'YYYY-MM-DD' o 'YYYYMMDD' a 'YYYYMMDD'; null si no es válida. */
function aYyyymmdd(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const soloDigitos = v.slice(0, 10).replace(/-/g, '');
  return /^\d{8}$/.test(soloDigitos) ? soloDigitos : null;
}
function hoyYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Estado de sincronización: para mostrar "última actualización" y decidir si es la primera vez.
router.get('/estado', exigirFuncion('sync.sync.ver_estado'), async (_req: Request, res: Response) => {
  const [ultimaSincronizacion, tramites, habilitacion] = await Promise.all([
    leerUltimaSincronizacion(), hayTramites(), estadoHabilitacionFlit1(),
  ]);
  const cuerpo: SyncEstadoFlit1 = { ultimaSincronizacion, hayTramites: tramites, ...habilitacion };
  res.json(cuerpo);
});

// Dispara una sincronización. initialDate: si viene en el body se respeta (modo manual); si no, se usa
// la fecha del último sync (incremental). La primera vez (sin fecha previa) exige elegir fecha. finalDate
// = hoy. Solo admin. Al terminar, persiste la fecha/hora del sync como "última actualización".
router.post('/sincronizar', exigirFuncion('sync.sync.lanzar'), async (req: Request, res: Response) => {
  // Un fallo de base al leer el interruptor responde 500 (Express 4 no captura el async): nunca se
  // toma como «encendido» ni deja la petición colgada (nota de security-agent, HU #13237).
  const habilitada = await fuenteHabilitada('flit1').catch((err: unknown) => {
    log.error({ err: (err as Error).message }, 'no se pudo leer el interruptor de FLIT 1');
    return null;
  });
  if (habilitada === null) { res.status(500).json({ error: 'No se pudo verificar si la sincronización con FLIT 1 está encendida' }); return; }
  if (!habilitada) {
    const e = new FuenteApagadaError('flit1');
    res.status(e.status).json({ error: e.message, codigo: e.codigo, fuente: e.fuente });
    return;
  }
  const manual = aYyyymmdd(req.body?.initialDate);
  const ultima = await leerUltimaSincronizacion();
  const initialDate = manual ?? (ultima ? aYyyymmdd(ultima) : null);
  if (!initialDate) { res.status(400).json({ error: 'La primera sincronización requiere una fecha inicial (YYYY-MM-DD).' }); return; }
  const finalDate = hoyYyyymmdd();
  try {
    const candado = await conCandadoLecturaFlit1(async () => {
      const resultado = await sincronizar({ initialDate, finalDate });
      const at = new Date().toISOString();
      await guardarUltimaSincronizacion(at);
      await audit(req, {
        action: 'update', resource: 'flito_sincronizacion',
        detail: `Sync ${manual ? 'manual' : 'incremental'} [${initialDate}→${finalDate}]: ${resultado.tramitesLeidos} leídos, ${resultado.tramitesNuevos} nuevos, ${resultado.tramitesActualizados} con cambios, ${resultado.tramitesSinCambios} sin cambios, ${resultado.companiasFaltantes} sin empresa, ${resultado.organismosSinEmparejar} sin secretaría`,
      });
      return { ...resultado, ultimaSincronizacion: at };
    });
    if (!candado.tomado) {
      res.status(409).json({ error: 'Ya hay una lectura de FLIT 1 en curso. Intenta de nuevo en unos minutos.', codigo: 'LECTURA_EN_CURSO' });
      return;
    }
    res.json(candado.valor);
  } catch (error) {
    // HU #13629 (D8): solo el código técnico, nunca `error.message` (podía traer el cuerpo de FLIT 1).
    const codigo = codigoFalloFlit1(error);
    log.error({ codigo }, 'sincronización manual falló');
    res.status(500).json({ error: 'La sincronización falló', codigo });
  }
});

// HU #13237: interruptor por fuente — ver la cabecera de `flito-sync-interruptores.routes.ts`.
router.use(interruptoresRouter);

export default router;
