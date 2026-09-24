// Bug #12869 — las cinco transiciones de Operaciones también respetan el ENLACE del rol.
//
// `reactivar`, `reversar`, `asumirEnOperaciones` y `devolverAlGestor` leían el SOAT por id sin mirar
// el alcance, y `enviarAlGestor` bloqueaba el lote sin él: un rol ligado a una compañía al que el
// admin concediera esas funciones podía mover (y recibir en la respuesta) el SOAT de otra compañía.
//
// Mutante que esto mata, nombrado: quitar `dentroDeAlcance(soat, ctx)` de cualquiera de las cuatro
// (vuelve a leer por id a secas → la transición procede y emite el UPDATE), o quitar
// `...alcance` del WHERE del envío en lote (el lote deja de llevar la compañía).
//
// El mock no filtra por `where`: devuelve la fila de OTRA compañía a quien la pida. Por eso el
// rechazo se mide como «404 y cero UPDATE», y el admin sobre la MISMA fila tiene que seguir pasando.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const svc = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { EstadoSoat } = await import('@operaciones/shared-types');
type SoatCtx = Awaited<ReturnType<typeof svc.contextoSoat>>;

const SOAT_ID = '50a70000-0000-4000-8000-00000000cc01';
const PROV = '11111111-1111-1111-1111-111111111111';
const OTRA_COMPANIA = 9;

const fila = (estado: string, gestionOperaciones = false) => ({
  id: SOAT_ID, companiaId: OTRA_COMPANIA, proveedorSoatId: PROV, gestionOperaciones, estado,
  enviadoPorId: null, enviadoEn: null, motivoRechazo: null,
});

const ctxCompania: SoatCtx = {
  userId: 5, username: 'u', role: 'aseguradora_interna', externo: false, alcance: 'compania', proveedorSoatId: null, companiaId: 7,
};
const ctxAdmin: SoatCtx = {
  userId: 1, username: 'a', role: 'admin', externo: false, alcance: 'todo', proveedorSoatId: null, companiaId: null,
};

let espia: ReturnType<typeof crearEspia>;
beforeEach(() => { kdb.reset(); espia = crearEspia(kdb); });

/** Cada transición con la fila en el estado que la hace válida. */
const CASOS = [
  { nombre: 'reactivar', estado: EstadoSoat.CON_NOVEDAD, gestion: false,
    correr: (ctx: SoatCtx) => svc.reactivar(SOAT_ID, 'corregido el dato', ctx) },
  { nombre: 'reversar', estado: EstadoSoat.PAGADO, gestion: false,
    correr: (ctx: SoatCtx) => svc.reversar(SOAT_ID, EstadoSoat.PENDIENTE, 'error de carga', ctx) },
  { nombre: 'asumirEnOperaciones', estado: EstadoSoat.SOLICITADO, gestion: false,
    correr: (ctx: SoatCtx) => svc.asumirEnOperaciones(SOAT_ID, 'contingencia', ctx) },
  { nombre: 'devolverAlGestor', estado: EstadoSoat.SOLICITADO, gestion: true,
    correr: (ctx: SoatCtx) => svc.devolverAlGestor(SOAT_ID, PROV, 'ya se resolvió', ctx) },
] as const;

describe('Bug #12869 — transiciones por id: fuera del alcance del enlace = 404 y sin UPDATE; admin igual que hoy', () => {
  for (const c of CASOS) {
    it(`${c.nombre}: rol interno con enlace compañía sobre SOAT de OTRA compañía → 404 «no existe», cero UPDATE`, async () => {
      kdb.when.select('flito_soat', [fila(c.estado, c.gestion)])
        .select('flito_proveedores_soat', [{ id: PROV }])
        .update('flito_soat', [fila(c.estado, c.gestion)]);
      await expect(c.correr(ctxCompania)).rejects.toMatchObject({ status: 404, message: 'El SOAT no existe' });
      expect(espia.updatesEn('flito_soat')).toHaveLength(0);
    });

    it(`${c.nombre}: admin (alcance todo) sobre el mismo SOAT → procede y emite el UPDATE`, async () => {
      kdb.when.select('flito_soat', [fila(c.estado, c.gestion)])
        .select('flito_proveedores_soat', [{ id: PROV }])
        .update('flito_soat', [fila(c.estado, c.gestion)]);
      await expect(c.correr(ctxAdmin)).resolves.toBeTruthy();
      expect(espia.updatesEn('flito_soat')).toHaveLength(1);
    });
  }

  it('reactivar: la MISMA compañía sí procede (el enlace acota, no bloquea)', async () => {
    const propia = { ...fila(EstadoSoat.CON_NOVEDAD), companiaId: 7 };
    kdb.when.select('flito_soat', [propia]).update('flito_soat', [propia]);
    await expect(svc.reactivar(SOAT_ID, 'corregido el dato', ctxCompania)).resolves.toBeTruthy();
    expect(espia.updatesEn('flito_soat')).toHaveLength(1);
  });
});

describe('Bug #12869 — enviarAlGestor (lote): el bloqueo lleva la frontera del enlace', () => {
  const pendiente = { id: SOAT_ID };

  it('rol con enlace compañía → el SELECT … FOR UPDATE lleva SU compania_id', async () => {
    kdb.when.select('flito_soat', [pendiente]).update('flito_soat', []);
    await svc.enviarAlGestor([SOAT_ID], ctxCompania, { proveedorSoatId: PROV });
    const conds = espia.condicionesLeidas().map((c) => renderizar(c as never))
      .filter((q) => q.sql.includes('"flito_soat"."estado"'));
    expect(conds).toHaveLength(1);
    expect(ligadoA(conds[0]!, '"flito_soat"."compania_id"')).toBe(7);
  });

  it('alcance nada → nada enviado, cero UPDATE, y el id vuelve como no enviado', async () => {
    kdb.when.select('flito_soat', [pendiente]).update('flito_soat', []);
    const nada: SoatCtx = { ...ctxAdmin, role: 'transito', alcance: 'nada' };
    const r = await svc.enviarAlGestor([SOAT_ID], nada, { proveedorSoatId: PROV });
    expect(r).toEqual({ enviados: [], yaEnviados: [SOAT_ID] });
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('admin → sin condición de compañía y el envío procede', async () => {
    kdb.when.select('flito_soat', [pendiente]).update('flito_soat', []);
    const r = await svc.enviarAlGestor([SOAT_ID], ctxAdmin, { proveedorSoatId: PROV });
    expect(r.enviados).toEqual([SOAT_ID]);
    const conds = espia.condicionesLeidas().map((c) => renderizar(c as never))
      .filter((q) => q.sql.includes('"flito_soat"."estado"'));
    expect(conds[0]!.sql).not.toContain('"flito_soat"."compania_id"');
    expect(espia.updatesEn('flito_soat')).toHaveLength(1);
  });
});

describe('Bug #12869 — dentroDeAlcance: la tabla', () => {
  const f = { companiaId: 7, proveedorSoatId: PROV, gestionOperaciones: false, estado: EstadoSoat.SOLICITADO };
  it('todo → dentro; nada → fuera; compañía por igualdad y sin compañía fuera', () => {
    expect(svc.dentroDeAlcance(f, ctxAdmin)).toBe(true);
    expect(svc.dentroDeAlcance(f, { ...ctxAdmin, alcance: 'nada' })).toBe(false);
    expect(svc.dentroDeAlcance(f, ctxCompania)).toBe(true);
    expect(svc.dentroDeAlcance({ ...f, companiaId: 9 }, ctxCompania)).toBe(false);
    expect(svc.dentroDeAlcance(f, { ...ctxCompania, companiaId: null })).toBe(false);
  });
  it('proveedor → la frontera entera del gestor', () => {
    const g: SoatCtx = { ...ctxAdmin, role: 'gestor_b', alcance: 'proveedor', proveedorSoatId: PROV };
    expect(svc.dentroDeAlcance(f, g)).toBe(true);
    expect(svc.dentroDeAlcance({ ...f, proveedorSoatId: 'otro' }, g)).toBe(false);
    expect(svc.dentroDeAlcance({ ...f, gestionOperaciones: true }, g)).toBe(false);
    expect(svc.dentroDeAlcance({ ...f, estado: EstadoSoat.PENDIENTE }, g)).toBe(false);
    expect(svc.dentroDeAlcance(f, { ...g, proveedorSoatId: null })).toBe(false);
  });
});
