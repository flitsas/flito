// HU #12998 (Feature #12841) — reintento manual de la consulta al RUNT de una solicitud incompleta:
// `POST /api/flito/soat/cliente/incompletas/:id/reintentar`. ADR-0019; diseño §4, §11 y §11.1.
//
// Matriz AC → casos de este archivo:
//   AC1  el RUNT responde → 200 `completada`; el SOAT nace con id = soat_id_reservado por el camino del
//        alta (destino de la compañía AL MOMENTO, solicitado por el radicador, enviado por quien
//        reintenta, factura ya subida); propietario re-apuntado; incompleta `completada`;
//        renovación anticipada → `vigenciaProxima` y `vence_el`/`poliza_runt` guardados.
//   AC3  SOAT vigente → `descartada` soat_vigente con `soatActivo`; los tres 422 → `descartada` con su
//        motivo; quién, cuándo y por qué; nunca DELETE.
//   AC4  el VIN ya tiene SOAT: por la lectura previa, y por el 23505 del INSERT (rollback + segunda
//        transacción que descarta con solicitud_existente).
//   AC5  el RUNT sigue caído → 200 `sigue_incompleta` con intentos + 1 y la causa de la caída.
//   AC6  carrera: el re-chequeo tras FOR UPDATE ve la fila ya resuelta → 409 sin escribir nada.
//   AC7  403 sin la función; 404 uuid inválido / fuera de alcance / proveedor; 409 ya resuelta sin
//        gastar consulta; los dos limitadores montados (y ningún otro).
//   PII  `pii_access_log` con motivo del reintento; logs sin VIN ni placa.
//
// El mock `chain` devuelve la fila entera y no filtra por `where`: el alcance se prueba sobre el SQL
// renderizado (`espia.condicionesLeidas()`), y el orden de lecturas con `selectOnce`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
const piiMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const consultarMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  l.child.mockReturnValue(l);
  return l;
});

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/modules/flito-soat/flito-soat-cliente-runt.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  consultarYClasificar: consultarMock,
}));

const { extraerDatosCanal } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
const { soatClienteLimiter, soatPreconsultaLimiter } = await import('../../src/shared/middleware/rateLimiter.js');

const COMPANIA = 7;
const ID = '1c0a0000-0000-4000-8000-00000000bb01';
const RESERVADO = '5e5e0000-0000-4000-8000-00000000cc01';
const PROVEEDOR = '55555555-5555-4555-8555-555555555555';
const RADICADOR = 4242;
const VIN = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
const T0 = new Date('2026-09-27T15:00:00Z');
const URL = `/api/flito/soat/cliente/incompletas/${ID}/reintentar`;

const DATOS = extraerDatosCanal({
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
    cilindraje: '1598', tipoServicio: 'Particular', tipoCarroceria: 'WAGON', pasajerosSentados: '5',
    puertas: '5', organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
  },
});
const SOAT_ACTIVO = {
  poliza: 'AT-123', fechaExpedicion: '2025-11-01', inicioVigencia: '2025-11-02', vencimiento: '2026-11-01',
  aseguradora: 'SURA', estado: 'VIGENTE',
};
const OK = { clase: 'ok', datos: DATOS, vinEfectivo: VIN, organismoCodigo: '25286' };

const fila = (over: Record<string, unknown> = {}) => ({
  id: ID, estado: 'incompleta', vin: VIN, companiaId: COMPANIA, intentos: 2,
  soatIdReservado: RESERVADO, solicitadoPorId: RADICADOR, solicitadoPorNombre: 'ana@motos.co', solicitadoEn: T0,
  facturaStorageKey: `clientes/acme/soat/facturas-venta/${RESERVADO}.pdf`, facturaHash: 'a'.repeat(64),
  facturaNombreArchivo: 'factura.pdf', facturaContentType: 'application/pdf', facturaTamanoBytes: 1234,
  ...over,
});
const PROPIETARIO = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombres: 'ANA', apellidos: 'PÉREZ', razonSocial: null,
  correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Funza', departamento: 'Cundinamarca',
};

let sub = 12998_00;
let ultimoSub = 0;
async function auth(opts: { tipoPrincipal?: 'interno' | 'externo'; tipoEnlace?: string; funciones?: string[] } = {}) {
  sub += 1;
  ultimoSub = sub;
  await registrarUsuarioDePrueba(sub, {
    rol: 'rol_prueba', tipoPrincipal: opts.tipoPrincipal ?? 'interno', tipoEnlace: opts.tipoEnlace ?? 'ninguno',
    excepciones: [], funcionesDelRol: ['pagina.flito_soat', ...(opts.funciones ?? ['soat.solicitud.reintentar_runt'])],
  });
  const t = await new SignJWT({ username: 'pedro@flito.co', role: 'rol_prueba' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

let router: express.Router;
async function buildApp() {
  const app = express();
  app.use(express.json());
  router = (await import('../../src/modules/flito-soat/flito-soat-incompletas.routes.js')).default;
  app.use('/api/flito/soat', router);
  return app;
}

/** Escenario base (alcance `todo`): incompleta abierta, VIN libre, compañía con gestor activo. */
function escenario(over: Record<string, unknown[]> = {}) {
  kdb.when.scenario({
    flito_soat_incompletas: [fila()],
    flito_soat: [],
    flito_compradores: [PROPIETARIO],
    vehicles: [],
    clients: [{ proveedorId: PROVEEDOR, activo: true }],
    ...over,
  });
  kdb.when.insert('vehicles', [{ id: 55 }]);
}

const reintentar = async (app: express.Express, token?: string) =>
  request(app).post(URL).set('Authorization', token ?? await auth()).send({});

const updatesIncompleta = () => espia.updatesEn('flito_soat_incompletas').map((m) => m.datos);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  piiMock.mockClear();
  auditMock.mockClear();
  consultarMock.mockReset().mockResolvedValue(OK);
  logMock.info.mockClear(); logMock.warn.mockClear(); logMock.error.mockClear();
});

// ═══════════════ AC1 — el RUNT responde: pasa a Solicitado ═══════════════

describe('AC1 — el RUNT responde OK: la incompleta pasa a Solicitado por el camino del alta', () => {
  it('200 { resultado: completada, soatId = soat_id_reservado, estado: solicitado, vigenciaProxima: null }', async () => {
    escenario();
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'completada', soatId: RESERVADO, estado: 'solicitado', vigenciaProxima: null });
    expect(consultarMock).toHaveBeenCalledTimes(1);
    expect(consultarMock).toHaveBeenCalledWith(VIN);
  });

  it('el SOAT nace con id = soat_id_reservado, destino de la compañía AL MOMENTO y «enviado por» quien reintenta', async () => {
    escenario();
    await reintentar(await buildApp());
    const soat = espia.ultimoInsertEn('flito_soat');
    expect(soat.id).toBe(RESERVADO);
    expect(soat.vin).toBe(VIN);
    expect(soat.vehiculoId).toBe(55);
    expect(soat.estado).toBe('solicitado');
    expect(soat.origen).toBe('cliente');
    expect(soat.proveedorSoatId).toBe(PROVEEDOR);
    expect(soat.gestionOperaciones).toBe(false);
    expect(soat.enviadoPorId, 'enviado por = quien reintentó').toBe(ultimoSub);
    expect(soat.organismoCodigo).toBe('25286');
  });

  it('Q5: si HOY el gestor de la compañía no está activo, el destino es la contingencia (no el de cuando se radicó)', async () => {
    escenario({ clients: [{ proveedorId: PROVEEDOR, activo: false }] });
    await reintentar(await buildApp());
    const soat = espia.ultimoInsertEn('flito_soat');
    expect(soat.proveedorSoatId).toBeNull();
    expect(soat.gestionOperaciones).toBe(true);
  });

  it('«solicitado por» y su fecha son del radicador; la factura ya subida es el soporte (sin volver a subir)', async () => {
    escenario();
    await reintentar(await buildApp());
    const sat = espia.ultimoInsertEn('flito_soat_solicitud');
    expect(sat.soatId).toBe(RESERVADO);
    expect(sat.solicitadoPorId).toBe(RADICADOR);
    expect(sat.solicitadoPorNombre).toBe('ana@motos.co');
    expect(sat.solicitadoEn).toEqual(T0);
    expect(sat.verificacionEstado).toBe('ok');
    expect(sat.runtConsultadoEn).toBeInstanceOf(Date);
    const soporte = espia.ultimoInsertEn('flito_soportes');
    expect(soporte.soatId).toBe(RESERVADO);
    expect(soporte.storageKey).toBe(`clientes/acme/soat/facturas-venta/${RESERVADO}.pdf`);
    expect(soporte.hash).toBe('a'.repeat(64));
    expect(soporte.subidoPorId).toBe(RADICADOR);
  });

  it('guarda el vehículo con los datos del RUNT y re-apunta el propietario al SOAT (no inserta otro)', async () => {
    escenario();
    await reintentar(await buildApp());
    const v = espia.ultimoInsertEn('vehicles');
    expect(v.vin).toBe(VIN);
    expect(v.plate).toBe(PLACA);
    expect(v.brand).toBe('MAZDA');
    expect(v.clientId).toBe(COMPANIA);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
    const comp = espia.updatesEn('flito_compradores');
    expect(comp).toHaveLength(1);
    expect(comp[0]!.datos).toEqual({ soatId: RESERVADO });
    expect(comp[0]!.filtros).toContain(ID);
  });

  it('la incompleta queda completada con soat_id, quién y cuándo, e intentos + 1', async () => {
    escenario();
    await reintentar(await buildApp());
    const u = updatesIncompleta();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      estado: 'completada', soatId: RESERVADO, resueltaPorId: ultimoSub, resueltaPorNombre: 'pedro@flito.co',
      intentos: 3, ultimoIntentoPorId: ultimoSub,
    });
    expect(u[0]!.resueltaEn).toBeInstanceOf(Date);
  });

  it('renovación anticipada (≤ 30 días): 200 con vigenciaProxima y el SOAT guarda vence_el y poliza_runt (P-7)', async () => {
    escenario();
    consultarMock.mockResolvedValue({ ...OK, clase: 'renovacion_anticipada', venceEl: '2026-10-10', soatActivo: SOAT_ACTIVO });
    const r = await reintentar(await buildApp());
    expect(r.body.resultado).toBe('completada');
    expect(r.body.vigenciaProxima).toEqual({ venceEl: '2026-10-10', ...SOAT_ACTIVO });
    const soat = espia.ultimoInsertEn('flito_soat');
    expect(soat.venceEl).toBe('2026-10-10');
    expect(soat.polizaRunt).toBe('AT-123');
  });

  it('auditoría con uuid opaco y destino; pii_access_log con el motivo del reintento', async () => {
    escenario();
    await reintentar(await buildApp());
    const detalles = auditMock.mock.calls.map((c) => c[1]);
    expect(detalles).toContainEqual(expect.objectContaining({ resource: 'flito_soat_incompletas', resourceId: ID }));
    expect(detalles).toContainEqual(expect.objectContaining({ resource: 'flito_soat', resourceId: RESERVADO }));
    for (const d of detalles) { expect(d.detail).not.toContain(VIN); expect(d.detail).not.toContain(PLACA); }
    expect(piiMock).toHaveBeenCalledTimes(1);
    const pii = piiMock.mock.calls[0]![1];
    expect(pii.motivo).toMatch(/reintentar una solicitud SOAT pendiente de validar/);
    expect(pii.motivo).not.toContain(VIN);
    expect(pii.camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin']));
  });
});

// ═══════════════ AC3 — SOAT vigente o 422: se descarta ═══════════════

describe('AC3 — SOAT vigente o VIN que el RUNT rechaza: se descarta, no se borra', () => {
  it('SOAT vigente que bloquea → 200 descartada soat_vigente con soatActivo, y la fila guarda quién/cuándo/por qué', async () => {
    escenario();
    consultarMock.mockResolvedValue({ clase: 'vigente', fechaVencimiento: '2026-11-01', soatActivo: SOAT_ACTIVO });
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'descartada', motivo: 'soat_vigente', soatActivo: SOAT_ACTIVO });
    const u = updatesIncompleta();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      estado: 'descartada', motivoDescarte: 'soat_vigente', resueltaPorId: ultimoSub,
      resueltaPorNombre: 'pedro@flito.co', intentos: 3,
    });
    expect(u[0]!.resueltaEn).toBeInstanceOf(Date);
    expect(kdb.delete).not.toHaveBeenCalled();
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    // El 409-vigente publica el SOAT activo: se declara en el registro (como el intento del alta).
    expect(piiMock.mock.calls[0]![1].camposAccedidos).toEqual(expect.arrayContaining(['poliza_soat', 'aseguradora_soat']));
  });

  for (const codigo of ['runt_no_cuadra', 'runt_sin_registro', 'runt_sin_vin'] as const) {
    it(`422 ${codigo} → 200 descartada con motivo ${codigo}, soatActivo null, sin crear SOAT`, async () => {
      escenario();
      consultarMock.mockResolvedValue({ clase: 'revise', codigo, campo: 'vin' });
      const r = await reintentar(await buildApp());
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ resultado: 'descartada', motivo: codigo, soatActivo: null });
      expect(updatesIncompleta()[0]).toMatchObject({ estado: 'descartada', motivoDescarte: codigo });
      expect(espia.insertsEn('flito_soat')).toHaveLength(0);
      expect(kdb.delete).not.toHaveBeenCalled();
      expect(piiMock.mock.calls[0]![1].camposAccedidos).toEqual([]);
    });
  }
});

// ═══════════════ AC4 — el VIN ya tiene SOAT ═══════════════

describe('AC4 — el VIN ya tiene solicitud o SOAT: se descarta con solicitud_existente', () => {
  it('la lectura previa de flito_soat encuentra el VIN → descartada sin intentar el INSERT', async () => {
    escenario({ flito_soat: [{ id: 'otro-soat' }] });
    const r = await reintentar(await buildApp());
    expect(r.body).toEqual({ resultado: 'descartada', motivo: 'solicitud_existente', soatActivo: null });
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(updatesIncompleta()).toEqual([expect.objectContaining({ estado: 'descartada', motivoDescarte: 'solicitud_existente' })]);
  });

  it('23505 al insertar: la transacción del SOAT se revierte y una SEGUNDA transacción descarta', async () => {
    escenario();
    kdb.when.insert('flito_soat', () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'descartada', motivo: 'solicitud_existente', soatActivo: null });
    expect(kdb.transaction).toHaveBeenCalledTimes(2);
    // El INSERT del SOAT lanzó antes de re-apuntar el propietario o completar la incompleta.
    expect(espia.updatesEn('flito_compradores')).toHaveLength(0);
    const u = updatesIncompleta();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ estado: 'descartada', motivoDescarte: 'solicitud_existente' });
  });
});

// ═══════════════ AC5 — el RUNT sigue caído ═══════════════

describe('AC5 — el RUNT sigue caído: sigue por validar con intentos + 1', () => {
  it('200 { sigue_incompleta, intentos: 3, ultimoIntentoRuntEn } y guarda la causa de la caída', async () => {
    escenario();
    consultarMock.mockResolvedValue({ clase: 'caido', causa: 'timeout' });
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(200);
    expect(r.body.resultado).toBe('sigue_incompleta');
    expect(r.body.intentos).toBe(3);
    expect(Number.isNaN(Date.parse(r.body.ultimoIntentoRuntEn))).toBe(false);
    const u = updatesIncompleta();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ intentos: 3, ultimaCausaCaida: 'timeout', ultimoIntentoPorId: ultimoSub });
    expect(u[0]!.estado).toBeUndefined();
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(piiMock.mock.calls[0]![1].motivo).toMatch(/resultado=runt_no_disponible/);
  });

  it('caída sin causa conocida (no-200 clasificado) → ultima_causa_caida NULL', async () => {
    escenario();
    consultarMock.mockResolvedValue({ clase: 'caido' });
    await reintentar(await buildApp());
    expect(updatesIncompleta()[0]).toMatchObject({ ultimaCausaCaida: null, intentos: 3 });
  });
});

// ═══════════════ AC6 — dos reintentos a la vez ═══════════════

describe('AC6 — carrera: el re-chequeo tras FOR UPDATE ve la fila ya resuelta', () => {
  for (const [desenlace, preparar] of [
    ['completar', () => consultarMock.mockResolvedValue(OK)],
    ['descartar', () => consultarMock.mockResolvedValue({ clase: 'revise', codigo: 'runt_sin_registro' })],
    ['sumar intento', () => consultarMock.mockResolvedValue({ clase: 'caido', causa: 'red' })],
  ] as const) {
    it(`al ${desenlace}: 409 incompleta_ya_resuelta { estado } sin cambiar la fila`, async () => {
      escenario();
      preparar();
      // 1.ª lectura (antes del RUNT): abierta. 2.ª (FOR UPDATE, dentro de la tx): otro la completó.
      kdb.when.selectOnce('flito_soat_incompletas', [fila()])
        .selectOnce('flito_soat_incompletas', [fila({ estado: 'completada' })]);
      const r = await reintentar(await buildApp());
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ codigo: 'incompleta_ya_resuelta', estado: 'completada' });
      expect(updatesIncompleta()).toHaveLength(0);
      expect(espia.updatesEn('flito_compradores')).toHaveLength(0);
      expect(espia.insertsEn('flito_soat')).toHaveLength(0);
      expect(consultarMock).toHaveBeenCalledTimes(1);
      // La consulta al RUNT sí ocurrió: queda en el registro del artículo 17.
      expect(piiMock).toHaveBeenCalledTimes(1);
      expect(piiMock.mock.calls[0]![1].motivo).toMatch(/resultado=incompleta_ya_resuelta/);
    });
  }
});

// ═══════════════ AC7 — permiso, alcance y límite ═══════════════

describe('AC7 — permiso, alcance y límite', () => {
  it('sin soat.solicitud.reintentar_runt → 403 (aunque vea la bandeja y el detalle)', async () => {
    escenario();
    const r = await reintentar(await buildApp(), await auth({ funciones: ['soat.incompletas.buscar', 'soat.incompleta.ver'] }));
    expect(r.status).toBe(403);
    expect(consultarMock).not.toHaveBeenCalled();
  });

  it('uuid inválido → 404 sin tocar la base', async () => {
    escenario();
    const app = await buildApp();
    const r = await request(app).post('/api/flito/soat/cliente/incompletas/no-es-uuid/reintentar')
      .set('Authorization', await auth()).send({});
    expect(r.status).toBe(404);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('cuerpo con campos → 400 (`.strict()`)', async () => {
    escenario();
    const r = await request(await buildApp()).post(URL).set('Authorization', await auth()).send({ vin: VIN });
    expect(r.status).toBe(400);
    expect(consultarMock).not.toHaveBeenCalled();
  });

  it('fuera de alcance → 404 (no 403): la lectura va acotada a la compañía del enlace', async () => {
    kdb.when.selectOnce('users', [{ c: COMPANIA, p: null }]).selectOnce('flito_soat_incompletas', []);
    const token = await auth({ tipoPrincipal: 'externo', tipoEnlace: 'compania', funciones: ['soat.solicitud.reintentar_runt'] });
    const r = await reintentar(await buildApp(), token);
    expect(r.status).toBe(404);
    expect(consultarMock).not.toHaveBeenCalled();
    const q = espia.condicionesLeidas().filter(Boolean).map((c) => renderizar(c as never))
      .find((x) => x.sql.includes('"flito_soat_incompletas"."compania_id"'));
    expect(q, 'el WHERE de la incompleta lleva la compañía').toBeDefined();
    expect(q!.params).toContain(COMPANIA);
    expect(q!.params).toContain(ID);
  });

  it('un gestor (enlace proveedor) no ve ninguna incompleta → 404 sin leer la tabla', async () => {
    kdb.when.selectOnce('users', [{ c: null, p: PROVEEDOR }]);
    const token = await auth({ tipoEnlace: 'proveedor_soat', funciones: ['soat.solicitud.reintentar_runt'] });
    const r = await reintentar(await buildApp(), token);
    expect(r.status).toBe(404);
    expect(consultarMock).not.toHaveBeenCalled();
  });

  for (const estado of ['descartada', 'completada'] as const) {
    it(`ya ${estado} → 409 incompleta_ya_resuelta { estado } sin consultar el RUNT ni escribir`, async () => {
      escenario({ flito_soat_incompletas: [fila({ estado })] });
      const r = await reintentar(await buildApp());
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ codigo: 'incompleta_ya_resuelta', estado });
      expect(consultarMock).not.toHaveBeenCalled();
      expect(kdb.transaction).not.toHaveBeenCalled();
      expect(piiMock).not.toHaveBeenCalled();
    });
  }

  it('la ruta monta exactamente soatClienteLimiter y soatPreconsultaLimiter (ningún limitador nuevo)', async () => {
    await buildApp();
    const capa = (router.stack as { route?: { path: string; stack: { handle: unknown }[] } }[])
      .find((l) => l.route?.path === '/cliente/incompletas/:id/reintentar');
    expect(capa).toBeDefined();
    const handles = capa!.route!.stack.map((s) => s.handle);
    expect(handles).toContain(soatClienteLimiter);
    expect(handles).toContain(soatPreconsultaLimiter);
    expect(handles.indexOf(soatClienteLimiter)).toBeLessThan(handles.indexOf(soatPreconsultaLimiter));
    // guarda + 2 limitadores + handler
    expect(handles).toHaveLength(4);
  });
});

// ═══════════════ Logs sin PII ═══════════════

describe('logs — ni VIN ni placa en ningún desenlace', () => {
  it.each([
    ['completada', OK],
    ['descartada', { clase: 'vigente', fechaVencimiento: null, soatActivo: SOAT_ACTIVO }],
    ['sigue_incompleta', { clase: 'caido', causa: 'red' }],
  ])('%s', async (_n, desenlace) => {
    escenario();
    consultarMock.mockResolvedValue(desenlace);
    await reintentar(await buildApp());
    const texto = JSON.stringify([...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls]);
    expect(texto).not.toContain(VIN);
    expect(texto).not.toContain(PLACA);
    expect(texto).not.toContain('1020304050');
  });
});
