// ADR-0041 §13 (Enmienda 1, Épica #13763) — rutas del costo de proveedor: quién lo ve y cómo se filtra.
//
// App mínima con el `authMiddleware` REAL (que llama a la `guardiaFrontera` real) y el `exigirFuncion` real, montando los
// routers como `app.ts` (SIN `conAlcance`); solo `resolverPermisos` y los servicios son dobles.
//
// Matriz regla → casos:
//   C8 / RN-CP-08  enlace `proveedor` y `compania` CON `finanzas.reporte_costos.ver`/`exportar` ⇒ 403 en GET /reporte-costos,
//                  /consolidado, POST /reporte-costos/export y GET /api/flito/liquidacion/:id, sin importes en el cuerpo;
//                  `ninguno` ⇒ 200 con los campos; `app.ts` monta los dos routers sin `conAlcance`
//   C7 / RN-CP-07  `costoProveedorSinConfigurar`: `true` llega al servicio; mal formado ⇒ 400 (query y body)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermisosResueltos } from '../../src/shared/permisos-efectivos.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();
vi.mock('../../src/db/client.js', () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn() }, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/permisos-efectivos.js', async (orig) => ({
  ...(await orig<typeof import('../../src/shared/permisos-efectivos.js')>()),
  resolverPermisos: (id: number) => resolverMock(id),
}));
vi.mock('../../src/shared/pii-audit.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const COSTO = {
  estado: 'costo', proveedorId: 'p1', proveedor: 'Seguros Uno', vigenciaId: 'v1', valor: 12000,
  fechaReferencia: '2026-11-01T10:00:00.000Z', contadoEnTramiteId: null, contadoEnIdFlit: null,
};
const FILA = { tramiteId: 't1', idFlit: 'FLIT-1', total: 500000, costoProveedorSoat: COSTO, costoProveedorLogistica: { ...COSTO, estado: 'sin_configurar', valor: null, vigenciaId: null }, costoProveedorTotal: 12000 };
const reporteMock = vi.fn();
const exportarMock = vi.fn();
const consolidadoMock = vi.fn();
vi.mock('../../src/modules/finanzas/finanzas.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  reporteCostos: reporteMock, filasParaExportar: exportarMock,
}));
vi.mock('../../src/modules/finanzas/finanzas.consolidado.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), consolidadoReporte: consolidadoMock,
}));
vi.mock('../../src/shared/utils/excel.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendExcel: vi.fn(async (res: express.Response, _n: string, _c: unknown, filas: unknown) => { res.json({ filas }); }),
}));

const { default: finanzasRoutes } = await import('../../src/modules/finanzas/finanzas.routes.js');
const { default: liquidacionRoutes } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.routes.js');

const FUNCIONES = ['finanzas.reporte_costos.ver', 'finanzas.reporte_costos.exportar', 'liquidacion.liquidacion.ver'];
type Enlace = 'ninguno' | 'compania' | 'proveedor';
const ok = (userId: number, tipoEnlace: Enlace): PermisosResueltos => ({
  ok: true, userId, rol: `rol_${tipoEnlace}`, tipoEnlace, funciones: new Set(FUNCIONES), version: `v${userId}`, resueltoEn: new Date(),
  proveedor: tipoEnlace === 'proveedor' ? { id: 'p1', activo: true, servicios: ['soat', 'logistica'] } : null,
});
const USUARIOS: Record<number, PermisosResueltos> = { 1: ok(1, 'proveedor'), 2: ok(2, 'compania'), 3: ok(3, 'ninguno') };

const token = async (sub: number) => `Bearer ${await new SignJWT({ username: `u${sub}`, role: 'financiera' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET))}`;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/flito/liquidacion', liquidacionRoutes);
  a.use('/api/finanzas', finanzasRoutes);
  return a;
}

beforeEach(() => {
  resolverMock.mockReset();
  resolverMock.mockImplementation(async (id) => USUARIOS[id]!);
  reporteMock.mockReset().mockResolvedValue({ items: [FILA], total: 1, page: 1, pageSize: 50, totales: {}, resumen: {} });
  exportarMock.mockReset().mockResolvedValue([]);
  consolidadoMock.mockReset().mockResolvedValue({ filas: [] });
});

describe('C8 / RN-CP-08 — el proveedor (y la compañía) no ven el costo', () => {
  it('app.ts monta /api/finanzas y /api/flito/liquidacion SIN conAlcance', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/app.ts'), 'utf8');
    expect(src).toMatch(/app\.use\('\/api\/finanzas', finanzasRoutes\)/);
    expect(src).toMatch(/app\.use\('\/api\/flito\/liquidacion', flitoLiquidacionRoutes\)/);
    expect(src).not.toMatch(/conAlcance\([^)]*(finanzasRoutes|flitoLiquidacionRoutes)/);
  });

  for (const [sub, enlace] of [[1, 'proveedor'], [2, 'compania']] as const) {
    it(`enlace ${enlace} con la función concedida ⇒ 403 en las cuatro rutas, sin importes`, async () => {
      const a = app(); const auth = await token(sub);
      const respuestas = [
        await request(a).get('/api/finanzas/reporte-costos').set('Authorization', auth),
        await request(a).get('/api/finanzas/reporte-costos/consolidado').set('Authorization', auth),
        await request(a).post('/api/finanzas/reporte-costos/export').set('Authorization', auth).send({}),
        await request(a).get('/api/flito/liquidacion/7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f6').set('Authorization', auth),
      ];
      for (const r of respuestas) {
        expect(r.status).toBe(403);
        expect(JSON.stringify(r.body)).not.toMatch(/costoProveedor|Seguros Uno|12000/);
      }
      expect(reporteMock).not.toHaveBeenCalled();
      expect(exportarMock).not.toHaveBeenCalled();
    });
  }

  it('enlace ninguno ⇒ 200 con los campos del costo de proveedor', async () => {
    const r = await request(app()).get('/api/finanzas/reporte-costos').set('Authorization', await token(3));
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ costoProveedorSoat: { estado: 'costo', valor: 12000 }, costoProveedorTotal: 12000 });
  });
});

describe('C7 / RN-CP-07 — filtro costoProveedorSinConfigurar (booleano, sin PII)', () => {
  it('query true ⇒ llega al servicio; ausente ⇒ false; en /consolidado igual', async () => {
    const a = app(); const auth = await token(3);
    await request(a).get('/api/finanzas/reporte-costos?costoProveedorSinConfigurar=true').set('Authorization', auth).expect(200);
    expect(reporteMock.mock.calls[0]![0]).toMatchObject({ costoProveedorSinConfigurar: true });
    await request(a).get('/api/finanzas/reporte-costos').set('Authorization', auth).expect(200);
    expect(reporteMock.mock.calls[1]![0]).toMatchObject({ costoProveedorSinConfigurar: false });
    await request(a).get('/api/finanzas/reporte-costos/consolidado?costoProveedorSinConfigurar=true').set('Authorization', auth).expect(200);
    expect(consolidadoMock.mock.calls[0]![0]).toMatchObject({ costoProveedorSinConfigurar: true });
  });

  it('query mal formada ⇒ 400 y el servicio no corre', async () => {
    const a = app(); const auth = await token(3);
    for (const ruta of ['/api/finanzas/reporte-costos', '/api/finanzas/reporte-costos/consolidado', '/api/finanzas/reporte-costos/facturacion-electronica']) {
      const r = await request(a).get(`${ruta}?costoProveedorSinConfigurar=si`).set('Authorization', auth);
      expect(r.status, ruta).toBe(400);
    }
    expect(reporteMock).not.toHaveBeenCalled();
    expect(consolidadoMock).not.toHaveBeenCalled();
  });

  it('body del export: true llega a filasParaExportar; un texto ⇒ 400', async () => {
    const a = app(); const auth = await token(3);
    await request(a).post('/api/finanzas/reporte-costos/export').set('Authorization', auth).send({ costoProveedorSinConfigurar: true }).expect(200);
    expect(exportarMock.mock.calls[0]![0]).toMatchObject({ costoProveedorSinConfigurar: true });
    const r = await request(a).post('/api/finanzas/reporte-costos/export').set('Authorization', auth).send({ costoProveedorSinConfigurar: 'si' });
    expect(r.status).toBe(400);
    expect(exportarMock).toHaveBeenCalledTimes(1);
  });
});
