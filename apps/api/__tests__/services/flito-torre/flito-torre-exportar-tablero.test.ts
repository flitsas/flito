// Torre de Control Gerencial (Épica #14590) — exportar un tablero a Excel y `GET /opciones` por HTTP: las dos guardas
// del export (la del tablero y la de exportar), el xlsx con una hoja por bloque, sin columnas de dinero para quien no
// lo ve, y el 403 de opciones. Son reales `authMiddleware`, `exigirFuncion`/`tieneFuncion`, Zod y el armado del
// libro; los servicios de tablero y de opciones van mockeados (su SQL se prueba contra PostgreSQL en otros archivos).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { SignJWT } from 'jose';
import type { TableroFinanciero } from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', () => ({
  db: { insert: () => ({ values: () => Promise.resolve() }), transaction: () => Promise.reject(new Error('sin base en este archivo')) },
  getPoolStats: vi.fn(),
}));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const finSvc = { tableroFinanciero: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.financiera.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...finSvc };
});
const opcSvc = { opcionesFiltroTorre: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.opciones.service.js', () => opcSvc);

const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: router } = await import('../../../src/modules/flito-torre/flito-torre.routes.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const filas = new Map<number, FilasPermisos>();
const de = (id: number, funciones: string[]) => {
  filas.set(id, { rol: `r${id}`, tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(funciones), excepciones: [] });
};
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

const app = express();
app.use(express.json());
app.use('/api/flito/torre/tableros', tableros);
app.use('/api/flito/torre', router);

const binario = (res: NodeJS.ReadableStream, cb: (e: Error | null, body: Buffer) => void) => {
  const partes: Buffer[] = [];
  res.on('data', (c: Buffer) => partes.push(c));
  res.on('end', () => cb(null, Buffer.concat(partes)));
};
const exporta = async (tablero: string, sub: number, body: object) =>
  request(app).post(`/api/flito/torre/tableros/${tablero}/exportar`).set('Authorization', `Bearer ${await token(sub)}`)
    .send({ filtro: body }).buffer(true).parse(binario);
const libroDe = async (buf: Buffer) => { const l = new ExcelJS.Workbook(); await l.xlsx.load(buf as unknown as ArrayBuffer); return l; };
const cabeceras = (l: ExcelJS.Workbook, hoja: string) => (l.getWorksheet(hoja)!.getRow(1).values as unknown[]).filter(Boolean);
const columnaA = (l: ExcelJS.Workbook, hoja: string) => l.getWorksheet(hoja)!.getColumn(1).values.filter(Boolean);

const MARZO = { rango: { desde: '2035-03-01', hasta: '2035-03-31' } };
const FIN = 'accion.torre_financiera.ver';
const EXP = 'accion.torre_explorador.exportar';
const DIN = 'accion.torre_explorador.ver_dinero';

/** Lo que devolvería el servicio real: sin dinero, los campos de dinero en `null` y sin bloque de margen. */
const financiero = ({ dinero }: { dinero: boolean }): TableroFinanciero => ({
  rango: { desde: '2035-03-01', hasta: '2035-03-31' }, dineroVisible: dinero, generadoEn: '2035-03-31T12:00:00Z',
  cifras: {
    menorCobertura: { companiaId: 7, compania: 'Cía Siete', dias: 4, severidad: 'critico' },
    sinFacturarValor: dinero ? 900_000 : null, sinFacturarTramites: 3, margenPct: dinero ? 12.5 : null, soportesCompletosPct: 50,
  },
  bolsas: { filtrosIgnorados: ['rango'], umbralAtencionDias: 15, umbralCriticoDias: 7,
    filas: [{ companiaId: 7, compania: 'Cía Siete', saldo: dinero ? 100_000 : null, consumoDiario: dinero ? 25_000 : null, diasCobertura: 4, severidad: 'critico' }] },
  sinFacturar: { filtrosIgnorados: [], filas: [{ companiaId: 7, compania: 'Cía Siete', tramites: 3, valorEstimado: dinero ? 900_000 : null, masAntiguoDias: 9 }] },
  margen: dinero ? {
    filtrosIgnorados: [],
    porServicio: [{ servicio: 'tramite', cobrado: 1_000_000, costo: 875_000, sinCostoRegistrado: false }],
    porCliente: [{ companiaId: 7, compania: 'Cía Siete', cobrado: 1_000_000, costo: 875_000, margenPct: 12.5, sinCostoRegistrado: false }],
  } : null,
  conciliacion: { filtrosIgnorados: [], completos: 1, dos: 1, uno: 0, cero: 0, total: 2, pctCompletos: 50 },
});

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  for (const i of [1, 2, 3, 4, 5]) permisos.invalidarPermisosDe(i);
  finSvc.tableroFinanciero.mockReset().mockImplementation(async (ctx: { dinero: boolean }) => financiero(ctx));
  opcSvc.opcionesFiltroTorre.mockReset();
  de(1, [FIN]);                // ve el tablero, no exporta
  de(2, [EXP, 'accion.torre_comercial.ver']); // exporta, pero no ve el financiero
  de(3, [FIN, EXP]);           // exporta sin dinero
  de(4, [FIN, EXP, DIN]);      // exporta con dinero
  de(5, ['accion.torre_360.ver']); // sin `torre.metricas.consultar`
});

describe('POST /tableros/:tablero/exportar', () => {
  it('403 sin la función de exportar y 403 sin la función de ESE tablero; el servicio no se llama', async () => {
    expect((await exporta('financiera', 1, MARZO)).status).toBe(403);
    expect((await exporta('financiera', 2, MARZO)).status).toBe(403);
    expect(finSvc.tableroFinanciero).not.toHaveBeenCalled();
  });

  it('400 si el body no es un FiltroTorre estricto y 404 para un tablero que no existe', async () => {
    expect((await exporta('financiera', 4, { ...MARZO, placa: 'ABC123' })).status).toBe(400);
    expect((await exporta('logistica', 4, MARZO)).status).toBe(404);
  });

  it('xlsx con una hoja por bloque, nombre torre-<tablero>-<desde>_<hasta> y, con dinero, sus columnas y el margen', async () => {
    const r = await exporta('financiera', 4, MARZO);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(r.headers['content-disposition']).toBe('attachment; filename="torre-financiera-2035-03-01_2035-03-31.xlsx"');
    expect(finSvc.tableroFinanciero).toHaveBeenCalledWith(expect.objectContaining({ filtro: MARZO, dinero: true }));
    const l = await libroDe(r.body as Buffer);
    expect(l.worksheets.map((h) => h.name)).toEqual(['Cifras', 'Bolsas', 'Sin facturar', 'Margen por servicio', 'Margen por cliente', 'Conciliación']);
    expect(cabeceras(l, 'Bolsas')).toEqual(['Compañía', 'Saldo', 'Consumo diario', 'Días de cobertura', 'Severidad']);
    expect(columnaA(l, 'Cifras')).toContain('Sin facturar (valor)');
  });

  it('sin FUNCION_TORRE_DINERO: sin columnas ni cifras de dinero, sin hojas de margen, y sin placa en ninguna celda', async () => {
    const r = await exporta('financiera', 3, MARZO);
    expect(r.status).toBe(200);
    expect(finSvc.tableroFinanciero).toHaveBeenCalledWith(expect.objectContaining({ dinero: false }));
    const l = await libroDe(r.body as Buffer);
    expect(l.worksheets.map((h) => h.name)).toEqual(['Cifras', 'Bolsas', 'Sin facturar', 'Conciliación']);
    expect(cabeceras(l, 'Bolsas')).toEqual(['Compañía', 'Días de cobertura', 'Severidad']);
    expect(cabeceras(l, 'Sin facturar')).toEqual(['Compañía', 'Trámites', 'Más antiguo (días)']);
    expect(columnaA(l, 'Cifras')).not.toContain('Sin facturar (valor)');
    expect(columnaA(l, 'Cifras')).not.toContain('Margen %');
    for (const h of l.worksheets) expect(cabeceras(l, h.name).join('|')).not.toMatch(/placa|nit|vin/i);
  });
});

describe('GET /opciones', () => {
  it('403 sin torre.metricas.consultar; con ella responde lo del servicio con el alcance del motor', async () => {
    const sin = await request(app).get('/api/flito/torre/opciones').set('Authorization', `Bearer ${await token(5)}`);
    expect(sin.status).toBe(403);
    expect(opcSvc.opcionesFiltroTorre).not.toHaveBeenCalled();

    de(6, ['accion.torre_explorador.consultar']);
    const forma = { companias: [{ id: 7, nombre: 'Cía Siete' }], organismos: [], tiposTramite: [], flitEstados: [] };
    opcSvc.opcionesFiltroTorre.mockResolvedValue(forma);
    const ok = await request(app).get('/api/flito/torre/opciones').set('Authorization', `Bearer ${await token(6)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(forma);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(opcSvc.opcionesFiltroTorre).toHaveBeenCalledWith({ enlace: 'ninguno' });
  });
});
