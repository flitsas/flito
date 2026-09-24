// HU #12842 (Feature #12840) — **datos del SOAT activo y póliza del RUNT** en el canal Cliente.
//
// Lo que esta suite fija, y que `flito-soat.cliente-renovacion-anticipada.test.ts` no cubre:
//
//   · El extractor `soatActivoRunt`: seis claves, `estado` y nunca `estadoSoat`, fechas ISO con huso
//     llevadas al día en Bogotá, `null` por dato ausente, solo `soat[0]` (AC4, AC6, AC8).
//   · `polizaSoatRunt` lee `numSoat` —también numérico— sin perder los alias viejos (AC7), y el alta
//     por renovación anticipada lo persiste en `poliza_runt`.
//   · El contrato HTTP: el 409 `soat_vigente` con `soatActivo` y `vigenciaProxima` con `venceEl` + seis
//     datos, exactos con `toStrictEqual` (AC4, AC5), iguales en preconsulta y alta (AC9).
//   · La regla de 30 días por HTTP con el día congelado (AC1, AC2).
//   · Ni la póliza ni el VIN en el log (AC10).
//
// Datos ficticios: póliza «AT-0000-TEST-01», aseguradora «ASEGURADORA FICTICIA S.A.», VIN sintético.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const consultarVehiculoRuntMock = vi.fn();
const uploadMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const piiMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));

/**
 * El logger, espiado. Lo añade el Bug #12179: la compuerta escribe una línea por cada desenlace que
 * RESUELVE organismo, y la renovación anticipada es uno de ellos —lleva el mismo `PayloadOk`—. Sin
 * este mock no hay forma de afirmar la FORMA de esa línea, que es lo único que separa «se mide el
 * organismo» de «se filtra PII en logs».
 */
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** VIN y placa sintéticos: ni un VIN ni una cédula reales en esta suite. */
const VIN_RUNT = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
/**
 * El día de hoy en Bogotá calculado **en el test y no con la función bajo prueba**.
 *
 * Los casos que van por HTTP no pueden congelar el reloj —el servidor de supertest y los limitadores
 * usan temporizadores—, así que la fecha del RUNT se construye relativa a hoy. Reimplementarla aquí
 * es lo que evita la tautología: si la de producción cambiara de zona, estos casos se caerían.
 */
function diaBogotaDelTest(instante: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instante);
}

/**
 * Una fecha a `n` días de hoy, en `yyyy-mm-dd`.
 *
 * `+10` está SIEMPRE dentro del umbral de 30 días y `+45` SIEMPRE fuera, así que estos casos no
 * caducan ni parpadean según el día en que se corran.
 * El borde exacto no se prueba por aquí: para eso está la mitad pura, con `hoy` congelado.
 */
function aDias(n: number): string {
  const hoy = diaBogotaDelTest();
  const base = Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1, Number(hoy.slice(8, 10)));
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

/** La respuesta del RUNT del canal; `soat` se sobrescribe caso a caso. */
function runtOk(soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: PLACA, vin: VIN_RUNT,
        idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular',
        tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5',
        organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
      },
      soat,
    },
  };
}

let sub = 4200;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (id: number) => `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: 'cliente' as never })}`;

function escenario(over: Partial<Record<string, unknown[]>> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{
      id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme',
      proveedorId: '55555555-5555-4555-8555-555555555555', activo: true,
    }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}

const CAMPOS: Record<string, string> = {
  vin: VIN_RUNT.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string, campos: Record<string, string | null> = {}) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS, ...campos })) {
    if (v !== null) req.field(k, v);
  }
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const preconsultar = (app: express.Express, token: string, cuerpo: Record<string, string> = { vin: VIN_RUNT }) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);

const umbral = () => import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
});


const POLIZA_FICTICIA = 'AT-0000-TEST-01';
/** Lo que `polizaParaColumna` hace con ella: es lo que se persiste y lo que se publica. */
const POLIZA_NORMALIZADA = 'AT0000TEST01';
const ASEGURADORA = 'ASEGURADORA FICTICIA S.A.';

/** Un `soat[0]` con la forma de la respuesta real del RUNT (nombres de campo medidos). */
function soatReal(venceEl: string, over: Record<string, unknown> = {}) {
  return {
    numSoat: POLIZA_FICTICIA,
    fechaExpedicion: '2025-10-01',
    fechaInicioPoliza: '2025-10-02',
    fechaVencimSoat: venceEl,
    razonSocialAsegur: ASEGURADORA,
    estado: 'VIGENTE',
    estadoSoat: 'VIGENTE',
    ...over,
  };
}

/** Congela SOLO `Date` (no los temporizadores de supertest) a mediodía de Bogotá del día dado. */
async function conHoy<T>(hoy: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${hoy}T17:00:00Z`));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

// ═══════════ El extractor: seis claves, del `soat[0]` (AC4, AC6, AC8) ════════

describe('`soatActivoRunt` — los seis datos del SOAT activo, leídos del `soat[0]`', () => {
  it('**AC4 — las seis claves, con las fechas en `yyyy-mm-dd`**', async () => {
    const { soatActivoRunt } = await umbral();
    const s = soatActivoRunt({ soat: [soatReal('09/04/2026', { fechaExpedicion: '01/10/2025' })] });

    expect(s).toStrictEqual({
      poliza: POLIZA_NORMALIZADA,
      fechaExpedicion: '2025-10-01',
      inicioVigencia: '2025-10-02',
      vencimiento: '2026-04-09',
      aseguradora: ASEGURADORA,
      estado: 'VIGENTE',
    });
  });

  it('**`estado` sale de `estado`, NUNCA de `estadoSoat`**', async () => {
    const { soatActivoRunt } = await umbral();
    expect(soatActivoRunt({ soat: [soatReal('2026-04-09', { estado: 'VIGENTE', estadoSoat: 'EMITIDA' })] }).estado)
      .toBe('VIGENTE');
    // Sin `estado`, `null` — aunque `estadoSoat` venga lleno.
    const sinEstado = soatReal('2026-04-09', { estadoSoat: 'EMITIDA' });
    delete (sinEstado as Record<string, unknown>).estado;
    expect(soatActivoRunt({ soat: [sinEstado] }).estado).toBeNull();
  });

  it('**AC4 — un ISO con huso se lleva al DÍA EN BOGOTÁ**: `-05:00` igual, `Z` y `+01:00` corrigen', async () => {
    const { soatActivoRunt } = await umbral();
    const venc = (v: string) => soatActivoRunt({ soat: [soatReal(v)] }).vencimiento;

    expect(venc('2026-10-05T00:00:00-05:00')).toBe('2026-10-05');
    // 03:00 UTC es todavía el día anterior en Bogotá; el `slice(0,10)` de antes decía 05.
    expect(venc('2026-10-05T03:00:00Z')).toBe('2026-10-04');
    expect(venc('2026-10-05T02:00:00+01:00')).toBe('2026-10-04');
    expect(venc('2026-10-05T23:59:59.000-0500')).toBe('2026-10-05');
    // Sin huso: los diez primeros caracteres, como siempre.
    expect(venc('2026-10-05T03:00:00')).toBe('2026-10-05');
  });

  it('una fecha que no es fecha da `null`, nunca una por defecto', async () => {
    const { soatActivoRunt } = await umbral();
    const s = soatActivoRunt({ soat: [soatReal('2026-13-45T00:00:00Z', { fechaExpedicion: 'ayer', fechaInicioPoliza: '31/02/2026' })] });
    expect(s.vencimiento).toBeNull();
    expect(s.fechaExpedicion).toBeNull();
    expect(s.inicioVigencia).toBeNull();
  });

  it('**AC6 — un dato ausente va en `null`**; sin nodo, las seis en `null`', async () => {
    const { soatActivoRunt } = await umbral();
    const todoNull = {
      poliza: null, fechaExpedicion: null, inicioVigencia: null, vencimiento: null, aseguradora: null, estado: null,
    };
    expect(soatActivoRunt({ soat: [{ fechaVencimSoat: '2026-04-09' }] }))
      .toStrictEqual({ ...todoNull, vencimiento: '2026-04-09' });
    expect(soatActivoRunt({ soat: [] })).toStrictEqual(todoNull);
    expect(soatActivoRunt({})).toStrictEqual(todoNull);
    expect(soatActivoRunt(null)).toStrictEqual(todoNull);
    expect(soatActivoRunt({ soat: [{ numSoat: '   ', razonSocialAsegur: 'null', estado: '' }] })).toStrictEqual(todoNull);
  });

  it('**AC8 — solo cuenta `soat[0]`**: un `soat[1]` distinto no se lee', async () => {
    const { soatActivoRunt } = await umbral();
    const s = soatActivoRunt({
      soat: [soatReal('2020-01-01', { numSoat: 'AT-0000-TEST-02' }), soatReal('2026-04-09')],
    });
    expect(s.poliza).toBe('AT0000TEST02');
    expect(s.vencimiento).toBe('2020-01-01');
  });
});

// ═══════════ AC7 — `polizaSoatRunt` lee `numSoat` ═════════════════════════════

describe('AC7 — `polizaSoatRunt` lee `numSoat`, también numérico, sin perder los alias viejos', () => {
  it('**`numSoat` string** se normaliza como se persiste', async () => {
    const { polizaSoatRunt } = await umbral();
    expect(polizaSoatRunt({ soat: [{ numSoat: POLIZA_FICTICIA }] })).toBe(POLIZA_NORMALIZADA);
  });

  it('**`numSoat` NUMÉRICO** también sirve', async () => {
    const { polizaSoatRunt } = await umbral();
    expect(polizaSoatRunt({ soat: [{ numSoat: 12345678 }] })).toBe('12345678');
  });

  it('los alias viejos siguen funcionando, y `numSoat` manda sobre ellos', async () => {
    const { polizaSoatRunt } = await umbral();
    for (const k of ['numeroPoliza', 'noPoliza', 'numPoliza', 'poliza']) {
      expect(polizaSoatRunt({ soat: [{ [k]: POLIZA_FICTICIA }] }), k).toBe(POLIZA_NORMALIZADA);
    }
    expect(polizaSoatRunt({ soat: { numeroPoliza: 'AT-0000-TEST-09', numSoat: POLIZA_FICTICIA } })).toBe(POLIZA_NORMALIZADA);
  });

  it('**el alta por renovación anticipada guarda `poliza_runt` desde `numSoat`**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(aDias(10), { numSoat: 87654321 })]));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').polizaRunt).toBe('87654321');
  });
});

// ═══════════ AC1/AC2 — 30 días por HTTP, con el día congelado ═════════════════

describe('AC1/AC2 — el día 30 deja continuar y el 31 bloquea, en Bogotá, por los dos endpoints', () => {
  it('**AC1 — hoy 2026-03-10: vence el 2026-04-09 → 200 con aviso; el 2026-04-10 → 409**', async () => {
    escenario();
    await conHoy('2026-03-10', async () => {
      const app = await buildApp();
      consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal('2026-04-09')]));
      const ok = await preconsultar(app, await auth(siguienteUsuario()));
      expect(ok.status).toBe(200);
      expect(ok.body.vigenciaProxima?.venceEl).toBe('2026-04-09');

      consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal('2026-04-10')]));
      const no = await preconsultar(app, await auth(siguienteUsuario()));
      expect(no.status).toBe(409);
      expect(no.body.codigo).toBe('soat_vigente');
    });
  });

  it('**AC2 — hoy 2027-01-31: vence el 2027-03-02 → pasa; el 2027-03-03 → 409**', async () => {
    escenario();
    await conHoy('2027-01-31', async () => {
      const app = await buildApp();
      consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal('2027-03-02')]));
      const ok = await preconsultar(app, await auth(siguienteUsuario()));
      expect(ok.status).toBe(200);
      expect(ok.body.vigenciaProxima?.venceEl).toBe('2027-03-02');

      consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal('2027-03-03')]));
      const no = await preconsultar(app, await auth(siguienteUsuario()));
      expect(no.status).toBe(409);
    });
  });
});

// ═══════════ AC4/AC5/AC6/AC9 — el contrato HTTP ═══════════════════════════════

describe('el contrato HTTP del SOAT activo', () => {
  it('**AC5 — `vigenciaProxima` trae `venceEl` + los seis datos, exactos (ni una clave de más)**', async () => {
    escenario();
    const venceEl = aDias(10);
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(venceEl, { dato_crudo_extra: 'NO-PUBLICAR' })]));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.vigenciaProxima).toStrictEqual({
      venceEl,
      poliza: POLIZA_NORMALIZADA,
      fechaExpedicion: '2025-10-01',
      inicioVigencia: '2025-10-02',
      vencimiento: venceEl,
      aseguradora: ASEGURADORA,
      estado: 'VIGENTE',
    });
    expect(JSON.stringify(r.body)).not.toContain('NO-PUBLICAR');
  });

  it('**AC4/AC9 — el 409 `soat_vigente` trae `soatActivo` y es IDÉNTICO en preconsulta y alta; el alta no crea fila**', async () => {
    escenario();
    const venceEl = aDias(45);
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(venceEl, { estadoSoat: 'VIGENTE', estado: 'VIGENTE' })]));
    const app = await buildApp();

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    const alt = await alta(app, await auth(siguienteUsuario()));

    expect(pre.status).toBe(409);
    expect(alt.status).toBe(409);
    expect(pre.body.codigo).toBe('soat_vigente');
    // Se conserva la clave de siempre.
    expect(pre.body.fechaVencimiento).toBe(venceEl);
    expect(pre.body.soatActivo).toStrictEqual({
      poliza: POLIZA_NORMALIZADA,
      fechaExpedicion: '2025-10-01',
      inicioVigencia: '2025-10-02',
      vencimiento: venceEl,
      aseguradora: ASEGURADORA,
      estado: 'VIGENTE',
    });
    // Campo por campo.
    expect(alt.body).toStrictEqual(pre.body);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(espia.insertsEn('flito_soat_solicitud')).toHaveLength(0);
  });

  it('**AC6 — vigente SIN fecha sigue bloqueando**: 409 sin `fechaVencimiento` y `soatActivo` con nulls', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([{ estadoSoat: 'VIGENTE', numSoat: POLIZA_FICTICIA }]));
    const app = await buildApp();

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    expect(pre.status).toBe(409);
    expect(pre.body).not.toHaveProperty('fechaVencimiento');
    expect(pre.body.soatActivo).toStrictEqual({
      poliza: POLIZA_NORMALIZADA, fechaExpedicion: null, inicioVigencia: null,
      vencimiento: null, aseguradora: null, estado: null,
    });

    const alt = await alta(app, await auth(siguienteUsuario()));
    expect(alt.status).toBe(409);
    expect(alt.body).toStrictEqual(pre.body);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('**AC8 — `soat[0]` vencido: 200 con `vigenciaProxima: null`, aunque `soat[1]` esté vigente**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([
      soatReal('2020-01-01', { estadoSoat: 'NO VIGENTE', estado: 'NO VIGENTE' }),
      soatReal(aDias(10)),
    ]));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.vigenciaProxima).toBeNull();
  });

  it('**AC8 — `soat` vacío: 200 con `vigenciaProxima: null`**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([]));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('vigenciaProxima');
    expect(r.body.vigenciaProxima).toBeNull();
  });
});

// ═══════════ AC10 — ni la póliza ni el VIN en el log ═══════════════════════════

describe('AC10 — la compuerta no escribe la póliza ni el VIN en el log', () => {
  it('**ni en la renovación (200 + alta), ni en el 409**, aunque ahora se publiquen al Cliente', async () => {
    escenario();
    const app = await buildApp();

    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(aDias(10))]));
    expect((await preconsultar(app, await auth(siguienteUsuario()))).status).toBe(200);
    expect((await alta(app, await auth(siguienteUsuario()))).status).toBe(201);

    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(aDias(45))]));
    expect((await preconsultar(app, await auth(siguienteUsuario()))).status).toBe(409);
    expect((await alta(app, await auth(siguienteUsuario()))).status).toBe(409);

    // La línea de la compuerta se escribió (control positivo) y solo con sus tres claves.
    const lineas = logMock.info.mock.calls.filter((c) => c[1] === 'compuerta RUNT del canal Cliente');
    expect(lineas.length).toBeGreaterThan(0);
    for (const [obj] of lineas) {
      expect(Object.keys(obj as object).sort()).toEqual(['desenlace', 'organismoCatalogado', 'organismoRunt']);
    }

    const todo = JSON.stringify([
      logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls, logMock.debug.mock.calls,
    ]);
    for (const dato of [POLIZA_FICTICIA, POLIZA_NORMALIZADA, VIN_RUNT, VIN_RUNT.toLowerCase(), ASEGURADORA]) {
      expect(todo, `${dato} no puede acabar en el log`).not.toContain(dato);
    }
  });
});

// ═══════════ RN-05 — `campos_accedidos` declara el SOAT activo publicado ════════

describe('RN-05 (Feature #12840) — `campos_accedidos` declara el SOAT activo que sale en la respuesta', () => {
  const SOAT_ACTIVO = ['poliza_soat', 'aseguradora_soat', 'fecha_expedicion_soat', 'inicio_vigencia_soat', 'estado_soat'];
  const registros = () => piiMock.mock.calls.map((c) => c[1] as { camposAccedidos: string[]; motivo: string });

  it('**200 con aviso**: placa, VIN, vencimiento y los cinco datos del SOAT activo', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(aDias(10))]));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.vigenciaProxima).not.toBeNull();
    expect(registros()).toHaveLength(1);
    expect([...registros()[0].camposAccedidos].sort()).toStrictEqual(
      ['placa', 'vin', 'nombre_completo', 'fecha_vencimiento_soat', ...SOAT_ACTIVO].sort(),
    );
  });

  it('**200 sin aviso**: ni el vencimiento ni el SOAT activo se declaran', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([]));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    const campos = registros()[0].camposAccedidos;
    for (const c of ['fecha_vencimiento_soat', ...SOAT_ACTIVO]) expect(campos).not.toContain(c);
  });

  it('**409 `soat_vigente` con fecha, en preconsulta Y alta**: los cinco datos + `fecha_vencimiento_soat`', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([soatReal(aDias(45))]));
    const app = await buildApp();

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    const alt = await alta(app, await auth(siguienteUsuario()));

    expect(pre.status).toBe(409);
    expect(alt.status).toBe(409);
    expect(pre.body.fechaVencimiento).toBeDefined();
    const [rPre, rAlt] = registros();
    expect(registros()).toHaveLength(2);
    expect(rPre.motivo).toContain('resultado=soat_vigente');
    expect(rAlt.motivo).toContain('resultado=soat_vigente');
    const esperado = [...SOAT_ACTIVO, 'fecha_vencimiento_soat'].sort();
    expect([...rPre.camposAccedidos].sort()).toStrictEqual(esperado);
    expect([...rAlt.camposAccedidos].sort()).toStrictEqual(esperado);
  });

  it('**409 `soat_vigente` SIN fecha**: los cinco datos, y `fecha_vencimiento_soat` NO (no viajó)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([{ estadoSoat: 'VIGENTE', numSoat: POLIZA_FICTICIA }]));
    const app = await buildApp();

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    const alt = await alta(app, await auth(siguienteUsuario()));

    expect(pre.status).toBe(409);
    expect(alt.status).toBe(409);
    expect(pre.body).not.toHaveProperty('fechaVencimiento');
    for (const r of registros()) expect([...r.camposAccedidos].sort()).toStrictEqual([...SOAT_ACTIVO].sort());
    expect(registros()).toHaveLength(2);
  });

  it('**negativo — un 422 y un 503 siguen declarando `[]`**', async () => {
    escenario();
    const app = await buildApp();

    const otroVin = runtOk();
    otroVin.data.vehiculo.vin = '9FKRG2222T2099999';
    consultarVehiculoRuntMock.mockResolvedValue(otroVin);
    const r422 = await preconsultar(app, await auth(siguienteUsuario()));
    expect(r422.status).toBe(422);

    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, error: 'timeout' });
    const r503 = await alta(app, await auth(siguienteUsuario()));
    expect(r503.status).toBe(503);

    expect(registros()).toHaveLength(2);
    for (const r of registros()) expect(r.camposAccedidos).toStrictEqual([]);
  });
});
