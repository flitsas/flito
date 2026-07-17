// TRAM-INNOV-B5-MVP — liquidación + pago manual (sin pasarela, sin PCI).

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { liquidaciones, liquidacionItems, pagos } from '../../db/schema.js';

export interface ItemInput { descripcion: string; cantidad: number; valorUnitario: number }

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

export interface LiquidacionDto {
  id: number;
  woId: number | null;
  tramiteId: number | null;
  estado: string;
  total: number;
  nota: string | null;
  createdAt: string;
  confirmadaAt: string | null;
  items: { id: number; descripcion: string; cantidad: number; valorUnitario: number; subtotal: number }[];
  pagos: { id: number; metodo: string; estado: string; monto: number; referencia: string | null; nota: string | null; createdAt: string }[];
}

export async function getLiquidacion(id: number): Promise<LiquidacionDto | null> {
  const [liq] = await db.select().from(liquidaciones).where(eq(liquidaciones.id, id)).limit(1);
  if (!liq) return null;
  const items = await db.select().from(liquidacionItems).where(eq(liquidacionItems.liquidacionId, id));
  const pagosRows = await db.select().from(pagos).where(eq(pagos.liquidacionId, id)).orderBy(desc(pagos.createdAt));
  return {
    id: liq.id, woId: liq.woId, tramiteId: liq.tramiteId, estado: liq.estado,
    total: num(liq.total), nota: liq.nota,
    createdAt: (liq.createdAt as Date).toISOString(),
    confirmadaAt: liq.confirmadaAt ? (liq.confirmadaAt as Date).toISOString() : null,
    items: items.map((i) => ({ id: i.id, descripcion: i.descripcion, cantidad: num(i.cantidad), valorUnitario: num(i.valorUnitario), subtotal: num(i.subtotal) })),
    pagos: pagosRows.map((p) => ({ id: p.id, metodo: p.metodo, estado: p.estado, monto: num(p.monto), referencia: p.referencia, nota: p.nota, createdAt: (p.createdAt as Date).toISOString() })),
  };
}

export async function listLiquidaciones(filtro: { woId?: number; tramiteId?: number }): Promise<LiquidacionDto[]> {
  const conds = [];
  if (filtro.woId) conds.push(eq(liquidaciones.woId, filtro.woId));
  if (filtro.tramiteId) conds.push(eq(liquidaciones.tramiteId, filtro.tramiteId));
  const rows = await db.select({ id: liquidaciones.id }).from(liquidaciones)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(liquidaciones.createdAt));
  const out: LiquidacionDto[] = [];
  for (const r of rows) { const d = await getLiquidacion(r.id); if (d) out.push(d); }
  return out;
}

export async function crearLiquidacion(opts: {
  woId?: number | null; tramiteId?: number | null; items: ItemInput[]; nota?: string | null; userId: number | null;
}): Promise<LiquidacionDto> {
  const itemsCalc = opts.items.map((i) => ({ ...i, subtotal: round2(num(i.cantidad) * num(i.valorUnitario)) }));
  const total = round2(itemsCalc.reduce((s, i) => s + i.subtotal, 0));

  const [liq] = await db.insert(liquidaciones).values({
    woId: opts.woId ?? null, tramiteId: opts.tramiteId ?? null, estado: 'borrador',
    total: String(total), nota: opts.nota ?? null, createdBy: opts.userId,
  }).returning({ id: liquidaciones.id });

  if (itemsCalc.length) {
    await db.insert(liquidacionItems).values(itemsCalc.map((i) => ({
      liquidacionId: liq.id, descripcion: i.descripcion,
      cantidad: String(i.cantidad), valorUnitario: String(i.valorUnitario), subtotal: String(i.subtotal),
    })));
  }
  return (await getLiquidacion(liq.id))!;
}

export type ConfirmarPagoResult =
  | { ok: true; liquidacion: LiquidacionDto }
  | { ok: false; code: 'not_found' | 'anulada' };

export async function confirmarPago(opts: {
  liquidacionId: number; monto: number; metodo?: string; referencia?: string | null; nota?: string | null; userId: number | null;
}): Promise<ConfirmarPagoResult> {
  const [liq] = await db.select({ id: liquidaciones.id, estado: liquidaciones.estado })
    .from(liquidaciones).where(eq(liquidaciones.id, opts.liquidacionId)).limit(1);
  if (!liq) return { ok: false, code: 'not_found' };
  if (liq.estado === 'anulada') return { ok: false, code: 'anulada' };

  await db.insert(pagos).values({
    liquidacionId: opts.liquidacionId, metodo: opts.metodo || 'manual', estado: 'manual_confirmado',
    monto: String(round2(num(opts.monto))), referencia: opts.referencia ?? null, nota: opts.nota ?? null, createdBy: opts.userId,
  });
  await db.update(liquidaciones).set({ estado: 'confirmada', confirmadaAt: new Date() })
    .where(eq(liquidaciones.id, opts.liquidacionId));

  return { ok: true, liquidacion: (await getLiquidacion(opts.liquidacionId))! };
}
