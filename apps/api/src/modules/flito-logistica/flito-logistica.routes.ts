// FLITO Logística (HTTP). Montado en /api/flito/logistica. Consola de Operaciones (trazabilidad por
// documento, actas, despacho) + endpoints de campo que la PWA del mensajero consumirá en la Fase 2.
// Lectura: Operaciones/Auditoría. Escritura de Operaciones: admin. Campo: admin/mensajero (con scoping).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { EstadoDocumentoLogistica } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { alcanceDe, soloSinEnlace } from '../../shared/middleware/frontera-enlace.js';
import { enAlcanceLogistica, exigirPropioLogistica } from './flito-logistica.alcance.js';
import { consultarVehiculoLimiter } from '../../shared/middleware/rateLimiter.js';
import { esProyeccionCliente } from '../../shared/alcance-filas.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { confirmarRecogida } from './flito-logistica.recogida.js';
import { candidatosDe, listarPendientes, resolverTramite } from './flito-logistica.pendientes.js';
import { contarPendientesFirma, ltPendientesFirma } from './flito-logistica.pendientes-firma.js';
import { misRecogidas, recogidaDetalle, revelarDocumentoFirmante } from './flito-logistica.firmante.js';
import { recogidaConfirmarLimiter, revelarDocumentoLimiter, trasladoCicloLimiter, trasladoRegistrarLimiter } from './flito-logistica.limitadores.js';
import {
  actaDetalle, anularTraslado, buscarIdempotencia, cerrarLote, despachar, despacharTraslado,
  destinoDeTraslado, devolverTraslado, entregar, entregarTraslado, firmarLlegadaFlit, consultarVehiculo, escanearLt, facetas,
  guardarIdempotencia, listar, listarActas, LogisticaError, miRuta, registrarDevolucion,
  registrarNovedad, registrarTraslado, reversar, tramiteDetalle, urlActaPdf, validarLt,
  type FiltrosLogistica, type LogisticaCtx,
} from './flito-logistica.service.js';

/** La bitácora sin el nombre del actor (HU #13426): la forma del DTO no cambia. */
const sinActor = <T extends { actorNombre: string | null }>(xs: T[]): T[] => xs.map((e) => ({ ...e, actorNombre: null }));

const router = Router();
router.use(authMiddleware);


/**
 * Contexto de las operaciones SIN regla de propiedad (escanear, novedad, lote, despacho, reversa):
 * `operaAjenas` no se consulta ahí, así que va en `false` (cerrado) sin preguntar al resolutor.
 */
function ctxDe(user: { sub: number; username: string; role: string }): LogisticaCtx {
  return { userId: user.sub, username: user.username, role: user.role, operaAjenas: false };
}

/**
 * Contexto de las operaciones CON regla de propiedad (mi ruta, entregar, devolver; CA-11). HU #13425:
 * quién opera actas ajenas lo decide la función `logistica.actas.operar_ajenas`, no el nombre del rol.
 * Es la única guarda en línea del fichero, en un solo sitio para las tres rutas.
 */
async function ctxConPropiedad(req: Request): Promise<LogisticaCtx> {
  return { ...ctxDe(req.user!), operaAjenas: await tieneFuncion(req, 'logistica.actas.operar_ajenas') };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};

/** Ejecuta la acción del servicio y traduce LogisticaError a su código HTTP; el resto es 500. */
async function ejecutar<T>(res: Response, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LogisticaError) { res.status(error.status).json({ error: error.message, ...(error.codigo ? { codigo: error.codigo } : {}), ...(error.extra ? { detalle: error.extra } : {}) }); return undefined; }
    throw error;
  }
}

/**
 * Envuelve una escritura de campo con idempotencia (RN-06/CA-06). Si la petición trae `Idempotency-Key`
 * y ya se procesó, devuelve la respuesta guardada sin re-ejecutar; así un reenvío offline no duplica.
 */
async function conIdempotencia(req: Request, res: Response, run: () => Promise<{ status?: number; body: unknown }>, ruta?: string): Promise<void> {
  const cabecera = req.header('Idempotency-Key') || undefined;
  // ADR-0030 §10: con `ruta`, la clave se prefija `usuarioId:ruta:` y no colisiona entre usuarios ni endpoints.
  const key = cabecera && ruta ? `${req.user!.sub}:${ruta}:${cabecera}` : cabecera;
  if (key) {
    const prev = await buscarIdempotencia(key);
    if (prev) { res.status(prev.status).json(prev.body); return; }
  }
  try {
    const { status = 200, body } = await run();
    if (key) await guardarIdempotencia(key, status, body);
    res.status(status).json(body);
  } catch (error) {
    if (error instanceof LogisticaError) { res.status(error.status).json({ error: error.message, ...(error.codigo ? { codigo: error.codigo } : {}), ...(error.extra ? { detalle: error.extra } : {}) }); return; }
    throw error;
  }
}

// GET / — listado paginado con filtros multiselect (CA-07).
router.get('/', exigirFuncion('logistica.consola.ver'), async (req: Request, res: Response) => {
  const q = req.query;
  const filtros: FiltrosLogistica = {
    buscar: str(q.buscar), estados: lista(q.estados),
    empresas: lista(q.empresas), organismos: lista(q.organismos), actas: lista(q.actas),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
  res.json(await listar(filtros, await alcanceDe(req)));
});

// GET /facetas — valores para los dropdowns de filtro, compañías cerrables y mensajeros.
router.get('/facetas', exigirFuncion('logistica.consola.filtrar'), async (req: Request, res: Response) => {
  res.json(await facetas(await alcanceDe(req)));
});

// GET /mi-ruta — ruta del mensajero (PWA): recogidas por organismo + entregas asignadas (CA-11).
// HU #13426 (P-2): la ruta del mensajero es de personal de FLITO (sin enlace, AC1) → cerrada a enlaces.
router.get('/mi-ruta', soloSinEnlace(), exigirFuncion('logistica.ruta.ver'), async (req: Request, res: Response) => {
  res.json(await miRuta(await ctxConPropiedad(req)));
});

// GET /actas — panel de despacho/entrega (todas las actas con su estado y mensajero).
router.get('/actas', exigirFuncion('logistica.actas.listar'), async (req: Request, res: Response) => {
  res.json(await listarActas(await alcanceDe(req)));
});

// GET /actas/:id — detalle del acta: documentos + bitácora del despacho (CA-13).
router.get('/actas/:id', exigirFuncion('logistica.actas.ver'), async (req: Request, res: Response) => {
  // HU #13426 (AC2): un acta de otra compañía responde 404, igual que una inexistente.
  const alcance = await alcanceDe(req);
  if (!await enAlcanceLogistica('acta', req.params.id, alcance)) { res.status(404).json({ error: 'El acta no existe' }); return; }
  const r = await ejecutar(res, () => actaDetalle(req.params.id));
  // Habeas Data (HU #13426): la compañía no recibe quién de FLIT movió cada documento de la bitácora.
  if (r !== undefined) res.json(esProyeccionCliente(alcance) ? { ...r, bitacora: sinActor(r.bitacora) } : r);
});

// GET /actas/:id/pdf — URL prefirmada del PDF base del acta (se genera si falta).
router.get('/actas/:id/pdf', exigirFuncion('logistica.actas.descargar'), async (req: Request, res: Response) => {
  if (!await enAlcanceLogistica('acta', req.params.id, await alcanceDe(req))) { res.status(404).json({ error: 'El acta no existe' }); return; }
  const url = await ejecutar(res, () => urlActaPdf(req.params.id));
  if (url !== undefined) res.json({ url });
});

// ── LT pendientes de trámite (HU #14143, ADR-0030 §17.3) ─────────────────────
// Función propia (`logistica.documento.resolver_tramite`); cliente y enlace no ven nada (`soloSinEnlace`).
// Antes de `GET /:id` para que `pendientes-tramite` no se tome por un id.
router.get('/pendientes-tramite', soloSinEnlace(), exigirFuncion('logistica.documento.resolver_tramite'), async (_req: Request, res: Response) => {
  res.json({ pendientes: await listarPendientes() });
});
router.get('/documentos/:id/candidatos-tramite', soloSinEnlace(), exigirFuncion('logistica.documento.resolver_tramite'), async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'La LT no existe', codigo: 'LT_NO_ENCONTRADA' }); return; }
  const r = await ejecutar(res, () => candidatosDe(id.data));
  if (r !== undefined) res.json({ candidatos: r });
});
const resolverSchema = z.object({ tramiteId: z.string().uuid() });
router.post('/documentos/:id/resolver-tramite', soloSinEnlace(), exigirFuncion('logistica.documento.resolver_tramite'), async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'La LT no existe', codigo: 'LT_NO_ENCONTRADA' }); return; }
  const parsed = resolverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: 'Indica el trámite que corresponde a la LT', codigo: 'DATOS_INVALIDOS' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await resolverTramite(id.data, parsed.data.tramiteId, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica', resourceId: id.data, detail: `Trámite de LT pendiente resuelto: trámite ${r.tramiteId}, compañía ${r.companiaId}` });
    return { body: r };
  }, 'documentos/resolver-tramite');
});

// GET /:id — detalle del trámite aprobado + su LT + bitácora (CA-07).
router.get('/:id', exigirFuncion('logistica.documento.ver'), async (req: Request, res: Response) => {
  const alcance = await alcanceDe(req);
  if (!await enAlcanceLogistica('tramite', req.params.id, alcance)) { res.status(404).json({ error: 'El trámite no existe' }); return; }
  const r = await ejecutar(res, () => tramiteDetalle(req.params.id));
  if (r !== undefined) res.json(esProyeccionCliente(alcance) ? { ...r, eventos: sinActor(r.eventos) } : r); // ídem acta
});

// Entrada de la LT: o el código PDF417 (`rawValue`) o el ingreso manual (placa + n.º de licencia del frente +
// n.º de sustrato «LT…» del reverso). XOR. La placa va SIEMPRE en el body (PII), nunca en URL/query ni en logs.
const manualCampos = { placa: z.string().trim().min(1).max(10), numeroLicencia: z.string().trim().min(1).max(40), numeroLt: z.string().trim().min(1).max(40) };
const xorEntrada = (b: { rawValue?: string; placa?: string; numeroLicencia?: string; numeroLt?: string }) => {
  const manual = b.placa !== undefined || b.numeroLicencia !== undefined;
  return b.rawValue !== undefined ? !manual : (b.placa !== undefined && b.numeroLicencia !== undefined && b.numeroLt !== undefined);
};
const entradaDe = (b: { rawValue?: string; placa?: string; numeroLicencia?: string; numeroLt?: string }) =>
  b.rawValue !== undefined ? b.rawValue : { placa: b.placa!, numeroLicencia: b.numeroLicencia!, numeroLt: b.numeroLt! };

// POST /validar-lt — valida el match de una LT SIN persistir (el mensajero escanea en lote; solo al
// confirmar se llama a /escanear por cada LT relacionada). Solo lectura → sin idempotencia ni auditoría.
const validarSchema = z.object({ rawValue: z.string().min(1).optional(), placa: manualCampos.placa.optional(), numeroLicencia: manualCampos.numeroLicencia.optional(), numeroLt: manualCampos.numeroLt.optional() }).strict().refine(xorEntrada);
// HU #13426 (P-2): buscan por placa/VIN entre TODOS los trámites → oráculo para una compañía: cerradas.
router.post('/validar-lt', soloSinEnlace(), exigirFuncion('logistica.lt.validar'), async (req: Request, res: Response) => {
  const parsed = validarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const r = await ejecutar(res, () => validarLt(entradaDe(parsed.data as never)));
  if (r !== undefined) res.json(r);
});

// POST /consultar-vehiculo — HU #14142: trámites aprobados sin LT de una placa (ingreso manual). Placa en body;
// mismas guardas que /escanear + tope de consultas por usuario (no enumerar placas). Sin auditoría con la placa.
const consultarSchema = z.object({ placa: manualCampos.placa }).strict();
router.post('/consultar-vehiculo', soloSinEnlace(), exigirFuncion('logistica.documento.escanear'), consultarVehiculoLimiter, async (req: Request, res: Response) => {
  const parsed = consultarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const r = await ejecutar(res, () => consultarVehiculo(parsed.data.placa));
  if (r !== undefined) res.json(r);
});

// POST /escanear — recogida de una LT desde su código PDF417 o ingresada a mano (match placa → recogida/novedad).
// HU #14142: `tramiteId` (elige entre candidatos) y `dejarPendiente` son excluyentes; `organismoCodigo` solo aplica al pendiente.
const escanearSchema = z.object({
  rawValue: z.string().min(1).optional(), numeroLt: z.string().optional(), lat: z.string().optional(), lng: z.string().optional(),
  placa: manualCampos.placa.optional(), numeroLicencia: manualCampos.numeroLicencia.optional(),
  tramiteId: z.string().uuid().optional(), dejarPendiente: z.boolean().optional(), organismoCodigo: z.string().min(1).max(5).optional(),
}).strict()
  .refine((b) => b.rawValue !== undefined ? (b.placa === undefined && b.numeroLicencia === undefined) : (b.placa !== undefined && b.numeroLicencia !== undefined && b.numeroLt !== undefined), { message: 'rawValue o (placa, numeroLicencia, numeroLt)' })
  .refine((b) => !(b.tramiteId && b.dejarPendiente), { message: 'tramiteId y dejarPendiente son excluyentes' });
router.post('/escanear', soloSinEnlace(), exigirFuncion('logistica.documento.escanear'), async (req: Request, res: Response) => {
  const parsed = escanearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  await conIdempotencia(req, res, async () => {
    const d = parsed.data;
    const r = await escanearLt(entradaDe(d as never), d.rawValue !== undefined ? (d.numeroLt ?? null) : null, { lat: d.lat, lng: d.lng }, ctxDe(req.user!),
      { tramiteId: d.tramiteId, dejarPendiente: d.dejarPendiente, organismoCodigo: d.organismoCodigo });
    await audit(req, { action: 'update', resource: 'flito_logistica', detail: `Escaneo LT: ${r.resultado}${d.rawValue === undefined ? ' (manual)' : ''}` }); // sin placa (PII)
    return { body: r };
  });
});

// POST /documentos/:id/novedad — motivo obligatorio; bloquea el avance (RN-04).
const motivoSchema = z.object({ motivo: z.string().trim().min(1) });
router.post('/documentos/:id/novedad', exigirFuncion('logistica.documento.reportar_novedad'), async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  await exigirPropioLogistica('documento', req.params.id, await alcanceDe(req)); // HU #13426 (AC3)
  await conIdempotencia(req, res, async () => {
    await registrarNovedad(req.params.id, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica', resourceId: req.params.id, detail: `Novedad: ${parsed.data.motivo}` });
    return { body: { ok: true } };
  });
});

// POST /traslados — HU #14114 / #14122. `origen` solo se honra si destino = cliente.
const trasladoLtSchema = z.object({
  documentoId: z.string().uuid(),
  motivoLlegadaId: z.string().uuid().optional(),
  nota: z.string().trim().max(300).optional(),
});
const trasladoSchema = z.object({
  companiaId: z.number().int().positive(),
  destino: z.enum(['cliente', 'flit']),
  origen: z.enum(['organismo', 'flit']).optional(),
  lts: z.array(trasladoLtSchema).min(1).max(200),
  motivoLlegadaId: z.string().uuid().optional(),
  mensajeroId: z.number().int().positive().optional(),
});
router.post('/traslados', soloSinEnlace(), exigirFuncion('logistica.traslado.registrar'), trasladoRegistrarLimiter, async (req: Request, res: Response) => {
  const parsed = trasladoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: 'Datos inválidos: la compañía, el destino y al menos una LT son obligatorios', codigo: 'DATOS_INVALIDOS' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await registrarTraslado(parsed.data, await ctxConPropiedad(req));
    await audit(req, { action: 'create', resource: 'flito_logistica_traslado', detail: `Traslado ${r.id} destino ${parsed.data.destino} compañía ${parsed.data.companiaId}: ${r.documentos} LT` });
    return { body: r };
  }, 'traslados');
});

const uuidParam = (v: string | undefined) => z.string().uuid().safeParse(v);
const despacharTrasladoSchema = z.object({
  mensajeroId: z.number().int().positive(),
  firmaEntrega: z.string().min(1).optional(),
  entregaNombre: z.string().optional(),
});
const entregarTrasladoSchema = z.object({
  receptorNombre: z.string().trim().min(1), receptorDocumento: z.string().trim().min(1),
  firma: z.string().min(1), foto: z.string().optional(), lat: z.string().optional(), lng: z.string().optional(),
  ltsDevueltas: z.array(z.string().uuid()).optional(), ltsEntregadas: z.array(z.string().uuid()).optional(),
});

async function auditarCedulaReceptor(req: Request, firmaId: string | undefined): Promise<void> {
  if (!firmaId) return;
  await logPiiAccess(req, {
    resourceTipo: 'flito_logistica_acta_firmas', accion: 'read', camposAccedidos: ['documento_cifrado'],
    motivo: `firma:${firmaId}`,
  });
}

// POST /traslados/:id/despachar — HU #14115. Reusa `logistica.actas.despachar`. Firma de Operaciones opcional.
router.post('/traslados/:id/despachar', soloSinEnlace(), exigirFuncion('logistica.actas.despachar'), trasladoCicloLimiter, async (req: Request, res: Response) => {
  const id = uuidParam(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'Viaje no encontrado', codigo: 'TRASLADO_NO_ENCONTRADO' }); return; }
  const parsed = despacharTrasladoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: 'Datos inválidos: el mensajero es obligatorio', codigo: 'DATOS_INVALIDOS' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await despacharTraslado(id.data, parsed.data, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica_traslado', resourceId: id.data, detail: `Despacho a mensajero ${parsed.data.mensajeroId}` });
    return { body: r };
  }, 'traslados-despachar');
});

const llegadaFlitSchema = z.object({
  firma: z.string().min(1),
  lat: z.string().optional(),
  lng: z.string().optional(),
  ltsDevueltas: z.array(z.string().uuid()).optional(),
  ltsEntregadas: z.array(z.string().uuid()).optional(),
});
const CAMPOS_PROHIBIDOS_LLEGADA = ['receptorNombre', 'receptorDocumento', 'firmante'] as const;

function sinPermiso(res: Response): void {
  res.status(403).json({ error: 'Sin permisos' });
}

// POST /traslados/:id/entregar — guarda en línea según destino (HU #14122).
// Cliente: cédula + `logistica.actas.entregar`. FLIT: `{ firma, lat?, lng? }` + `logistica.actas.firmar_flit`.
// 404 si el viaje no está, antes del 403 de función. Sin `exigirFuncion` de ruta: quien solo firma FLIT
// no puede quedar fuera, y el mensajero (solo `entregar`) no puede entrar a un viaje a FLIT.
router.post('/traslados/:id/entregar', soloSinEnlace(), trasladoCicloLimiter, async (req: Request, res: Response) => {
  const id = uuidParam(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'Viaje no encontrado', codigo: 'TRASLADO_NO_ENCONTRADO' }); return; }
  const destino = await destinoDeTraslado(id.data);
  if (!destino) { res.status(404).json({ error: 'Viaje no encontrado', codigo: 'TRASLADO_NO_ENCONTRADO' }); return; }
  if (destino === 'flit') {
    if (!(await tieneFuncion(req, 'logistica.actas.firmar_flit'))) { sinPermiso(res); return; }
    const cuerpo = req.body;
    if (cuerpo && typeof cuerpo === 'object' && CAMPOS_PROHIBIDOS_LLEGADA.some((k) => k in cuerpo)) {
      res.status(422).json({ error: 'La llegada a FLIT no admite cédula ni nombre de receptor', codigo: 'DATOS_INVALIDOS' });
      return;
    }
    const parsed = llegadaFlitSchema.safeParse(cuerpo);
    if (!parsed.success) {
      const soloFirma = parsed.error.issues.every((i) => i.path[0] === 'firma');
      if (soloFirma) {
        res.status(422).json({ error: 'La llegada a FLIT requiere la firma de quien recibe', codigo: 'FIRMA_LLEGADA_REQUERIDA' });
        return;
      }
      res.status(422).json({ error: 'Datos inválidos', codigo: 'DATOS_INVALIDOS' });
      return;
    }
    await conIdempotencia(req, res, async () => {
      const r = await firmarLlegadaFlit(id.data, parsed.data, await ctxConPropiedad(req));
      await audit(req, {
        action: 'update', resource: 'flito_logistica_traslado', resourceId: id.data,
        detail: `Llegada a FLIT del viaje ${id.data}`,
      });
      return { body: r };
    }, 'traslados-entregar');
    return;
  }
  if (!(await tieneFuncion(req, 'logistica.actas.entregar'))) { sinPermiso(res); return; }
  const parsed = entregarTrasladoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: 'Datos inválidos: nombre, cédula y firma del receptor son obligatorios', codigo: 'DATOS_INVALIDOS' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await entregarTraslado(id.data, parsed.data, await ctxConPropiedad(req));
    await auditarCedulaReceptor(req, r.firmaId);
    await audit(req, { action: 'update', resource: 'flito_logistica_traslado', resourceId: id.data, detail: 'Entrega de viaje' });
    return { body: r };
  }, 'traslados-entregar');
});

// POST /traslados/:id/devolucion — todo el viaje. Reusa `logistica.actas.devolver`.
router.post('/traslados/:id/devolucion', soloSinEnlace(), exigirFuncion('logistica.actas.devolver'), trasladoCicloLimiter, async (req: Request, res: Response) => {
  const id = uuidParam(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'Viaje no encontrado', codigo: 'TRASLADO_NO_ENCONTRADO' }); return; }
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await devolverTraslado(id.data, parsed.data.motivo, await ctxConPropiedad(req));
    await audit(req, { action: 'update', resource: 'flito_logistica_traslado', resourceId: id.data, detail: `Devolución: ${parsed.data.motivo}` });
    return { body: r };
  }, 'traslados-devolucion');
});

// POST /traslados/:id/anular — solo `registrado`. Permiso propio; siembra admin (0283).
router.post('/traslados/:id/anular', soloSinEnlace(), exigirFuncion('logistica.traslado.anular'), trasladoCicloLimiter, async (req: Request, res: Response) => {
  const id = uuidParam(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'Viaje no encontrado', codigo: 'TRASLADO_NO_ENCONTRADO' }); return; }
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await anularTraslado(id.data, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica_traslado', resourceId: id.data, detail: `Anulación: ${parsed.data.motivo}` });
    return { body: r };
  }, 'traslados-anular');
});

// POST /cerrar-lote — adaptador (HU #14114): viaje a cliente de las LT clasificadas de la compañía.
const cerrarLoteSchema = z.object({ companiaId: z.number().int().positive() });
router.post('/cerrar-lote', exigirFuncion('logistica.lote.cerrar'), async (req: Request, res: Response) => {
  const parsed = cerrarLoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  // HU #13426 (AC3): una compañía solo cierra SU lote; otro id → 403 sin comprobar si existe.
  const a = await alcanceDe(req);
  if (a.enlace !== 'ninguno' && !(a.enlace === 'compania' && a.companiaId === parsed.data.companiaId)) {
    res.status(403).json({ error: 'Sin permisos' });
    return;
  }
  await conIdempotencia(req, res, async () => {
    const r = await cerrarLote(parsed.data.companiaId, await ctxConPropiedad(req));
    await audit(req, { action: 'create', resource: 'flito_logistica_acta', detail: `Acta generada para compañía ${parsed.data.companiaId}: ${r.documentos} documentos` });
    return { body: r };
  }, 'cerrar-lote');
});

// POST /actas/:id/despachar — Operaciones firma la ENTREGA en consola, asigna mensajero y pone las
// LT en 'despachado' (CA-05). La firma de quien entrega es la primera de las dos firmas del acta.
const despacharSchema = z.object({
  mensajeroId: z.number().int().positive(), firmaEntrega: z.string().min(1), entregaNombre: z.string().optional(),
});
router.post('/actas/:id/despachar', exigirFuncion('logistica.actas.despachar'), async (req: Request, res: Response) => {
  const parsed = despacharSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'La firma de quien entrega es obligatoria' }); return; }
  await exigirPropioLogistica('acta', req.params.id, await alcanceDe(req));
  const r = await ejecutar(res, () => despachar(req.params.id, parsed.data, ctxDe(req.user!)));
  if (r === undefined) return;
  await audit(req, { action: 'update', resource: 'flito_logistica_acta', resourceId: req.params.id, detail: `Despacho a mensajero ${parsed.data.mensajeroId}` });
  res.json(r);
});

// POST /actas/:id/entregar — recepción del acta (RN-03: identidad del receptor). CA-11: mensajero solo la suya.
const entregarSchema = z.object({
  receptorNombre: z.string().trim().min(1), receptorDocumento: z.string().trim().min(1),
  firma: z.string().min(1), foto: z.string().optional(), lat: z.string().optional(), lng: z.string().optional(),
  ltsDevueltas: z.array(z.string().uuid()).optional(), ltsEntregadas: z.array(z.string().uuid()).optional(),
});
router.post('/actas/:id/entregar', exigirFuncion('logistica.actas.entregar'), async (req: Request, res: Response) => {
  const parsed = entregarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  await exigirPropioLogistica('acta', req.params.id, await alcanceDe(req));
  await conIdempotencia(req, res, async () => {
    const r = await entregar(req.params.id, parsed.data, await ctxConPropiedad(req));
    await auditarCedulaReceptor(req, r.firmaId);
    await audit(req, { action: 'update', resource: 'flito_logistica_acta', resourceId: req.params.id, detail: `Entrega a ${parsed.data.receptorNombre}` });
    return { body: r };
  });
});

// POST /actas/:id/devolucion — receptor ausente/rechazo; motivo obligatorio (CA-10).
router.post('/actas/:id/devolucion', exigirFuncion('logistica.actas.devolver'), async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  await exigirPropioLogistica('acta', req.params.id, await alcanceDe(req));
  await conIdempotencia(req, res, async () => {
    const r = await registrarDevolucion(req.params.id, parsed.data.motivo, await ctxConPropiedad(req));
    await audit(req, { action: 'update', resource: 'flito_logistica_acta', resourceId: req.params.id, detail: `Devolución: ${parsed.data.motivo}` });
    return { body: r };
  });
});

// POST /documentos/:id/reversar — reversa con justificación (RN-08). Solo Operaciones.
const reversarSchema = z.object({ estadoDestino: z.nativeEnum(EstadoDocumentoLogistica), motivo: z.string().trim().min(1) });
router.post('/documentos/:id/reversar', exigirFuncion('logistica.documento.reversar'), async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  await exigirPropioLogistica('documento', req.params.id, await alcanceDe(req));
  const r = await ejecutar(res, () => reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo, ctxDe(req.user!)));
  if (r === undefined && res.headersSent) return;
  await audit(req, { action: 'update', resource: 'flito_logistica', resourceId: req.params.id, detail: `Reversa a "${parsed.data.estadoDestino}": ${parsed.data.motivo}` });
  res.json({ ok: true });
});

// POST /recogidas/confirmar — confirma la recogida: UN firmante (firma y cédula cifrada, una sola vez) y UNA acta
// de organismo por compañía (HU #14110, ADR-0030 §17.1). Las LT sin trámite llevan la firma y no acta.
// Ni logs ni auditoría llevan nombre, cédula ni firma. Función propia; las LT ajenas exigen `operar_ajenas`.
const recogidaSchema = z.object({
  organismoCodigo: z.string().trim().min(1).max(5),
  documentoIds: z.array(z.string().uuid()).min(1).max(200),
  firmante: z.object({ nombre: z.string().trim().min(1).max(150), documento: z.string().trim().min(4).max(30), firma: z.string().min(1) }),
  lat: z.string().max(20).optional(), lng: z.string().max(20).optional(),
});
router.post('/recogidas/confirmar', soloSinEnlace(), exigirFuncion('logistica.recogida.confirmar'), recogidaConfirmarLimiter, async (req: Request, res: Response) => {
  const parsed = recogidaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: 'Datos inválidos: el organismo, las LT y el nombre, la cédula y la firma del funcionario son obligatorios', codigo: 'DATOS_INVALIDOS' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await confirmarRecogida(parsed.data, await ctxConPropiedad(req));
    // Solo ids y conteos: sin nombre, cédula ni firma del funcionario.
    await audit(req, { action: 'create', resource: 'flito_logistica_recogida_firmante', detail: `Recogida confirmada ${r.firmanteId}: ${r.actas.length} actas de organismo, ${r.pendientesTramite} LT pendientes de trámite` });
    return { body: r };
  }, 'recogidas/confirmar');
});

// GET /recogidas/mias y /recogidas/:firmanteId — la recogida se consulta aparte de las actas (sin filtros con PII;
// cédula enmascarada ••••1234). Antes de `/:firmanteId` para que `mias` no se tome por un id.
router.get('/recogidas/mias', soloSinEnlace(), exigirFuncion('logistica.recogida.confirmar'), async (req: Request, res: Response) => {
  const r = await ejecutar(res, async () => { const ctx = await ctxConPropiedad(req); return { recogidas: await misRecogidas(ctx), pendientesFirma: await contarPendientesFirma(ctx) }; });
  if (r !== undefined) res.json(r);
});
// GET /recogidas/pendientes-firma — HU #14147: mis LT escaneadas cuya acta de organismo sigue pendiente (se firman con
// POST /recogidas/confirmar). Sin filtros ni placa en la URL; la placa solo sale en la respuesta, nunca en audit/logs.
router.get('/recogidas/pendientes-firma', soloSinEnlace(), exigirFuncion('logistica.recogida.confirmar'), async (req: Request, res: Response) => {
  const r = await ejecutar(res, async () => ltPendientesFirma(await ctxConPropiedad(req)));
  if (r !== undefined) res.json({ pendientes: r });
});
router.get('/recogidas/:firmanteId', soloSinEnlace(), exigirFuncion('logistica.recogida.confirmar'), async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.firmanteId);
  if (!id.success) { res.status(404).json({ error: 'La recogida no existe', codigo: 'RECOGIDA_NO_ENCONTRADA' }); return; }
  const r = await ejecutar(res, async () => recogidaDetalle(id.data, await ctxConPropiedad(req)));
  if (r !== undefined) res.json(r);
});

// POST /recogidas/:firmanteId/documento — cédula COMPLETA del firmante (PII). Función propia, rateLimiter y
// registro de acceso (`logPiiAccess`); el uuid va en `motivo` porque resource_id es integer.
router.post('/recogidas/:firmanteId/documento', soloSinEnlace(), exigirFuncion('logistica.actas.ver_documento_firmante'), revelarDocumentoLimiter, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.firmanteId);
  if (!id.success) { res.status(404).json({ error: 'El documento del firmante no está disponible' }); return; }
  const documento = await ejecutar(res, () => revelarDocumentoFirmante(id.data));
  if (documento === undefined) return;
  await logPiiAccess(req, {
    resourceTipo: 'flito_logistica_recogida_firmante', accion: 'read', camposAccedidos: ['documento'],
    motivo: `firmante:${id.data}`,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ documento });
});

export default router;
