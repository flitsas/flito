// Bug #12869 — la frontera del ENLACE en dos superficies que `flito-soat.alcance-por-enlace.test.ts`
// no alcanzaba: la RUTA de soportes (qué tipos de documento se leen) y la carga masiva de
// comprobantes (con qué SOAT puede cruzar un archivo).
//
// Mutantes que estas pruebas matan, nombrados:
//   · `flito-soat.routes.ts` vuelve a `externo: ctx.externo` en `GET /:id/soportes` → A (un rol
//     INTERNO con enlace compañía dejaría de recibir la allowlist del canal compañía y leería la
//     factura electrónica y el comprobante PSE).
//   · `buscarEnAdquisicion` pierde la rama `acotadoACompania` → B (un comprobante de ese rol
//     cruzaría con el SOAT de cualquier compañía).
//
// Se aserta sobre las condiciones que las consultas REALMENTE reciben (`espia.condicionesLeidas()`,
// renderizadas), no sobre las filas del mock, que no filtra por `where`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, ligadosA, renderizar } from '../helpers/sql-ligado.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

/**
 * `detalle` es la puerta de acceso de la ruta y ya tiene su prueba por enlace (`buscarConAcceso` en
 * el archivo hermano). Aquí se fija su salida para aislar lo que decide la línea medida: con qué
 * `externo` llama la RUTA a `soportesDeSoat`. `contextoSoat` y `soportesDeSoat` corren reales.
 */
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/flito-soat/flito-soat.service.js')>()),
  detalle: vi.fn(async () => ({ id: SOAT_ID, estado: 'pagado', motivoRechazo: null })),
}));

/** El OCR lee la placa del comprobante; lo que importa es con qué WHERE se busca el SOAT. */
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/flito-ocr/flito-ocr.service.js')>()),
  extraerFacturaSoat: vi.fn(async () => {
    const { CampoSoat } = await import('@operaciones/shared-types');
    return { [CampoSoat.PLACA]: { valor: 'ABC123', confianza: 0.99 } };
  }),
}));

const SOAT_ID = '50a70000-0000-4000-8000-00000000bb01';
const COMPANIA = 7;

beforeEach(() => { kdb.reset(); });

async function authRol(sub: number, rol: string, tipoPrincipal: 'interno' | 'externo', tipoEnlace: string) {
  await registrarUsuarioDePrueba(sub, {
    rol, tipoPrincipal, tipoEnlace, excepciones: [],
    funcionesDelRol: ['pagina.flito_soat', 'soat.solicitud.ver_soportes'],
  });
  const t = await new SignJWT({ username: 'u@x.co', role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const AHORA = new Date('2026-09-24T12:00:00Z');
const soporte = (id: string, tipo: string) => ({ id, tipo, nombreArchivo: `${id}.pdf`, storageKey: `flito/${id}`, subidoEn: AHORA });
const TODOS = [
  soporte('sop-poliza', 'factura_soat'), soporte('sop-venta', 'factura_venta'),
  soporte('sop-fe', 'factura_electronica_pdf'), soporte('sop-pse', 'comprobante_pse'),
];

/** Las condiciones renderizadas que mencionan esa tabla. */
const condicionesSobre = (espia: ReturnType<typeof crearEspia>, tabla: string) =>
  espia.condicionesLeidas().map((c) => renderizar(c as never)).filter((q) => q.sql.includes(`"${tabla}".`));

describe('Bug #12869 · A — GET /:id/soportes: rol INTERNO con enlace compañía recibe la allowlist del canal compañía', () => {
  it('su propio SOAT pagado → la lectura de flito_soportes va acotada por tipo a la allowlist', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select('users', [{ c: COMPANIA, p: null }])
      .select('flito_soportes', TODOS).select('flito_conciliacion_lineas', [TODOS[3]]);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await authRol(9401, 'aseguradora_interna', 'interno', 'compania'));

    expect(r.status).toBe(200);
    const sops = condicionesSobre(espia, 'flito_soportes');
    expect(sops.length).toBeGreaterThanOrEqual(1);
    expect(ligadosA(sops[0]!, '"flito_soportes"."tipo"')).toEqual(['factura_soat', 'factura_venta']);
    const tipos = (r.body as { tipo: string }[]).map((s) => s.tipo);
    expect(tipos).not.toContain('comprobante_pse');
    expect(tipos).not.toContain('factura_electronica_pdf');
  });

  it('no-regresión: rol interno con enlace ninguno (admin) → sin recorte por tipo', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select('flito_soportes', TODOS).select('flito_conciliacion_lineas', []);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await authRol(9402, 'admin', 'interno', 'ninguno'));

    expect(r.status).toBe(200);
    const sops = condicionesSobre(espia, 'flito_soportes');
    expect(() => ligadosA(sops[0]!, '"flito_soportes"."tipo"')).toThrow();
  });
});

describe('Bug #12869 · B — carga masiva de comprobantes: rol INTERNO con enlace compañía solo cruza con su compañía', () => {
  it('la búsqueda del SOAT en adquisición lleva SU compania_id en el WHERE', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select('flito_soportes', []).select('flito_soat', []);
    const { cargarFacturasMasivo } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const ctx = {
      userId: 1, username: 'u', role: 'aseguradora_interna', externo: false,
      alcance: 'compania' as const, proveedorSoatId: null, companiaId: COMPANIA,
    };

    const res = await cargarFacturasMasivo(
      [{ originalname: 'ABC123.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x'), size: 10 } as never],
      ctx,
    );

    expect(res.noAsociados).toHaveLength(1);
    const soat = condicionesSobre(espia, 'flito_soat').filter((q) => q.sql.includes('"flito_soat"."estado"'));
    expect(soat).toHaveLength(1);
    expect(ligadoA(soat[0]!, '"flito_soat"."compania_id"')).toBe(COMPANIA);
  });

  it('alcance nada → ni siquiera consulta el SOAT', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select('flito_soportes', []).select('flito_soat', []);
    const { cargarFacturasMasivo } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const ctx = {
      userId: 1, username: 'u', role: 'transito', externo: false,
      alcance: 'nada' as const, proveedorSoatId: null, companiaId: null,
    };
    const res = await cargarFacturasMasivo(
      [{ originalname: 'ABC123.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 y'), size: 10 } as never],
      ctx,
    );
    expect(res.noAsociados).toHaveLength(1);
    expect(condicionesSobre(espia, 'flito_soat').filter((q) => q.sql.includes('"flito_soat"."estado"'))).toHaveLength(0);
  });
});
