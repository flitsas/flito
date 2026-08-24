// FLITO — el gestor SOAT ve el comprobante del pago de la financiera (HU #11678, AC3 y AC4).
//
// Dos afirmaciones, y la segunda es la que importa más:
//
//   AC3. El comprobante PSE de la boleta que concilió ESTE SOAT sale por
//        `GET /api/flito/soat/:id/soportes`, con `origen: 'conciliacion'`, **sin perder** la factura
//        del SOAT que el gestor ya veía. Se añade a la lista, no la sustituye.
//   AC4. La frontera del gestor NO se abre por colgarle un documento más. Los tres casos —SOAT de
//        otro proveedor, SOAT de un cliente autogestionado y SOAT en un estado que el gestor no ve—
//        siguen siendo **404 y no 403**: confirmar que un id existe ya sería filtrar.
//
// Aquí NO se mockea `flito-soat.service`: la frontera la aplica `buscarConAcceso` de verdad, contra
// el mock de drizzle. Mockear `detalle()` —como hace `flito-soportes.routes.test.ts`— probaría que
// la ruta respeta lo que el servicio diga, que es otra cosa; lo que el AC4 pide es que el servicio
// lo siga diciendo después de añadir el join nuevo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const SOAT_ID = '50a70000-0000-4000-8000-000000000001';
const PROVEEDOR = 'prov-0000-4000-8000-000000000001';
const AHORA = new Date('2026-08-20T15:00:00Z');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: TestRole) =>
  `Bearer ${await testToken({ sub: 7, username: 'gestor@proveedor.io', role })}`;

/** La fila que `buscarConAcceso` lee: el SOAT entero más la frontera de autogestión ya evaluada. */
function conAcceso(over: Record<string, unknown> = {}, dentroDeFrontera = true) {
  return {
    soat: {
      id: SOAT_ID,
      estado: 'pagado',
      proveedorSoatId: PROVEEDOR,
      gestionOperaciones: false,
      extraccion: null,
      pagadoEn: AHORA,
      ...over,
    },
    dentroDeFrontera,
  };
}

/** La fila plana de la proyección del detalle (la segunda consulta a `flito_soat`). */
const FILA_DETALLE = {
  id: SOAT_ID, vin: 'VIN0001', estado: 'pagado', proveedorSoatId: PROVEEDOR,
  gestionOperaciones: false, enviadoEn: AHORA, pagadoEn: AHORA, valorPagado: '740800.00',
  motivoRechazo: null, createdAt: AHORA, placa: 'ABC123', marca: 'RENAULT', linea: 'LOGAN',
  companiaNombre: 'ACME S.A.S.', organismoNombre: 'Medellín', proveedorSoatNombre: 'Seguros X',
  proveedorSlaHoras: 24, enviadoPorNombre: 'ops@flit.io',
};

const soporte = (id: string, nombre: string, subidoEn: string, tipo: string) => ({
  id, tipo, nombreArchivo: nombre, storageKey: `flito/${id}`, subidoEn: new Date(subidoEn),
});

/** El gestor pide sus soportes y el SOAT es suyo, pagado y de un cliente no autogestionado. */
function escenarioGestorConAcceso(): void {
  kdb.when
    .select('users', [{ p: PROVEEDOR }])
    .selectOnce('flito_soat', [conAcceso()])
    .selectOnce('flito_soat', [FILA_DETALLE])
    .select('flito_tramites', [])
    .select('flito_compradores', []);
}

/** Igual que el anterior pero sin la lectura de `users`: admin y auditor no tienen proveedor. */
function escenarioAdminConAcceso(): void {
  kdb.when
    .selectOnce('flito_soat', [conAcceso()])
    .selectOnce('flito_soat', [FILA_DETALLE])
    .select('flito_tramites', [])
    .select('flito_compradores', []);
}

beforeEach(() => { kdb.reset(); });

// ─────────────────── AC4: la frontera no se abre ────────────────────────────

describe('AC4 — el gestor sigue recibiendo 404 y no 403', () => {
  const casos: Array<[string, () => void]> = [
    ['un SOAT de OTRO proveedor', () => {
      kdb.when
        .select('users', [{ p: PROVEEDOR }])
        .select('flito_soat', [conAcceso({ proveedorSoatId: 'otro-proveedor' })]);
    }],
    ['un SOAT de un cliente AUTOGESTIONADO', () => {
      kdb.when
        .select('users', [{ p: PROVEEDOR }])
        .select('flito_soat', [conAcceso({}, false)]);
    }],
    ['un SOAT en un estado que el gestor NO ve', () => {
      kdb.when
        .select('users', [{ p: PROVEEDOR }])
        .select('flito_soat', [conAcceso({ estado: 'pendiente' })]);
    }],
    ['un SOAT que asumió Operaciones', () => {
      kdb.when
        .select('users', [{ p: PROVEEDOR }])
        .select('flito_soat', [conAcceso({ gestionOperaciones: true })]);
    }],
  ];

  for (const [titulo, escenario] of casos) {
    it(`${titulo} → 404, nunca 403`, async () => {
      escenario();

      const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
        .set('Authorization', await auth('proveedor'));

      // 403 diría «existe pero no es tuyo», que es media respuesta de más. El 404 no confirma nada.
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('El SOAT no existe');
      // Y el cuerpo no filtra ni un dato del SOAT ajeno.
      expect(JSON.stringify(r.body)).not.toContain('ABC123');
    });
  }

  it('un SOAT que no existe → el MISMO 404, indistinguible de uno ajeno', async () => {
    kdb.when.select('users', [{ p: PROVEEDOR }]).select('flito_soat', []);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('El SOAT no existe');
  });

  it('el rol que no pinta nada en SOAT sigue siendo 403, no 404', async () => {
    // La distinción importa: 403 es «tu rol no entra a esta pantalla» y 404 es «no hay nada tuyo
    // aquí». Confundirlas haría el 404-no-403 del gestor indistinguible de un fallo de permisos.
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('gestor_impuestos'));

    expect(r.status).toBe(403);
  });
});

// ─────────────────── AC3: el comprobante en la lista del gestor ─────────────

describe('AC3 — el comprobante PSE en GET /flito/soat/:id/soportes', () => {
  it('el gestor ve su factura Y el comprobante del pago, cada uno con su origen', async () => {
    escenarioGestorConAcceso();
    kdb.when
      .select('flito_soportes', [soporte('sop-soat', 'factura-soat.pdf', '2026-07-01T00:00:00Z', 'factura_soat')])
      .select('flito_conciliacion_lineas', [
        soporte('sop-pse', 'comprobante-pse.pdf', '2026-08-20T15:00:00Z', 'comprobante_pse'),
      ]);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(200);
    // Lo que el AC3 pide con esas palabras: se AÑADE, no sustituye.
    expect(r.body.map((s: { origen: string }) => s.origen).sort()).toEqual(['conciliacion', 'soat']);
    const pse = r.body.find((s: { origen: string }) => s.origen === 'conciliacion');
    expect(pse).toMatchObject({ tipo: 'comprobante_pse', nombreArchivo: 'comprobante-pse.pdf' });
  });

  it('el enlace del comprobante es firmado y caducable, nunca la ruta del almacenamiento', async () => {
    escenarioGestorConAcceso();
    kdb.when
      .select('flito_soportes', [])
      .select('flito_conciliacion_lineas', [
        soporte('sop-pse', 'comprobante-pse.pdf', '2026-08-20T15:00:00Z', 'comprobante_pse'),
      ]);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('proveedor'));

    expect(r.body[0].url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
    expect(r.body[0].storageKey).toBeUndefined();
  });

  it('un SOAT sin conciliar sigue devolviendo solo lo suyo: la lista no se inventa nada', async () => {
    escenarioGestorConAcceso();
    kdb.when
      .select('flito_soportes', [soporte('sop-soat', 'factura-soat.pdf', '2026-07-01T00:00:00Z', 'factura_soat')])
      .select('flito_conciliacion_lineas', []);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('proveedor'));

    expect(r.body).toHaveLength(1);
    expect(r.body[0].origen).toBe('soat');
  });

  it('admin también lo ve: el comprobante no es exclusivo del gestor', async () => {
    escenarioAdminConAcceso();
    kdb.when
      .select('flito_soportes', [])
      .select('flito_conciliacion_lineas', [
        soporte('sop-pse', 'comprobante-pse.pdf', '2026-08-20T15:00:00Z', 'comprobante_pse'),
      ]);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body[0].origen).toBe('conciliacion');
  });
});

// ─────────────────── AC5: el auditor NO ve el comprobante ───────────────────
//
// El bloqueante que el gate encontró sobre `3f1e124`, y su regresión.
//
// `GET /:id/soportes` está abierta a `admin`, `proveedor` y `auditor`, y `buscarConAcceso` solo
// aplica frontera de pertenencia cuando el rol es `proveedor` (`esGestor`). Para `auditor` no filtra
// nada. Así que colgar el comprobante de esta lista sin mirar el rol le daba a auditoría el
// comprobante de CUALQUIER boleta conciliada con solo tener el id de uno de sus SOAT —y con la URL
// ya firmada—: más fácil que la puerta de atrás que esta misma HU cerró en bolsas y revisiones.
//
// Manda el AC5, la matriz de docs/ux (`auditor → No` en «Ver comprobante») y el ADR-0006 §7.5.

describe('AC5 — auditoría ve el SOAT entero MENOS el comprobante del pago', () => {
  it('el auditor NO recibe el bloque `conciliacion`, ni su url firmada', async () => {
    escenarioAdminConAcceso();
    kdb.when
      .select('flito_soportes', [soporte('sop-soat', 'factura-soat.pdf', '2026-07-01T00:00:00Z', 'factura_soat')])
      // Aunque la consulta devolviera algo, no debe llegar a pedirse. La fila está aquí a propósito:
      // si la condición de rol desapareciera, este test se pondría en rojo en vez de pasar por
      // casualidad porque el mock devolvía vacío.
      .select('flito_conciliacion_lineas', [
        soporte('sop-pse', 'comprobante-pse.pdf', '2026-08-20T15:00:00Z', 'comprobante_pse'),
      ]);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(r.body.map((x: { origen: string }) => x.origen)).toEqual(['soat']);
    // Ni el archivo, ni el tipo, ni —sobre todo— un enlace firmado que lo abra.
    const cuerpo = JSON.stringify(r.body);
    expect(cuerpo).not.toContain('comprobante_pse');
    expect(cuerpo).not.toContain('comprobante-pse.pdf');
    expect(cuerpo).not.toContain('sop-pse');
  });

  it('y el auditor sigue viendo lo suyo: la factura del SOAT no se le quita', async () => {
    // La corrección tenía que ser quirúrgica. Quitarle a auditoría toda la lista habría sido una
    // regresión de una superficie que lleva funcionando desde la HU de soportes.
    escenarioAdminConAcceso();
    kdb.when
      .select('flito_soportes', [soporte('sop-soat', 'factura-soat.pdf', '2026-07-01T00:00:00Z', 'factura_soat')])
      .select('flito_conciliacion_lineas', []);

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ origen: 'soat', nombreArchivo: 'factura-soat.pdf' });
  });

  it('la consulta del comprobante ni se EMITE para el auditor: no se lee lo que no se devuelve', async () => {
    const { getTableName } = await import('drizzle-orm');
    const { soportesDeSoat } = await import('../../src/shared/soportes/soportes-consulta.js');
    const tablas: string[] = [];
    const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const c = selectBase(...args);
      const from = c.from as (t: unknown) => unknown;
      c.from = (tbl: unknown) => {
        try { tablas.push(getTableName(tbl as never)); } catch { /* no es una tabla */ }
        return from(tbl);
      };
      return c;
    });

    await soportesDeSoat(SOAT_ID, { rol: 'auditor' });
    expect(tablas).not.toContain('flito_conciliacion_lineas');

    tablas.length = 0;
    await soportesDeSoat(SOAT_ID, { rol: 'admin' });
    expect(tablas).toContain('flito_conciliacion_lineas');
  });

  it('el rol tiene que venir: la firma no admite olvidarse de decir a quién se sirve', async () => {
    // Un `actor` opcional habría dejado que el bloque más sensible se colara por defecto en el
    // próximo llamador, que es exactamente cómo nació el bloqueante. Esto lo fija en el tipo.
    const modulo = await import('../../src/shared/soportes/soportes-consulta.js');
    expect(modulo.soportesDeSoat.length).toBe(2);
  });
});

// ─────────────────── El puente, en la consulta ──────────────────────────────

describe('el puente soporte → boleta → línea → SOAT, en el where', () => {
  it('exige la línea SELLADA y el comprobante VIVO', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const condiciones: unknown[] = [];
    const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const c = selectBase(...args);
      const original = c.where as (v: unknown) => unknown;
      c.where = (cond: unknown) => { condiciones.push(cond); return original(cond); };
      return c;
    });

    const { soportesDeSoat } = await import('../../src/shared/soportes/soportes-consulta.js');
    await soportesDeSoat(SOAT_ID, { rol: 'admin' });

    const dialecto = new PgDialect();
    const textos = condiciones.map((c) => dialecto.sqlToQuery(c as never).sql);
    const puente = textos.find((t) => t.includes('flito_conciliacion_lineas')) ?? '';

    // Una línea sin sellar es un cuadre que todavía no movió un peso: su boleta puede acabar
    // descartada y no hay pago que documentar.
    expect(puente).toContain('"conciliada_en" is not null');
    // Y el comprobante reemplazado no se enseña: `descartado` es lo que distingue el vivo.
    expect(puente).toContain('"descartado"');
    expect(puente).toContain('"flito_soportes"."tipo"');
  });
});
