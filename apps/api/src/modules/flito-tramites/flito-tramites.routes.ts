// FLITO Trámites unificado (HTTP). Porta packages/server/src/tramites/tramites.controlador.ts. Montado
// en /api/flito/tramites (coexiste con /api/tramites del grande). Los gestores NO entran: cada uno sigue
// en su propia cola (/soat, /impuestos); esta es la vista de quien despacha. Lectura Operaciones/Auditoría.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { esAlertaOperativa, TipoSoporteZip } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { soportesDeTramite } from '../../shared/soportes/soportes-consulta.js';
import {
  comprobarTopeRegistrosZip, emitirZipSoportes, registrarAccesoZipTramites, resolverEntradasZip,
  ZipError, zipSoportesLimiter,
} from '../../shared/soportes/soportes-zip.js';
import {
  desbloquear, revocar, ExcepcionError, MOTIVO_MINIMO,
} from '../flito-excepciones/flito-excepciones.service.js';
import {
  crearEmpresaDesdeTramite, crearTramiteDemo, entregar, esOrdenListado, facetas, historial, listar,
  registrosZipTramites, solicitarAmbos, solicitarImpuestos, solicitarSoat,
  type FiltrosListado, type TramitesCtx,
} from './flito-tramites.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin');
const LECTURA = requireRole('admin', 'auditor');

function ctxDe(user: { sub: number; username: string; role: string }): TramitesCtx {
  return { userId: user.sub, username: user.username, role: user.role };
}

const loteSchema = z.object({ tramiteIds: z.array(z.string().uuid()).min(1) });
const soatSchema = loteSchema.extend({ proveedorSoatId: z.string().uuid() });

function bad(res: Response): void { res.status(400).json({ error: 'Datos inválidos' }); }

// GET / — tabla unificada, PAGINADA y filtrada en servidor.
// Query: buscar, estado, tipoTramite, transito, ciudad, compania, soat=a,b, impuesto=c,d, page, pageSize.
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
/** Fecha de calendario, o nada. Un texto suelto en un `::date` es un 500 que se puede evitar. */
const fecha = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

router.get('/', LECTURA, async (req: Request, res: Response) => {
  const q = req.query;
  const filtros: FiltrosListado = {
    buscar: str(q.buscar), estados: lista(q.estados), transitos: lista(q.transitos), ciudades: lista(q.ciudades),
    empresas: lista(q.empresas), soat: lista(q.soat), impuesto: lista(q.impuesto),
    autogestion: q.autogestion === 'si' || q.autogestion === 'no' ? q.autogestion : undefined,
    // Un orden desconocido no es motivo para fallar: se ignora y manda el default.
    orden: esOrdenListado(q.orden) ? q.orden : undefined,
    // Igual que el orden: una alerta desconocida se ignora en vez de tumbar la petición.
    alerta: esAlertaOperativa(q.alerta) ? q.alerta : undefined,
    // Solo se aceptan como 'yyyy-mm-dd': lo demás se ignora en vez de llegar a un cast de Postgres.
    creadoDesde: fecha(q.creadoDesde), creadoHasta: fecha(q.creadoHasta),
    aprobadoDesde: fecha(q.aprobadoDesde), aprobadoHasta: fecha(q.aprobadoHasta),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
  res.json(await listar(filtros));
});

// GET /facetas — valores distintos para los dropdowns de filtro.
router.get('/facetas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await facetas());
});

// GET /:id/historial — auditoría de cambios del trámite (campo por campo). Operaciones/Auditoría.
router.get('/:id/historial', LECTURA, async (req: Request, res: Response) => {
  res.json(await historial(req.params.id));
});

/**
 * GET /:id/soportes — los documentos del trámite: SOAT, impuesto, derecho de tránsito y logística.
 *
 * Quien despacha desde esta pantalla es quien tiene que comprobar que el papel existe antes de
 * entregar, y hasta ahora la única forma de verlo era irse al reporte de costos —que solo alcanza
 * el rol financiera— o a la tabla de derechos. Es la misma lista que sirve finanzas; lo único
 * propio de aquí es el rol que entra.
 */
router.get('/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const soportes = await soportesDeTramite(req.params.id);
  if (!soportes) { res.status(404).json({ error: 'El trámite no existe' }); return; }
  // Sin caché: un soporte cargado hace un minuto tiene que salir sin recargar la pantalla.
  res.set('Cache-Control', 'no-store');
  res.json(soportes);
});

/**
 * POST /soportes/zip — el ZIP MIXTO de los trámites marcados (HU #11910, AC4).
 *
 * Los tres tipos a la vez y en un solo archivo: la factura de venta de FLIT, el recibo del organismo
 * y el comprobante del SOAT. Es la superficie que da sentido al desempate del AC5 — factura + recibo
 * + comprobante del MISMO trámite se llaman los tres `PLACA-ORGANISMO`, así que el `-3` es el caso
 * normal aquí, no el borde.
 *
 * ── El rol es `OPERACIONES`, y **no `LECTURA`** ─────────────────────────────────────────────────
 *
 * `LECTURA` de este router es `admin` + `auditor`, y el AC7 dice que auditoría **no descarga**.
 * Reusar la constante de al lado —que es lo que pide el cuerpo, porque las demás lecturas la usan—
 * le abriría a auditoría una descarga masiva de documentos con datos del titular, y el error se
 * leería como una coherencia. El mutante `OPERACIONES → LECTURA` tiene su test.
 *
 * ── Por qué esta ruta existe aparte y no es la de SOAT parametrizada ────────────────────────────
 *
 * Los ids son de OTRO espacio (`flito_tramites.id`, no `flito_soat.id`), el predicado de frontera es
 * otro (aquí no hay ninguno: quien despacha ve el parque entero, y lo que acota es el rol) y el
 * catálogo de tipos es otro. Un endpoint único obligaría a un `requireRole` con la unión de los tres
 * roles y a mover la comprobación al cuerpo del handler, que es donde se olvida.
 */
const zipSoportesSchema = z.object({
  // Sin `.max()`: el tope se comprueba con `comprobarTopeRegistrosZip`, que responde con
  // `codigo` propio. Un `.max()` aquí daría un 400 de Zod indistinguible de un cuerpo roto.
  ids: z.array(z.string().uuid()).min(1),
  tipos: z.array(z.enum([
    TipoSoporteZip.FACTURA_VENTA, TipoSoporteZip.RECIBO_IMPUESTO, TipoSoporteZip.FACTURA_SOAT,
  ])).min(1).max(3),
}).strict();

router.post('/soportes/zip', OPERACIONES, zipSoportesLimiter, async (req: Request, res: Response) => {
  const parsed = zipSoportesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  try {
    comprobarTopeRegistrosZip(parsed.data.ids);
    const registros = await registrosZipTramites(parsed.data.ids);
    const entradas = await resolverEntradasZip(registros, parsed.data.tipos);

    // Antes del primer byte. Este router no tenía módulo de PII propio; ver la nota de
    // `registrarAccesoZipTramites` sobre por qué no se le hace pasar por los de las otras dos colas.
    await registrarAccesoZipTramites(req, entradas.length);
    await audit(req, {
      action: 'export', resource: 'flito_tramite',
      detail: `Descarga zip de soportes (${parsed.data.tipos.join(', ')}): ${entradas.length} documento(s)`,
    });

    await emitirZipSoportes(res, entradas);
  } catch (e) {
    // Con la respuesta ya empezada no se puede responder: se relanza al manejador global.
    if (res.headersSent) throw e;
    // UN solo `instanceof` para los tres desenlaces del ZIP: con uno por clase, añadir un código
    // nuevo y olvidarse en una de las tres rutas lo devuelve a la rama genérica —sin `codigo`— y
    // la pantalla enseña «avisa a soporte». Ya pasó con el tope de registros.
    if (e instanceof ZipError) {
      res.status(e.status).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

// POST /crear-empresa — crea la empresa (cliente) de un trámite con empresa inexistente y re-vincula
// por NIT los trámites pendientes. Solo Operaciones.
const crearEmpresaSchema = z.object({
  nombre: z.string().trim().min(1), nit: z.string().trim().min(1),
  soatAutogestionable: z.boolean().optional(), impuestosAutogestionable: z.boolean().optional(),
  logisticaAutogestionable: z.boolean().optional(),
});
router.post('/crear-empresa', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = crearEmpresaSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const d = parsed.data;
  const r = await crearEmpresaDesdeTramite(d.nombre, d.nit, {
    soat: d.soatAutogestionable ?? false, impuestos: d.impuestosAutogestionable ?? false, logistica: d.logisticaAutogestionable ?? false,
  }, ctxDe(req.user!));
  await audit(req, { action: 'create', resource: 'flito_tramite', detail: `Empresa ${parsed.data.nit} ${r.yaExistia ? 'reutilizada' : 'creada'}; ${r.revinculados} trámites re-vinculados` });
  res.json(r);
});

// POST /demo — crea un trámite DEMO aprobado (vehículo + trámite + comprador) para probar Logística
// sin depender del sync de FLIT. Solo Operaciones.
const demoSchema = z.object({
  placa: z.string().trim().min(4), vin: z.string().trim().min(11),
  propietarioNombre: z.string().trim().min(2), propietarioDocumento: z.string().trim().optional(),
  marca: z.string().trim().optional(), linea: z.string().trim().optional(), modelo: z.number().int().optional(),
  companiaId: z.number().int().positive(), organismoCodigo: z.string().trim().min(3),
  transitoNombre: z.string().trim().optional(), idFlit: z.string().trim().optional(),
  flitEstado: z.string().trim().optional(),
});
router.post('/demo', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = demoSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  try {
    const r = await crearTramiteDemo(parsed.data, ctxDe(req.user!));
    await audit(req, { action: 'create', resource: 'flito_tramite', detail: `Trámite DEMO ${r.idFlit} (placa ${r.placa}) creado` });
    res.status(201).json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /solicitar-soat — envío al gestor SOAT del lote, fijando proveedor. Solo Operaciones.
router.post('/solicitar-soat', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = soatSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await solicitarSoat(parsed.data.tramiteIds, parsed.data.proveedorSoatId, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Solicitud SOAT: ${r.enviados} enviados, ${r.yaEnviados} ya enviados, ${r.autogestionados} autogestionados, ${r.sinRegistro} sin registro` });
  res.json(r);
});

// POST /solicitar-impuestos — envío al gestor de impuestos (solo los que tienen factura de venta).
router.post('/solicitar-impuestos', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = loteSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await solicitarImpuestos(parsed.data.tramiteIds, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Solicitud impuestos: ${r.enviados} enviados, ${r.yaEnviados} ya enviados, ${r.noEnviables} no enviables` });
  res.json(r);
});

// POST /solicitar-ambos — SOAT y luego impuestos, secuencial.
router.post('/solicitar-ambos', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = soatSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await solicitarAmbos(parsed.data.tramiteIds, parsed.data.proveedorSoatId, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Solicitud SOAT+impuestos sobre ${parsed.data.tramiteIds.length} trámites` });
  res.json(r);
});

// POST /entregar — entrega en lote (delega en compuerta, que revalida cada uno). Solo Operaciones.
router.post('/entregar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = loteSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await entregar(parsed.data.tramiteIds, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Entrega en lote: ${r.entregados} entregados, ${r.noHabilitados.length} no habilitados` });
  res.json(r);
});

// ─────────────────── Desbloqueo excepcional de autogestión ──────────────────
//
// Solo Operaciones: decidir qué gestiona FLITO no es una decisión financiera ni del gestor.

const excepcionSchema = z.object({
  concepto: z.enum(['soat', 'impuesto', 'logistica']),
  motivo: z.string().min(MOTIVO_MINIMO, `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres)`),
});

router.post('/:id/desbloquear-autogestion', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = excepcionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' }); return; }
  try {
    const ctx = ctxDe(req.user!);
    const e = await desbloquear(req.params.id, parsed.data.concepto, parsed.data.motivo, ctx);
    await audit(req, {
      action: 'update', resource: 'flito_tramite', resourceId: req.params.id,
      detail: `Desbloqueo excepcional de ${parsed.data.concepto}: ${parsed.data.motivo.trim()}`,
    });
    res.status(201).json(e);
  } catch (err) {
    if (err instanceof ExcepcionError) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

router.post('/:id/revocar-autogestion', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = excepcionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' }); return; }
  try {
    const ctx = ctxDe(req.user!);
    await revocar(req.params.id, parsed.data.concepto, parsed.data.motivo, ctx);
    await audit(req, {
      action: 'update', resource: 'flito_tramite', resourceId: req.params.id,
      detail: `Revocado el desbloqueo de ${parsed.data.concepto}: ${parsed.data.motivo.trim()}`,
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof ExcepcionError) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

export default router;
