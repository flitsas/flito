import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  PERSONA_TIPOS,
  SIIGO_ID_TIPOS_CODIGOS,
  RESPONSABILIDADES_FISCALES_CODIGOS,
  SUCURSAL_MINIMA,
  SUCURSAL_MAXIMA,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { maskName } from '../../shared/utils/pii.js';

const router = Router();
router.use(authMiddleware);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  document: z.string().max(20).optional(),
  documentType: z.string().max(5).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  notes: z.string().optional(),

  // ── Datos fiscales para Siigo (HU #11292) ────────────────────────────────
  //
  // A diferencia de `documentType` —cadena libre de hasta 5 caracteres que no se puede cerrar sin
  // romper filas existentes—, todo lo de aquí es enumeración cerrada desde el primer día. Un
  // `id_type` inventado no se descubre al guardarlo: se descubre cuando Siigo rechaza una factura.
  //
  // `.nullable()` en todos: la pantalla necesita poder BORRAR un dato fiscal mal capturado, y con
  // solo `.optional()` un campo omitido es indistinguible de uno que se quiere vaciar.
  personType: z.enum(PERSONA_TIPOS).nullable().optional(),
  idType: z.enum(SIIGO_ID_TIPOS_CODIGOS as [string, ...string[]]).nullable().optional(),
  checkDigit: z.number().int().min(0).max(9).nullable().optional(),
  fiscalResponsibilities: z.array(z.enum(RESPONSABILIDADES_FISCALES_CODIGOS as [string, ...string[]]))
    .max(RESPONSABILIDADES_FISCALES_CODIGOS.length).optional(),
  countryCode: z.string().length(2).nullable().optional(),
  stateCode: z.string().max(5).nullable().optional(),
  cityCode: z.string().max(10).nullable().optional(),
  commercialName: z.string().max(200).nullable().optional(),
  branchOffice: z.number().int().min(SUCURSAL_MINIMA).max(SUCURSAL_MAXIMA).optional(),
  contactFirstName: z.string().max(100).nullable().optional(),
  contactLastName: z.string().max(100).nullable().optional(),
  contactEmail: z.string().email().max(150).nullable().optional(),
  // Siigo los quiere numéricos y de 10 como máximo. El mismo CHECK está en la 0132.
  phoneIndicative: z.string().regex(/^[0-9]{1,10}$/, 'Solo dígitos, máximo 10').nullable().optional(),
  phoneNumber: z.string().regex(/^[0-9]{1,10}$/, 'Solo dígitos, máximo 10').nullable().optional(),
});

// Lectura alineada con la del módulo fusionado (HU #10979): antes bastaba con estar autenticado,
// mientras que su gemelo `GET /flito/parametrizacion/companias` —la misma tabla— exigía rol. Dos
// puertas distintas a los mismos datos no es una decisión, es un descuido.
const LECTURA = requireRole('admin', 'auditor', 'financiera');

/**
 * Campos fiscales que se pueden escribir en la auditoría tal cual.
 *
 * Son códigos de catálogo, no datos personales. Los de contacto —nombres, apellidos, correo,
 * teléfono— quedan fuera a propósito: dejar un correo en `audit_logs` es meter PII en una tabla que
 * nadie purga (Ley 1581). De esos se registra QUÉ cambió, no a qué valor.
 */
const CAMPOS_FISCALES_TRAZABLES = [
  'personType', 'idType', 'checkDigit', 'fiscalResponsibilities',
  'countryCode', 'stateCode', 'cityCode', 'branchOffice',
] as const;

const CAMPOS_FISCALES_PII = [
  'commercialName', 'contactFirstName', 'contactLastName', 'contactEmail',
  'phoneIndicative', 'phoneNumber',
] as const;

function comoTexto(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  return Array.isArray(v) ? (v.length === 0 ? '∅' : v.join('+')) : String(v);
}

/**
 * Resumen «antes → después» de los datos fiscales para la auditoría (AC7).
 *
 * Devuelve cadena vacía si no cambió ninguno, para no ensuciar la auditoría de las ediciones
 * normales de un cliente con ruido de facturación.
 */
function diffFiscal(antes: Record<string, unknown>, despues: Record<string, unknown>): string {
  const partes: string[] = [];
  for (const campo of CAMPOS_FISCALES_TRAZABLES) {
    const a = comoTexto(antes[campo]);
    const d = comoTexto(despues[campo]);
    if (a !== d) partes.push(`${campo}: ${a} → ${d}`);
  }
  for (const campo of CAMPOS_FISCALES_PII) {
    if (comoTexto(antes[campo]) !== comoTexto(despues[campo])) partes.push(`${campo}: modificado`);
  }
  return partes.join(' · ');
}

/**
 * En Siigo la identidad de un tercero es la pareja (identificación, sucursal): el mismo número solo
 * puede repetirse si la sucursal es distinta (AC5).
 *
 * Se comprueba aquí y no con un índice único porque los datos actuales ya traen duplicados —la
 * migración 0132 los deja señalados en vez de fallar— y un índice único no se puede crear sobre
 * ellos. La restricción de base entra cuando esos conflictos estén resueltos; hasta entonces esto
 * evita que la cartera siga creciendo con parejas repetidas.
 */
async function parejaOcupada(document: string, branchOffice: number, excluirId?: number) {
  const mismos = and(
    sql`trim(upper(${clients.document})) = ${document.trim().toUpperCase()}`,
    eq(clients.branchOffice, branchOffice),
    excluirId === undefined ? undefined : ne(clients.id, excluirId),
  );
  const [fila] = await db.select({ id: clients.id }).from(clients).where(mismos).limit(1);
  return fila !== undefined;
}

router.get('/', LECTURA, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const result = await db.select().from(clients).orderBy(clients.name).limit(limit).offset(offset);
  res.json(result);
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const datos = parsed.data;
  if (datos.document && datos.document.trim() !== '') {
    if (await parejaOcupada(datos.document, datos.branchOffice ?? 0)) {
      res.status(409).json({
        error: 'Ya existe un cliente con esa identificación en esa sucursal. En Siigo serían el mismo tercero.',
        campo: 'document',
      });
      return;
    }
  }

  const [client] = await db.insert(clients).values(datos).returning();
  await audit(req, {
    action: 'create',
    resource: 'client',
    resourceId: String(client.id),
    detail: `Cliente: ${maskName(client.name)}`,
  });
  res.status(201).json(client);
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  // Se lee ANTES de escribir: sin el estado previo no hay «valor anterior» que auditar (AC7), y
  // tampoco se puede saber contra qué sucursal validar cuando el PATCH solo trae uno de los dos.
  const [previo] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!previo) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  const cambios = parsed.data;
  const documento = cambios.document ?? previo.document;
  const sucursal = cambios.branchOffice ?? previo.branchOffice;
  const tocaIdentidad = cambios.document !== undefined || cambios.branchOffice !== undefined;
  if (tocaIdentidad && documento && documento.trim() !== '') {
    if (await parejaOcupada(documento, sucursal, id)) {
      res.status(409).json({
        error: 'Ya existe otro cliente con esa identificación en esa sucursal. En Siigo serían el mismo tercero.',
        campo: 'document',
      });
      return;
    }
  }

  const [updated] = await db.update(clients).set(cambios).where(eq(clients.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  // Su gemelo de parametrización sí auditaba; este no. Cambiar los datos de un cliente sin dejar
  // rastro es peor aquí, donde además se editan sus datos de contacto.
  const fiscal = diffFiscal(previo as Record<string, unknown>, updated as Record<string, unknown>);
  await audit(req, {
    action: 'update',
    resource: 'client',
    resourceId: String(id),
    detail: `Cliente actualizado: ${maskName(updated.name)}${fiscal ? ` · Datos fiscales — ${fiscal}` : ''}`,
  });
  res.json(updated);
});

export default router;
