// Finanzas (HTTP). Montado en /api/finanzas. Lectura para el rol `financiera` (+ admin/auditor).
// Los dos exports son POST con el filtro en el cuerpo y devuelven `.xlsx` (HU #12531).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { soportesDeTramite } from '../../shared/soportes/soportes-consulta.js';
import { sendExcel } from '../../shared/utils/excel.js';
import {
  ExportColaDemasiadoGrandeError, exportColaLimiter, nombreArchivoColaExport,
} from '../../shared/export/cola-flito-excel.js';
import {
  ETAPAS, facetas, filasParaExportar, reporteCostos, resumenFacturacionElectronicaDelReporte,
  type EtapaReporte, type FiltrosReporte,
} from './finanzas.service.js';
import { consolidadoReporte, PERIODOS_CONSOLIDADO, periodoConsolidado } from './finanzas.consolidado.js';
import { gastosDiarios, resolverRango } from './finanzas.gastos-diarios.js';
import { desgloseViajesLogistica, TramiteNoEncontradoError } from './finanzas.viajes-logistica.js';
import {
  COLUMNAS_EXPORT_CONSOLIDADO, COLUMNAS_EXPORT_DETALLE, filasExcelConsolidado, filasExcelDetalle,
  HOJA_CONSOLIDADO, HOJA_DETALLE,
} from './finanzas.export-excel.js';
import { esEstadoReporte, SIIGO_ESTADOS_REPORTE, type SiigoEstadoReporte } from '@operaciones/shared-types';

const router = Router();
router.use(authMiddleware);

// `auditor` estaba documentado en la cabecera de este archivo desde el principio pero NO en el
// requireRole, así que un auditor recibía 403 en el reporte mientras sí podía ver los derechos que
// lo alimentan. Se corrige aquí.
const LECTURA = requireRole('financiera', 'admin', 'auditor');

/**
 * Habeas Data (HU #12432, Ley 1581 art. 17): desde esa HU cada fila del reporte y del archivo lleva
 * el bloque del titular —nombre, razón social, tipo y número de documento—, que es PII y sale del
 * perímetro en el export. Se registra el acceso como ya hacen los Excel de SOAT e Impuestos, con
 * los nombres de columna de la base (como `CAMPOS_PII_COLA_EXPORT`). Best-effort: `logPiiAccess`
 * no lanza, así que un fallo del registro no deja sin reporte a Financiero. Va DESPUÉS de la
 * consulta y con `await`, como en Impuestos.
 *
 * **HU #12531: el `.xlsx` del detalle añade el contacto del primer comprador** —`correo`, `celular`,
 * `direccion`—, y la lista lo declara en la misma edición que lo entrega (la regla de
 * `flito-soat.pii.ts`: declarar de más fue un bloqueante; declarar de menos hace que el registro
 * mienta por omisión). El JSON del `GET /reporte-costos` también proyecta esas tres columnas desde
 * esta HU (viajan en `FilaReporte`), así que la misma lista vale para `read` y para `export`.
 *
 * `resourceId` es null: el recurso es el reporte entero, no un trámite, y el filtro puede cubrir
 * miles. Ningún nombre, documento ni correo va a las trazas de la aplicación; en `motivo` solo el
 * NÚMERO de filas entregadas, que es lo que permite recalibrar el tope (ADR-0004), como hace
 * `registrarAccesoSoat`.
 */
const RECURSO_PII = 'finanzas_reporte_costos';
const CAMPOS_PII_REPORTE = [
  'nombres', 'apellidos', 'razon_social', 'numero_documento', 'tipo_documento', 'placa', 'vin',
  'correo', 'celular', 'direccion',
] as const;
const registrarAccesoPii = (
  req: Request, accion: 'read' | 'export', acceso: { filas?: number } = {},
): Promise<void> => logPiiAccess(req, {
  resourceTipo: RECURSO_PII, resourceId: null, accion, camposAccedidos: [...CAMPOS_PII_REPORTE],
  motivo: acceso.filas === undefined ? undefined : `Reporte de costos — filas=${acceso.filas}`,
});

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
/** Etapa del ciclo de cobro. Una desconocida se ignora: mejor el universo entero que un error. */
const etapa = (v: unknown): EtapaReporte | undefined =>
  (typeof v === 'string' && (ETAPAS as readonly string[]).includes(v) ? v as EtapaReporte : undefined);
/**
 * Estado de facturación electrónica (HU #11336). Uno desconocido se IGNORA, igual que la etapa: la
 * alternativa —devolver 400— convertiría un enlace guardado en favoritos, hecho antes de que el
 * catálogo cambiara, en una pantalla rota. Mejor el universo entero que un error.
 */
const estadoFe = (v: unknown): SiigoEstadoReporte | undefined =>
  (esEstadoReporte(v) ? v : undefined);

/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre. */
const fecha = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

function filtrosDe(q: Request['query']): FiltrosReporte {
  return {
    buscar: str(q.buscar), estados: lista(q.estados), empresas: lista(q.empresas), tipos: lista(q.tipos),
    etapa: etapa(q.etapa),
    documentacionCompleta: q.documentacionCompleta === 'si',
    // HU #12653 (AC5) — calco de `documentacionCompleta`: 'si' o nada.
    conDiferencias: q.conDiferencias === 'si',
    desde: fecha(q.desde), hasta: fecha(q.hasta),
    aprobadoDesde: fecha(q.aprobadoDesde), aprobadoHasta: fecha(q.aprobadoHasta),
    estadoFacturacion: estadoFe(q.estadoFacturacion),
    // HU #12432 — códigos de organismo, con el mismo `lista()` que los demás. Llega a las cuatro
    // rutas porque las cuatro pasan por aquí.
    organismos: lista(q.organismos),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
}

// GET /reporte-costos — listado con valores sellados o estimados, y totales del universo filtrado.
router.get('/reporte-costos', LECTURA, async (req: Request, res: Response) => {
  const reporte = await reporteCostos(filtrosDe(req.query));
  await registrarAccesoPii(req, 'read');
  res.json(reporte);
});

// GET /reporte-costos/facetas — valores para los filtros (estados, empresas, tipos).
router.get('/reporte-costos/facetas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await facetas());
});

/**
 * GET /reporte-costos/facturacion-electronica — los contadores por estado (HU #11336).
 *
 * Misma guarda de lectura que el resto del reporte (AC6): quien puede ver el reporte puede ver sus
 * contadores, y nadie más. No se inventa un permiso nuevo — sería una segunda verdad sobre quién
 * puede mirar lo mismo.
 *
 * Recibe los MISMOS filtros que el listado, y por eso cuenta sobre el mismo conjunto (AC3). No
 * llama a Siigo (AC5): la pantalla lo consulta cada vez que se abre, y si cada apertura gastara
 * peticiones de la ventana de 100 por minuto, mirar el reporte frenaría la emisión.
 */
router.get('/reporte-costos/facturacion-electronica', LECTURA, async (req: Request, res: Response) => {
  res.json(await resumenFacturacionElectronicaDelReporte(filtrosDe(req.query)));
});

/**
 * GET /reporte-costos/consolidado — cliente × periodo de aprobación (HU #12433, CF-12).
 *
 * Misma guarda de lectura y los MISMOS filtros que el listado (`filtrosDe`), y por eso suma sobre
 * el mismo conjunto (CF-13, CF-19). `periodo=mes|trimestre`; uno desconocido cae en `mes` como una
 * etapa desconocida cae en «todas»: mejor el consolidado entero que un 400 en un enlace guardado.
 *
 * Sin registro PII: el consolidado no lleva titular ni placa, solo el cliente (empresa) y cifras.
 */
router.get('/reporte-costos/consolidado', LECTURA, async (req: Request, res: Response) => {
  res.json(await consolidadoReporte(filtrosDe(req.query), periodoConsolidado(req.query.periodo)));
});

/**
 * GET /gastos-diarios — serie por día del evento y totales por categoría con GMF estimado (HU #12623).
 *
 * Guarda por PÁGINA y no por rol (`requirePage`, no `LECTURA`): la misma función que abre la
 * pantalla «Gastos diarios» (HU #12624) abre su consulta, así que quien reciba la página en el panel
 * de roles recibe la consulta con ella, y nadie más. Hasta que la migración siembre la función,
 * 403 para todos: es lo esperado.
 *
 * `desde`/`hasta` en `YYYY-MM-DD`; sin los dos, los últimos 30 días (hoy incluido, en Bogotá). Uno
 * solo, una fecha que no es un día, `hasta < desde` o más de 366 días → 400 nombrando el parámetro.
 * `empresas` con la misma `lista()` del reporte. Sin registro PII: la respuesta son días, cantidades
 * y sumas (motivo en la cabecera del servicio).
 */
router.get('/gastos-diarios', requirePage('finanzas_gastos_diarios'), async (req: Request, res: Response) => {
  const rango = resolverRango(str(req.query.desde), str(req.query.hasta));
  if (!rango.ok) { res.status(400).json({ error: rango.error, parametro: rango.parametro }); return; }
  res.json(await gastosDiarios(rango.rango, lista(req.query.empresas)));
});

// ── Exportación a Excel (HU #12531) ──────────────────────────────────────────

/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre (como `fecha()`). */
const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ser yyyy-mm-dd');
// Topes de tamaño (security diff-scoped, HU #12531): con la query la URL acotaba sola; con
// `express.json` de 5 MB un cuerpo podría traer miles de elementos y reventar el `IN` de Postgres.
const listaSchema = z.array(z.string().trim().min(1).max(120)).max(200).optional();

/**
 * Cuerpo del `POST /reporte-costos/export`: los MISMOS filtros que `filtrosDe` lee de la query, con
 * listas como arrays y `.strict()`.
 *
 * `.strict()` a propósito y con más motivo que en la query: un `{"organismo": "05001"}` —en
 * singular— se ignoraría en silencio y devolvería el reporte ENTERO a quien pidió el de un organismo.
 * En un archivo con nombre, documento, correo y dirección de los titulares, un filtro mal escrito
 * tiene que ser un 400 y no un export de más. Por lo mismo aquí una etapa, un estado de facturación o
 * un periodo desconocidos son 400 y no «todas»: el GET tolera el enlace guardado con un valor viejo;
 * el archivo no se guarda en favoritos, se pide desde la pantalla con lo que la pantalla enseña.
 *
 * Sin `page`/`pageSize`: el archivo es todo el filtro, no una página.
 */
const exportDetalleSchema = z.object({
  buscar: z.string().trim().min(1).max(120).optional(),
  estados: listaSchema, empresas: listaSchema, tipos: listaSchema, organismos: listaSchema,
  etapa: z.enum(ETAPAS).optional(),
  documentacionCompleta: z.boolean().optional(),
  conDiferencias: z.boolean().optional(),
  desde: fechaSchema.optional(), hasta: fechaSchema.optional(),
  aprobadoDesde: fechaSchema.optional(), aprobadoHasta: fechaSchema.optional(),
  estadoFacturacion: z.enum(SIIGO_ESTADOS_REPORTE).optional(),
}).strict();

/** El consolidado añade el eje: `periodo` (mes por defecto, como el GET). */
const exportConsolidadoSchema = exportDetalleSchema.extend({
  periodo: z.enum(PERIODOS_CONSOLIDADO).optional(),
}).strict();

/** `FiltrosReporte` a partir del cuerpo ya validado. Una lista vacía no filtra, como en `lista()`. */
function filtrosDeCuerpo(b: z.infer<typeof exportDetalleSchema>): FiltrosReporte {
  const noVacia = (l: string[] | undefined) => (l && l.length > 0 ? l : undefined);
  return {
    buscar: b.buscar, estados: noVacia(b.estados), empresas: noVacia(b.empresas), tipos: noVacia(b.tipos),
    etapa: b.etapa, documentacionCompleta: b.documentacionCompleta === true,
    conDiferencias: b.conDiferencias === true,
    desde: b.desde, hasta: b.hasta, aprobadoDesde: b.aprobadoDesde, aprobadoHasta: b.aprobadoHasta,
    estadoFacturacion: b.estadoFacturacion, organismos: noVacia(b.organismos),
  };
}

/** El 400 de un cuerpo que no pasa el esquema, igual en las dos rutas. */
const responderCuerpoInvalido = (res: Response, e: z.ZodError): void => {
  res.status(400).json({ error: 'Filtro inválido', details: e.flatten() });
};

/**
 * POST /reporte-costos/export — el detalle filtrado, en `.xlsx` (HU #12531). Sustituye al GET del
 * CSV: no existe variante GET —un `router.get` aquí devolvería `buscar` (placa, VIN, nombre,
 * documento) a la URL, a los logs de nginx y al `Referer` (AGENTS.md §14)—.
 *
 * Misma guarda de lectura que el resto del reporte (`LECTURA`): quien puede ver el reporte puede
 * llevárselo, y nadie más. `exportColaLimiter` es la MISMA bolsa de 5/min por usuario que SOAT e
 * Impuestos, y es una decisión, no un descuido: el recurso que se raciona es el heap del único
 * proceso —`sendExcel` arma el libro entero en memoria— y una bolsa propia le daría a una sesión el
 * doble de exports simultáneos sobre el presupuesto que ADR-0004 midió para cinco. Lo que se paga:
 * quien acaba de bajar cinco archivos de SOAT espera un minuto para el reporte de costos.
 *
 * Orden: validar → consultar (el tope lanza dentro) → `await` del rastro PII con el número de filas
 * → `Cache-Control: no-store` → archivo. El rastro va ANTES del primer byte (Ley 1581 art. 17).
 */
router.post('/reporte-costos/export', LECTURA, exportColaLimiter, async (req: Request, res: Response) => {
  const parsed = exportDetalleSchema.safeParse(req.body ?? {});
  if (!parsed.success) { responderCuerpoInvalido(res, parsed.error); return; }

  try {
    const filas = await filasParaExportar(filtrosDeCuerpo(parsed.data));
    // `filas.length` = las REALMENTE entregadas, no el tope ni lo pedido.
    await registrarAccesoPii(req, 'export', { filas: filas.length });
    res.set('Cache-Control', 'no-store');
    await sendExcel(
      res, nombreArchivoColaExport('reporte-costos'), [...COLUMNAS_EXPORT_DETALLE], filasExcelDetalle(filas),
      { nombreHoja: HOJA_DETALLE, autofiltro: true, fijarCabecera: true },
    );
  } catch (e) {
    // Con la respuesta ya empezada, responder reventaría con ERR_HTTP_HEADERS_SENT y taparía la
    // causa real: se relanza al manejador global.
    if (res.headersSent) throw e;
    if (e instanceof ExportColaDemasiadoGrandeError) {
      // 422 y no 400: la petición está bien formada; lo que no cabe es el RESULTADO. Sin cuerpo
      // xlsx y sin decir cuántas filas hay (el `tope + 1` existe para no contarlas).
      res.status(e.status).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

/**
 * POST /reporte-costos/consolidado/export — el consolidado cliente × periodo, en `.xlsx` (HU #12531).
 *
 * **Sin tope de filas, y es una decisión**: el consolidado agrupa EN SQL por (cliente, periodo), así
 * que lo que llega al proceso son los grupos —decenas de clientes por unos pocos periodos, cientos
 * de filas en el peor caso—, no los trámites. `TOPE_EXPORTACION` acota trámites y aquí no hay
 * trámites que acotar; un tope sobre grupos sería un número inventado sin medición detrás. Lo que
 * sí comparte es la bolsa de `exportColaLimiter`, por el mismo motivo que el detalle.
 *
 * Sin registro PII: el consolidado no lleva titular ni placa, solo el cliente (empresa) y cifras
 * (la misma decisión que su GET, HU #12433).
 */
router.post('/reporte-costos/consolidado/export', LECTURA, exportColaLimiter, async (req: Request, res: Response) => {
  const parsed = exportConsolidadoSchema.safeParse(req.body ?? {});
  if (!parsed.success) { responderCuerpoInvalido(res, parsed.error); return; }

  const consolidado = await consolidadoReporte(filtrosDeCuerpo(parsed.data), periodoConsolidado(parsed.data.periodo));
  res.set('Cache-Control', 'no-store');
  await sendExcel(
    res, nombreArchivoColaExport('consolidado-costos'), [...COLUMNAS_EXPORT_CONSOLIDADO],
    filasExcelConsolidado(consolidado),
    { nombreHoja: HOJA_CONSOLIDADO, autofiltro: true, fijarCabecera: true },
  );
});

/**
 * GET /tramites/:id/soportes — TODOS los documentos del trámite, en una sola respuesta.
 *
 * Cada flujo servía los suyos por su propia ruta, así que verlos obligaba a varias llamadas y a
 * saber de antemano cuáles existían. Aquí no se elige: se devuelve lo que haya, de los cuatro
 * orígenes. Lo que no exista simplemente no aparece.
 *
 * El armado vive en shared/soportes: la misma lista se sirve desde Gestión de trámites, y las de
 * un solo concepto desde el detalle de un SOAT o de un impuesto. Lo que cambia entre esas rutas es
 * el rol que entra, no cómo se arma la lista.
 */
router.get('/tramites/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const soportes = await soportesDeTramite(req.params.id);
  if (!soportes) { res.status(404).json({ error: 'El trámite no existe' }); return; }
  // Sin caché: un soporte cargado hace un minuto tiene que salir sin recargar la pantalla.
  res.set('Cache-Control', 'no-store');
  res.json(soportes);
});

/**
 * GET /tramites/:id/viajes-logistica — de qué se compone la celda «Logística» del reporte (HU #12627):
 * la tarifa (viaje 1) y cada viaje adicional, con su precio. Solo lectura.
 *
 * La MISMA guarda `LECTURA` que el reporte: quien puede ver la celda puede ver su desglose, y nadie
 * más. No se inventa una función del motor —el módulo `finanzas/` sigue vallado por rol
 * (`permisos.valla-legacy.test.ts`)—; registrar y quitar viajes viven en `flito-logistica` con las
 * suyas. Un id que no es uuid o que no existe es 404: el id es opaco.
 */
router.get('/tramites/:id/viajes-logistica', LECTURA, async (req: Request, res: Response) => {
  try {
    const desglose = await desgloseViajesLogistica(req.params.id);
    // Sin caché: un viaje registrado hace un minuto tiene que salir sin recargar la pantalla.
    res.set('Cache-Control', 'no-store');
    res.json(desglose);
  } catch (e) {
    if (e instanceof TramiteNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

export default router;
