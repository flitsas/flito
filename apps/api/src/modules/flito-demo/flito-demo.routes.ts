// FLITO — panel de demostración: fábrica del FLIT simulado. Portado de
// packages/server/src/demo (solo la parte de trámites mock; la generación de facturas/recibos
// depende del OCR y llega en la Fase 3). Todo esto existe solo mientras no haya FLIT real; se
// retira cuando llegue el adaptador HTTP, sin que el dominio se caiga.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoMockTramite, organismosTransitoConfig } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { env } from '../../config/env.js';
import { EstadoTramiteFlito, TipoPropiedad } from '@operaciones/shared-types';
import { PROCESS_STATUS, estadoDesdeProcessStatus, processStatusDesdeEstado } from '../flito-sync/flit-mock.adapter.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('operaciones'));

// Crear/mover trámites solo tiene sentido con FLIT simulado. Con FLIT_ADAPTER=http este panel
// escribiría en una tabla que la sincronización ya no lee: el trámite se crearía y no aparecería
// en ninguna cola. Es preferible negarse y decirlo.
function guardMock(res: Response): boolean {
  if (env.FLIT_ADAPTER !== 'mock') {
    res.status(400).json({ error: `FLIT_ADAPTER="${env.FLIT_ADAPTER}": los trámites vienen de FLIT, no se fabrican aquí.` });
    return false;
  }
  return true;
}

const MARCAS = [
  { marca: 'Tesla', linea: 'Model 3', cilindraje: 0, capacidad: 5, tipo: 'Automóvil' },
  { marca: 'Renault', linea: 'Logan', cilindraje: 1600, capacidad: 5, tipo: 'Automóvil' },
  { marca: 'Chevrolet', linea: 'Onix', cilindraje: 1200, capacidad: 5, tipo: 'Automóvil' },
  { marca: 'Yamaha', linea: 'FZ 2.0', cilindraje: 150, capacidad: 2, tipo: 'Motocicleta' },
  { marca: 'Mazda', linea: 'CX-30', cilindraje: 2000, capacidad: 5, tipo: 'Camioneta' },
];
const NOMBRES = ['Ana María Restrepo', 'Carlos Andrés Gómez', 'Luisa Fernanda Ortiz', 'Julián David Herrera', 'Paula Andrea Cardona', 'Santiago Betancur'];

let contador = 0;

function generarVin(): string {
  const alfabeto = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'; // sin I, O ni Q (estándar VIN)
  return Array.from({ length: 17 }, () => alfabeto[Math.floor(Math.random() * alfabeto.length)]).join('');
}
function generarPlaca(esMoto: boolean): string {
  const letras = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const numeros = String(Math.floor(10 + Math.random() * 89));
  const final = esMoto ? String.fromCharCode(65 + Math.floor(Math.random() * 26)) : String(Math.floor(Math.random() * 10));
  return `${letras}${numeros}${final}`;
}
function comprador(indice: number, porcentaje: number) {
  const nombre = NOMBRES[(contador + indice) % NOMBRES.length];
  return {
    nombreCompleto: nombre,
    numeroDocumento: String(1_000_000_000 + Math.floor(Math.random() * 99_999_999)),
    correo: `${nombre.split(' ')[0].toLowerCase()}${indice}@ejemplo.co`,
    celular: `30${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    direccion: `Calle ${10 + indice} # ${20 + indice} - ${30 + indice}, Medellín`,
    porcentajeParticipacion: porcentaje,
  };
}
function valorImpuesto(cilindraje: number): number {
  const base = cilindraje === 0 ? 180_000 : Math.round(cilindraje * 190);
  return Math.round(base / 1000) * 1000;
}

type MockRow = typeof flitoMockTramite.$inferSelect;
function aDto(t: MockRow) {
  return {
    idFlit: t.idFlit,
    estado: estadoDesdeProcessStatus(t.processStatus),
    processStatus: t.processStatus,
    placa: t.placa,
    vin: t.vin,
    marca: t.marca,
    linea: t.linea,
    companiaNit: t.companiaNit,
    organismoCodigo: t.organismoCodigo,
    tipoPropiedad: t.tipoPropiedad,
    valorImpuestoLiquidado: t.valorImpuestoLiquidado === null ? null : Number(t.valorImpuestoLiquidado),
    creadoEn: t.createdAt.toISOString(),
  };
}

router.get('/tramites', async (_req: Request, res: Response) => {
  const filas = await db.select().from(flitoMockTramite).orderBy(desc(flitoMockTramite.createdAt)).limit(200);
  res.json(filas.map(aDto));
});

const crearSchema = z.object({
  companiaId: z.number().int().positive(),
  organismoCodigo: z.string().min(1).max(5),
  tipoPropiedad: z.enum([TipoPropiedad.UNICO_PROPIETARIO, TipoPropiedad.MULTIPLE_PROPIETARIO]),
  vin: z.string().max(17).optional(),
  placa: z.string().max(10).optional(),
});

/**
 * Crea un trámite en el FLIT simulado. Repetir un VIN es la forma de demostrar CA-02/CA-03:
 * el segundo trámite sobre el mismo vehículo no devuelve el VIN a la cola si su SOAT ya está
 * en adquisición o pagado.
 */
async function crearTramite(input: z.infer<typeof crearSchema>): Promise<{ ok: true; row: MockRow } | { ok: false; status: number; error: string }> {
  const [compania] = await db.select().from(clients).where(eq(clients.id, input.companiaId)).limit(1);
  if (!compania) return { ok: false, status: 404, error: 'La compañía no existe' };
  if (!compania.document) return { ok: false, status: 400, error: 'La compañía no tiene NIT (document); no se puede sincronizar' };

  const [organismo] = await db.select().from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, input.organismoCodigo)).limit(1);
  if (!organismo) return { ok: false, status: 404, error: 'El organismo no existe' };

  contador += 1;
  const secuencia = Date.now().toString(36).toUpperCase().slice(-5) + contador;
  const modelo = MARCAS[contador % MARCAS.length];

  const vin = input.vin?.trim().toUpperCase() ?? generarVin();
  const placaPedida = input.placa?.trim().toUpperCase();

  const [existentePorVin] = await db.select().from(flitoMockTramite).where(eq(flitoMockTramite.vin, vin)).limit(1);

  // Mismo VIN = mismo vehículo físico → la placa es la que ya tiene. Aceptar otra placa crearía
  // un vehículo imposible y reventaría al sincronizar (la placa es única en FLITO).
  if (existentePorVin && placaPedida && placaPedida !== existentePorVin.placa) {
    return { ok: false, status: 400, error: `El VIN ${vin} ya existe con la placa ${existentePorVin.placa}. Omite la placa para reutilizar la suya.` };
  }
  // Una placa ya usada por OTRO vehículo tampoco: es única por vehículo.
  if (placaPedida && !existentePorVin) {
    const [conflicto] = await db.select({ vin: flitoMockTramite.vin }).from(flitoMockTramite).where(eq(flitoMockTramite.placa, placaPedida)).limit(1);
    if (conflicto) return { ok: false, status: 400, error: `La placa ${placaPedida} ya está asignada al VIN ${conflicto.vin}.` };
  }

  const placa = existentePorVin?.placa ?? placaPedida ?? generarPlaca(modelo.tipo === 'Motocicleta');
  const compradores = input.tipoPropiedad === TipoPropiedad.MULTIPLE_PROPIETARIO
    ? [comprador(0, 60), comprador(1, 40)]
    : [comprador(0, 100)];

  const [row] = await db.insert(flitoMockTramite).values({
    idFlit: `FLIT-${secuencia}`,
    processStatus: PROCESS_STATUS.ASIGNADO,
    plateComplete: placa,
    vin,
    placa,
    marca: existentePorVin?.marca ?? modelo.marca,
    linea: existentePorVin?.linea ?? modelo.linea,
    cilindraje: existentePorVin?.cilindraje ?? modelo.cilindraje,
    capacidad: existentePorVin?.capacidad ?? modelo.capacidad,
    tipoVehiculo: existentePorVin?.tipoVehiculo ?? modelo.tipo,
    companiaNit: compania.document,
    organismoCodigo: organismo.codigo,
    tipoPropiedad: input.tipoPropiedad,
    compradores,
    valorImpuestoLiquidado: String(valorImpuesto(modelo.cilindraje)),
  }).returning();

  return { ok: true, row };
}

router.post('/tramites', async (req: Request, res: Response) => {
  if (!guardMock(res)) return;
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const r = await crearTramite(parsed.data);
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  res.status(201).json(aDto(r.row));
});

/** Anula un trámite en FLIT y crea uno nuevo sobre el mismo vehículo (escenario CA-03). */
router.post('/tramites/:idFlit/anular-recrear', async (req: Request, res: Response) => {
  if (!guardMock(res)) return;
  const idFlit = req.params.idFlit;
  const [original] = await db.select().from(flitoMockTramite).where(eq(flitoMockTramite.idFlit, idFlit)).limit(1);
  if (!original) { res.status(404).json({ error: 'El trámite no existe en el FLIT simulado' }); return; }

  await db.update(flitoMockTramite).set({ processStatus: PROCESS_STATUS.ANULADO, updatedAt: new Date() }).where(eq(flitoMockTramite.id, original.id));

  const [compania] = await db.select({ id: clients.id }).from(clients).where(eq(clients.document, original.companiaNit)).limit(1);
  if (!compania) { res.status(404).json({ error: 'La compañía del trámite ya no existe' }); return; }

  const r = await crearTramite({
    companiaId: compania.id,
    organismoCodigo: original.organismoCodigo,
    tipoPropiedad: original.tipoPropiedad as TipoPropiedad,
    vin: original.vin,
  });
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  res.status(201).json(aDto(r.row));
});

const estadoSchema = z.object({
  estado: z.enum([
    EstadoTramiteFlito.ASIGNADO, EstadoTramiteFlito.ENTREGADO, EstadoTramiteFlito.APROBADO,
    EstadoTramiteFlito.ANULADO, EstadoTramiteFlito.RECHAZADO,
  ]),
});

/**
 * Mueve el trámite a otro estado dentro del FLIT simulado. Es un acto de FLIT, no de FLITO: sin
 * validación de transiciones ni bitácora. El efecto se ve al sincronizar (la reconciliación lo
 * saca de la compuerta si salió de Asignado); el SOAT y el impuesto NO cambian (RN-01).
 */
router.post('/tramites/:idFlit/estado', async (req: Request, res: Response) => {
  if (!guardMock(res)) return;
  const parsed = estadoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Estado inválido' }); return; }
  const [updated] = await db.update(flitoMockTramite)
    .set({ processStatus: processStatusDesdeEstado(parsed.data.estado), updatedAt: new Date() })
    .where(eq(flitoMockTramite.idFlit, req.params.idFlit))
    .returning();
  if (!updated) { res.status(404).json({ error: 'El trámite no existe en el FLIT simulado' }); return; }
  res.json(aDto(updated));
});

export default router;
