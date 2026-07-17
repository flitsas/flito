import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, gte, lte, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { remesas, clients, propietariosCarga, destinatariosCarga, rndcMunicipios } from '../../db/schema.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('rndc'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Genera correlativo serializado bajo pg_advisory_xact_lock (migration 0048).
// Debe invocarse dentro de una transacción para que el lock sea efectivo.
type Executor = { execute: (q: any) => Promise<any> };
async function nextRemesaNumero(executor: Executor): Promise<string> {
  const result = await executor.execute(sql`SELECT fn_next_remesa_numero() AS numero`);
  const numero = (result as any)[0]?.numero;
  if (!numero) throw new Error('No se pudo generar número de remesa');
  return numero as string;
}

const remesaBaseSchema = z.object({
  clientId: z.number().int().positive().optional().nullable(),
  propietarioCargaId: z.number().int().positive().optional().nullable(),
  destinatarioCargaId: z.number().int().positive().optional().nullable(),
  municipioOrigenDane: z.string().length(5),
  municipioDestinoDane: z.string().length(5),
  direccionCargue: z.string().max(300).optional().nullable(),
  direccionDescargue: z.string().max(300).optional().nullable(),
  productoCodigo: z.string().max(10).optional().nullable(),
  naturaleza: z.enum(['carga_normal', 'carga_peligrosa', 'carga_refrigerada', 'carga_extradimensionada', 'carga_extrapesada']).default('carga_normal'),
  empaqueCodigo: z.string().max(10).optional().nullable(),
  unidadMedidaCodigo: z.string().max(10).optional().nullable(),
  cantidadCargada: z.number().positive(),
  pesoKg: z.number().positive().optional().nullable(),
  fechaCargue: z.string(),
  horaCargue: z.string().optional().nullable(),
  fechaDescargePactada: z.string().optional().nullable(),
  valorFlete: z.number().min(0).default(0),
  valorAnticipo: z.number().min(0).default(0),
  moneda: z.enum(['COP', 'USD']).default('COP'),
  modoPagoCodigo: z.string().max(10).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
});

const remesaSchema = remesaBaseSchema.refine(
  (r) => r.valorAnticipo <= r.valorFlete,
  { message: 'Anticipo no puede superar el flete' },
);

// LISTADO con filtros
router.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const clienteId = req.query.clienteId ? parseId(String(req.query.clienteId)) : null;
  const desde = req.query.desde as string | undefined;
  const hasta = req.query.hasta as string | undefined;
  const sinManifiesto = req.query.sinManifiesto === '1';

  const conds: any[] = [isNull(remesas.deletedAt)];
  if (estado) conds.push(eq(remesas.estado, estado as any));
  if (clienteId) conds.push(eq(remesas.clientId, clienteId));
  if (desde) conds.push(gte(remesas.fechaCargue, desde));
  if (hasta) conds.push(lte(remesas.fechaCargue, hasta));
  if (sinManifiesto) conds.push(isNull(remesas.manifiestoId));

  const rows = await db.select({
    id: remesas.id,
    numero: remesas.numero,
    consecutivoRndc: remesas.consecutivoRndc,
    estado: remesas.estado,
    clientId: remesas.clientId,
    clientName: clients.name,
    municipioOrigenDane: remesas.municipioOrigenDane,
    origenNombre: rndcMunicipios.nombre,
    municipioDestinoDane: remesas.municipioDestinoDane,
    cantidadCargada: remesas.cantidadCargada,
    pesoKg: remesas.pesoKg,
    valorFlete: remesas.valorFlete,
    fechaCargue: remesas.fechaCargue,
    manifiestoId: remesas.manifiestoId,
    cumplidoAt: remesas.cumplidoAt,
  })
    .from(remesas)
    .leftJoin(clients, eq(clients.id, remesas.clientId))
    .leftJoin(rndcMunicipios, eq(rndcMunicipios.codigoDane, remesas.municipioOrigenDane))
    .where(and(...conds))
    .orderBy(desc(remesas.fechaCargue), desc(remesas.id))
    .limit(500);
  res.json({ data: rows });
});

// DETALLE
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(remesas).where(eq(remesas.id, id)).limit(1);
  if (!row || row.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json({ data: row });
});

// CREAR — número correlativo dentro de la transacción (advisory lock vía fn_next_remesa_numero).
router.post('/', async (req: Request, res: Response) => {
  const parsed = remesaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const numero = await nextRemesaNumero(tx);
    const [row] = await tx.insert(remesas).values({
      numero,
      clientId: data.clientId ?? null,
      propietarioCargaId: data.propietarioCargaId ?? null,
      destinatarioCargaId: data.destinatarioCargaId ?? null,
      municipioOrigenDane: data.municipioOrigenDane,
      municipioDestinoDane: data.municipioDestinoDane,
      direccionCargue: data.direccionCargue ?? null,
      direccionDescargue: data.direccionDescargue ?? null,
      productoCodigo: data.productoCodigo ?? null,
      naturaleza: data.naturaleza,
      empaqueCodigo: data.empaqueCodigo ?? null,
      unidadMedidaCodigo: data.unidadMedidaCodigo ?? null,
      cantidadCargada: String(data.cantidadCargada),
      pesoKg: data.pesoKg != null ? String(data.pesoKg) : null,
      fechaCargue: data.fechaCargue,
      horaCargue: data.horaCargue ?? null,
      fechaDescargePactada: data.fechaDescargePactada ?? null,
      valorFlete: String(data.valorFlete),
      valorAnticipo: String(data.valorAnticipo),
      moneda: data.moneda,
      modoPagoCodigo: data.modoPagoCodigo ?? null,
      observaciones: data.observaciones ?? null,
      estado: 'borrador',
      createdBy: req.user?.sub ?? null,
    } as any).returning();
    return row;
  });
  await audit(req, { action: 'create', resource: 'remesa', resourceId: String(result.id), detail: result.numero });
  res.status(201).json({ data: result });
});

// EDITAR (solo borrador)
router.put('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [current] = await db.select().from(remesas).where(eq(remesas.id, id)).limit(1);
  if (!current || current.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (current.estado !== 'borrador' && current.estado !== 'activa') {
    res.status(409).json({ error: `No se puede editar una remesa en estado "${current.estado}"` }); return;
  }
  const parsed = remesaBaseSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const d = parsed.data;
  const updates: any = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined) continue;
    if (['cantidadCargada', 'pesoKg', 'valorFlete', 'valorAnticipo'].includes(k) && typeof v === 'number') {
      updates[k] = String(v);
    } else {
      updates[k] = v;
    }
  }
  const [row] = await db.update(remesas).set(updates).where(eq(remesas.id, id)).returning();
  await audit(req, { action: 'update', resource: 'remesa', resourceId: String(id) });
  res.json({ data: row });
});

// ACTIVAR (borrador → activa, lista para asignar manifiesto)
router.post('/:id/activar', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.update(remesas)
    .set({ estado: 'activa', updatedAt: new Date() })
    .where(and(eq(remesas.id, id), eq(remesas.estado, 'borrador'), isNull(remesas.deletedAt)))
    .returning();
  if (!row) { res.status(409).json({ error: 'Remesa no encontrada o no está en borrador' }); return; }
  await audit(req, { action: 'update', resource: 'remesa', resourceId: String(id), detail: 'activar' });
  res.json({ data: row });
});

// CUMPLIR (cierra con cantidad entregada)
const cumplirSchema = z.object({
  cantidadEntregada: z.number().positive(),
  observaciones: z.string().max(2000).optional(),
  evidenciaKeys: z.array(z.string()).max(20).optional(),
});

router.post('/:id/cumplir', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = cumplirSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }

  const [current] = await db.select().from(remesas).where(eq(remesas.id, id)).limit(1);
  if (!current || current.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (current.estado !== 'activa') {
    res.status(409).json({ error: `No se puede cumplir una remesa en estado "${current.estado}"` }); return;
  }
  if (parsed.data.cantidadEntregada > Number(current.cantidadCargada)) {
    res.status(400).json({ error: 'La cantidad entregada no puede superar la cantidad cargada' }); return;
  }

  const [row] = await db.update(remesas).set({
    estado: 'cumplida',
    cantidadEntregada: String(parsed.data.cantidadEntregada),
    cumplidoAt: new Date(),
    cumplidoObservaciones: parsed.data.observaciones ?? null,
    cumplidoEvidenciaKeys: parsed.data.evidenciaKeys ?? [],
    updatedAt: new Date(),
  } as any).where(eq(remesas.id, id)).returning();
  await audit(req, { action: 'update', resource: 'remesa', resourceId: String(id), detail: 'cumplir' });
  res.json({ data: row });
});

// ANULAR
router.post('/:id/anular', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ motivo: z.string().min(5).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Motivo requerido (mín 5 chars)' }); return; }
  const [row] = await db.update(remesas)
    .set({ estado: 'anulada', observaciones: sql`COALESCE(observaciones, '') || E'\n[ANULADA] ' || ${parsed.data.motivo}`, updatedAt: new Date() })
    .where(and(eq(remesas.id, id), isNull(remesas.deletedAt)))
    .returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'remesa', resourceId: String(id), detail: 'anular' });
  res.json({ data: row });
});

// ELIMINAR (soft, solo borrador)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.update(remesas)
    .set({ deletedAt: new Date(), deletedBy: req.user?.sub ?? null })
    .where(and(eq(remesas.id, id), eq(remesas.estado, 'borrador'), isNull(remesas.deletedAt)))
    .returning();
  if (!row) { res.status(409).json({ error: 'Solo se eliminan remesas en borrador' }); return; }
  await audit(req, { action: 'delete', resource: 'remesa', resourceId: String(id), detail: 'soft_delete' });
  res.json({ data: row });
});

export default router;
