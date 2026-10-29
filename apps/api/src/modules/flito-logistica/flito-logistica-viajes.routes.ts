// FLITO — rutas de los viajes adicionales de logística de un trámite (HU #12619, Feature #12617).
//
// Montado bajo `/api/flito/logistica` (app.ts) junto al router legado de logística, en fichero
// PROPIO: aquel está contra su techo de líneas y su `GET /:id` no choca con `/tramites/:id/viajes`.
// Tres funciones, sembradas por la 0199 SOLO a admin (el administrador reparte desde el panel):
//   · logistica.viajes.ver       → GET    /tramites/:tramiteId/viajes
//   · logistica.viajes.registrar → POST   /tramites/:tramiteId/viajes
//   · logistica.viajes.quitar    → DELETE /tramites/:tramiteId/viajes/:viajeId
// Sin PUT/PATCH: un viaje se quita y se vuelve a registrar. Todo id que no sea uuid es 404 (el id es
// opaco), nunca 400 ni 22P02. Las mutaciones auditan con `resource: 'flito_tramite_viaje_logistica'`
// y un `detail` sin PII (idFlit, número, modo y valor).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { mensajesDeTipo } from '../../shared/utils/zod-mensajes.js';
import { MOTIVOS_VIAJE_LOGISTICA } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  MAX_LT_POR_OPERACION, TramiteNoEncontradoError, ViajeLogisticaError, ViajeNoEncontradoError, listar, quitar,
  registrar, registrarMasivo, type ItemMasivo, type RechazoMasivo,
} from './flito-logistica-viajes.service.js';
import { normPlaca } from './flito-logistica.aprobado.js';
import { buscarIdempotencia, guardarIdempotencia } from './flito-logistica.service.js';
import { viajesMasivoLimiter } from '../../shared/middleware/rateLimiter.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { esProyeccionCliente } from '../../shared/alcance-filas.js';
import { enAlcanceLogistica, exigirPropioLogistica } from './flito-logistica.alcance.js';

const router = Router();
router.use(authMiddleware);

const uuidSchema = z.string().guid();
/** Un id que no es uuid es «no existe» (404): el id es opaco para el cliente. */
const idUuid = (raw: string): string | null => (uuidSchema.safeParse(raw).success ? raw : null);

/** Tope de numeric(14,2): por encima la base respondería 22003 y aquí sería un 500 sin explicación. */
const VALOR_MAXIMO = 999_999_999_999.99;

/** Valor libre de un viaje manual: ≥ 0, sin tope de negocio (solo el de la columna). */
const valorManualSchema = z.number({ error: mensajesDeTipo({ requerido: 'es obligatorio', tipo: 'debe ser un número' }) })
  .finite('debe ser un número').min(0, 'debe ser mayor o igual a 0').max(VALOR_MAXIMO, 'supera el máximo');

const motivoYDetalle = {
  // zod 4: un enum reporta `invalid_value` también para lo ausente o no-texto; se reproduce el
  // mensaje de zod 3 (ausente / no-texto) y lo demás queda con el mensaje por defecto (Bug #13928).
  motivo: z.enum(MOTIVOS_VIAJE_LOGISTICA, {
    error: (iss) => (iss.input === undefined ? 'es obligatorio'
      : typeof iss.input !== 'string' ? `debe ser uno de: ${MOTIVOS_VIAJE_LOGISTICA.join(', ')}` : undefined),
  }),
  motivoDetalle: z.string({ error: mensajesDeTipo({ tipo: 'debe ser texto' }) }).trim()
    .min(1, 'no puede estar en blanco').max(300, 'no puede superar 300 caracteres').optional(),
};

/** `inicial` no admite `valor` (strict: copia la tarifa); `manual` lo exige. */
const registrarSchema = z.discriminatedUnion('modo', [
  z.object({ modo: z.literal('inicial'), ...motivoYDetalle }).strict(),
  z.object({
    modo: z.literal('manual'),
    valor: valorManualSchema,
    ...motivoYDetalle,
  }).strict(),
]).superRefine((d, ctx) => {
  if (d.motivo === 'otro' && d.motivoDetalle === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['motivoDetalle'], message: 'es obligatorio cuando el motivo es «otro»' });
  }
});

/** «campo: regla» por cada problema, para que el 400 diga QUÉ campo y QUÉ regla. */
function mensajeDe(e: z.ZodError): string {
  return `Datos inválidos: ${e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ')}`;
}

const NO_EXISTE_TRAMITE = { error: 'El trámite no existe' };

/** La clase del error decide el código y el `codigo` del cuerpo. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof TramiteNoEncontradoError) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  if (e instanceof ViajeLogisticaError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
  throw e;
}

router.get('/tramites/:tramiteId/viajes', exigirFuncion('logistica.viajes.ver'), async (req: Request, res: Response) => {
  const tramiteId = idUuid(req.params.tramiteId);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  // HU #13426 (AC2): trámite de otra compañía → 404, igual que uno inexistente.
  const alcance = await alcanceDe(req);
  if (!await enAlcanceLogistica('tramite', tramiteId, alcance)) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  try {
    const lista = await listar(tramiteId);
    // Habeas Data (HU #13426): la compañía no recibe el nombre de quien de FLIT registró el viaje.
    const cuerpo = esProyeccionCliente(alcance)
      ? { ...lista, items: lista.items.map((v) => ({ ...v, registradoPorNombre: null })) } : lista;
    // Sin caché: un viaje registrado hace un segundo tiene que salir sin recargar la pantalla.
    res.set('Cache-Control', 'no-store');
    res.json(cuerpo);
  } catch (e) { fallo(res, e); }
});

router.post('/tramites/:tramiteId/viajes', exigirFuncion('logistica.viajes.registrar'), async (req: Request, res: Response) => {
  const parsed = registrarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  const tramiteId = idUuid(req.params.tramiteId);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  await exigirPropioLogistica('tramite', tramiteId, await alcanceDe(req)); // HU #13426 (AC3): 403
  try {
    const { viaje, idFlit } = await registrar(tramiteId, parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_tramite_viaje_logistica', resourceId: viaje.id,
      detail: `Viaje adicional #${viaje.numero} (${viaje.modo}, ${viaje.valor}) registrado en el trámite ${idFlit}`,
    });
    res.status(201).json(viaje);
  } catch (e) { fallo(res, e); }
});

/**
 * HU #14127 — registro masivo: N LT identificadas por la PLACA del vehículo (la LT es del vehículo, ADR-0030
 * §17.2; la placa es PII y va en el body), cada una con su valor. El valor de cada item se valida
 * APARTE (negativo o vacío rechaza solo esa LT, AC3); lo estructural (tope, uuid, motivo) es 400.
 * Idempotencia opcional por `Idempotency-Key` (AC5): repetirla devuelve la respuesta guardada.
 */
const masivoSchema = z.object({
  items: z.array(z.object({ placa: z.string(), valor: z.unknown().optional() }).strict(), {
    error: 'debe ser una lista de LT',
  }).min(1, 'debe traer al menos una LT')
    .max(MAX_LT_POR_OPERACION, `no puede superar ${MAX_LT_POR_OPERACION} LT por operación`),
  ...motivoYDetalle,
}).strict().superRefine((d, ctx) => {
  if (d.motivo === 'otro' && d.motivoDetalle === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['motivoDetalle'], message: 'es obligatorio cuando el motivo es «otro»' });
  }
});

router.post('/viajes/masivo', exigirFuncion('logistica.viajes.registrar'), viajesMasivoLimiter, async (req: Request, res: Response) => {
  const parsed = masivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  const usuarioId = req.user?.sub ?? null;
  const claveBruta = req.header('Idempotency-Key')?.trim();
  const clave = claveBruta ? `viajes-masivo:${usuarioId ?? 'anon'}:${claveBruta.slice(0, 120)}` : undefined;
  if (clave) {
    const previa = await buscarIdempotencia(clave);
    if (previa) { res.status(previa.status).json(previa.body); return; }
  }
  const alcance = await alcanceDe(req);
  const rechazadosDeEntrada: RechazoMasivo[] = [];
  const validos: ItemMasivo[] = [];
  const vistas = new Set<string>();
  for (const it of parsed.data.items) {
    const placa = normPlaca(it.placa);
    const valor = valorManualSchema.safeParse(it.valor);
    const rechazo = (motivo: string, codigo: string) => rechazadosDeEntrada.push({ placa, motivo, codigo });
    if (placa === '') rechazo('La placa es obligatoria', 'PLACA_INVALIDA');
    else if (vistas.has(placa)) rechazo('Placa repetida en la operación', 'PLACA_REPETIDA');
    else if (!valor.success) rechazo(`Valor inválido: ${valor.error.issues.map((i) => i.message).join('; ')}`, 'VALOR_INVALIDO');
    else { vistas.add(placa); validos.push({ placa, valor: valor.data }); }
  }
  const { motivo, motivoDetalle } = parsed.data;
  const r = await registrarMasivo(validos, { motivo, motivoDetalle }, usuarioId,
    (id) => enAlcanceLogistica('tramite', id, alcance));
  // Sin PII en el rastro: el `detail` lleva idFlit, número, modo y valor; la placa no se registra.
  for (const c of r.creados) {
    await audit(req, {
      action: 'create', resource: 'flito_tramite_viaje_logistica', resourceId: c.viaje.id,
      detail: `Viaje adicional #${c.viaje.numero} (${c.viaje.modo}, ${c.viaje.valor}) registrado en el trámite ${c.idFlit} (masivo)`,
    });
  }
  const cuerpo = {
    solicitadas: parsed.data.items.length,
    creados: r.creados.map(({ placa, tramiteId, idFlit, viaje }) => ({ placa, tramiteId, idFlit, viaje })),
    rechazados: [...rechazadosDeEntrada, ...r.rechazados],
  };
  const status = r.creados.length > 0 ? 201 : 200;
  if (clave) await guardarIdempotencia(clave, status, cuerpo);
  res.status(status).json(cuerpo);
});

router.delete('/tramites/:tramiteId/viajes/:viajeId', exigirFuncion('logistica.viajes.quitar'), async (req: Request, res: Response) => {
  const tramiteId = idUuid(req.params.tramiteId);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  const viajeId = idUuid(req.params.viajeId);
  if (viajeId === null) { fallo(res, new ViajeNoEncontradoError()); return; }
  await exigirPropioLogistica('tramite', tramiteId, await alcanceDe(req));
  try {
    const quitado = await quitar(tramiteId, viajeId);
    // El `detail` lleva número, modo y valor porque la fila ya no existe.
    await audit(req, {
      action: 'delete', resource: 'flito_tramite_viaje_logistica', resourceId: viajeId,
      detail: `Viaje adicional #${quitado.numero} (${quitado.modo}, ${quitado.valor}) quitado del trámite ${quitado.idFlit}`,
    });
    res.status(204).end();
  } catch (e) { fallo(res, e); }
});

export default router;
