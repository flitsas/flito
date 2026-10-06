// HU #13310 (Feature #13309, Épica #12741, ADR-0021) — ciclo del envío del comprobante de pago a FLIT 1.
//
// Misma «grabadora» que flito-impuestos.envio-flit2.test.ts: Drizzle REAL que renderiza con `toSQL()` y
// responde por patrón, para asertar sobre el SQL y los parámetros reales (el mock `chain` devuelve la
// fila entera e ignora el WHERE). El adaptador es el HTTP REAL con `fetch` espiado (vi.stubGlobal): así
// «cero llamadas a FLIT 1» es literal, y cada describe con un «no llama» trae su control positivo.
// TCs: docs/qa/hu-13310-tcs.md. TZ=UTC: el backoff se compara como instante.

process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

type Grabada = { sql: string; params: unknown[] };
const estado = vi.hoisted(() => ({
  grabadas: [] as Array<{ sql: string; params: unknown[] }>,
  responder: (_q: { sql: string; params: unknown[] }): unknown[] => [],
  env: {} as Record<string, unknown>,
}));

vi.mock('../../src/db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const postgres = (await import('postgres')).default;
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
        if (typeof prop === 'string' && prop in estado.env) return estado.env[prop];
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
const fuenteMock = vi.hoisted(() => vi.fn(async (_f: string) => true));
vi.mock('../../src/modules/flito-sync/flito-sync-interruptor.service.js', () => ({ fuenteHabilitada: fuenteMock }));

const svc = await import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit1.service.js');
const cola = await import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit1.cola.js');
const svc2 = await import('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.service.js');
const { db } = await import('../../src/db/client.js');
const { crearFlit2SyncFake } = await import('../../src/modules/flito-sync/flit2-sync-fake.adapter.js');

const IMP = '11111111-1111-4111-8111-111111111111';
const SOP = '22222222-2222-4222-8222-222222222222';
const SOP2 = '33333333-3333-4333-8333-333333333333';
const FILA = '44444444-4444-4444-8444-444444444444';
const AHORA = new Date('2026-10-06T15:00:00.000Z');
const ARCHIVOS = 'https://flit1-archivos.ejemplo.test';
const TRAMITES = 'https://flit1-tramites.ejemplo.test';
const SUBIDA = 'https://flito-ejemplo.s3.us-east-1.amazonaws.com/';
const FIELDS = { key: 'k', Policy: 'POLICYSECRETA', 'X-Amz-Signature': 'SIGSECRETA', 'X-Amz-Credential': 'CREDSECRETA' };
const PDF = Buffer.from('%PDF-1.4 comprobante sintetico');
const ENV_ON = { FLIT1_ADJUNTOS_ENVIO_HABILITADO: true, FLIT1_ARCHIVOS_BASE_URL: ARCHIVOS, FLIT1_TRAMITES_BASE_URL: TRAMITES };

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });
const p1Ok = (id = 'adj-777', url = SUBIDA) => json({ id, presignedUrl: { url, fields: FIELDS } });
const vacio = (status: number) => new Response(null, { status });
type Paso = Response | Error;
let fetchMock: ReturnType<typeof vi.fn>;
function programar(...pasos: Paso[]) {
  const c = [...pasos];
  fetchMock = vi.fn(async () => {
    const r = c.shift();
    if (!r) throw new Error('fetch inesperado');
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal('fetch', fetchMock);
}
const llamadas = () => fetchMock.mock.calls.map(([u, i]) => [(i as RequestInit).method, u as string]);

const q = (re: RegExp): Grabada[] => estado.grabadas.filter((g) => re.test(g.sql));
const updatesDeFila = () => q(/^update "flito_impuesto_envios_flit2"/);
const audits = () => q(/^insert into "audit_logs"/);
/** Valor que el UPDATE asigna a `col` (lee el SET renderizado, no la fila devuelta). */
function valorSet(g: Grabada, col: string): unknown {
  const set = g.sql.slice(0, g.sql.indexOf(' where '));
  const m = new RegExp(`"${col}" = \\$(\\d+)`).exec(set);
  return m ? g.params[Number(m[1]) - 1] : undefined;
}
const asigna = (g: Grabada, col: string) => new RegExp(`"${col}" = \\$\\d+`).test(g.sql.slice(0, g.sql.indexOf(' where ')));

const tomada = (over: Record<string, unknown> = {}) => ({
  id: FILA, impuesto_id: IMP, soporte_id: SOP, intentos: 0, version: 1, estado: 'pendiente',
  id_flit: 'FLIT-012345', archivo_flit1_id: null, ...over,
});
function responderCiclo(opts: { filas?: unknown[]; pausa?: { hasta: Date; codigo: string } | null; soporteDescartado?: boolean } = {}) {
  return (g: Grabada): unknown[] => {
    if (/from "system_locks"/.test(g.sql)) return opts.pausa ? [opts.pausa] : [];
    if (/WITH candidatas/.test(g.sql)) return opts.filas ?? [tomada()];
    if (/from "flito_soportes"/.test(g.sql)) {
      if (opts.soporteDescartado) {
        if (/"flito_soportes"\."id" = \$1/.test(g.sql) && g.params[0] === SOP) return [{ id: SOP, storageKey: 'k', descartado: true, impuestoId: IMP }];
        if (/"flito_soportes"\."descartado" = \$\d/.test(g.sql)) return [{ id: SOP2, tipo: 'recibo_impuesto', subidoEn: AHORA }];
        return [{ id: SOP2, storageKey: 'impuestos/recibos/y.pdf' }];
      }
      return [{ id: SOP, storageKey: 'impuestos/recibos/x.pdf', descartado: false, impuestoId: IMP }];
    }
    if (/^update "flito_impuesto_envios_flit2".*returning/s.test(g.sql)) return [{ id: FILA }];
    return [];
  };
}
const ciclo = () => svc.procesarCicloEnvioFlit1({ tomadoPor: 'h', reloj: () => AHORA });

beforeEach(() => {
  estado.grabadas = [];
  estado.responder = responderCiclo();
  estado.env = { ...ENV_ON };
  fuenteMock.mockReset(); fuenteMock.mockResolvedValue(true);
  piiMock.mockClear();
  storage.stat.mockReset(); storage.stream.mockReset();
  storage.stat.mockResolvedValue({ size: PDF.length, contentType: 'application/pdf' });
  storage.stream.mockImplementation(async () => Readable.from([PDF]));
  for (const m of Object.values(logMock)) m.mockClear();
  programar();
});
afterEach(() => { vi.unstubAllGlobals(); });

// ── Toma ─────────────────────────────────────────────────────────────────────────────────────────
describe('RN-F1-03 toma (SQL renderizado)', () => {
  it('una sola sentencia SKIP LOCKED: destino flit1, fuente flit, pendiente vencida, impuesto pagado; sin rama en_espera', async () => {
    await cola.tomarLoteEnviosFlit1({ limite: 20, tomadoPor: 'h', ahora: AHORA });
    const [g] = q(/WITH candidatas/);
    expect(g.sql).toMatch(/FOR UPDATE OF e SKIP LOCKED/);
    expect(g.sql).toMatch(/i\.estado = \$1/);
    expect(g.params[0]).toBe('pagado');
    expect(g.sql).toMatch(/e\.destino = 'flit1' AND t\.fuente = 'flit'/);
    expect(g.sql).toMatch(/e\.estado = 'pendiente' AND e\.proximo_intento_en <= \$\d+::timestamptz/);
    expect(g.sql).not.toMatch(/en_espera|id_flit2/);
    expect(g.sql).toMatch(/RETURNING c\.id, c\.impuesto_id, c\.soporte_id, c\.intentos, c\.version, c\.estado, c\.archivo_flit1_id, t\.id_flit/);
    expect(g.params).toContain(20);
    expect(g.params.some((p) => p instanceof Date)).toBe(false);
  });
});

// ── AC7 ──────────────────────────────────────────────────────────────────────────────────────────
describe('AC7 / TC-01d — envío apagado: cero llamadas, filas intactas', () => {
  it.each([
    ['(a) falta FLIT1_ARCHIVOS_BASE_URL', { FLIT1_ARCHIVOS_BASE_URL: undefined }],
    ['(b) falta FLIT1_TRAMITES_BASE_URL', { FLIT1_TRAMITES_BASE_URL: undefined }],
    ['(c) faltan ambas', { FLIT1_ARCHIVOS_BASE_URL: undefined, FLIT1_TRAMITES_BASE_URL: undefined }],
    ['(e) base vacía', { FLIT1_TRAMITES_BASE_URL: '' }],
    ['(f) base inválida (http)', { FLIT1_ARCHIVOS_BASE_URL: 'http://flit1-archivos.ejemplo.test' }],
    ['flag apagada', { FLIT1_ADJUNTOS_ENVIO_HABILITADO: false }],
  ])('%s → omitido apagado', async (_n, over) => {
    Object.assign(estado.env, over);
    expect(await ciclo()).toMatchObject({ omitido: 'apagado', tomadas: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.grabadas).toHaveLength(0);
  });

  it('interruptor flit1 apagado → fuente_apagada, sin tomar', async () => {
    fuenteMock.mockImplementation(async (f: string) => f !== 'flit1');
    expect(await ciclo()).toMatchObject({ omitido: 'fuente_apagada' });
    expect(fuenteMock).toHaveBeenCalledWith('flit1');
    expect(q(/WITH candidatas/)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TC-07a: con FLIT 1 apagado, el ciclo FLIT 2 procesa su fila igual', async () => {
    estado.env.FLIT1_ADJUNTOS_ENVIO_HABILITADO = false;
    estado.env.FLIT2_ADJUNTOS_ENVIO_HABILITADO = true;
    fuenteMock.mockImplementation(async (f: string) => f === 'flit2');
    estado.responder = (g) => (/WITH candidatas/.test(g.sql)
      ? [{ id: FILA, impuesto_id: IMP, soporte_id: SOP, intentos: 0, version: 1, estado: 'pendiente', en_espera_desde: null, id_flit2: '0192b7c4-5e6a-7d10-9f21-000000000001', sync_version: '1' }]
      : responderCiclo()(g));
    expect(await ciclo()).toMatchObject({ omitido: 'apagado' });
    const fake = crearFlit2SyncFake([]);
    expect(await svc2.procesarCicloEnvioFlit2({ tomadoPor: 'h', adapter: fake, reloj: () => AHORA })).toMatchObject({ tomadas: 1, escritas: 1 });
    expect(fake.llamadasEnvio).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TC-01d (d) / TC-07b control positivo: todo encendido → sí llama a FLIT 1 y la fila queda enviada', async () => {
    programar(p1Ok(), vacio(204), json({}));
    expect(await ciclo()).toMatchObject({ tomadas: 1, escritas: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(valorSet(updatesDeFila()[0]!, 'estado')).toBe('enviado');
  });
});

// ── AC1 ──────────────────────────────────────────────────────────────────────────────────────────
describe('AC1 — envío exitoso', () => {
  it('TC-01a/f + TC-02c: P1 → P2 → P3 a los hosts correctos; fila enviada con archivo, paso 3 y fecha del intento', async () => {
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(llamadas()).toEqual([['POST', `${ARCHIVOS}/api/v1/files`], ['POST', SUBIDA], ['PUT', `${TRAMITES}/api/v1/vehicleTaxesQuery/2345`]]);
    const [up] = updatesDeFila();
    expect(up.sql).toMatch(/where \("flito_impuesto_envios_flit2"\."id" = \$\d+ and "flito_impuesto_envios_flit2"\."version" = \$\d+\)/);
    expect(valorSet(up, 'estado')).toBe('enviado');
    expect(valorSet(up, 'archivo_flit1_id')).toBe('adj-777');
    expect(valorSet(up, 'ultimo_paso')).toBe(3);
    expect(valorSet(up, 'intentos')).toBe(1);
    expect(valorSet(up, 'ultimo_intento_en')).toBe(AHORA.toISOString());
    expect(valorSet(up, 'enviado_en')).toBe(AHORA.toISOString());
    expect(valorSet(up, 'soporte_enviado_id')).toBe(SOP);
    expect(valorSet(up, 'proximo_intento_en')).toBeNull();
  });

  it('TC-01b: el filename usa el uuid del impuesto y la extensión del MIME real (JPEG → .jpg)', async () => {
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    storage.stat.mockResolvedValue({ size: JPG.length, contentType: 'application/pdf' });
    storage.stream.mockImplementation(async () => Readable.from([JPG]));
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ filename: `impuesto-${IMP}.jpg`, category: 'impuestos-flito' });
    expect(((fetchMock.mock.calls[1]![1] as RequestInit).body as FormData).get('file')).toMatchObject({ type: 'image/jpeg' });
  });

  it('TC-02d (A-3): FLIT-010045 → PUT /vehicleTaxesQuery/45', async () => {
    estado.responder = responderCiclo({ filas: [tomada({ id_flit: 'FLIT-010045' })] });
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(llamadas()[2]).toEqual(['PUT', `${TRAMITES}/api/v1/vehicleTaxesQuery/45`]);
  });
});

// ── HU #13311: reemplazo del comprobante → reprogramar y siguiente ciclo ──────────────────────────
describe('HU #13311 — reemplazo: la fila FLIT 1 se reprograma y el ciclo siguiente repite P1 → P2 → P3 con el soporte nuevo', () => {
  const CTX = { userId: 7, username: 'op@flitsas.io' };
  const KEY_NUEVO = 'impuestos/recibos/nuevo.pdf';
  /** Lectura FOR UPDATE de reprogramar: fila FLIT 1 en `desde`. */
  const responderReprogramar = (desde: string) => (g: Grabada): unknown[] =>
    (/^select .* from "flito_impuesto_envios_flit2"/s.test(g.sql) ? [{ id: FILA, estado: desde, destino: 'flit1' }] : []);
  /** El ciclo toma la fila TAL COMO la dejó el UPDATE de reprogramar (soporte y archivo leídos del SET). */
  function cicloTrasReprogramar(up: Grabada, previa: Record<string, unknown>) {
    const fila = tomada({ ...previa, soporte_id: valorSet(up, 'soporte_id'), archivo_flit1_id: valorSet(up, 'archivo_flit1_id'), intentos: 0, version: 2 });
    estado.grabadas = [];
    estado.responder = (g) => {
      if (/from "flito_soportes"/.test(g.sql)) return [{ id: SOP2, storageKey: KEY_NUEVO, descartado: false, impuestoId: IMP }];
      return responderCiclo({ filas: [fila] })(g);
    };
  }

  it.each([
    ['AC1: enviado', 'enviado', { archivo_flit1_id: 'adj-777' }],
    ['AC2: error con archivo de un intento a medias (soporte viejo)', 'error', { archivo_flit1_id: 'adj-777', intentos: 3 }],
    ['AC2: pendiente con archivo de un intento a medias', 'pendiente', { archivo_flit1_id: 'adj-777', intentos: 1 }],
  ])('%s → reprogramado (destino flit1); el ciclo siguiente sube el soporte nuevo con P1 → P2 → P3 y el PUT lleva el id nuevo', async (_n, desde, previa) => {
    estado.responder = responderReprogramar(desde);
    expect(await svc2.reprogramarEnvioComprobante(db as never, IMP, SOP2, CTX, AHORA)).toEqual({ destino: 'flit1', reenviado: true });
    expect(fetchMock).not.toHaveBeenCalled();
    const [lectura] = q(/^select .* from "flito_impuesto_envios_flit2"/s);
    expect(lectura!.sql).not.toMatch(/"destino" = /); // sin la guarda D-12 de la #13310
    const [up, ...resto] = updatesDeFila();
    expect(resto).toHaveLength(0);
    expect(valorSet(up!, 'estado')).toBe('pendiente');
    expect(valorSet(up!, 'soporte_id')).toBe(SOP2);
    expect(asigna(up!, 'archivo_flit1_id')).toBe(true);
    expect(valorSet(up!, 'archivo_flit1_id')).toBeNull();
    expect(asigna(up!, 'ultimo_paso')).toBe(true);
    expect(valorSet(up!, 'ultimo_paso')).toBeNull();
    expect(up!.sql).toMatch(/"version" = "flito_impuesto_envios_flit2"\."version" \+ 1/);
    expect(audits()[0]!.params).toContain(`Envío a FLIT 1 reprogramado por reemplazo (estaba ${desde}). Soporte ${SOP2}.`);

    cicloTrasReprogramar(up!, previa);
    programar(p1Ok('adj-888'), vacio(204), json({}));
    expect(await ciclo()).toMatchObject({ tomadas: 1, escritas: 1 });
    expect(llamadas()).toEqual([['POST', `${ARCHIVOS}/api/v1/files`], ['POST', SUBIDA], ['PUT', `${TRAMITES}/api/v1/vehicleTaxesQuery/2345`]]);
    expect(storage.stream.mock.calls.flat()).toContain(KEY_NUEVO);
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toMatchObject({ idAttachedPaymentReceipt: 'adj-888' });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('adj-777');
    const [fin] = updatesDeFila();
    expect(valorSet(fin!, 'estado')).toBe('enviado');
    expect(valorSet(fin!, 'archivo_flit1_id')).toBe('adj-888');
    expect(valorSet(fin!, 'soporte_enviado_id')).toBe(SOP2);
  });

  it('AC4: ni el reemplazo ni el ciclo siguiente llaman a borrar nada en FLIT 1 (control positivo: sí hay 3 llamadas)', async () => {
    estado.responder = responderReprogramar('enviado');
    await svc2.reprogramarEnvioComprobante(db as never, IMP, SOP2, CTX, AHORA);
    cicloTrasReprogramar(updatesDeFila()[0]!, {});
    programar(p1Ok('adj-888'), vacio(204), json({}));
    await ciclo();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(llamadas().map(([m]) => m)).not.toContain('DELETE');
  });

  it('AC6: envío apagado → el reemplazo deja la fila pendiente y el ciclo no la toma hasta que se encienda', async () => {
    estado.env.FLIT1_ADJUNTOS_ENVIO_HABILITADO = false;
    estado.responder = responderReprogramar('enviado');
    expect(await svc2.reprogramarEnvioComprobante(db as never, IMP, SOP2, CTX, AHORA)).toEqual({ destino: 'flit1', reenviado: true });
    expect(valorSet(updatesDeFila()[0]!, 'estado')).toBe('pendiente');
    cicloTrasReprogramar(updatesDeFila()[0]!, {});
    expect(await ciclo()).toMatchObject({ omitido: 'apagado', tomadas: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.grabadas).toHaveLength(0);
    estado.env.FLIT1_ADJUNTOS_ENVIO_HABILITADO = true; // control positivo: encendido, sí sale
    programar(p1Ok('adj-888'), vacio(204), json({}));
    expect(await ciclo()).toMatchObject({ tomadas: 1, escritas: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('AC3: trámite FLIT 1 sin fila de envío → sin_envio_previo con destino flit1; no crea fila ni llama', async () => {
    estado.responder = (g) => (/"flito_tramites"\."fuente"/.test(g.sql) ? [{ fuente: 'flit' }] : []);
    expect(await svc2.reprogramarEnvioComprobante(db as never, IMP, SOP2, CTX, AHORA))
      .toEqual({ destino: 'flit1', reenviado: false, motivo: 'sin_envio_previo' });
    expect(q(/^(update|insert)/)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── AC2 / AC3 ────────────────────────────────────────────────────────────────────────────────────
describe('AC2 / AC3 — pre-validación local: error sin llamar ni consumir intento', () => {
  it.each(['FLIT-032345', '12345', 'FLIT-01', 'FLIT-01234A', ' FLIT-012345', 'FLIT-0100', null])('TC-02b: id_flit %j → error id_flit_invalido', async (idFlit) => {
    estado.responder = responderCiclo({ filas: [tomada({ id_flit: idFlit })] });
    await ciclo();
    expect(fetchMock).not.toHaveBeenCalled();
    const [up] = updatesDeFila();
    expect(valorSet(up, 'estado')).toBe('error');
    expect(valorSet(up, 'ultimo_resultado')).toBe('id_flit_invalido');
    expect(asigna(up, 'intentos')).toBe(false);
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('TC-03a: 0 bytes → missing_file; TC-03b: 20 MiB + 1 → file_too_large sin bajar el objeto', async () => {
    storage.stat.mockResolvedValue({ size: 0, contentType: 'application/pdf' });
    await ciclo();
    expect(valorSet(updatesDeFila()[0]!, 'ultimo_resultado')).toBe('missing_file');
    estado.grabadas = [];
    storage.stat.mockResolvedValue({ size: 20 * 1024 * 1024 + 1, contentType: 'application/pdf' });
    await ciclo();
    expect(valorSet(updatesDeFila()[0]!, 'ultimo_resultado')).toBe('file_too_large');
    expect(storage.stream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TC-03b borde: exactamente 20 MiB SÍ se envía (control positivo)', async () => {
    const grande = Buffer.alloc(20 * 1024 * 1024, 0x20);
    grande.write('%PDF-1.4');
    storage.stat.mockResolvedValue({ size: grande.length, contentType: 'application/pdf' });
    storage.stream.mockImplementation(async () => Readable.from([grande]));
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(llamadas()[0]).toEqual(['POST', `${ARCHIVOS}/api/v1/files`]);
  });

  it('TC-03c: bytes ZIP aunque el almacén diga application/pdf → invalid_mime, sin llamar', async () => {
    storage.stream.mockImplementation(async () => Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])]));
    await ciclo();
    expect(valorSet(updatesDeFila()[0]!, 'ultimo_resultado')).toBe('invalid_mime');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
    ['WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])],
  ])('TC-03d: %s se envía', async (_n, bytes) => {
    storage.stat.mockResolvedValue({ size: bytes.length, contentType: 'x' });
    storage.stream.mockImplementation(async () => Readable.from([bytes]));
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ── AC4 / AC5 ────────────────────────────────────────────────────────────────────────────────────
describe('AC4 — fallo transitorio antes de subir', () => {
  it.each([
    ['P1 503', [vacio(503)]], ['P1 429', [vacio(429)]], ['P1 red', [new TypeError('fetch failed')]],
    ['P2 500', [p1Ok(), vacio(500)]], ['P2 red', [p1Ok(), new TypeError('fetch failed')]],
  ] as Array<[string, Paso[]]>)('TC-04a / TC-06b: %s → pendiente, intento 1, cita a 5 min, archivo_flit1_id NULL', async (_n, pasos) => {
    programar(...pasos);
    await ciclo();
    const [up] = updatesDeFila();
    expect(valorSet(up, 'estado')).toBe('pendiente');
    expect(valorSet(up, 'intentos')).toBe(1);
    expect(valorSet(up, 'proximo_intento_en')).toBe(new Date(AHORA.getTime() + 5 * 60_000).toISOString());
    expect(asigna(up, 'archivo_flit1_id')).toBe(true);
    expect(valorSet(up, 'archivo_flit1_id')).toBeNull();
  });

  it('TC-04b: tras un P2 caído, el siguiente intento vuelve a P1 y el PUT usa el id NUEVO', async () => {
    programar(p1Ok('adj-777'), vacio(500));
    await ciclo();
    expect(valorSet(updatesDeFila()[0]!, 'archivo_flit1_id')).toBeNull();
    estado.grabadas = [];
    estado.responder = responderCiclo({ filas: [tomada({ intentos: 1, archivo_flit1_id: null })] });
    programar(p1Ok('adj-888'), vacio(204), json({}));
    await ciclo();
    expect(llamadas()[0]).toEqual(['POST', `${ARCHIVOS}/api/v1/files`]);
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body)).idAttachedPaymentReceipt).toBe('adj-888');
  });

  it('TC-04c: con intentos = tope − 1, un 503 → error sin más cita; con tope − 2 sigue pendiente a 30 min', async () => {
    estado.responder = responderCiclo({ filas: [tomada({ intentos: 2 })] });
    programar(vacio(503));
    await ciclo();
    let [up] = updatesDeFila();
    expect(valorSet(up, 'estado')).toBe('error');
    expect(valorSet(up, 'intentos')).toBe(3);
    expect(valorSet(up, 'proximo_intento_en')).toBeNull();
    estado.grabadas = [];
    estado.responder = responderCiclo({ filas: [tomada({ intentos: 1 })] });
    programar(vacio(503));
    await ciclo();
    [up] = updatesDeFila();
    expect(valorSet(up, 'estado')).toBe('pendiente');
    expect(valorSet(up, 'proximo_intento_en')).toBe(new Date(AHORA.getTime() + 30 * 60_000).toISOString());
  });
});

describe('AC5 — fallo transitorio del PUT con el archivo ya subido', () => {
  it.each([['503', vacio(503)], ['429', vacio(429)], ['red', new TypeError('fetch failed')]] as Array<[string, Paso]>)(
    'TC-05a/b: P3 %s → persiste archivo_flit1_id; el siguiente intento hace SOLO el PUT con ese id', async (_n, fallo) => {
      programar(p1Ok('adj-777'), vacio(204), fallo);
      await ciclo();
      const [up] = updatesDeFila();
      expect(valorSet(up, 'estado')).toBe('pendiente');
      expect(valorSet(up, 'archivo_flit1_id')).toBe('adj-777');
      expect(valorSet(up, 'ultimo_paso')).toBe(3);
      estado.grabadas = [];
      estado.responder = responderCiclo({ filas: [tomada({ intentos: 1, archivo_flit1_id: 'adj-777' })] });
      programar(json({}));
      await ciclo();
      expect(llamadas()).toEqual([['PUT', `${TRAMITES}/api/v1/vehicleTaxesQuery/2345`]]);
      expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).idAttachedPaymentReceipt).toBe('adj-777');
      expect(valorSet(updatesDeFila()[0]!, 'estado')).toBe('enviado');
    });

  it('D-4: con archivo_flit1_id pero el soporte cambió (descartado y re-elegido) → reempieza desde el paso 1', async () => {
    estado.responder = responderCiclo({ filas: [tomada({ intentos: 1, archivo_flit1_id: 'adj-777' })], soporteDescartado: true });
    programar(p1Ok('adj-999'), vacio(204), json({}));
    await ciclo();
    expect(llamadas().map(([m]) => m)).toEqual(['POST', 'POST', 'PUT']);
    const [up] = updatesDeFila();
    expect(valorSet(up, 'archivo_flit1_id')).toBe('adj-999');
    expect(valorSet(up, 'soporte_id')).toBe(SOP2);
  });
});

// ── AC6 ──────────────────────────────────────────────────────────────────────────────────────────
describe('AC6 — rechazo definitivo de FLIT 1', () => {
  const cuerpo = (s: number) => json({ message: 'PROPIETARIO PRUEBA 1000000000' }, s);
  const casos: Array<[string, number, number, Paso[]]> = [];
  for (const s of [400, 403, 404, 413, 422]) {
    casos.push([`P1 ${s}`, 1, s, [cuerpo(s)]], [`P2 ${s}`, 2, s, [p1Ok(), cuerpo(s)]], [`P3 ${s}`, 3, s, [p1Ok(), vacio(204), cuerpo(s)]]);
  }
  it.each(casos)('TC-06a: %s → error sin reintento, con status y paso, sin cuerpo ni PII', async (_n, paso, s, pasos) => {
    programar(...pasos);
    await ciclo();
    const [up] = updatesDeFila();
    expect(valorSet(up, 'estado')).toBe('error');
    expect(valorSet(up, 'ultimo_status')).toBe(s);
    expect(valorSet(up, 'ultimo_paso')).toBe(paso);
    expect(valorSet(up, 'ultimo_resultado')).toBe(`http_${s}`);
    expect(valorSet(up, 'proximo_intento_en')).toBeNull();
    const todo = JSON.stringify([estado.grabadas, logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls]);
    expect(todo).not.toMatch(/PROPIETARIO PRUEBA|1000000000/);
    expect(q(/^insert into "system_locks"/)).toHaveLength(0);
  });
});

// ── Ajustes A-1 / A-2: pausa global ──────────────────────────────────────────────────────────────
describe('A-1 / A-2 — pausa global de configuración (sin consumir intento)', () => {
  it.each([
    ['A-2: P3 404 sin cuerpo', [p1Ok(), vacio(204), vacio(404)], 'no_disponible', 3],
    ['A-2: P1 403 Missing Authentication Token', [json({ message: 'Missing Authentication Token' }, 403)], 'no_disponible', 1],
    ['A-1: presignedUrl fuera de *.amazonaws.com', [p1Ok('adj-777', 'https://evilamazonaws.com/subida')], 'url_subida_no_permitida', 1],
  ] as Array<[string, Paso[], string, number]>)('%s → system_locks 20 min, fila liberada sin estado ni intento, ciclo cortado', async (_n, pasos, codigo, nFetch) => {
    programar(...pasos);
    const r = await ciclo();
    expect(r).toMatchObject({ corte: 'pausa', escritas: 0 });
    const [ins] = q(/^insert into "system_locks"/);
    expect(ins.params).toEqual(expect.arrayContaining([cola.PAUSA_ENVIO_FLIT1_CLAVE, codigo, new Date(AHORA.getTime() + 20 * 60_000).toISOString()]));
    expect(updatesDeFila().every((u) => !asigna(u, 'intentos') && !asigna(u, 'estado'))).toBe(true);
    expect(audits()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(nFetch); // A-1: nada se sube a la URL no permitida
    expect(q(/^update "flito_impuesto_envios_flit2" set "tomado_por" = \$1, "tomado_en" = \$2/)).toHaveLength(1); // liberada
    expect(JSON.stringify(logMock.error.mock.calls)).not.toMatch(/evilamazonaws|flito-ejemplo/);
  });

  it('pausa vigente → no toma; vencida → sondeo de 1 fila y, si sale bien, borra la marca', async () => {
    estado.responder = responderCiclo({ pausa: { hasta: new Date(AHORA.getTime() + 60_000), codigo: 'no_disponible' } });
    expect((await ciclo()).omitido).toBe('pausa');
    expect(q(/WITH candidatas/)).toHaveLength(0);
    estado.grabadas = [];
    estado.responder = responderCiclo({ pausa: { hasta: new Date(AHORA.getTime() - 1), codigo: 'no_disponible' } });
    programar(p1Ok(), vacio(204), json({}));
    expect((await ciclo()).sondeo).toBe(true);
    expect(q(/WITH candidatas/)[0]!.params).toContain(1);
    expect(q(/^delete from "system_locks"/)).toHaveLength(1);
  });

  it('la pausa de FLIT 1 usa su propia clave (no frena a FLIT 2)', () => {
    expect(cola.PAUSA_ENVIO_FLIT1_CLAVE).not.toBe('flito-impuestos-envio-flit2:pausa');
    expect(cola.PAUSA_ENVIO_FLIT1_MS).toBe(20 * 60_000);
  });
});

// ── AC8 / AC9 ────────────────────────────────────────────────────────────────────────────────────
describe('AC8 — sin envío retroactivo', () => {
  it('TC-08a: el ciclo nunca crea filas del outbox (solo UPDATE de las tomadas)', async () => {
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(q(/^insert into "flito_impuesto_envios_flit2"/)).toHaveLength(0);
    expect(updatesDeFila().length).toBeGreaterThan(0);
  });
});

describe('AC9 — sin secretos ni PII en logs ni bitácora', () => {
  const firmada = `${SUBIDA}?X-Amz-Signature=SIGSECRETA`;
  const SECRETOS = /flito-ejemplo\.s3|SIGSECRETA|POLICYSECRETA|CREDSECRETA|impuestos\/recibos/;
  it.each([
    ['éxito', [p1Ok('adj-777', firmada), vacio(204), json({})]],
    ['P2 500', [p1Ok('adj-777', firmada), vacio(500)]],
    ['P2 403', [p1Ok('adj-777', firmada), new Response('<Error/>', { status: 403 })]],
    ['P2 red con la URL en el mensaje', [p1Ok('adj-777', firmada), new TypeError(`fetch failed ${firmada}`)]],
  ] as Array<[string, Paso[]]>)('TC-09a: %s', async (_n, pasos) => {
    programar(...pasos);
    await ciclo();
    const todo = JSON.stringify([estado.grabadas, logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls]);
    expect(todo).not.toMatch(SECRETOS);
    expect(audits()).toHaveLength(1); // control: sí se auditó el intento
  });

  it('TC-09b: la lectura del comprobante se registra en la auditoría PII como acceso del sistema, una vez por intento', async () => {
    programar(p1Ok(), vacio(204), json({}));
    await ciclo();
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accion: 'read', camposAccedidos: ['comprobante_pago_impuesto'], motivo: expect.stringMatching(/^envio_flit1 \(sistema\) — intento 1 · impuesto /),
    }));
    const detalle = String(audits()[0]!.params.find((p) => typeof p === 'string' && p.startsWith('Envío a FLIT 1')));
    expect(detalle).toMatch(/intento 1 · enviado · paso 3 · HTTP 200 · soporte 22222222/);
  });
});

// ── RN-F1-03 puro ────────────────────────────────────────────────────────────────────────────────
describe('cambiosPorResultadoFlit1 (puro)', () => {
  it('pausa no escribe desenlace; reintentable del almacén no tiene paso de FLIT 1', () => {
    expect(svc.cambiosPorResultadoFlit1({ intentos: 0 }, SOP, { tipo: 'pausa', paso: 3, codigo: 'no_disponible', status: 404 }, AHORA)).toBeNull();
    const c = svc.cambiosPorResultadoFlit1({ intentos: 0 }, SOP, { tipo: 'reintentable', paso: 1, codigo: 'almacen_no_disponible', status: null, archivoId: null }, AHORA)!;
    expect(c.cambios.ultimoPaso).toBeNull();
  });
  it('definitivo del paso 3 conserva el id del archivo (traza); los de 1/2 lo limpian', () => {
    expect(svc.cambiosPorResultadoFlit1({ intentos: 0 }, SOP, { tipo: 'definitivo', paso: 3, codigo: 'http_404', status: 404, archivoId: 'adj-1' }, AHORA)!.cambios)
      .toMatchObject({ estado: 'error', archivoFlit1Id: 'adj-1', ultimoPaso: 3 });
    expect(svc.cambiosPorResultadoFlit1({ intentos: 0 }, SOP, { tipo: 'definitivo', paso: 2, codigo: 'http_403', status: 403, archivoId: null }, AHORA)!.cambios)
      .toMatchObject({ estado: 'error', archivoFlit1Id: null, ultimoPaso: 2 });
  });
});
