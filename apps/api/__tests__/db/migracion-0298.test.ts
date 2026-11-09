// ADR-0040 (HU #14351, #14353) — la 0298 siembra el perfil Coordinador de logística en el rol `proveedor` y cuelga
// `logistica.traslado.anular` de `despachar_entregar_devolver`. Estática (siempre) + contra PostgreSQL solo con
// TEST_DATABASE_URL (en tx con ROLLBACK).
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';
import { MIGRACIONES_ANTES_DEL_ARBOL, MIGRACIONES_CON_REPARTO, bloquesRepartoUnRol } from '../helpers/permisos-seed-sql.js';
import { PADRES_DE_OPCIONAL } from '../../src/modules/permisos/arbol/expansion.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0298_permisos_rol_proveedor_logistica.sql';
const SQL = leerMigracion(ARCHIVO);
const sinComentarios = (s: string) => s.replace(/--[^\n]*/g, '');
const ANULAR = 'logistica.traslado.anular';
const DESPACHAR = 'accion.logistica.despachar_entregar_devolver';

describe('0298 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio y sin DDL', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(sinComentarios(SQL)).not.toMatch(/\b(BEGIN|COMMIT|ALTER|CREATE|DROP)\b/i);
  });

  it('reparto con JOIN a permisos_roles (sin literal de rol en VALUES), solo al rol proveedor', () => {
    const s = sinComentarios(SQL);
    expect(s).not.toMatch(/VALUES/i);
    const bloques = bloquesRepartoUnRol(SQL);
    expect(bloques.map(([r]) => r)).toEqual(['proveedor']);
    expect(bloques[0]![1]).toHaveLength(15);
    expect(s).not.toMatch(/'(admin|mensajero|operaciones)'/);
  });

  it('el padre de anular en la base es el primero del árbol del código', () => {
    expect(PADRES_DE_OPCIONAL.get(ANULAR)?.[0]).toBe(DESPACHAR);
    expect(PADRES_DE_OPCIONAL.get(ANULAR)).toContain('accion.logistica.reversar_paso');
    expect(sinComentarios(SQL)).toMatch(new RegExp(`SET padre_codigo = '${DESPACHAR}'`));
  });

  it('entra al pliegue del mundo de hoy, no al plano', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_ANTES_DEL_ARBOL).not.toContain(ARCHIVO);
  });
});

describe.skipIf(!URL_BASE)('0298 — contra la base real', () => {
  let sql: ReturnType<typeof abrirBase>;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('aplicar 0298 dos veces deja el mismo reparto del proveedor y el padre de anular', async () => {
    await enTx(sql, async (tx) => {
      const foto = async () => {
        const [n] = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE rol_codigo = 'proveedor'`;
        const [l] = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion
          WHERE rol_codigo = 'proveedor' AND funcion_codigo = ANY(${bloquesRepartoUnRol(SQL)[0]![1]})`;
        const [p] = await tx`SELECT padre_codigo FROM permisos_funciones WHERE codigo = ${ANULAR}`;
        const [o] = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion rf
          WHERE rf.rol_codigo = 'proveedor' AND rf.funcion_codigo IN ('accion.logistica.cerrar_lote', 'accion.logistica.reversar_paso',
            'accion.logistica.registrar_viajes', 'logistica.actas.firmar_flit', 'logistica.actas.ver_documento_firmante')`;
        return { total: n!.n as number, logistica: l!.n as number, padre: p!.padre_codigo as string, cerradas: o!.n as number };
      };
      await tx.unsafe(SQL);
      const una = await foto();
      expect(una.logistica).toBe(15);
      expect(una.padre).toBe(DESPACHAR);
      expect(una.cerradas).toBe(0);
      await tx.unsafe(SQL);
      expect(await foto()).toEqual(una);
    });
  }, 60_000);
});
