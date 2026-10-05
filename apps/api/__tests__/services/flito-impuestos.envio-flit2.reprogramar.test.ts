// HU #13269 (Feature #13267, diseño §12) — RN-10 `reprogramarEnvioFlit2`: la reprogramación del envío
// a FLIT 2 cuando se reemplaza el comprobante de pago.
//
// Misma «grabadora» que flito-impuestos.envio-flit2.test.ts: Drizzle REAL que renderiza con `toSQL()`
// y responde por patrón, para asertar sobre el SQL y los parámetros reales (el mock `chain` ignora el
// WHERE y devuelve filas enteras: un aserto sobre la fila devuelta sobreviviría al mutante).
// TZ=UTC: `proximo_intento_en` se compara como instante.

process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Grabada = { sql: string; params: unknown[] };
const estado = vi.hoisted(() => ({
  grabadas: [] as Array<{ sql: string; params: unknown[] }>,
  responder: (_q: { sql: string; params: unknown[] }): unknown[] => [],
}));

vi.mock('../../src/db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const postgres = (await import('postgres')).default;
  const real = drizzle(postgres('postgres://grabadora:x@127.0.0.1:1/nada', { max: 1 }));
  const envolver = (b: any): any => new Proxy(b, {
    get(t, p) {
      if (p === 'then') {
        return (ok: (v: unknown) => void, ko: (e: unknown) => void) => {
          try { const q = t.toSQL(); estado.grabadas.push(q); ok(estado.responder(q)); } catch (e) { ko(e); }
        };
      }
      const v = t[p];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => { const r = v.apply(t, a); return r && typeof r === 'object' && 'toSQL' in r ? envolver(r) : r; };
    },
  });
  const db: any = {
    select: (...a: unknown[]) => envolver((real.select as any)(...a)),
    insert: (t: any) => envolver(real.insert(t)),
    update: (t: any) => envolver(real.update(t)),
    delete: (t: any) => envolver(real.delete(t)),
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return { db, getPoolStats: vi.fn() };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn(async () => {}) }));
vi.mock('../../src/services/storage.js', () => ({ statEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn() }));
vi.mock('../../src/modules/flito-sync/flito-sync-interruptor.service.js', () => ({ fuenteHabilitada: vi.fn(async () => true) }));

const svc = await import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.service.js');
const { db } = await import('../../src/db/client.js');
const { EstadoEnvioFlit2 } = await import('@operaciones/shared-types');

const IMP = '11111111-1111-4111-8111-111111111111';
const NUEVO = '33333333-3333-4333-8333-333333333333';
const FILA = '44444444-4444-4444-8444-444444444444';
const AHORA = new Date('2026-10-05T15:00:00.000Z');
const CTX = { userId: 7, username: 'op@flitsas.io' };

const q = (re: RegExp): Grabada[] => estado.grabadas.filter((g) => re.test(g.sql));
const updates = () => q(/^update "flito_impuesto_envios_flit2"/);
const auditorias = () => q(/^insert into "audit_logs"/);

/** Responde la lectura FOR UPDATE de la fila y, si se pide, la fuente del trámite. */
function base(filaEstado: string | null, fuente: string | null = 'flit2') {
  estado.responder = (g) => {
    if (/from "flito_impuesto_envios_flit2"/.test(g.sql) && /^select/.test(g.sql)) {
      return filaEstado ? [{ id: FILA, estado: filaEstado }] : [];
    }
    if (/"flito_tramites"\."fuente"/.test(g.sql)) return fuente ? [{ fuente }] : [];
    return [];
  };
}

beforeEach(() => { estado.grabadas = []; estado.responder = () => []; });

describe('RN-10 — filas reprogramables vuelven a pendiente desde cero con el soporte nuevo', () => {
  it.each([
    EstadoEnvioFlit2.ENVIADO, EstadoEnvioFlit2.ERROR, EstadoEnvioFlit2.PENDIENTE,
    EstadoEnvioFlit2.EN_ESPERA, EstadoEnvioFlit2.SIN_COMPROBANTE,
  ])('%s → reenviado:true; UPDATE de la fila con todos los campos del diseño §12', async (desde) => {
    base(desde);
    const r = await svc.reprogramarEnvioFlit2(db as never, IMP, NUEVO, CTX, AHORA);
    expect(r).toEqual({ reenviado: true });

    const lectura = q(/^select .* from "flito_impuesto_envios_flit2"/);
    expect(lectura).toHaveLength(1);
    expect(lectura[0]!.sql).toMatch(/where "flito_impuesto_envios_flit2"\."impuesto_id" = \$1 for update$/);
    expect(lectura[0]!.params).toEqual([IMP]);

    const [u, ...resto] = updates();
    expect(resto).toHaveLength(0);
    // Cada columna, con su valor, en el SET; la versión SUBE (guarda de RN-07 contra el envío en vuelo).
    expect(u!.sql).toMatch(/"estado" = \$\d+/);
    expect(u!.sql).toMatch(/"version" = "flito_impuesto_envios_flit2"\."version" \+ 1/);
    for (const col of ['tomado_por', 'tomado_en', 'ultimo_resultado', 'sync_version_espera', 'en_espera_desde']) {
      expect(u!.sql).toMatch(new RegExp(`"${col}" = \\$\\d+`));
    }
    expect(u!.sql).toMatch(/where "flito_impuesto_envios_flit2"\."id" = \$\d+$/);
    const valor = (col: string): unknown => {
      const set = u!.sql.slice(u!.sql.indexOf(' set ') + 5, u!.sql.indexOf(' where '));
      const asignaciones = set.split(', ');
      const i = asignaciones.findIndex((a) => a.startsWith(`"${col}" = $`));
      const n = Number(/\$(\d+)/.exec(asignaciones[i]!)![1]);
      return u!.params[n - 1];
    };
    expect(valor('estado')).toBe('pendiente');
    expect(valor('soporte_id')).toBe(NUEVO);
    expect(valor('intentos')).toBe(0);
    expect(valor('proximo_intento_en')).toBe(AHORA.toISOString());
    for (const col of ['tomado_por', 'tomado_en', 'ultimo_resultado', 'sync_version_espera', 'en_espera_desde']) {
      expect(valor(col)).toBeNull();
    }
    expect(u!.params[u!.params.length - 1]).toBe(FILA);
  });

  it('audita «reprogramado por reemplazo» con el actor, el impuesto, el estado previo y el soporte nuevo', async () => {
    base(EstadoEnvioFlit2.ENVIADO);
    await svc.reprogramarEnvioFlit2(db as never, IMP, NUEVO, CTX, AHORA);
    const a = auditorias();
    expect(a).toHaveLength(1);
    expect(a[0]!.params).toEqual(expect.arrayContaining([7, 'op@flitsas.io', 'update', 'flito_impuesto', IMP]));
    const detalle = a[0]!.params.find((p) => typeof p === 'string' && p.startsWith('Envío a FLIT 2 reprogramado por reemplazo'));
    expect(detalle).toBe(`Envío a FLIT 2 reprogramado por reemplazo (estaba enviado). Soporte ${NUEVO}.`);
  });

  it('usa el escritor que recibe (la tx del reemplazo), no `db` por su cuenta', async () => {
    base(EstadoEnvioFlit2.ERROR);
    const tx = { select: vi.fn((...a: unknown[]) => (db as any).select(...a)), update: vi.fn((t: unknown) => (db as any).update(t)), insert: vi.fn((t: unknown) => (db as any).insert(t)) };
    await svc.reprogramarEnvioFlit2(tx as never, IMP, NUEVO, CTX, AHORA);
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });
});

describe('RN-10 — lo que NO se reenvía', () => {
  it('ya_cargado_gestor (AC6) → { reenviado:false, motivo:ya_cargado_gestor }; ni UPDATE ni auditoría', async () => {
    base(EstadoEnvioFlit2.YA_CARGADO_GESTOR);
    expect(await svc.reprogramarEnvioFlit2(db as never, IMP, NUEVO, CTX, AHORA)).toEqual({ reenviado: false, motivo: 'ya_cargado_gestor' });
    expect(updates()).toHaveLength(0);
    expect(q(/^insert/)).toHaveLength(0);
  });

  it('sin fila y trámite que no es de FLIT 2 (AC5) → no_flit2; no crea fila', async () => {
    base(null, 'flit1');
    expect(await svc.reprogramarEnvioFlit2(db as never, IMP, NUEVO, CTX, AHORA)).toEqual({ reenviado: false, motivo: 'no_flit2' });
    expect(updates()).toHaveLength(0);
    expect(q(/^insert/)).toHaveLength(0);
  });

  it('sin fila y trámite de FLIT 2 pagado antes del envío automático (D-5) → sin_envio_previo; no crea fila', async () => {
    base(null, 'flit2');
    expect(await svc.reprogramarEnvioFlit2(db as never, IMP, NUEVO, CTX, AHORA)).toEqual({ reenviado: false, motivo: 'sin_envio_previo' });
    expect(updates()).toHaveLength(0);
    expect(q(/^insert/)).toHaveLength(0);
  });
});
