// HU #12828 — paso «autocertificacion» del análisis post-envío: con la MISMA respuesta RUNT del
// análisis (`job.consultaRunt`) certifica igual que `POST /:id/certificar` (fila vigente + snapshot +
// audit + motor/serie en `vehicles`) SIN volver a consultar el RUNT; no certificable → sin fila;
// consulta ausente o no `ok` → no hace nada; ya certificado → no duplica. Mock keyed (OPS-02b); las
// condiciones de los SELECT/UPDATE se asertan renderizadas porque el mock devuelve la fila entera.
// Valores INVENTADOS.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ buscarConAcceso: vi.fn() }));
const consultarVehiculoRunt = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({ consultarVehiculoRunt }));
const logPiiAccess = vi.fn();
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess }));
const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const { pasoAutocertificacion, ACTOR_AUTOCERTIFICACION } =
  await import('../../src/modules/flito-impuestos/flito-impuestos.autocertificacion.js');
const { flitoImpuestos, flitoImpuestoCertificaciones, vehicles, auditLogs } = await import('../../src/db/schema.js');
type Ctx = Parameters<typeof pasoAutocertificacion>[0];

const T_IMP = getTableName(flitoImpuestos);
const T_CERT = getTableName(flitoImpuestoCertificaciones);
const T_VEH = getTableName(vehicles);
const T_AUDIT = getTableName(auditLogs);

const ID = '00000000-0000-0000-0000-0000000000c8';
const PLACA = 'ZZZ998';
const VIN = '9ZZTEST0000000002';
const DOC = '9999999998';
const VEHICULO_ID = 7001;

const fila = (over: Record<string, unknown> = {}) => ({
  estado: 'solicitado', analisisEstado: 'en_curso',
  vehiculoId: VEHICULO_ID, placa: PLACA, vin: VIN,
  marca: 'CHEVROLET', linea: 'SPARK GT', modelo: 2018, clase: 'AUTOMOVIL',
  ownerName: 'PROPIETARIO FALSO', ownerDocument: DOC, compradorNombre: null, compradorDocumento: null,
  ...over,
});
const dataRunt = (vehiculo: Record<string, unknown> = {}) => ({
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'CHEVROLET', linea: 'SPARK GT', modelo: '2018', claseVehiculo: 'AUTOMOVIL',
    numMotor: 'MTR-FALSO', numSerie: 'SER-FALSO', ...vehiculo,
  },
  tipoDocPropietario: 'C',
});
const consultaOk = (data: unknown = dataRunt(), via: 'documento' | 'vin' = 'documento') =>
  ({ estado: 'ok' as const, via, data, vehiculo: {} as never });
const ctx = (job: Ctx['job']): Ctx => ({
  impuestoId: ID, runt: { ejecutar: vi.fn() } as unknown as Ctx['runt'], job,
});

function capturar(metodo: 'insert' | 'update', tabla: string, campo: 'values' | 'set' | 'where'): unknown[] {
  const out: unknown[] = [];
  const porDefecto = kdb[metodo].getMockImplementation()!;
  kdb[metodo].mockImplementation((tbl: unknown) => {
    const c = porDefecto(tbl) as Record<string, (v: unknown) => unknown>;
    if (getTableName(tbl as never) === tabla) {
      const orig = c[campo];
      c[campo] = (v: unknown) => { out.push(v); return orig(v); };
    }
    return c;
  });
  return out;
}
/** Condiciones de los SELECT a una tabla: el mock keyed ignora el `where`. */
function condicionesSelect(tabla: string): SQL[] {
  const out: SQL[] = [];
  const porDefecto = kdb.select.getMockImplementation()!;
  kdb.select.mockImplementation((...a: unknown[]) => {
    const c = porDefecto(...a) as Record<string, (v: unknown) => unknown>;
    const from = c.from; const where = c.where;
    let t = '';
    c.from = (tbl: unknown) => { t = getTableName(tbl as never); return from(tbl); };
    c.where = (w: unknown) => { if (t === tabla) out.push(w as SQL); return where(w); };
    return c;
  });
  return out;
}

function escenario(over: { fila?: Record<string, unknown>; vigente?: unknown[] } = {}) {
  kdb.when.scenario({ [T_IMP]: [fila(over.fila)], [T_CERT]: over.vigente ?? [] });
  kdb.when.insert(T_CERT, [{
    id: 'cert-auto', impuestoId: ID, placaConsultada: PLACA, documentoConsultado: DOC, vinConsultado: null,
    tipoDocPropietario: 'C', propietarioNombre: 'PROPIETARIO FALSO', campos: [],
    certificadoPorNombre: ACTOR_AUTOCERTIFICACION.username, createdAt: new Date(),
  }]);
  kdb.when.insert(T_AUDIT, []);
  kdb.when.update(T_CERT, []);
  kdb.when.update(T_VEH, []);
}

beforeEach(() => {
  kdb.reset();
  registros.length = 0;
  consultarVehiculoRunt.mockReset();
  logPiiAccess.mockReset();
});

describe('AC1 — certificable con la respuesta RUNT del análisis', () => {
  it('crea la fila vigente como POST /certificar, con actor de sistema y snapshot, y guarda motor/serie SIN reconsultar el RUNT', async () => {
    escenario();
    const certs = capturar('insert', T_CERT, 'values');
    const audits = capturar('insert', T_AUDIT, 'values');
    const enVehicles = capturar('update', T_VEH, 'set');
    const data = dataRunt();
    const c = ctx({ consultaRunt: consultaOk(data) });

    await pasoAutocertificacion(c);

    expect(consultarVehiculoRunt).not.toHaveBeenCalled();
    expect(c.runt.ejecutar).not.toHaveBeenCalled();
    expect(certs).toHaveLength(1);
    expect(certs[0]).toMatchObject({
      impuestoId: ID, vigente: true, placaConsultada: PLACA, documentoConsultado: DOC, vinConsultado: null,
      tipoDocPropietario: 'C', propietarioNombre: 'PROPIETARIO FALSO', snapshotRunt: data,
      certificadoPorId: null, certificadoPorNombre: 'Sistema (validación automática)',
    });
    expect(audits[0]).toMatchObject({ userId: null, userEmail: 'Sistema (validación automática)', resourceId: ID });
    expect(enVehicles[0]).toMatchObject({ numMotor: 'MTR-FALSO', numSerie: 'SER-FALSO' });
  });

  it('consulta por VIN: guarda el VIN como identificador usado', async () => {
    escenario({ fila: { ownerDocument: null } });
    const certs = capturar('insert', T_CERT, 'values');
    await pasoAutocertificacion(ctx({ consultaRunt: consultaOk(dataRunt(), 'vin') }));
    expect(certs[0]).toMatchObject({ documentoConsultado: null, vinConsultado: VIN });
  });

  it('el chequeo de vigente filtra por ESTE impuesto y vigente = true (SQL renderizado)', async () => {
    escenario();
    const conds = condicionesSelect(T_CERT);
    await pasoAutocertificacion(ctx({ consultaRunt: consultaOk() }));
    expect(conds).toHaveLength(1);
    const q = renderizar(conds[0]);
    expect(ligadoA(q, '"impuesto_id"')).toBe(ID);
    expect(ligadoA(q, '"vigente"')).toBe(true);
  });

  it('deja constancia PII de sistema y los logs no llevan placa, documento ni VIN', async () => {
    escenario();
    await pasoAutocertificacion(ctx({ consultaRunt: consultaOk() }));
    expect(logPiiAccess).toHaveBeenCalledTimes(1);
    const [, entrada] = logPiiAccess.mock.calls[0];
    expect(entrada.camposAccedidos).toEqual(['placa', 'documento_propietario', 'vin', 'nombre_propietario']);
    expect(entrada.motivo).toContain('resultado=certificado');
    const logs = JSON.stringify(registros);
    for (const pii of [PLACA, DOC, VIN]) expect(logs).not.toContain(pii);
  });
});

describe('AC2 — no certificable', () => {
  it('con diferencias bloqueantes no crea fila (pero motor/serie sí, como el endpoint)', async () => {
    escenario();
    const certs = capturar('insert', T_CERT, 'values');
    const enVehicles = capturar('update', T_VEH, 'set');
    await pasoAutocertificacion(ctx({ consultaRunt: consultaOk(dataRunt({ vin: '9ZZTEST0000000099' })) }));
    expect(certs).toHaveLength(0);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(enVehicles).toHaveLength(1);
    expect(consultarVehiculoRunt).not.toHaveBeenCalled();
  });
});

describe('sin respuesta RUNT válida → no hace nada y no lanza', () => {
  it.each([
    ['ausente', {}],
    ['sin_respuesta', { consultaRunt: { estado: 'sin_respuesta' as const } }],
    ['sin_registro', { consultaRunt: { estado: 'sin_registro' as const } }],
    ['traspaso', { consultaRunt: { estado: 'traspaso' as const } }],
    ['sin_identificador', { consultaRunt: { estado: 'sin_identificador' as const } }],
  ])('%s', async (_n, job) => {
    escenario();
    await expect(pasoAutocertificacion(ctx(job))).resolves.toBeUndefined();
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(consultarVehiculoRunt).not.toHaveBeenCalled();
  });
});

describe('idempotencia y guardas', () => {
  it('con certificación vigente no crea otra ni toca vehicles', async () => {
    escenario({ vigente: [{ id: 'cert-previa' }] });
    await pasoAutocertificacion(ctx({ consultaRunt: consultaOk() }));
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it.each([
    ['estado no certificable', { estado: 'pagado' }],
    ['análisis ya no en_curso', { analisisEstado: 'completado' }],
    ['la vía de consulta cambió (apareció/desapareció el documento)', { ownerDocument: null }],
  ])('%s → sin fila', async (_n, over) => {
    escenario({ fila: over });
    await pasoAutocertificacion(ctx({ consultaRunt: consultaOk() }));
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});
