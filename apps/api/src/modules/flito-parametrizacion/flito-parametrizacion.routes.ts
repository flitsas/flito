// FLITO — parametrización (HTTP). Portado de packages/server/src/parametrizacion.
//
// Toda la parametrización es de `operaciones`, con lectura para `auditor`. Los gestores
// NO entran: un gestor que pudiera cambiar el umbral de OCR de su proveedor podría hacer
// que sus propias facturas pasaran sin revisión (RN-04).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients,
  flitoImpuestos,
  flitoOrganismoVigencias,
  flitoProveedoresSoat,
  flitoReglasProveedorSoat,
  organismosTransitoConfig,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  AmbitoReglaProveedor,
  CONCEPTOS_TARIFA,
  EstadoImpuesto,
  ModalidadOrganismo,
  ORGANISMOS_TRANSITO,
  PRIORIDAD_POR_AMBITO,
} from '@operaciones/shared-types';
import { modalidadVigente } from './flito-parametrizacion.service.js';
import {
  actualizarTarifa, crearTarifa, eliminarTarifa, listarTarifas, TarifaError,
} from './flito-tarifas.service.js';

const router = Router();
router.use(authMiddleware);

// Lectura: operaciones + auditoría (solo lectura). Escritura: solo operaciones.
const LECTURA = requireRole('admin', 'auditor');
const ESCRITURA = requireRole('admin');
// Las TARIFAS son la parte comercial del cliente: las negocia Finanzas, así que también las escribe.
// El resto de la parametrización (umbrales de OCR, SLA, modalidad, autogestión) sigue siendo solo de
// Operaciones — RN-04: un gestor que pudiera mover su propio umbral colaría sus facturas sin revisar.
const ESCRITURA_TARIFAS = requireRole('admin', 'financiera');
const LECTURA_TARIFAS = requireRole('admin', 'auditor', 'financiera');

// ───────────────────────────────── Compañías (sobre `clients`) ──────────────

function companiaDto(c: typeof clients.$inferSelect) {
  return {
    id: c.id,
    nombre: c.name,
    nit: c.document,
    soatAutogestionable: c.soatAutogestionable,
    // Feature #11912 — «SOAT sin trámite»: el canal por el que un usuario `cliente` de esta compañía
    // le pide a FLITO un SOAT sin que haya trámite digital abierto. Campo APARTE y no derivado de
    // `soatAutogestionable`: son dos preguntas distintas y las dos encendidas a la vez es una
    // combinación válida (AC3).
    soatSinTramite: c.soatSinTramite,
    impuestosAutogestionable: c.impuestosAutogestionable,
    logisticaAutogestionable: c.logisticaAutogestionable,
    logisticaPermiteParcial: c.logisticaPermiteParcial,
    carpetaStorage: c.flitoCarpetaStorage,
    toleranciaValorImpuesto: Number(c.flitoToleranciaValorImpuesto),
  };
}

router.get('/companias', LECTURA, async (_req: Request, res: Response) => {
  const filas = await db.select().from(clients).orderBy(asc(clients.name));
  res.json(filas.map(companiaDto));
});

const actualizarCompaniaSchema = z.object({
  soatAutogestionable: z.boolean().optional(),
  soatSinTramite: z.boolean().optional(),
  impuestosAutogestionable: z.boolean().optional(),
  logisticaAutogestionable: z.boolean().optional(),
  logisticaPermiteParcial: z.boolean().optional(),
  carpetaStorage: z.string().max(300).nullable().optional(),
  toleranciaValorImpuesto: z.number().min(0, 'La tolerancia no puede ser negativa').optional(),
});

router.patch('/companias/:id', ESCRITURA, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = actualizarCompaniaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;
  const set: Partial<typeof clients.$inferInsert> = {};
  if (cambios.soatAutogestionable !== undefined) set.soatAutogestionable = cambios.soatAutogestionable;
  // Cada bandera se escribe SOLA. Un `set.soatSinTramite = false` colgado del `if` de la autogestión
  // sería justo lo que el AC3 prohíbe: apagar una y que se apague la otra.
  if (cambios.soatSinTramite !== undefined) set.soatSinTramite = cambios.soatSinTramite;
  if (cambios.impuestosAutogestionable !== undefined) set.impuestosAutogestionable = cambios.impuestosAutogestionable;
  if (cambios.logisticaAutogestionable !== undefined) set.logisticaAutogestionable = cambios.logisticaAutogestionable;
  if (cambios.logisticaPermiteParcial !== undefined) set.logisticaPermiteParcial = cambios.logisticaPermiteParcial;
  if (cambios.carpetaStorage !== undefined) set.flitoCarpetaStorage = cambios.carpetaStorage;
  if (cambios.toleranciaValorImpuesto !== undefined) set.flitoToleranciaValorImpuesto = String(cambios.toleranciaValorImpuesto);

  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  const [updated] = await db.update(clients).set(set).where(eq(clients.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'La compañía no existe' }); return; }

  await audit(req, {
    action: 'update',
    resource: 'flito_compania',
    resourceId: String(id),
    detail: `Parametrización compañía ${updated.name}`,
  });
  res.json(companiaDto(updated));
});

// ───────────────────────────────── Proveedores de SOAT ──────────────────────

function proveedorDto(p: typeof flitoProveedoresSoat.$inferSelect) {
  return {
    id: p.id,
    nombre: p.nombre,
    estrategia: p.estrategia,
    umbralOcr: p.umbralOcr === null ? null : Number(p.umbralOcr),
    slaHoras: p.slaHoras,
    activo: p.activo,
  };
}

router.get('/proveedores-soat', LECTURA, async (_req: Request, res: Response) => {
  const filas = await db.select().from(flitoProveedoresSoat).orderBy(asc(flitoProveedoresSoat.nombre));
  res.json(filas.map(proveedorDto));
});

const crearProveedorSchema = z.object({
  nombre: z.string().min(1).max(150),
  estrategia: z.string().max(40).optional(),
  umbralOcr: z.number().min(0).max(1).nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
});

router.post('/proveedores-soat', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = crearProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { nombre, estrategia, umbralOcr, slaHoras } = parsed.data;

  const [existente] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat)
    .where(eq(flitoProveedoresSoat.nombre, nombre)).limit(1);
  if (existente) { res.status(409).json({ error: 'Ya existe un proveedor con ese nombre' }); return; }

  const [creado] = await db.insert(flitoProveedoresSoat).values({
    nombre,
    ...(estrategia !== undefined ? { estrategia } : {}),
    umbralOcr: umbralOcr === undefined || umbralOcr === null ? null : String(umbralOcr),
    slaHoras: slaHoras ?? null,
  }).returning();

  await audit(req, { action: 'create', resource: 'flito_proveedor_soat', resourceId: creado.id, detail: `Proveedor SOAT: ${nombre}` });
  res.status(201).json(proveedorDto(creado));
});

const actualizarProveedorSchema = z.object({
  nombre: z.string().min(1).max(150).optional(),
  estrategia: z.string().max(40).optional(),
  umbralOcr: z.number().min(0, 'El umbral de OCR debe estar entre 0 y 1').max(1, 'El umbral de OCR debe estar entre 0 y 1').nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
  activo: z.boolean().optional(),
});

router.patch('/proveedores-soat/:id', ESCRITURA, async (req: Request, res: Response) => {
  const id = req.params.id;
  const parsed = actualizarProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;
  const set: Partial<typeof flitoProveedoresSoat.$inferInsert> = {};
  if (cambios.nombre !== undefined) set.nombre = cambios.nombre;
  if (cambios.estrategia !== undefined) set.estrategia = cambios.estrategia;
  if (cambios.umbralOcr !== undefined) set.umbralOcr = cambios.umbralOcr === null ? null : String(cambios.umbralOcr);
  if (cambios.slaHoras !== undefined) set.slaHoras = cambios.slaHoras;
  if (cambios.activo !== undefined) set.activo = cambios.activo;

  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  const [updated] = await db.update(flitoProveedoresSoat).set(set).where(eq(flitoProveedoresSoat.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'El proveedor no existe' }); return; }

  await audit(req, { action: 'update', resource: 'flito_proveedor_soat', resourceId: id, detail: `Parametrización proveedor ${updated.nombre}` });
  res.json(proveedorDto(updated));
});

// ───────────────────────────────── Organismos + modalidad ───────────────────

async function organismoDto(codigo: string) {
  const [org] = await db.select().from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  if (!org) return null;
  const modalidad = await modalidadVigente(codigo);
  return {
    codigo: org.codigo,
    nombre: org.alias ?? org.codigo,
    alias: org.alias,
    activo: org.activo,
    modalidadVigente: modalidad,
    umbralOcr: org.flitoUmbralOcr === null ? null : Number(org.flitoUmbralOcr),
    slaHoras: org.flitoSlaHoras,
    diferenciaValorActiva: org.flitoDiferenciaValorActiva,
    // Derechos de trámite (HU #10950/#10952): pista de OCR y carpeta de Drive del organismo.
    ocrPromptHint: org.flitoOcrPromptHint,
    driveFolderId: org.flitoDriveFolderId,
    driveActivo: org.flitoDriveActivo,
  };
}

router.get('/organismos', LECTURA, async (_req: Request, res: Response) => {
  const filas = await db.select().from(organismosTransitoConfig).orderBy(asc(organismosTransitoConfig.codigo));
  const dtos = await Promise.all(filas.map((o) => organismoDto(o.codigo)));
  res.json(dtos.filter(Boolean));
});

/**
 * Garantiza que exista la fila de config del organismo, creándola desde el catálogo nacional si aún no
 * estaba sembrada. Permite clasificar/parametrizar CUALQUIER secretaría (no solo las del seed): la
 * modalidad por defecto ya es AUTOGESTIONADO (ver modalidadVigente). Devuelve false solo si el código no
 * corresponde a un organismo real del catálogo.
 */
async function asegurarConfigOrganismo(codigo: string): Promise<boolean> {
  const [existe] = await db.select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  if (existe) return true;
  const enCatalogo = ORGANISMOS_TRANSITO.find((o) => o.codigo === codigo);
  if (!enCatalogo) return false;
  await db.insert(organismosTransitoConfig)
    .values({ codigo, alias: `Tránsito de ${enCatalogo.ciudad}` })
    .onConflictDoNothing();
  return true;
}

router.get('/organismos/:codigo/vigencias', LECTURA, async (req: Request, res: Response) => {
  const codigo = req.params.codigo;
  const filas = await db.select().from(flitoOrganismoVigencias)
    .where(eq(flitoOrganismoVigencias.organismoCodigo, codigo))
    .orderBy(desc(flitoOrganismoVigencias.desde));
  res.json(filas.map((v) => ({
    id: v.id,
    modalidad: v.modalidad,
    desde: v.desde.toISOString(),
    hasta: v.hasta ? v.hasta.toISOString() : null,
    motivo: v.motivo,
    actorNombre: v.actorNombre,
    creadoEn: v.createdAt.toISOString(),
  })));
});

const cambiarModalidadSchema = z.object({
  modalidad: z.enum([
    ModalidadOrganismo.REQUIERE_GESTION,
    ModalidadOrganismo.AUTOGESTIONADO,
  ]),
  motivo: z.string().min(5, 'El motivo debe explicar el porqué del cambio'),
});

/**
 * Cambia la modalidad: cierra la vigencia anterior y abre una nueva (CA-04, nunca sobrescribe). Los
 * impuestos ya sincronizados conservan su estado; los nuevos trámites toman la modalidad vigente en el
 * próximo sync. El motivo es obligatorio para la auditoría.
 */
router.post('/organismos/:codigo/modalidad', ESCRITURA, async (req: Request, res: Response) => {
  const codigo = req.params.codigo;
  const parsed = cambiarModalidadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { modalidad, motivo } = parsed.data;

  // Crea la fila de config al vuelo si el organismo del catálogo aún no estaba sembrado (así se puede
  // clasificar cualquier secretaría, no solo las del seed).
  if (!(await asegurarConfigOrganismo(codigo))) { res.status(404).json({ error: 'El organismo no existe' }); return; }

  const anterior = await modalidadVigente(codigo);
  if (anterior === modalidad) { res.status(400).json({ error: `El organismo ya está en modalidad "${modalidad}"` }); return; }

  const ahora = new Date();
  await db.transaction(async (tx) => {
    await tx.update(flitoOrganismoVigencias).set({ hasta: ahora })
      .where(and(eq(flitoOrganismoVigencias.organismoCodigo, codigo), sql`hasta IS NULL`));
    await tx.insert(flitoOrganismoVigencias).values({
      organismoCodigo: codigo, modalidad, desde: ahora, hasta: null,
      motivo: motivo.trim(), actorId: req.user!.sub, actorNombre: req.user!.username,
    });
  });

  await audit(req, {
    action: 'update', resource: 'flito_organismo', resourceId: codigo,
    detail: `Modalidad ${anterior} → ${modalidad}. Motivo: ${motivo.trim()}`,
  });
  res.json(await organismoDto(codigo));
});

const actualizarOrganismoSchema = z.object({
  umbralOcr: z.number().min(0).max(1).nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
  // D-5 (Fase 7): activa/desactiva la marca de diferencia de valor de impuestos por organismo.
  diferenciaValorActiva: z.boolean().optional(),
  // HU #10950: pista que se concatena al prompt genérico de derechos de trámite. Cadena vacía = quitar.
  ocrPromptHint: z.string().max(500).nullable().optional(),
  // HU #10952: carpeta de Drive del organismo y su interruptor. Configurar no es activar: se puede
  // dejar la carpeta puesta con la sincronización apagada mientras se valida.
  driveFolderId: z.string().max(120).nullable().optional(),
  driveActivo: z.boolean().optional(),
});

router.patch('/organismos/:codigo', ESCRITURA, async (req: Request, res: Response) => {
  const codigo = req.params.codigo;
  const parsed = actualizarOrganismoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;
  const set: Partial<typeof organismosTransitoConfig.$inferInsert> = {};
  if (cambios.umbralOcr !== undefined) set.flitoUmbralOcr = cambios.umbralOcr === null ? null : String(cambios.umbralOcr);
  if (cambios.slaHoras !== undefined) set.flitoSlaHoras = cambios.slaHoras;
  if (cambios.diferenciaValorActiva !== undefined) set.flitoDiferenciaValorActiva = cambios.diferenciaValorActiva;
  if (cambios.ocrPromptHint !== undefined) set.flitoOcrPromptHint = cambios.ocrPromptHint?.trim() || null;
  if (cambios.driveFolderId !== undefined) set.flitoDriveFolderId = cambios.driveFolderId?.trim() || null;
  if (cambios.driveActivo !== undefined) set.flitoDriveActivo = cambios.driveActivo;
  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  // Igual que en el cambio de modalidad: crea la config si el organismo del catálogo no estaba sembrado.
  if (!(await asegurarConfigOrganismo(codigo))) { res.status(404).json({ error: 'El organismo no existe' }); return; }
  const [updated] = await db.update(organismosTransitoConfig).set(set).where(eq(organismosTransitoConfig.codigo, codigo)).returning();
  if (!updated) { res.status(404).json({ error: 'El organismo no existe' }); return; }

  const detalleDif = cambios.diferenciaValorActiva === undefined ? '' : `; diferencia de valor ${cambios.diferenciaValorActiva ? 'activada' : 'desactivada'}`;
  const detalleDrive = cambios.driveActivo === undefined ? '' : `; sincronización Drive ${cambios.driveActivo ? 'activada' : 'desactivada'}`;
  await audit(req, { action: 'update', resource: 'flito_organismo', resourceId: codigo, detail: `Parámetros OCR/SLA organismo ${codigo}${detalleDif}${detalleDrive}` });
  res.json(await organismoDto(codigo));
});

// Las reglas de enrutamiento de proveedor se retiraron en la HU #10979: el proveedor se elige al
// enviar el SOAT al gestor, que es cuando alguien mira la carga de cada uno. La tabla
// `flito_reglas_proveedor_soat` se deja en la base a propósito —borrar datos en el mismo cambio que
// quita su único lector es innecesariamente irreversible— y su DROP irá en una migración posterior.

// ───────────────────────────────── Tarifas por compañía ────────────────────
//
// El valor negociado del trámite digital y de la logística. Antes eran constantes iguales para
// todos los clientes; el requerimiento cita $200.000 en una compañía y $1.500 en otra.

const tarifaCrearSchema = z.object({
  companiaId: z.number().int().positive(),
  concepto: z.enum(CONCEPTOS_TARIFA),
  // Vacío o ausente = tarifa genérica del concepto.
  tipoTramite: z.string().trim().max(60).optional().nullable(),
  valor: z.number().nonnegative(),
  activo: z.boolean().optional(),
});
const tarifaEditarSchema = z.object({
  valor: z.number().nonnegative().optional(),
  activo: z.boolean().optional(),
}).refine((d) => d.valor !== undefined || d.activo !== undefined, { message: 'Nada que actualizar' });

/** TarifaError es de negocio (400); cualquier otra cosa sube y la maneja el error handler. */
function tarifaFallo(res: Response, e: unknown): void {
  if (e instanceof TarifaError) { res.status(400).json({ error: e.message }); return; }
  throw e;
}

router.get('/tarifas', LECTURA_TARIFAS, async (req: Request, res: Response) => {
  const companiaId = Number(req.query.companiaId) || undefined;
  res.json(await listarTarifas(companiaId));
});

router.post('/tarifas', ESCRITURA_TARIFAS, async (req: Request, res: Response) => {
  const parsed = tarifaCrearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  try {
    const t = await crearTarifa(parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_tarifa', resourceId: t.id,
      detail: `Tarifa ${t.concepto}${t.tipoTramite ? ` (${t.tipoTramite})` : ' (genérica)'} = ${t.valor} para ${t.companiaNombre ?? t.companiaId}`,
    });
    res.status(201).json(t);
  } catch (e) { tarifaFallo(res, e); }
});

router.patch('/tarifas/:id', ESCRITURA_TARIFAS, async (req: Request, res: Response) => {
  const parsed = tarifaEditarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  try {
    const t = await actualizarTarifa(req.params.id, parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_tarifa', resourceId: t.id,
      detail: `Tarifa ${t.concepto}${t.tipoTramite ? ` (${t.tipoTramite})` : ' (genérica)'} = ${t.valor}, activa=${t.activo}`,
    });
    res.json(t);
  } catch (e) { tarifaFallo(res, e); }
});

router.delete('/tarifas/:id', ESCRITURA_TARIFAS, async (req: Request, res: Response) => {
  try {
    await eliminarTarifa(req.params.id);
    await audit(req, { action: 'delete', resource: 'flito_tarifa', resourceId: req.params.id, detail: 'Tarifa eliminada' });
    res.status(204).end();
  } catch (e) { tarifaFallo(res, e); }
});

export default router;
