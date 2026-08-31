// HU #11914 (Feature #11912) — el ALTA del canal Cliente: `POST /api/flito/soat/cliente` y su
// preconsulta. Un AC por bloque, y cada aserción escrita para morir si se quita el código que la
// sostiene.
//
// ── Cómo está montada, y por qué así ─────────────────────────────────────────────────────────────
//
// **Se mide el INSERT, no la respuesta.** El mock de drizzle devuelve lo que el test le registre, así
// que afirmar sobre el cuerpo de la respuesta prueba el mock. Lo que se afirma aquí es el PAYLOAD
// REAL que el servicio le pasó a `insert().values()` —`espia-drizzle`—: `origen`, `estado`,
// `compania_id` y el organismo salen de ahí. Cambiar `pendiente_revision` por `pendiente` en el
// servicio pone rojo este archivo; cambiar el mock, no.
//
// **La API sube por su router real y por `authMiddleware` real.** Eso hace que el guarda de negación
// por defecto (`RUTAS_PERMITIDAS_CLIENTE`) esté vivo en cada petición: si alguien borra las dos
// entradas que la HU inscribió en la allowlist, TODO este archivo se pone en 403 — que es
// exactamente la señal que se quiere.
//
// **Cada test usa un `sub` distinto.** El limitador del canal es por usuario y su ventana es de 15
// minutos; con un `sub` compartido, el test número 21 de este archivo empezaría a fallar con 429 sin
// que nadie entendiera por qué. El último bloque usa esa misma propiedad para comprobar el freno.

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

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';

/** PDF de verdad: `file-type` reconoce el `%PDF-` de los primeros bytes, no la extensión. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
/** Un ejecutable de Windows con nombre y `Content-Type` de PDF. Es el ataque del AC5. */
const EXE_DISFRAZADO = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);

/**
 * Respuesta del RUNT con el vehículo registrado y SIN SOAT vigente — el camino feliz.
 *
 * `idAutomotor` y `estadoAutomotor` no son decoración: `runtSinRegistro()` los usa como señales de
 * que el RUNT sí tiene el vehículo. Sin ellas, esta misma respuesta sería «no registrado».
 */
function runtOk(over: Record<string, unknown> = {}, soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: 'JNH38H', vin: '9FKRG2222T2042405',
        idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular',
        organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
        ...over,
      },
      soat,
    },
  };
}

let sub = 100;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: string, id: number) => `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: role as never })}`;

/**
 * El escenario por defecto: compañía 7 con el canal ENCENDIDO, ningún SOAT con ese VIN, Funza
 * configurado y un vehículo que todavía no existe.
 *
 * `users` sirve a DOS lecturas con formas distintas —`sessionInvalidatedAt` de `authMiddleware` y
 * `compania_id` de `contextoSoat`— y por eso la fila trae las dos claves.
 */
function escenario(over: Partial<Record<string, unknown[]>> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{ id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme' }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}

/** Los campos del formulario, tal como los manda el `multipart` del navegador (todo texto). */
const CAMPOS: Record<string, string> = {
  placa: 'jnh38h', vin: '9fkrg2222t2042405',
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombreCompleto: 'JUANA PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
};

/** `POST /cliente` con el adjunto que se le pase. */
function alta(app: express.Express, token: string, opciones: { campos?: Record<string, string>; archivo?: Buffer; nombre?: string; mime?: string } = {}) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS, ...opciones.campos })) req.field(k, v);
  return req.attach('facturaVenta', opciones.archivo ?? PDF, {
    filename: opciones.nombre ?? 'factura.pdf',
    contentType: opciones.mime ?? 'application/pdf',
  });
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
});

// ───────────────────────────── AC1 — crear ES enviar ─────────────────────────

describe('AC1 — el alta crea la fila del canal y la deja lista para revisión', () => {
  it('**201 y la fila nace con `origen = cliente` y estado `pendiente_revision`**', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('pendiente_revision');

    const soat = espia.ultimoInsertEn('flito_soat');
    expect(soat.origen).toBe('cliente');
    // El estado es la decisión cara del ADR-0008 §2: `pendiente` haría que `POST /enviar` —que
    // filtra por ese estado— despachara al gestor una solicitud que nadie ha validado.
    expect(soat.estado).toBe('pendiente_revision');
    expect(soat.id).toBe(r.body.id);
  });

  it('la compañía es la del USUARIO, no la del formulario', async () => {
    escenario();
    // El cuerpo intenta radicar para otra compañía. Se ignora: `companiaId` no está en el schema de
    // Zod y el servicio lo toma de `contextoSoat()`.
    await alta(await buildApp(), await auth('cliente', siguienteUsuario()), { campos: { companiaId: '99' } });

    expect(espia.ultimoInsertEn('flito_soat').companiaId).toBe(COMPANIA);
  });

  it('**201 aunque `consultarVehiculoRunt` nunca se resuelve** (el alta no espera a Kyverum)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockReturnValue(new Promise(() => { /* colgada a propósito */ }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('pendiente_revision');
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
  });

  it('**marca, línea y organismoCodigo AUSENTES en el INSERT del 201** (el cliente no los manda; el RUNT va después)', async () => {
    escenario();
    await alta(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { marca: 'FERRARI', linea: 'F40', cilindraje: '2999', organismoCodigo: '11001' },
    });

    const vehiculo = espia.ultimoInsertEn('vehicles');
    expect(vehiculo).toMatchObject({
      vin: '9FKRG2222T2042405', plate: 'JNH38H',
    });
    expect(vehiculo.brand).toBeNull();
    expect(vehiculo.model).toBeNull();
    expect(vehiculo.vehicleClass).toBeNull();
    expect(espia.ultimoInsertEn('flito_soat').organismoCodigo).toBeNull();
  });

  it('el tipo de documento de la UI se persiste; el alta no llama a Kyverum', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { tipoDocumento: 'PPT' },
    });
    expect(r.status).toBe(201);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(espia.ultimoInsertEn('flito_compradores').tipoDocumento).toBe('PPT');
  });

  it('**201 sin haber llamado `/preconsulta`**: crear no la invoca', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    // La preconsulta es otro endpoint. Este POST no la dispara ni como paso interno.
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('el propietario va a `flito_compradores` colgado del SOAT y NO de un trámite', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    const propietario = espia.ultimoInsertEn('flito_compradores');
    expect(propietario).toMatchObject({
      soatId: r.body.id, nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050',
      tipoDocumento: 'CC', correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
    });
    // El CHECK `flito_compradores_padre_chk` exige uno y solo uno de los dos padres: mandar también
    // `tramiteId` sería un 23514 en la base y aquí un test verde con una fila que nunca entra.
    expect(propietario.tramiteId).toBeUndefined();
  });

  it('la satélite guarda quién radicó, y el soporte queda como factura de venta del SOAT', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(espia.ultimoInsertEn('flito_soat_solicitud')).toMatchObject({
      soatId: r.body.id, solicitadoPorId: sub, solicitadoPorNombre: 'cliente@empresa.co',
      verificacionEstado: 'pendiente',
    });
    expect(espia.ultimoInsertEn('flito_soportes')).toMatchObject({
      tipo: 'factura_venta', soatId: r.body.id, contentType: 'application/pdf',
      storageKey: 'clientes/acme/soat/facturas-venta/abc.pdf',
    });
  });

  it('el alta deja su fila de historial: sin ella, la solicitud no tendría principio', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(espia.ultimoInsertEn('flito_estado_historial')).toMatchObject({
      concepto: 'soat', registroId: r.body.id, estadoAnterior: null, estadoNuevo: 'pendiente_revision',
    });
  });

  it('la clave de storage se nombra con el uuid del SOAT — nunca con la placa ni con el VIN', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    const [prefijo, entityId] = uploadMock.mock.calls[0];
    expect(entityId).toBe(r.body.id);
    for (const fragmento of [prefijo, String(entityId)]) {
      expect(fragmento).not.toContain('JNH38H');
      expect(fragmento).not.toContain('9FKRG2222T2042405');
    }
  });

  it('un vehículo que YA existe **y es de SU compañía** se actualiza sin borrar lo que el alta no trajo', async () => {
    escenario({ vehicles: [{ id: VEHICULO_ID, clientId: COMPANIA }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);

    expect(espia.insertsEn('vehicles')).toHaveLength(0);
    const set = espia.updatesEn('vehicles').at(-1)!.datos;
    // El alta no espera al RUNT: no pisa marca/línea. Un `null` no viaja (política del sync).
    expect(Object.keys(set)).not.toContain('brand');
    expect(Object.keys(set)).not.toContain('model');
    expect(Object.keys(set)).not.toContain('cilindraje');
    expect(Object.keys(set)).not.toContain('tipoServicio');
    expect(Object.keys(set)).not.toContain('clientId');
  });
});

// ───────── La ficha de `vehicles` es COMPARTIDA: no se escribe sobre la de otra compañía ─────────
//
// Bloqueante del `security-agent`, y el motivo por el que la RN-01 no bastaba: `verificarRn01` mira
// `flito_soat.vin` y esto mira `vehicles.vin`, que son conjuntos distintos. Un vehículo puede existir
// en `vehicles` SIN fila en `flito_soat` —es el caso mayoritario: el sync crea el vehículo para todo
// trámite y solo crea el SOAT con trámite asignado—, así que para ese VIN no saltaba ni la RN-01 ni
// el UNIQUE de `vehiculo_id`, y el alta sobrescribía la ficha ajena con lo que teclea quien radica.

describe('tenencia del vehículo — la ficha de otra compañía no se toca', () => {
  it('**VIN de un vehículo de OTRA compañía → 409 `propia: false` y CERO escrituras sobre `vehicles`**', async () => {
    // Ojo al escenario: NO hay fila en `flito_soat` para ese VIN, así que la RN-01 pasa limpia. Es
    // exactamente el caso que se colaba.
    escenario({ flito_soat: [], vehicles: [{ id: VEHICULO_ID, clientId: 999 }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(r.body.propia).toBe(false);
    // Ni un UPDATE: ni el titular, ni la cédula, ni la placa, ni la marca de la ficha ajena.
    expect(espia.updatesEn('vehicles')).toHaveLength(0);
    expect(espia.insertsEn('vehicles')).toHaveLength(0);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    // Y el recorte de siempre: no se le dice de quién es ni en qué estado está.
    expect(r.body.id).toBeUndefined();
    expect(r.body.estado).toBeUndefined();
  });

  it('la guarda corta ANTES del RUNT y ANTES de subir el PDF (ni consulta cara ni objeto huérfano)', async () => {
    escenario({ flito_soat: [], vehicles: [{ id: VEHICULO_ID, clientId: 999 }] });

    await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('**una ficha SIN dueño se adopta** para la compañía que radica, y queda anotado', async () => {
    // `clientId === null` es lo que dejan la vía legacy (que se alimenta de placa) y el OCR de la
    // tarjeta de propiedad. Dejarlo en null mantendría el agujero abierto para esa fila: el
    // siguiente que radicara con ese VIN volvería a encontrarla sin dueño.
    escenario({ vehicles: [{ id: VEHICULO_ID, clientId: null }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);

    const set = espia.updatesEn('vehicles').at(-1)!.datos;
    expect(set.clientId).toBe(COMPANIA);

    // El rastro que faltaba: tocar una ficha que ya existía no quedaba escrito en ninguna parte,
    // porque el `audit()` de la ruta anota el SOAT nuevo con SU uuid.
    const rastro = espia.insertsEn('audit_logs').at(-1)!.datos;
    expect(rastro).toMatchObject({ action: 'update', resource: 'vehicles', resourceId: String(VEHICULO_ID) });
    expect(String(rastro.detail)).toMatch(/no tenía dueño/);
    // Sin placa, VIN ni documento en la bitácora (AGENTS.md §14).
    for (const pii of ['JNH38H', '9FKRG2222T2042405', '1020304050']) {
      expect(String(rastro.detail)).not.toContain(pii);
    }
  });

  it('**la CARRERA: la ficha aparece ajena entre la comprobación previa y el UPDATE**', async () => {
    // Sin este caso, la guarda de DENTRO de la transacción no está probada: en todos los demás
    // escenarios la comprobación previa corta antes, y borrarla del código dejaría la suite verde
    // (mutante comprobado). Aquí la previa ve la fila libre y la de dentro la ve de otra compañía,
    // que es lo que ocurre cuando dos altas del mismo VIN se cruzan.
    escenario({ flito_soat: [], vehicles: [{ id: VEHICULO_ID, clientId: 999 }] });
    kdb.when.selectOnce('vehicles', []); // la comprobación previa: todavía no hay ficha

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.propia).toBe(false);
    // Lo que decide es la lectura de dentro de la transacción: sin ella, esto sería un UPDATE sobre
    // la ficha ajena y un 201.
    expect(espia.updatesEn('vehicles')).toHaveLength(0);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('una ficha cuyo dueño llega VACÍO se trata como sin dueño, no como ajena', async () => {
    // Fija la comparación LAXA del predicado. `null` y `undefined` significan aquí lo mismo —«nadie
    // reclama esta ficha»— y el doble de drizzle del repo devuelve la fila entera que el test
    // registró, sin recortarla a las claves del `select`: con el estricto, esta fila se clasificaba
    // como AJENA y el alta moría con un 409 sobre un vehículo de nadie.
    escenario({ vehicles: [{ id: VEHICULO_ID }] }); // sin `clientId` en la fila

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    // Y la MISMA laxitud en la otra decisión que se toma sobre ese hecho: se adopta. Si `adopta`
    // comparara estricto, la ficha pasaría la guarda pero seguiría sin dueño para el siguiente.
    expect(espia.updatesEn('vehicles').at(-1)!.datos.clientId).toBe(COMPANIA);
  });

  it('la preconsulta aplica la MISMA guarda: no deja llenar el formulario para fallar al final', async () => {
    escenario({ flito_soat: [], vehicles: [{ id: VEHICULO_ID, clientId: 999 }] });

    const r = await request(await buildApp()).post('/api/flito/soat/cliente/preconsulta')
      .set('Authorization', await auth('cliente', siguienteUsuario()))
      .send({ placa: 'JNH38H', vin: '9FKRG2222T2042405', tipoDocumento: 'CC', numeroDocumento: '1020304050' });

    expect(r.status).toBe(409);
    expect(r.body.propia).toBe(false);
  });

  it('los dos «no es suyo» son INDISTINGUIBLES: mismo código y mismo texto', async () => {
    // Si cada uno tuviera su frase, dos intentos separarían «ese vehículo tiene SOAT» de «existe sin
    // SOAT» — información sobre la cartera ajena a fuerza de sondear VINes.
    escenario({ flito_soat: [], vehicles: [{ id: VEHICULO_ID, clientId: 999 }] });
    const sinSoat = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    escenario({ flito_soat: [{ id: 'eeee', estado: 'pagado', companiaId: 999 }], vehicles: [] });
    const conSoat = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(sinSoat.status).toBe(conSoat.status);
    expect(sinSoat.body.codigo).toBe(conSoat.body.codigo);
    expect(sinSoat.body.error).toBe(conSoat.body.error);
  });
});

// ───────────────────────────── AC2 — el RUNT falla: igual se crea ────────────

describe('AC2 — el RUNT falla o el organismo no está en el catálogo: igual se crea', () => {
  it('RUNT caído → 201 (ya no 503); la fila nace', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'Timeout 90s' });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('pendiente_revision');
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
    expect(espia.ultimoInsertEn('flito_soat_solicitud').verificacionEstado).toBe('pendiente');
  });

  it('RUNT sin registro (eco de la consulta) → 201, no 422', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({
      ok: true, data: { vehiculo: { placa: 'JNH38H', vin: '9FKRG2222T2042405' } },
    });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
  });

  it('placa o VIN que no cuadran con el RUNT → 201 (el job anota `no_cuadra`)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ placa: 'XXX999', vin: 'OTROVIN12345678901' }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
  });

  it('organismo que no cruza con el catálogo → 201 y organismoCodigo NULL', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ organismoTransito: 'STRIA TTO DE MARTE' }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').organismoCodigo).toBeNull();
  });

  it('organismo del catálogo pero SIN configurar en esta instalación → 201, organismo NULL', async () => {
    escenario({ organismos_transito_config: [] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').organismoCodigo).toBeNull();
  });

  it('**TC-AC5-01: el INSERT del 201 lleva organismoCodigo NULL**', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').organismoCodigo).toBeNull();
  });
});

// ───────────────────────────── AC3 — SOAT vigente: se crea, no auto-solicita ─

describe('AC3 — el RUNT dice que ya tiene SOAT vigente: se crea en pendiente_revision', () => {
  it('**SOAT vigente por fecha → 201, no 409; el estado NO pasa a solicitado**', async () => {
    escenario();
    const dentroDeUnAnio = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({}, {
      estadoSoat: 'VIGENTE', fechaVencimSoat: dentroDeUnAnio,
    }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('pendiente_revision');
    expect(r.body.codigo).not.toBe('soat_vigente');
    expect(espia.ultimoInsertEn('flito_soat').estado).toBe('pendiente_revision');
    expect(espia.ultimoInsertEn('flito_soat').estado).not.toBe('solicitado');
  });

  it('SOAT vigente con fecha en `dd/MM/yyyy` → 201 (el aviso vive en el satélite, no en el 201)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({}, { estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2027' }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).not.toContain('fechaVencimiento');
  });

  it('vigencia SOLO por estado → 201 sin auto-transición', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({}, { estadoSoat: 'VIGENTE' }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').estado).toBe('pendiente_revision');
  });

  it('SOAT VENCIDO → 201 (como siempre)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({}, { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/02/2019' }));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
  });

  it('el RUNT no reporta póliza → 201', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({}, null));

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
  });
});

// ───────────────────────────── AC4 — RN-01 ───────────────────────────────────

describe('AC4 — RN-01: un VIN, un SOAT', () => {
  it('**el VIN ya tiene SOAT → 409 `vin_ya_tiene_soat` y NI UNA segunda fila**', async () => {
    escenario({ flito_soat: [{ id: 'aaaa', estado: 'pagado', companiaId: COMPANIA }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    // Y tampoco toca el que ya existe: un SOAT nacido de trámite no cambia de ciclo (AC5).
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('una solicitud RECHAZADA de SU compañía bloquea, y la respuesta le dice cuál abrir', async () => {
    escenario({ flito_soat: [{ id: 'bbbb', estado: 'rechazada', companiaId: COMPANIA }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    // Es suya: puede ver el id y el estado, que ya vería en su cola, y el mensaje la manda a
    // subsanar esa misma fila en vez de radicar otra.
    expect(r.body).toMatchObject({ propia: true, id: 'bbbb', estado: 'rechazada' });
    expect(r.body.error).toMatch(/subsan/i);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('**el VIN choca con un SOAT de OTRA compañía → bloquea IGUAL, pero sin id, sin estado y sin pista**', async () => {
    // La frontera entre compañías (§4 del doc de UX y la lección de la #11913): un `cliente` puede
    // sondear VINs, y si la respuesta cambiara según el estado, cada intento respondería una
    // pregunta sobre la cartera ajena.
    escenario({ flito_soat: [{ id: 'cccc', estado: 'rechazada', companiaId: 999 }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(r.body.propia).toBe(false);
    // Ni el identificador, ni el estado, ni una palabra que distinga «rechazada» de «pagada».
    expect(r.body.id).toBeUndefined();
    expect(r.body.estado).toBeUndefined();
    expect(r.body.error).not.toMatch(/subsan|rechaz|pagad/i);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('carrera entre dos altas del mismo VIN → el 23505 de la base también sale como 409', async () => {
    escenario();
    // La comprobación previa pasa (no había fila) y es el UNIQUE quien decide. Sin traducir el
    // 23505, esto sería un 500 y el cliente no sabría que su vehículo ya tiene SOAT.
    kdb.when.insert('flito_soat', () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
  });

  /**
   * El texto de esa carrera es DELIBERADAMENTE el del vehículo ajeno, y hace falta fijarlo.
   *
   * Lo pidió `security-agent` en la #11914 y lo cerró la #11915: los tres caminos que acaban en «no
   * puedes con este VIN» —el SOAT de otra compañía, la ficha de `vehicles` de otra compañía y la
   * carrera perdida contra el UNIQUE— comparten ahora código, cuerpo y frase. Con frases distintas,
   * dos intentos sondeando VINes separaban «ese vehículo ya tiene SOAT» de «ese vehículo existe en
   * FLITO sin SOAT», que son dos hechos sobre la cartera de otra empresa.
   *
   * **El precio, escrito para que se vea:** cuando el choque es con una fila de la MISMA compañía
   * —dos pestañas del mismo cliente radicando a la vez—, la frase «no figura a nombre de su
   * compañía» es falsa para esa persona. Se acepta porque el servidor NO SABE de quién es la fila
   * ganadora sin una consulta más, y esa consulta convertiría una carrera perdida en un oráculo
   * («¿es mía?» es exactamente la pregunta que el recorte tapa). El caso es raro —hay que perder una
   * carrera de milisegundos— y el desenlace no miente en lo que importa: no se puede radicar.
   *
   * Este test existe para que quien vaya a «arreglar el copy» sepa que era una decisión y no un
   * descuido. Si algún día se cambia, se cambia junto con `MENSAJE_VEHICULO_AJENO` y las dos ramas
   * de `verificarRn01`, o el oráculo vuelve.
   */
  it('**la carrera perdida dice EXACTAMENTE lo mismo que el vehículo ajeno** (decisión de seguridad, no descuido)', async () => {
    const app = await buildApp();

    escenario();
    kdb.when.insert('flito_soat', () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
    const carrera = await alta(app, await auth('cliente', siguienteUsuario()));

    // El otro camino: el VIN ya tiene SOAT y es de otra compañía.
    escenario({ flito_soat: [{ id: 'cccc', estado: 'pagado', companiaId: 999 }] });
    const ajeno = await alta(app, await auth('cliente', siguienteUsuario()));

    // Indistinguibles: mismo estado, mismo código, mismo cuerpo, misma frase.
    expect(carrera.status).toBe(ajeno.status);
    expect(carrera.body).toEqual(ajeno.body);
    expect(carrera.body.error).toBe(ajeno.body.error);
    // Y ninguno de los dos deja escapar el id ni el estado de la fila ganadora.
    expect(carrera.body).toMatchObject({ propia: false });
    expect(carrera.body.id).toBeUndefined();
    expect(carrera.body.estado).toBeUndefined();
    // La frase NO distingue «tiene SOAT» de «existe sin SOAT», que es el oráculo que se cerró.
    expect(carrera.body.error).not.toMatch(/tiene un SOAT|no puede tener dos/i);
  });
});

// ───────────────────────────── AC5 — las guardas del canal ───────────────────

describe('AC5 — flag, MIME real, PII fuera de la URL, rate limit y auditoría', () => {
  it('**flag «SOAT sin trámite» APAGADO → 403 `canal_desactivado` y nada creado**', async () => {
    escenario({ clients: [{ id: COMPANIA, sinTramite: false, carpeta: 'clientes/acme' }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('canal_desactivado');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    // Ni siquiera se consultó el RUNT: la guarda más barata va primera.
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('un `cliente` SIN compañía no radica (la tercera capa del AC2 de la #11913)', async () => {
    escenario({ users: [{ c: null, s: null }] });

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('sin_compania');
  });

  it('**un ejecutable renombrado a .pdf → 400 `archivo_no_pdf` (MIME REAL, no la extensión)**', async () => {
    escenario();

    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()), {
      archivo: EXE_DISFRAZADO, nombre: 'factura.pdf', mime: 'application/pdf',
    });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('archivo_no_pdf');
    expect(espia.insertsEn('flito_soportes')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('sin adjunto → 400: la factura de venta no es opcional', async () => {
    escenario();
    const req = request(await buildApp()).post('/api/flito/soat/cliente')
      .set('Authorization', await auth('cliente', siguienteUsuario()));
    for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
    expect((await req).status).toBe(400);
  });

  it('un tipo de documento fuera del catálogo RUNT → 400', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()), { campos: { tipoDocumento: 'XX' } });
    expect(r.status).toBe(400);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('la auditoría del alta NO escribe placa, VIN ni documento del propietario', async () => {
    escenario();
    await alta(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0][1];
    expect(entrada).toMatchObject({ action: 'create', resource: 'flito_soat' });
    for (const pii of ['JNH38H', '9FKRG2222T2042405', '1020304050']) {
      expect(entrada.detail).not.toContain(pii);
    }
  });

  it('el limitador frena al usuario que insiste, y solo a ese usuario', async () => {
    escenario();
    // El canal está apagado para que cada intento sea barato: lo que se mide es el freno, no el alta.
    kdb.when.select('clients', [{ id: COMPANIA, sinTramite: false, carpeta: null }]);
    const app = await buildApp();
    const insistente = await auth('cliente', siguienteUsuario());

    let ultimo = 0;
    for (let i = 0; i < 21; i++) ultimo = (await alta(app, insistente)).status;
    expect(ultimo).toBe(429);

    // Otro usuario de la misma compañía —misma IP en el test— sigue pasando: la llave es el `sub`.
    const otro = await alta(app, await auth('cliente', siguienteUsuario()));
    expect(otro.status).toBe(403);
  });
});

// ───────────────────────────── Quién puede entrar ────────────────────────────

describe('el canal es del rol `cliente`, y su ruta está inscrita en la allowlist', () => {
  it('sin token → 401', async () => {
    expect((await alta(await buildApp(), 'Bearer no-es-un-token')).status).toBe(401);
  });

  it('admin → 403: radicar es un acto de la compañía, y un admin no tiene compañía', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(403);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('proveedor (el gestor) → 403', async () => {
    escenario();
    expect((await alta(await buildApp(), await auth('proveedor', siguienteUsuario()))).status).toBe(403);
  });

  it('**el `cliente` LLEGA a la ruta: si no estuviera en `RUTAS_PERMITIDAS_CLIENTE`, el guarda de negación por defecto la cortaría antes**', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    // 201 y no 403: el guarda de `authMiddleware` corre de verdad en este test.
    expect(r.status).toBe(201);

    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/cliente')).toBe(true);
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/cliente/preconsulta')).toBe(true);
    // Y no abre de paso las mutaciones del router hermano.
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/enviar')).toBe(false);
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/aaaa/factura')).toBe(false);
  });
});

// ───────────────────────────── Preconsulta ───────────────────────────────────

describe('POST /cliente/preconsulta — paso 1, sin escribir nada', () => {
  const CUERPO_PRECONSULTA: Record<string, string> = {
    placa: 'JNH38H', vin: '9FKRG2222T2042405',
    tipoDocumento: 'CC', numeroDocumento: '1020304050',
  };
  const preconsultar = async (app: express.Express, token: string, cuerpo: Record<string, string> = CUERPO_PRECONSULTA) =>
    request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);

  it('sin tipoDocumento o numeroDocumento → 400, no 503 (la pasarela no se llama)', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()), {
      placa: 'JNH38H', vin: '9FKRG2222T2042405',
    });
    expect(r.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('consulta el RUNT con placa, VIN, número de documento y tipo de pasarela (PPT→Y)', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()), {
      placa: 'JNH38H', vin: '9FKRG2222T2042405',
      tipoDocumento: 'PPT', numeroDocumento: '1020304050',
    });
    expect(r.status).toBe(200);
    // Cuatro argumentos: un mutante que vuelva a `consultarVehiculoRunt(placa, vin)` muere aquí.
    // El 4.º es el código de pasarela, no el de la UI (`PPT` no es `Y`).
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(
      'JNH38H', '9FKRG2222T2042405', '1020304050', 'Y',
    );
  });

  it('devuelve el vehículo del RUNT, el organismo resuelto y el propietario si lo hay', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      vehiculo: { placa: 'JNH38H', vin: '9FKRG2222T2042405', marca: 'MAZDA', linea: 'CX-30', clase: 'CAMIONETA' },
      organismo: { codigo: ORGANISMO_FUNZA, nombre: 'FUNZA' },
      propietario: { nombreCompleto: 'JUANA PEREZ' },
    });
    // Es una LECTURA: ni una escritura, ni una subida.
    expect(espia.inserts).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('el payload CRUDO del RUNT no sale en la respuesta (ADR-0008 §1.6)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({
      ...runtOk(),
      data: { ...runtOk().data, licencias: [{ numero: 'L-1', documento: '1020304050' }] },
    });

    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(JSON.stringify(r.body)).not.toContain('licencias');
    expect(JSON.stringify(r.body)).not.toContain('1020304050');
  });

  it('aplica las MISMAS guardas que el alta: RN-01 y SOAT vigente bloquean también aquí', async () => {
    escenario({ flito_soat: [{ id: 'aaaa', estado: 'pendiente', companiaId: COMPANIA }] });
    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    // Y el mismo recorte que en el alta: la preconsulta es la puerta más fácil de sondear.
    expect(r.body.propia).toBe(true);
  });

  it('la preconsulta tampoco revela nada de un SOAT de otra compañía', async () => {
    escenario({ flito_soat: [{ id: 'dddd', estado: 'pagado', companiaId: 999 }] });
    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ propia: false });
    expect(r.body.id).toBeUndefined();
    expect(r.body.estado).toBeUndefined();
  });

  it('deja rastro de acceso a PII, y el motivo NO lleva la placa', async () => {
    escenario();
    await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const registro = piiMock.mock.calls[0][1];
    expect(registro.accion).toBe('read');
    expect(registro.camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin', 'nombre_completo']));
    expect(registro.motivo).not.toContain('JNH38H');
  });

  it('cuando el RUNT no trae propietario, el registro no dice que se accedió a su nombre', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ nombrePropietario: null }));

    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.body.propietario).toBeNull();
    expect(piiMock.mock.calls[0][1].camposAccedidos).not.toContain('nombre_completo');
  });

  it('placa o VIN ausentes → 400 (y la PII sigue viajando en el cuerpo, nunca en la query)', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()), { placa: 'JNH38H' } as Record<string, string>);
    expect(r.status).toBe(400);
  });

  it('organismo no catalogado → 422 con `organismoNombre` como CAMPO (contrato de preconsulta intacto)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ organismoTransito: 'STRIA TTO DE MARTE' }));

    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('organismo_no_catalogado');
    expect(r.body.organismoNombre).toBe('STRIA TTO DE MARTE');
  });

  it('preconsulta sin organismo en el RUNT → la clave viaja con `null`', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ organismoTransito: null }));

    const r = await preconsultar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(Object.keys(r.body)).toContain('organismoNombre');
    expect(r.body.organismoNombre).toBeNull();
  });
});

// ───────────────────────────── El catálogo de documentos ─────────────────────

describe('catálogo RUNT de tipos de documento: lo que el producto ofrece y lo que la pasarela entiende', () => {
  it('**los ocho tipos que acepta el alta tienen traducción a código RUNT**', async () => {
    const { TIPOS_DOCUMENTO_RUNT } = await import('@operaciones/shared-types');
    const { mapTipoDocUiToRunt } = await import('../../src/modules/runt/runt-tipo-doc.js');

    // El AC1 nombra los ocho. Si alguien añade uno a shared-types sin mapearlo en `runt-tipo-doc.ts`,
    // el formulario lo ofrece y la consulta al RUNT sale con el tipo en BLANCO — un fallo que no
    // tumba nada y devuelve resultados peores.
    expect([...TIPOS_DOCUMENTO_RUNT]).toEqual(['CC', 'CE', 'TI', 'PAS', 'PPT', 'NIT', 'RC', 'PT']);
    for (const tipo of TIPOS_DOCUMENTO_RUNT) {
      expect(mapTipoDocUiToRunt(tipo), `${tipo} no tiene código RUNT`).not.toBeNull();
    }
  });
});
