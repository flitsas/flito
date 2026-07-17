import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { adminAuth, proveedorAuth } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  updateMock.mockReset(); deleteMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV · GET /tablero', () => {
  it('admin recibe estructura completa con scores PHVA y KPIs', async () => {
    // Política vigente
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 2, titulo: 'PSV 2026', firmadaAt: '2026-01-01T00:00:00Z' }]));
    // Plan actual
    selectMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, estado: 'aprobado', presupuestoCop: '50000000' }]));
    // Plan próximo
    selectMock.mockReturnValueOnce(chain([]));
    // Diag actual
    selectMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, estado: 'borrador', scoreGlobal: '60.00' }]));
    // Diag referencia (cerrado)
    selectMock.mockReturnValueOnce(chain([{ id: 1, anio: 2025, estado: 'cerrado', scoreGlobal: '75.00' }]));
    // execute join items+catálogo
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce({ rows: [
      { fase: 'planear', codigo: '1', nombre: 'Líder', peso: 1.0, score: 80 },
      { fase: 'planear', codigo: '2', nombre: 'Comité', peso: 1.0, score: 90 },
      { fase: 'hacer', codigo: '7', nombre: 'Objetivos', peso: 1.0, score: 50 },
      { fase: 'verificar', codigo: '19', nombre: 'Archivo', peso: 1.0, score: 30 },
      { fase: 'actuar', codigo: '23', nombre: 'Mejora', peso: 1.0, score: 100 },
    ] });
    // jornadasMes execute
    executeMock.mockResolvedValueOnce({ rows: [{ total: 50, auto_cerradas: 2, horas_totales: 280 }] });
    // alarmasMes execute
    executeMock.mockResolvedValueOnce({ rows: [{ total: 5, pendientes: 2 }] });
    // conductoresOver60 execute
    executeMock.mockResolvedValueOnce({ rows: [{ conductor_id: 7 }] });
    // Comité activo
    selectMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'CSV Kyverum', activo: true }]));
    // Última acta cerrada
    selectMock.mockReturnValueOnce(chain([{ id: 50, comiteId: 1, numero: 7, fecha: '2026-04-15', estado: 'cerrada' }]));
    // Total rutas
    selectMock.mockReturnValueOnce(chain([{ count: 8 }]));
    // Rutas con análisis Q execute
    executeMock.mockResolvedValueOnce({ rows: [{ c: 5 }] });

    const r = await request(app).get('/api/pesv/tablero').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.anio).toBeDefined();
    expect(r.body.documentos.politicaVigente.version).toBe(2);
    expect(r.body.cumplimiento.scoresPorFase.planear.score).toBeCloseTo(85);
    expect(r.body.cumplimiento.scoresPorFase.actuar.score).toBe(100);
    expect(r.body.jornadasMes.total).toBe(50);
    expect(r.body.jornadasMes.alarmasPendientes).toBe(2);
    expect(r.body.jornadasMes.conductoresExcedenSemanal).toBe(1);
    expect(r.body.rutas.sinAnalisisTrimestre).toBe(3);
  });

  it('proveedor → 403', async () => {
    const r = await request(app).get('/api/pesv/tablero').set('Authorization', await proveedorAuth());
    expect(r.status).toBe(403);
  });

  it('sin política vigente reporta documento ausente', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin política
    selectMock.mockReturnValueOnce(chain([])); // sin plan
    selectMock.mockReturnValueOnce(chain([])); // sin plan próx
    selectMock.mockReturnValueOnce(chain([])); // sin diag actual
    selectMock.mockReturnValueOnce(chain([])); // sin diag referencia
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce({ rows: [{ total: 0, auto_cerradas: 0, horas_totales: 0 }] });
    executeMock.mockResolvedValueOnce({ rows: [{ total: 0, pendientes: 0 }] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    selectMock.mockReturnValueOnce(chain([])); // sin comité
    selectMock.mockReturnValueOnce(chain([{ count: 0 }])); // total rutas
    executeMock.mockResolvedValueOnce({ rows: [{ c: 0 }] });

    const r = await request(app).get('/api/pesv/tablero').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.documentos.politicaVigente).toBeNull();
    expect(r.body.cumplimiento.diagnosticoReferencia).toBeNull();
  });
});

describe('PESV · POST /export/sisi', () => {
  it('admin descarga ZIP con content-type application/zip', async () => {
    // Política vigente con datos
    selectMock.mockReturnValueOnce(chain([{
      id: 1, version: 2, titulo: 'PSV 2026', contenidoMd: 'contenido extenso de la política PESV',
      vigenciaDesde: '2026-01-01', vigenciaHasta: null, estado: 'vigente',
      firmadaPor: 1, firmadaAt: new Date('2026-01-01T00:00:00Z'),
    }]));
    // Plan
    selectMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, estado: 'aprobado', presupuestoCop: '50000000', objetivoGeneral: 'reducir índice 20%' }]));
    // Objetivos
    selectMock.mockReturnValueOnce(chain([{ codigo: 'O1', descripcion: 'objetivo 1', metaPct: '50.00' }]));
    // Diagnóstico
    selectMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, fecha: '2026-05-07', scoreGlobal: '75.00', estado: 'cerrado' }]));
    // Estándares execute
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce({ rows: [{ codigo: '1', fase: 'planear', nombre: 'Líder', score: 80 }] });
    // jornadas/alarmas/over60
    executeMock.mockResolvedValueOnce({ rows: [{ total: 50, auto: 2, horas: 280 }] });
    executeMock.mockResolvedValueOnce({ rows: [{ total: 5 }] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    // Rutas
    selectMock.mockReturnValueOnce(chain([{ id: 1, codigo: 'R-001', activo: true }]));
    executeMock.mockResolvedValueOnce({ rows: [{ c: 1 }] });
    // Comité + actas
    selectMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'CSV', periodicidad: 'trimestral', activo: true }]));
    selectMock.mockReturnValueOnce(chain([{ id: 50, comiteId: 1, numero: 7, fecha: '2026-04-15', estado: 'cerrada' }]));
    // user signer (para PDF política firmada)
    selectMock.mockReturnValueOnce(chain([{ id: 1, name: 'Admin Demo', role: 'admin' }]));

    const r = await request(app).post('/api/pesv/export/sisi')
      .set('Authorization', await adminAuth())
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .send({ anio: 2026 });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/zip/);
    expect(r.headers['content-disposition']).toMatch(/attachment.*pesv-export-2026/);
    const body = r.body as Buffer;
    expect(body.length).toBeGreaterThan(100);
    expect(body[0]).toBe(0x50); // 'P' magic ZIP
    expect(body[1]).toBe(0x4B); // 'K'
  });

  it('proveedor → 403', async () => {
    const r = await request(app).post('/api/pesv/export/sisi').set('Authorization', await proveedorAuth()).send({});
    expect(r.status).toBe(403);
  });
});
