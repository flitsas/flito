// HU #12875 — decisión (d) del PO: un rol de COMPAÑÍA con funciones de SOAT (reversar, reasignar
// proveedor, exportar…) puede usarlas, siempre limitado a SU compañía. Por HTTP, sobre el router REAL
// de SOAT montado como en `app.ts` (`conAlcance('soat', …)`), con la frontera y el resolutor reales.
//
// Lo que se afirma: la frontera deja pasar al rol de compañía (no es ella la que cierra); fuera de su
// compañía la transición responde 404 «no existe» y no hay UPDATE; sin la función, 403 de
// `exigirFuncion`; y el MISMO conjunto con un enlace al que SOAT no está abierto, 403 de la frontera.
// El mock no filtra por `where`: devuelve la fila de OTRA compañía a quien la pida.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { EstadoSoat } = await import('@operaciones/shared-types');

const SOAT_ID = '50a70000-0000-4000-8000-00000000dd01';
const PROV = '11111111-1111-1111-1111-111111111111';
const MI_COMPANIA = 7;
const OTRA_COMPANIA = 9;

let espia: ReturnType<typeof crearEspia>;
beforeEach(() => { kdb.reset(); espia = crearEspia(kdb); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

let sub = 9700;
async function auth(tipoEnlace: string, funciones: string[]) {
  sub += 1;
  await registrarUsuarioDePrueba(sub, { rol: 'aseguradora_x', tipoEnlace, funcionesDelRol: ['pagina.flito_soat', ...funciones], excepciones: [] });
  const t = await new SignJWT({ username: 'a@x.co', role: 'aseguradora_x' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

const fila = (estado: string, companiaId: number) => ({
  id: SOAT_ID, companiaId, proveedorSoatId: PROV, gestionOperaciones: false, estado,
  enviadoPorId: null, enviadoEn: null, motivoRechazo: null,
});

const CASOS = [
  { ruta: 'reversar', funcion: 'soat.solicitud.reversar', estado: EstadoSoat.PAGADO, cuerpo: { estadoDestino: EstadoSoat.PENDIENTE, motivo: 'error de carga' } },
  { ruta: 'proveedor', funcion: 'soat.proveedor.cambiar', estado: EstadoSoat.PENDIENTE, cuerpo: { proveedorSoatId: PROV, motivo: 'cambio de convenio' } },
] as const;

describe('decisión (d) — el rol de compañía usa sus funciones de SOAT, limitado a su compañía', () => {
  for (const c of CASOS) {
    it(`POST /:id/${c.ruta} con la función, sobre un SOAT de OTRA compañía → 404 «no existe», cero UPDATE`, async () => {
      kdb.when.select('users', [{ c: MI_COMPANIA, p: null }])
        .select('flito_soat', [fila(c.estado, OTRA_COMPANIA)])
        .select('flito_proveedores_soat', [{ id: PROV }])
        .update('flito_soat', [fila(c.estado, OTRA_COMPANIA)]);
      const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/${c.ruta}`)
        .set('Authorization', await auth('compania', [c.funcion])).send(c.cuerpo);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: 'El SOAT no existe' });
      expect(espia.updatesEn('flito_soat')).toHaveLength(0);
    });

    it(`POST /:id/${c.ruta} SIN la función → 403 de exigirFuncion (la frontera ya lo dejó pasar)`, async () => {
      const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/${c.ruta}`)
        .set('Authorization', await auth('compania', [])).send(c.cuerpo);
      expect(r.status).toBe(403);
      expect(r.body.funcion).toBe(c.funcion);
    });

    it(`POST /:id/${c.ruta} con la función y enlace organismos (SOAT no abierto) → 403 de la frontera, sin consultas`, async () => {
      const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/${c.ruta}`)
        .set('Authorization', await auth('organismos_transito', [c.funcion])).send(c.cuerpo);
      expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
      expect(kdb.select).not.toHaveBeenCalled();
    });
  }
});
