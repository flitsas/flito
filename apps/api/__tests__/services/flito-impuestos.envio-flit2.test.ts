// HU #13268 (Feature #13267, Épica #12741, ADR-0020) — outbox del envío del comprobante de pago a FLIT 2.
//
// La base es una «grabadora»: un Drizzle REAL (sobre un cliente postgres.js que nunca conecta) cuyas
// consultas se renderizan con `toSQL()` en vez de ejecutarse, y que responde por patrón de SQL. Así se
// asierta sobre el SQL y los parámetros reales —el mock `chain` devuelve filas enteras e ignora el
// WHERE y el `orderBy`, y un test sobre la fila devuelta sobreviviría al mutante—. Las reglas de
// estado (RN-07) y la elección del soporte (AC2) se prueban además como funciones puras.
// TZ=UTC: los plazos de 24 h y 30 días no deben depender del huso de la máquina.

process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

type Grabada = { sql: string; params: unknown[] };
const estado = vi.hoisted(() => ({
  grabadas: [] as Array<{ sql: string; params: unknown[] }>,
  responder: (_q: { sql: string; params: unknown[] }): unknown[] => [],
  habilitado: true,
}));

vi.mock('../../src/db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const postgres = (await import('postgres')).default;
  // Cliente perezoso: postgres.js no abre conexión hasta la primera consulta, y aquí no hay ninguna.
  const real = drizzle(postgres('postgres://grabadora:x@127.0.0.1:1/nada', { max: 1 }));
  const dialecto = new PgDialect();
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
    execute: async (q: any) => { const r = dialecto.sqlToQuery(q); estado.grabadas.push(r); return estado.responder(r); },
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return { db, getPoolStats: vi.fn() };
});
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_ADJUNTOS_ENVIO_HABILITADO') return estado.habilitado;
        return target[prop as string];
      },
    }),
  };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const piiMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
const storage = vi.hoisted(() => ({ stat: vi.fn(), stream: vi.fn() }));
vi.mock('../../src/services/storage.js', () => ({ statEntityDocument: storage.stat, getEntityDocumentStream: storage.stream }));
const fuenteMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/modules/flito-sync/flito-sync-interruptor.service.js', () => ({ fuenteHabilitada: fuenteMock }));

const svc = await import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.service.js');
const cola = await import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.cola.js');
const { crearFlit2SyncFake } = await import('../../src/modules/flito-sync/flit2-sync-fake.adapter.js');
const { Flit2BloqueadoError } = await import('../../src/modules/flito-sync/flit2.errors.js');
const { db } = await import('../../src/db/client.js');
const { EstadoEnvioFlit2, TipoSoporte } = await import('@operaciones/shared-types');

const IMP = '11111111-1111-4111-8111-111111111111';
const SOP = '22222222-2222-4222-8222-222222222222';
const SOP2 = '33333333-3333-4333-8333-333333333333';
const FILA = '44444444-4444-4444-8444-444444444444';
const ID2 = '0192b7c4-5e6a-7d10-9f21-000000000001';
const AHORA = new Date('2026-10-05T15:00:00.000Z');
const PDF = Buffer.from('%PDF-1.7 comprobante');

const q = (re: RegExp): Grabada[] => estado.grabadas.filter((g) => re.test(g.sql));
const fila = (over: Partial<import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.cola.js').FilaEnvioTomada> = {}) => ({
  id: FILA, impuestoId: IMP, soporteId: SOP, intentos: 0, version: 1, estado: 'pendiente',
  enEsperaDesde: null as Date | null, idFlit2: ID2, syncVersion: 1042, ...over,
});

beforeEach(() => {
  estado.grabadas = [];
  estado.responder = () => [];
  estado.habilitado = true;
  fuenteMock.mockReset(); fuenteMock.mockResolvedValue(true);
  piiMock.mockClear();
  storage.stat.mockReset(); storage.stream.mockReset();
  storage.stat.mockResolvedValue({ size: PDF.length, contentType: 'application/pdf' });
  storage.stream.mockImplementation(async () => Readable.from([PDF]));
  for (const m of Object.values(logMock)) m.mockClear();
});

// ── AC2 ──────────────────────────────────────────────────────────────────────────────────────────
describe('AC2 — elección del comprobante', () => {
  const s = (id: string, tipo: string, iso: string) => ({ id, tipo, subidoEn: new Date(iso) });
  it('el recibo de pago más reciente gana al de caja; sin recibo, la caja más reciente; la liquidación nunca', () => {
    expect(svc.elegirDeSoportes([
      s('caja', TipoSoporte.RECIBO_CAJA_IMPUESTO, '2026-10-05T10:00:00Z'),
      s('pago-viejo', TipoSoporte.RECIBO_IMPUESTO, '2026-10-01T10:00:00Z'),
      s('pago-nuevo', TipoSoporte.RECIBO_IMPUESTO, '2026-10-03T10:00:00Z'),
      s('liq', TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, '2026-10-06T10:00:00Z'),
    ])).toBe('pago-nuevo');
    expect(svc.elegirDeSoportes([
      s('caja-1', TipoSoporte.RECIBO_CAJA_IMPUESTO, '2026-10-01T10:00:00Z'),
      s('caja-2', TipoSoporte.RECIBO_CAJA_IMPUESTO, '2026-10-02T10:00:00Z'),
    ])).toBe('caja-2');
    expect(svc.elegirDeSoportes([s('liq', TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, '2026-10-06T10:00:00Z')])).toBeNull();
  });
  it('la consulta excluye descartados y solo pide recibo de pago y de caja', async () => {
    await svc.elegirComprobante(db as never, IMP);
    const [g] = q(/from "flito_soportes"/);
    expect(g.sql).toMatch(/"flito_soportes"\."descartado" = \$\d/);
    expect(g.sql).toMatch(/"flito_soportes"\."tipo" in \(\$\d, \$\d\)/);
    expect(g.params).toEqual(expect.arrayContaining([IMP, false, 'recibo_impuesto', 'recibo_caja_impuesto']));
    expect(g.params).not.toContain('recibo_impuesto_sin_marca_agua');
  });
});

// ── AC1 / AC3 / AC4 — RN-01 ──────────────────────────────────────────────────────────────────────
describe('RN-01 programarEnvioFlit2 (dentro de la tx del pago)', () => {
  const responderCon = (fuente: string, soportes: Array<{ id: string; tipo: string; subidoEn: Date }>) => (g: Grabada) => {
    if (/"flito_tramites"\."fuente"/.test(g.sql) && /inner join "flito_tramites"/.test(g.sql)) return [{ fuente }];
    if (/from "flito_soportes"/.test(g.sql)) return soportes;
    return [];
  };

  it('AC3: trámite que no es de FLIT 2 → no escribe nada', async () => {
    estado.responder = responderCon('flit', [{ id: SOP, tipo: 'recibo_impuesto', subidoEn: AHORA }]);
    expect(await svc.programarEnvioFlit2(db as never, IMP, AHORA)).toBe('no_flit2');
    expect(q(/insert into "flito_impuesto_envios_flit2"/)).toHaveLength(0);
    expect(q(/from "flito_soportes"/)).toHaveLength(0);
  });

  it('AC4: FLIT 2 sin recibo de pago ni de caja → sin_comprobante, sin intentos, ON CONFLICT DO NOTHING', async () => {
    estado.responder = responderCon('flit2', []);
    expect(await svc.programarEnvioFlit2(db as never, IMP, AHORA)).toBe('sin_comprobante');
    const [ins] = q(/insert into "flito_impuesto_envios_flit2"/);
    expect(ins.sql).toMatch(/on conflict \("impuesto_id"\) do nothing/);
    expect(ins.params).toContain('sin_comprobante');
  });

  it('AC1: FLIT 2 con recibo → pendiente con cita ahora; el upsert solo reabre sin_comprobante y enviado-con-otro-soporte', async () => {
    estado.responder = responderCon('flit2', [{ id: SOP, tipo: 'recibo_impuesto', subidoEn: AHORA }]);
    expect(await svc.programarEnvioFlit2(db as never, IMP, AHORA)).toBe('programado');
    const [ins] = q(/insert into "flito_impuesto_envios_flit2"/);
    expect(ins.params).toEqual(expect.arrayContaining([IMP, 'pendiente', SOP]));
    expect(ins.sql).toMatch(/on conflict \("impuesto_id"\) do update set/);
    // Transiciones de la tabla RN-01, en el WHERE del DO UPDATE.
    expect(ins.sql).toMatch(/where "flito_impuesto_envios_flit2"\."estado" = 'sin_comprobante'/);
    expect(ins.sql).toMatch(/"estado" IN \('pendiente','en_espera'\) AND "flito_impuesto_envios_flit2"\."soporte_id" IS DISTINCT FROM excluded\.soporte_id/);
    expect(ins.sql).toMatch(/"estado" = 'enviado' AND "flito_impuesto_envios_flit2"\."soporte_enviado_id" IS DISTINCT FROM excluded\.soporte_id/);
    // enviado con otro soporte → intentos 0 y version + 1 (D-2).
    expect(ins.sql).toMatch(/"intentos" = CASE WHEN "flito_impuesto_envios_flit2"\."estado" = 'enviado' THEN 0/);
    expect(ins.sql).toMatch(/"version" = CASE WHEN "flito_impuesto_envios_flit2"\."estado" = 'enviado' THEN "flito_impuesto_envios_flit2"\."version" \+ 1/);
    // Nada de red dentro de la transacción del pago.
    expect(q(/system_locks|WITH candidatas/)).toHaveLength(0);
  });

  it('RN-02 / AC3: completarComprobanteFlit2 NUNCA crea fila; solo promueve sin_comprobante o refresca pendiente/en_espera (AC4)', async () => {
    estado.responder = (g) => (/from "flito_soportes"/.test(g.sql) ? [{ id: SOP2, tipo: 'recibo_impuesto', subidoEn: AHORA }] : []);
    await svc.completarComprobanteFlit2(db as never, IMP, AHORA);
    expect(q(/^insert/)).toHaveLength(0);
    const [up] = q(/^update "flito_impuesto_envios_flit2"/);
    expect(up.sql).toMatch(/"estado" = CASE WHEN "flito_impuesto_envios_flit2"\."estado" = 'sin_comprobante' THEN 'pendiente'/);
    expect(up.sql).toMatch(/"flito_impuesto_envios_flit2"\."impuesto_id" = \$\d/);
    expect(up.params).toEqual(expect.arrayContaining([SOP2, IMP, AHORA.toISOString()]));
    expect(up.params.some((p) => p instanceof Date)).toBe(false);
  });

  it('completarComprobanteFlit2 sin recibo elegible no escribe', async () => {
    await svc.completarComprobanteFlit2(db as never, IMP, AHORA);
    expect(q(/^update|^insert/)).toHaveLength(0);
  });
});

// ── RN-07 puro ───────────────────────────────────────────────────────────────────────────────────
describe('RN-07 cambiosPorResultado (puro)', () => {
  const recibido = { adjuntoId: '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f', tipo: 'liquidacion_impuesto', sha256: 'a'.repeat(64), reemplazoDe: null, enMatriz: true, pagadoMarcado: false };

  it('AC1: 201 → enviado con adjuntoId, cuenta el intento, guarda pagadoMarcado/enMatriz y el soporte enviado', () => {
    const c = svc.cambiosPorResultado(fila(), SOP, { tipo: 'enviado', nuevo: true, recibido }, AHORA)!;
    expect(c.consumeIntento).toBe(true);
    expect(c.cambios).toMatchObject({
      estado: 'enviado', intentos: 1, adjuntoId: recibido.adjuntoId, pagadoMarcado: false, enMatriz: true,
      soporteEnviadoId: SOP, enviadoEn: AHORA, ultimoStatus: 201, syncVersionEspera: null, enEsperaDesde: null,
    });
  });

  it('AC8: 200 idempotente → enviado, sin contarlo como fallo', () => {
    const c = svc.cambiosPorResultado(fila({ intentos: 1 }), SOP, { tipo: 'enviado', nuevo: false, recibido }, AHORA)!;
    expect(c.cambios).toMatchObject({ estado: 'enviado', ultimoResultado: 'enviado_idempotente', ultimoStatus: 200, intentos: 2 });
  });

  it('AC5: reintentable → pendiente con backoff 5 min y 30 min; el 3.º → error sin más cita', () => {
    const r = { tipo: 'reintentable' as const, codigo: 'http_503', status: 503 };
    const c1 = svc.cambiosPorResultado(fila({ intentos: 0 }), SOP, r, AHORA)!.cambios;
    expect(c1).toMatchObject({ estado: 'pendiente', intentos: 1, proximoIntentoEn: new Date(AHORA.getTime() + 5 * 60_000) });
    const c2 = svc.cambiosPorResultado(fila({ intentos: 1 }), SOP, r, AHORA)!.cambios;
    expect(c2).toMatchObject({ estado: 'pendiente', intentos: 2, proximoIntentoEn: new Date(AHORA.getTime() + 30 * 60_000) });
    const c3 = svc.cambiosPorResultado(fila({ intentos: 2 }), SOP, r, AHORA)!.cambios;
    expect(c3).toMatchObject({ estado: 'error', intentos: 3, proximoIntentoEn: null, ultimoResultado: 'http_503' });
  });

  it('AC5 excepción: estacionar NO toca intentos, guarda la sync_version leída en la toma y cita a 24 h', () => {
    const c = svc.cambiosPorResultado(fila({ intentos: 1, syncVersion: 1042 }), SOP, { tipo: 'estacionar', estadoFlit2: 'preparado' }, AHORA)!;
    expect(c.consumeIntento).toBe(false);
    expect(c.cambios).not.toHaveProperty('intentos');
    expect(c.cambios).toMatchObject({
      estado: 'en_espera', estadoFlit2: 'preparado', syncVersionEspera: 1042, enEsperaDesde: AHORA,
      proximoIntentoEn: new Date('2026-10-06T15:00:00.000Z'),
    });
  });

  it('re-estacionar con versión nueva conserva en_espera_desde; a los 30 días → error espera_vencida', () => {
    const desde = new Date('2026-09-20T15:00:00.000Z');
    const re = svc.cambiosPorResultado(fila({ estado: 'en_espera', enEsperaDesde: desde, syncVersion: 1050 }), SOP, { tipo: 'estacionar', estadoFlit2: 'rechazado' }, AHORA)!;
    expect(re.cambios).toMatchObject({ estado: 'en_espera', enEsperaDesde: desde, syncVersionEspera: 1050 });
    const treinta = new Date(AHORA.getTime() - 30 * 24 * 60 * 60_000);
    const v = svc.cambiosPorResultado(fila({ estado: 'en_espera', enEsperaDesde: treinta }), SOP, { tipo: 'estacionar', estadoFlit2: 'borrador' }, AHORA)!;
    expect(v.consumeIntento).toBe(false);
    expect(v.cambios).toMatchObject({ estado: 'error', ultimoResultado: 'espera_vencida', syncVersionEspera: null, enEsperaDesde: null });
    expect(v.cambios).not.toHaveProperty('intentos');
  });

  it('AC6: attachment_exists → ya_cargado_gestor; not_allowed_in_state terminal:true → error con el estado de FLIT 2', () => {
    expect(svc.cambiosPorResultado(fila(), SOP, { tipo: 'definitivo', motivo: 'attachment_exists', status: 409 }, AHORA)!.cambios)
      .toMatchObject({ estado: 'ya_cargado_gestor', intentos: 1, proximoIntentoEn: null });
    expect(svc.cambiosPorResultado(fila(), SOP, { tipo: 'definitivo', motivo: 'not_allowed_in_state', status: 409, estadoFlit2: 'aprobado' }, AHORA)!.cambios)
      .toMatchObject({ estado: 'error', estadoFlit2: 'aprobado', proximoIntentoEn: null });
  });

  it('espera (429) y pausa no escriben desenlace en la fila', () => {
    expect(svc.cambiosPorResultado(fila(), SOP, { tipo: 'espera', segundos: 30 }, AHORA)).toBeNull();
    expect(svc.cambiosPorResultado(fila(), SOP, { tipo: 'pausa', codigo: 'no_disponible', status: 404 }, AHORA)).toBeNull();
  });
});

// ── RN-03 toma ───────────────────────────────────────────────────────────────────────────────────
describe('RN-03 toma (SQL renderizado)', () => {
  it('una sola sentencia SKIP LOCKED; pendiente vencida o en_espera despertada por el feed o el sondeo; solo pagado y flit2', async () => {
    await cola.tomarLoteEnvios({ limite: 50, tomadoPor: 'host-1', ahora: AHORA });
    const [g] = q(/WITH candidatas/);
    expect(g.sql).toMatch(/FOR UPDATE OF e SKIP LOCKED/);
    expect(g.sql).toMatch(/i\.estado = \$1/);
    expect(g.params[0]).toBe('pagado');
    expect(g.sql).toMatch(/t\.fuente = 'flit2' AND t\.id_flit2 IS NOT NULL/);
    expect(g.sql).toMatch(/e\.estado = 'pendiente' AND e\.proximo_intento_en <= \$\d+::timestamptz/);
    expect(g.sql).toMatch(/e\.estado = 'en_espera' AND \(\s*e\.proximo_intento_en <= \$\d+::timestamptz\s*OR \(t\.sync_version > e\.sync_version_espera AND t\.flit_estado IN \(\$\d+, \$\d+, \$\d+, \$\d+\)\)\)/);
    // La grafía la deriva `estadoDesdeFlit2` (la que escribe el feed), no un literal a mano.
    expect(g.params).toEqual(expect.arrayContaining(['Preasignacion', 'Asignado', 'Entregado', 'Rechazado']));
    expect(g.params).toContain(50);
    // postgres.js no serializa un Date crudo en db.execute: solo texto ISO.
    expect(g.params.some((p) => p instanceof Date)).toBe(false);
    expect(g.params).toContain(AHORA.toISOString());
    expect(g.sql).toMatch(/RETURNING c\.id, c\.impuesto_id, c\.soporte_id, c\.intentos, c\.version, c\.estado, c\.en_espera_desde,\s+t\.id_flit2, t\.sync_version/);
  });
});

// ── Ciclo (RN-04 / RN-05 / RN-06 / RN-08) ────────────────────────────────────────────────────────
describe('ciclo de envío', () => {
  const tomada = (n: number) => ({
    id: `${FILA.slice(0, -2)}${String(n).padStart(2, '0')}`, impuesto_id: IMP, soporte_id: SOP, intentos: 0, version: 1,
    estado: 'pendiente', en_espera_desde: null, id_flit2: ID2, sync_version: '1042',
  });
  const responderCiclo = (opts: { filas?: unknown[]; pausa?: { hasta: Date; codigo: string } | null } = {}) => (g: Grabada) => {
    if (/from "system_locks"/.test(g.sql)) return opts.pausa ? [opts.pausa] : [];
    if (/WITH candidatas/.test(g.sql)) return opts.filas ?? [tomada(1)];
    if (/from "flito_soportes"/.test(g.sql)) return [{ id: SOP, storageKey: 'impuestos/recibos/x.pdf', descartado: false, impuestoId: IMP }];
    if (/^update "flito_impuesto_envios_flit2".*returning/s.test(g.sql)) return [{ id: FILA }];
    return [];
  };
  const updatesDeFila = () => q(/^update "flito_impuesto_envios_flit2"/);
  const audits = () => q(/^insert into "audit_logs"/);

  it('AC7: FLIT2_ADJUNTOS_ENVIO_HABILITADO apagada → no toma nada', async () => {
    estado.habilitado = false;
    const fake = crearFlit2SyncFake([]);
    expect(await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA })).toMatchObject({ omitido: 'apagado', tomadas: 0 });
    expect(estado.grabadas).toHaveLength(0);
    expect(fake.llamadasEnvio).toHaveLength(0);
  });

  it('AC7: interruptor de la fuente flit2 apagado → no toma nada', async () => {
    fuenteMock.mockResolvedValue(false);
    expect(await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: crearFlit2SyncFake([]), reloj: () => AHORA })).toMatchObject({ omitido: 'fuente_apagada' });
    expect(q(/WITH candidatas/)).toHaveLength(0);
  });

  it('AC1 + AC9: envía el PDF con nombre genérico, escribe enviado con adjuntoId, audita el intento y la lectura PII', async () => {
    estado.responder = responderCiclo();
    const fake = crearFlit2SyncFake([]);
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(r).toMatchObject({ tomadas: 1, escritas: 1, sondeo: false });
    expect(fake.llamadasEnvio).toEqual([expect.objectContaining({ idFlit2: ID2, contentType: 'application/pdf', nombreArchivo: 'comprobante-impuesto.pdf', tamano: PDF.length })]);
    const [up] = updatesDeFila();
    expect(up.sql).toMatch(/where \("flito_impuesto_envios_flit2"\."id" = \$\d+ and "flito_impuesto_envios_flit2"\."version" = \$\d+\)/);
    expect(up.params).toEqual(expect.arrayContaining(['enviado', 1]));
    const [a] = audits();
    const detalle = String(a.params.find((p) => typeof p === 'string' && p.startsWith('Envío a FLIT 2')));
    expect(detalle).toMatch(/intento 1 · enviado · estado FLIT 2 — · adjunto [0-9a-f-]{36} · soporte 22222222/);
    expect(a.params).toEqual(expect.arrayContaining(['sistema', 'flito_impuesto', IMP]));
    expect(piiMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accion: 'read', camposAccedidos: ['comprobante_pago_impuesto'], motivo: expect.stringMatching(/^envio_flit2 \(sistema\) — intento 1 · impuesto /) }));
    // AC9: ningún log del ciclo lleva la clave de storage ni el nombre de archivo.
    expect(JSON.stringify([...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls])).not.toMatch(/impuestos\/recibos|comprobante-impuesto/);
  });

  it('RN-06: más de 20 MB → error file_too_large SIN llamada, SIN intento y SIN bajar el objeto', async () => {
    estado.responder = responderCiclo();
    storage.stat.mockResolvedValue({ size: 20 * 1024 * 1024 + 1, contentType: 'application/pdf' });
    const fake = crearFlit2SyncFake([]);
    await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(fake.llamadasEnvio).toHaveLength(0);
    expect(storage.stream).not.toHaveBeenCalled();
    const [up] = updatesDeFila();
    expect(up.params).toEqual(expect.arrayContaining(['error', 'file_too_large']));
    expect(up.sql).not.toMatch(/"intentos" =/);
  });

  it('RN-06: bytes que no son pdf/jpeg/png/webp → error invalid_mime sin llamada; vacío → missing_file', async () => {
    estado.responder = responderCiclo();
    storage.stream.mockImplementation(async () => Readable.from([Buffer.from('GIF89a…')]));
    const fake = crearFlit2SyncFake([]);
    await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(fake.llamadasEnvio).toHaveLength(0);
    expect(updatesDeFila()[0].params).toEqual(expect.arrayContaining(['error', 'invalid_mime']));
    estado.grabadas = [];
    storage.stat.mockResolvedValue({ size: 0, contentType: 'application/pdf' });
    await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(updatesDeFila()[0].params).toEqual(expect.arrayContaining(['error', 'missing_file']));
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('AC4 en el envío: el soporte quedó descartado y no hay otro → sin_comprobante (sin intento)', async () => {
    estado.responder = (g) => {
      if (/from "flito_soportes"/.test(g.sql)) return /"flito_soportes"\."id" = \$1/.test(g.sql) ? [{ id: SOP, storageKey: 'k', descartado: true, impuestoId: IMP }] : [];
      return responderCiclo()(g);
    };
    const fake = crearFlit2SyncFake([]);
    await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(fake.llamadasEnvio).toHaveLength(0);
    const [up] = updatesDeFila();
    expect(up.params).toContain('sin_comprobante');
    expect(up.sql).toMatch(/"soporte_id" = \$\d+/);
    expect(up.sql).not.toMatch(/"intentos" =/);
  });

  it('AC7: 429 corta el ciclo — las filas no empezadas se liberan sin intento; la que recibió el 429 se cita tras Retry-After', async () => {
    const filas = [1, 2, 3, 4, 5].map(tomada);
    estado.responder = responderCiclo({ filas });
    const fake = crearFlit2SyncFake([]);
    fake.programarRespuestaAdjunto(ID2, Array(5).fill({ tipo: 'espera', segundos: 30 }));
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(r).toMatchObject({ tomadas: 5, corte: 'espera', escritas: 0, liberadas: 1 });
    expect(fake.llamadasEnvio).toHaveLength(4); // concurrencia 4: la 5.ª no llega a salir
    const ups = updatesDeFila();
    expect(ups.every((u) => !/"intentos" =|"estado" =/.test(u.sql))).toBe(true);
    expect(ups.filter((u) => u.params.includes(new Date(AHORA.getTime() + 30_000).toISOString()) || /"proximo_intento_en" =/.test(u.sql))).toHaveLength(4);
    expect(audits()).toHaveLength(0);
  });

  it('AC7 / RN-05: 404 sin cuerpo → pausa global persistida 20 min en system_locks, sin intento', async () => {
    estado.responder = responderCiclo();
    const fake = crearFlit2SyncFake([]);
    fake.programarRespuestaAdjunto(ID2, [{ tipo: 'pausa', codigo: 'no_disponible', status: 404 }]);
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(r.corte).toBe('pausa');
    const [ins] = q(/^insert into "system_locks"/);
    expect(ins.params).toEqual(expect.arrayContaining([cola.PAUSA_ENVIO_FLIT2_CLAVE, 'no_disponible']));
    expect(ins.sql).toMatch(/on conflict \("lock_name"\) do update/);
    expect(updatesDeFila().every((u) => !/"intentos" =|"estado" =/.test(u.sql))).toBe(true);
    expect(cola.PAUSA_ENVIO_FLIT2_MS).toBe(20 * 60_000);
  });

  it('RN-05: pausa vigente → el ciclo no toma nada', async () => {
    estado.responder = responderCiclo({ pausa: { hasta: new Date(AHORA.getTime() + 60_000), codigo: 'no_disponible' } });
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: crearFlit2SyncFake([]), reloj: () => AHORA });
    expect(r.omitido).toBe('pausa');
    expect(q(/WITH candidatas/)).toHaveLength(0);
  });

  it('RN-05 sondeo: pausa vencida → lote 1; si sale bien, se borra la marca', async () => {
    estado.responder = responderCiclo({ pausa: { hasta: new Date(AHORA.getTime() - 1), codigo: 'no_disponible' } });
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: crearFlit2SyncFake([]), reloj: () => AHORA });
    expect(r.sondeo).toBe(true);
    const [toma] = q(/WITH candidatas/);
    expect(toma.params).toContain(1);
    expect(toma.params).not.toContain(50);
    expect(q(/^delete from "system_locks"/)).toHaveLength(1);
  });

  it('RN-05 sondeo que vuelve a dar pausa → renueva la pausa y NO la borra', async () => {
    estado.responder = responderCiclo({ pausa: { hasta: new Date(AHORA.getTime() - 1), codigo: 'no_disponible' } });
    const fake = crearFlit2SyncFake([]);
    fake.programarRespuestaAdjunto(ID2, [{ tipo: 'pausa', codigo: 'no_disponible', status: 404 }]);
    await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(q(/^insert into "system_locks"/)).toHaveLength(1);
    expect(q(/^delete from "system_locks"/)).toHaveLength(0);
  });

  it('error del pase (bloqueado) → pausa global hasta su `hasta`, sin intento', async () => {
    estado.responder = responderCiclo();
    const hasta = new Date(AHORA.getTime() + 7 * 60_000);
    const fake = crearFlit2SyncFake([]);
    fake.enviarAdjunto = async () => { throw new Flit2BloqueadoError('client_locked', hasta, true); };
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(r.corte).toBe('pausa');
    const [ins] = q(/^insert into "system_locks"/);
    expect(ins.params).toEqual(expect.arrayContaining(['pase_bloqueado']));
    expect(audits()).toHaveLength(0);
  });

  it('AC5 excepción en el ciclo: 409 terminal:false estaciona sin intento y no corta el ciclo', async () => {
    estado.responder = responderCiclo({ filas: [tomada(1), tomada(2)] });
    const fake = crearFlit2SyncFake([]);
    fake.programarRespuestaAdjunto(ID2, [{ tipo: 'estacionar', estadoFlit2: 'borrador' }]);
    const r = await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA });
    expect(r).toMatchObject({ escritas: 2, liberadas: 0 });
    expect(r.corte).toBeUndefined();
    const est = updatesDeFila().find((u) => u.params.includes('en_espera'))!;
    expect(est.params).toEqual(expect.arrayContaining(['en_espera', 1042]));
    expect(est.sql).not.toMatch(/"intentos" =/);
    expect(audits().some((a) => a.params.some((p) => typeof p === 'string' && /en_espera \(sin consumir intento\)/.test(p)))).toBe(true);
  });

  it('RN-07: si la fila se reprogramó mientras tanto (version distinta), el desenlace se descarta y se audita', async () => {
    estado.responder = (g) => (/^update "flito_impuesto_envios_flit2".*returning/s.test(g.sql) ? [] : responderCiclo()(g));
    await svc.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: crearFlit2SyncFake([]), reloj: () => AHORA });
    const [a] = audits();
    expect(a.params.some((p) => typeof p === 'string' && /descartado por reprogramación/.test(p))).toBe(true);
  });
});

// ── AC10 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC10 — estado del envío en el detalle', () => {
  it('null si el trámite no es de FLIT 2 o no hay fila; si no, estado/intentos/último intento', () => {
    expect(svc.envioFlit2DesdeFila({ fuente: 'flit', estado: 'enviado', intentos: 1, ultimoIntentoEn: AHORA })).toBeNull();
    expect(svc.envioFlit2DesdeFila({ fuente: 'flit2', estado: null, intentos: null, ultimoIntentoEn: null })).toBeNull();
    expect(svc.envioFlit2DesdeFila(undefined)).toBeNull();
    expect(svc.envioFlit2DesdeFila({ fuente: 'flit2', estado: EstadoEnvioFlit2.EN_ESPERA, intentos: 2, ultimoIntentoEn: AHORA }))
      .toEqual({ estado: 'en_espera', intentos: 2, ultimoIntentoEn: AHORA.toISOString() });
  });
  it('la lectura resuelve la fuente por join y deja el envío en LEFT JOIN', async () => {
    estado.responder = () => [{ fuente: 'flit2', estado: 'pendiente', intentos: 0, ultimoIntentoEn: null }];
    expect(await svc.envioFlit2DeImpuesto(IMP)).toEqual({ estado: 'pendiente', intentos: 0, ultimoIntentoEn: null });
    const [g] = estado.grabadas;
    expect(g.sql).toMatch(/inner join "flito_tramites"/);
    expect(g.sql).toMatch(/left join "flito_impuesto_envios_flit2"/);
  });
});
