// HU #12996 (Feature #12841, Épica #12616) — el alta del canal Cliente con el RUNT caído APARCA la
// solicitud en `flito_soat_incompletas` y responde 202. ADR-0019 (opción A, Aceptado); diseño
// docs/diseno-feature-12841-solicitud-incompleta-runt.md (§11 manda sobre §4).
//
// Matriz AC → casos de este archivo:
//   AC1  preconsulta 503 + alta con el RUNT aún caído → 202; incompleta (intentos 1, último intento),
//        propietario con `soat_incompleta_id`, factura con la clave del `soat_id_reservado`; nada en
//        `flito_soat` ni en `vehicles`.
//   AC2  el RUNT responde en el servidor → 201 `creada` con el cuerpo de hoy; ninguna incompleta.
//   AC3  preconsulta OK y el RUNT cae en el envío → 202.
//   AC4  la incompleta no llega a ningún lector de `flito_soat` (estructural: tabla aparte).
//   AC5  incompleta abierta ocupa el VIN → 409 `solicitud_incompleta_existente` (propia / ajena) en
//        preconsulta y alta; la consulta filtra por `estado = 'incompleta'` (la descartada no ocupa);
//        la carrera del índice parcial (23505) también sale como 409.
//   AC6  422 / 409 del RUNT no guardan nada.
//   AC10 el log del desenlace no lleva VIN, placa, documento ni el mensaje crudo del error.
//
// Montaje: el router real con `authMiddleware` real y el doble keyed de drizzle con `espia-drizzle`
// (se afirma sobre lo que se ESCRIBE, no sobre el mock). Un `sub` distinto por caso: el limitador
// del canal es por usuario.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar } from '../helpers/sql-ligado.js';
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

const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const COMPANIA = 7;
const OTRA_COMPANIA = 99;
const VEHICULO_ID = 55;
const INCOMPLETA_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** VIN, placa y documento sintéticos: ninguno es de nadie. */
const VIN = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
const DOCUMENTO = '1020304050';
/** El mensaje crudo de la pasarela: lleva el VIN dentro, que es lo que el log NO puede repetir. */
const MENSAJE_CRUDO = `ECONNRESET consultando ${VIN}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function runtOk(soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: PLACA, vin: VIN, idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular', tipoCarroceria: 'WAGON',
        pasajerosSentados: '5', puertas: '5', organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
      },
      soat,
    },
  };
}
const CAIDO = { ok: false, message: 'La consulta no pudo ser atendida' };
const NEGATIVA_DE_NEGOCIO = { ok: false, message: 'La consulta no pudo ser atendida', httpStatus: 200 };

let sub = 12996;
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
    flito_soat_incompletas: [],
    organismos_transito_config: [{ codigo: '25286', alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
  kdb.when.insert('flito_soat_incompletas', [{ id: INCOMPLETA_ID }]);
}

const CAMPOS: Record<string, string> = {
  vin: VIN.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: DOCUMENTO,
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const preconsultar = (app: express.Express, token: string) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send({ vin: VIN });

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/reservado.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

// ═══════════════ AC1 — RUNT caído en la preconsulta y en el envío ═══════════════

describe('AC1 — con el RUNT caído el alta queda POR VALIDAR (202), no se pierde', () => {
  it('preconsulta 503 y alta con el RUNT aún caído → 202 `{ desenlace, id, estado, mensaje }`', async () => {
    const app = await buildApp();
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    expect(pre.status, 'la preconsulta NO cambia: sigue en 503').toBe(503);
    expect(pre.body.codigo).toBe('runt_no_disponible');
    expect(espia.inserts, 'la preconsulta no escribe nada').toHaveLength(0);

    const r = await alta(app, await auth(siguienteUsuario()));
    expect(r.status).toBe(202);
    expect(Object.keys(r.body).sort()).toEqual(['desenlace', 'estado', 'id', 'mensaje']);
    expect(r.body).toMatchObject({ desenlace: 'incompleta', id: INCOMPLETA_ID, estado: 'incompleta' });
    expect(typeof r.body.mensaje).toBe('string');
    expect(r.body.mensaje).not.toContain(VIN);
    // El servidor SÍ volvió a consultar el RUNT (una vez en la preconsulta, una en el alta).
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(2);
  });

  it('la fila de espera nace con intentos = 1, último intento registrado, VIN normalizado y la factura', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(1);
    const fila = espia.ultimoInsertEn('flito_soat_incompletas');
    expect(fila.intentos).toBe(1);
    expect(fila.ultimoIntentoEn).toBeInstanceOf(Date);
    expect(fila.estado).toBe('incompleta');
    expect(fila.vin, 'el tecleado en minúsculas llega normalizado').toBe(VIN);
    expect(fila.companiaId).toBe(COMPANIA);
    expect(fila.soatIdReservado).toMatch(UUID_RE);
    expect(fila.facturaStorageKey).toBe('clientes/acme/soat/facturas-venta/reservado.pdf');
    expect(fila.facturaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.facturaNombreArchivo).toBe('factura.pdf');
    expect(fila.facturaTamanoBytes).toBe(PDF.length);
  });

  it('la factura se sube con la clave del `soat_id_reservado`', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [carpeta, clave] = uploadMock.mock.calls[0];
    expect(carpeta).toContain('soat/facturas-venta');
    expect(clave).toBe(espia.ultimoInsertEn('flito_soat_incompletas').soatIdReservado);
  });

  it('el propietario queda en `flito_compradores` con `soat_incompleta_id` y sin otro padre', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    await alta(await buildApp(), await auth(siguienteUsuario()));

    const comprador = espia.ultimoInsertEn('flito_compradores');
    expect(comprador.soatIncompletaId).toBe(INCOMPLETA_ID);
    expect(comprador).not.toHaveProperty('soatId');
    expect(comprador).not.toHaveProperty('tramiteId');
    // Mismo tratamiento que el alta normal: campos partidos, derivado y procedencia completa.
    expect(comprador).toMatchObject({
      nombreCompleto: 'JUANA PEREZ', nombres: 'JUANA', apellidos: 'PEREZ', razonSocial: null,
      numeroDocumento: DOCUMENTO, tipoDocumento: 'CC', municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
    });
    expect(Object.values(comprador.procedencia as Record<string, string>).every((v) => v === 'manual')).toBe(true);
  });

  it('**no se crea nada en `flito_soat`, `vehicles`, satélite, soportes ni historial**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    await alta(await buildApp(), await auth(siguienteUsuario()));

    for (const tabla of ['flito_soat', 'vehicles', 'flito_soat_solicitud', 'flito_soportes', 'flito_estado_historial']) {
      expect(espia.insertsEn(tabla), `nada en ${tabla}`).toHaveLength(0);
    }
    expect(espia.updatesEn('vehicles')).toHaveLength(0);
    expect(espia.secuencia()).toEqual(['flito_soat_incompletas', 'flito_compradores']);
  });

  it('deja el rastro PII de INTENTO (sin campos) y un audit con el uuid opaco de la incompleta', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const registro = piiMock.mock.calls[0][1];
    expect(registro.camposAccedidos).toEqual([]);
    expect(String(registro.motivo)).toContain('resultado=runt_no_disponible');

    expect(auditMock).toHaveBeenCalledTimes(1);
    const a = auditMock.mock.calls[0][1];
    expect(a).toMatchObject({ action: 'create', resource: 'flito_soat_incompletas', resourceId: INCOMPLETA_ID });
    for (const pii of [VIN, PLACA, DOCUMENTO]) expect(String(a.detail)).not.toContain(pii);
  });
});

// ═══════════════ AC2 — el RUNT responde: flujo de hoy ═══════════════════════════

describe('AC2 — si el RUNT responde en el servidor, el alta es la de hoy (201 `creada`)', () => {
  it('201 con `desenlace: creada` + `{ id, estado }`, y ninguna incompleta', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['desenlace', 'estado', 'id']);
    expect(r.body).toMatchObject({ desenlace: 'creada', estado: 'solicitado' });
    expect(r.body.id).toMatch(UUID_RE);
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(0);
    expect(espia.ultimoInsertEn('flito_compradores')).not.toHaveProperty('soatIncompletaId');
  });
});

// ═══════════════ AC3 — preconsulta OK, RUNT cae en el envío (P-6) ═══════════════

describe('AC3 — el RUNT responde en la preconsulta y cae en el envío', () => {
  it('→ 202 `incompleta`: lo que decide es la consulta del SERVIDOR, no la de la pantalla', async () => {
    const app = await buildApp();
    escenario();
    consultarVehiculoRuntMock.mockResolvedValueOnce(runtOk()).mockResolvedValueOnce(CAIDO);

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    expect(pre.status).toBe(200);

    const r = await alta(app, await auth(siguienteUsuario()));
    expect(r.status).toBe(202);
    expect(r.body.desenlace).toBe('incompleta');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(1);
  });
});

// ═══════════════ AC4 — ningún lector de `flito_soat` la ve ═══════════════════════

describe('AC4 — la incompleta no llega al gestor, ni a la cola, ni al Excel, ni al ZIP, ni al cron', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(__dirname, '../../src');
  const leer = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

  /**
   * La garantía es ESTRUCTURAL (ADR-0019 opción A): la incompleta vive en otra tabla, y estos
   * lectores solo leen `flito_soat`. Se afirma sobre el código de cada uno: el día que alguien
   * haga que la cola o el envío al gestor lean la tabla de espera, este caso se pone rojo.
   */
  it.each([
    ['envío al gestor (`enviarAlGestor`), cola (`cola`) y facetas (`facetasCola`)', 'modules/flito-soat/flito-soat.service.ts'],
    ['rutas de la cola y de `POST /enviar`', 'modules/flito-soat/flito-soat.routes.ts'],
    ['Excel de la cola', 'modules/flito-soat/flito-soat.export.service.ts'],
    ['Excel de pago', 'modules/flito-soat/flito-soat.export-pago.ts'],
    ['ZIP de soportes', 'shared/soportes/soportes-consulta.ts'],
    ['cron de vigencia', 'modules/flito-soat/flito-soat-vigencia.cron.ts'],
    ['servicio de vigencia', 'modules/flito-soat/flito-soat-vigencia.service.ts'],
    ['censo de vigencia', 'modules/flito-soat/flito-soat-censo.ts'],
  ])('%s no lee `flito_soat_incompletas`', (_nombre, archivo) => {
    const codigo = leer(archivo);
    expect(codigo).not.toMatch(/flitoSoatIncompletas|flito_soat_incompletas/);
  });

  it('el envío al gestor y la cola existen donde se miran (el caso de arriba no es vacío)', () => {
    const servicio = leer('modules/flito-soat/flito-soat.service.ts');
    expect(servicio).toMatch(/export async function enviarAlGestor\(/);
    expect(servicio).toMatch(/export async function cola\(/);
    expect(servicio).toMatch(/export async function facetasCola\(/);
  });

  it('y el alta aparcada no escribe la fila de `flito_soat` que esos lectores leerían', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });
});

// ═══════════════ AC5 — la incompleta abierta ocupa el VIN ═══════════════════════

describe('AC5 — una incompleta ABIERTA ocupa el VIN (RN-01, P-5)', () => {
  it('propia → 409 `solicitud_incompleta_existente` con `propia: true` + `id`, en la preconsulta y en el alta', async () => {
    const app = await buildApp();
    for (const llamar of [preconsultar, alta]) {
      escenario({ flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: COMPANIA }] });
      const r = await llamar(app, await auth(siguienteUsuario()));
      expect(r.status).toBe(409);
      expect(r.body.codigo).toBe('solicitud_incompleta_existente');
      expect(r.body.propia).toBe(true);
      expect(r.body.id).toBe(INCOMPLETA_ID);
    }
    // Corta ANTES del RUNT y antes de subir nada.
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(espia.inserts).toHaveLength(0);
  });

  it('ajena → 409 recortado: `propia: false`, sin id y sin estado, en la preconsulta y en el alta', async () => {
    const app = await buildApp();
    for (const llamar of [preconsultar, alta]) {
      escenario({ flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: OTRA_COMPANIA }] });
      const r = await llamar(app, await auth(siguienteUsuario()));
      expect(r.status).toBe(409);
      expect(r.body.codigo).toBe('solicitud_incompleta_existente');
      expect(r.body.propia).toBe(false);
      expect(r.body).not.toHaveProperty('id');
      expect(r.body).not.toHaveProperty('estado');
      expect(JSON.stringify(r.body)).not.toContain(INCOMPLETA_ID);
      // Anti-sondeo: el texto es el mismo del vehículo ajeno; no le dice al tercero «por validar».
      expect(r.body.error).not.toMatch(/validar/i);
    }
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**la consulta solo cuenta las ABIERTAS**: filtra por VIN y por `estado = incompleta` (la descartada no ocupa)', async () => {
    // El doble de drizzle ignora el WHERE, así que una fila «descartada» en el escenario no probaría
    // nada. Se lee el SQL real de la condición con la que se consultó la tabla de espera.
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    const sobreIncompletas = espia.condicionesLeidas()
      .map((c) => renderizar(c as SQL))
      .filter((q) => q.sql.includes('"flito_soat_incompletas"'));
    expect(sobreIncompletas.length).toBeGreaterThan(0);
    for (const q of sobreIncompletas) {
      expect(q.sql).toMatch(/"flito_soat_incompletas"\."vin" = \$\d+/);
      expect(q.sql).toMatch(/"flito_soat_incompletas"\."estado" = \$\d+/);
      expect(q.params).toContain('incompleta');
      expect(q.params).toContain(VIN);
      expect(q.params).not.toContain('descartada');
    }
  });

  it('un SOAT existente sigue mandando: con fila en `flito_soat` el 409 es `vin_ya_tiene_soat`', async () => {
    escenario({
      flito_soat: [{ id: '11111111-1111-4111-8111-111111111111', estado: 'solicitado', companiaId: COMPANIA }],
      flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: COMPANIA }],
    });
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
  });

  it('la carrera: otra petición aparcó el mismo VIN (23505 del índice parcial) → 409, no 500', async () => {
    escenario({ flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: OTRA_COMPANIA }] });
    // Primera lectura (antes del RUNT): libre. Segunda (tras el 23505): ya ocupada por otra compañía.
    kdb.when.selectOnce('flito_soat_incompletas', []);
    kdb.when.insert('flito_soat_incompletas', () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    });
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('solicitud_incompleta_existente');
    expect(r.body.propia).toBe(false);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
  });
});

// ═══════════════ AC6 — otras respuestas del RUNT no guardan nada ════════════════

describe('AC6 — 422 y 409 del RUNT son los de hoy y no aparcan nada', () => {
  it.each([
    ['negativa de negocio', () => NEGATIVA_DE_NEGOCIO, 422, 'runt_no_cuadra'],
    ['VIN no registrado', () => ({ ok: true, data: { vehiculo: { placa: PLACA, vin: VIN } } }), 422, 'runt_sin_registro'],
    ['VIN que no cuadra', () => { const r = runtOk(); r.data.vehiculo.vin = '9FKRG2222T2099999'; return r; }, 422, 'runt_no_cuadra'],
    ['RUNT sin VIN', () => { const r = runtOk(); (r.data.vehiculo as Record<string, unknown>).vin = null; return r; }, 422, 'runt_sin_vin'],
    ['SOAT vigente', () => runtOk({ estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2030' }), 409, 'soat_vigente'],
  ] as const)('%s → la respuesta de hoy, sin incompleta ni factura subida', async (_n, runt, status, codigo) => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runt());
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(status);
    expect(r.body.codigo).toBe(codigo);
    expect(r.body).not.toHaveProperty('desenlace');
    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(0);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

// ═══════════════ AC10 — sin PII en los logs ═══════════════════════════════════════

describe('AC10 — el log del desenlace no lleva VIN, placa, documento ni el mensaje crudo', () => {
  it('RUNT caído por `throw` con el VIN dentro del mensaje → ningún log lo repite', async () => {
    escenario();
    consultarVehiculoRuntMock.mockRejectedValue(new Error(MENSAJE_CRUDO));
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(202);

    const todo = JSON.stringify([
      ...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls,
    ]);
    // Hubo log del aparcamiento, y es el que se mira.
    expect(todo).toContain(INCOMPLETA_ID);
    for (const pii of [VIN, PLACA, DOCUMENTO, MENSAJE_CRUDO, 'ECONNRESET consultando']) {
      expect(todo, `el log no puede llevar «${pii}»`).not.toContain(pii);
    }
  });
});
