// HU #14017 (Feature #14012), fase 1 — `tipoSoat` en la cola y el detalle del SOAT.
// Mismo montaje posicional que `flito-soat.cola-propietario-canal.test.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
    // La cola registra el acceso a PII desde la HU #11913: sin un `insert` utilizable, el helper
    // falla, lo atrapa su propio catch y la salida se llena de ERROR que no son de esta prueba.
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}
const auth = async (role: string, sub = 1) => `Bearer ${await testToken({ sub, username: 'u', role: role as never })}`;

/** Chain que RESPETA la proyección: de cada fila devuelve solo lo que el `select({…})` pidió. */
function chainProyectado(proyeccion: Record<string, unknown>, filas: Record<string, unknown>[]) {
  const claves = Object.keys(proyeccion);
  return chain(filas.map((f) => Object.fromEntries(claves.map((k) => [k, k in f ? f[k] : null]))));
}

const SOAT_CANAL = '00000000-0000-0000-0000-0000000000c1';
const SOAT_TRAMITE = '00000000-0000-0000-0000-0000000000t1'.replace('t', 'a');

/** Fila de la cola tal como sale del join `flito_soat` × `vehicles` × … */
const filaCola = (over: Record<string, unknown> = {}) => ({
  // `solicitado` y no `pendiente_revision`: la HU #12080 retira ese estado del enum, y una fila
  // del canal nace despachada desde la #12078. Lo que este archivo mide —la proyección del
  // propietario— no depende del estado.
  id: SOAT_CANAL, vin: '9FKRG2222T2042405', estado: 'solicitado', origen: 'cliente',
  proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
  valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-08-29T12:00:00.000Z'),
  placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
  cilindraje: '1598', carroceria: null, tipoServicio: 'Particular',
  companiaNombre: 'ACME SAS', organismoNombre: 'FUNZA', proveedorSoatNombre: null,
  proveedorSlaHoras: null, enviadoPorNombre: null,
  ...over,
});

describe('cola y detalle SOAT — `tipoSoat` de la solicitud del canal (HU #14017, fase 1)', () => {
  it('la cola devuelve INICIAL/RENOVACION en filas del canal y null en filas de trámite', async () => {
    const filaTramite = filaCola({ id: SOAT_TRAMITE, origen: 'tramite', estado: 'pendiente', tipoSoat: null });
    selectMock.mockImplementationOnce(() => chain([{ total: 3 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [
      filaCola({ tipoSoat: 'inicial' }),
      filaCola({ id: '00000000-0000-0000-0000-0000000000c2', tipoSoat: 'renovacion' }),
      filaTramite,
    ]));
    selectMock.mockImplementationOnce(() => chain([]));          // trámites
    selectMock.mockImplementationOnce(() => chain([]));          // propietarios del canal

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { tipoSoat: string | null }) => i.tipoSoat)).toEqual(['INICIAL', 'RENOVACION', null]);
  });

  it('el CLIENTE también recibe `tipoSoat` (no es un campo interno)', async () => {
    selectMock.mockImplementationOnce(() => chain([{ c: 7 }]));
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola({ tipoSoat: 'renovacion' })]));
    selectMock.mockImplementationOnce(() => chain([]));
    selectMock.mockImplementationOnce(() => chain([]));

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
    expect(r.body.items[0].tipoSoat).toBe('RENOVACION');
  });

  it('el detalle devuelve `tipoSoat` de la solicitud y null para una fila de trámite', async () => {
    const soat = { soat: { id: SOAT_CANAL, companiaId: 7, estado: 'solicitado', proveedorSoatId: null, gestionOperaciones: false, pagadoEn: null, extraccion: null }, dentroDeFrontera: true };
    selectMock.mockImplementationOnce(() => chain([soat]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola({ tipoSoat: 'inicial' })]));
    selectMock.mockImplementationOnce(() => chain([]));
    selectMock.mockImplementationOnce(() => chain([]));
    selectMock.mockImplementationOnce(() => chain([]));          // revisionDeSolicitud (si aplica)
    const canal = await request(await buildApp()).get(`/api/flito/soat/${SOAT_CANAL}`).set('Authorization', await auth('admin'));
    expect(canal.status).toBe(200);
    expect(canal.body.tipoSoat).toBe('INICIAL');

    selectMock.mockReset();
    selectMock.mockImplementationOnce(() => chain([soat]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola({ origen: 'tramite', tipoSoat: null })]));
    selectMock.mockImplementationOnce(() => chain([]));
    const tramite = await request(await buildApp()).get(`/api/flito/soat/${SOAT_CANAL}`).set('Authorization', await auth('admin'));
    expect(tramite.status).toBe(200);
    expect(tramite.body.tipoSoat).toBeNull();
  });
});
