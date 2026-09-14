import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

// HU #12373: la sonda de capacidades NO debe registrar intentos denegados (no es un intento).
const intentoDenegadoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: intentoDenegadoMock,
  ventanaActual: () => new Date(),
  VENTANA_DEDUP_MS: 3_600_000,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
  intentoDenegadoMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}

const auth = async (role: 'admin' | 'auditor' | 'gestor_impuestos' | 'proveedor' | 'financiera') =>
  `Bearer ${await testToken({ sub: 1, username: 'u', role })}`;

// ───────────────────────────── RBAC (D-2: gestores no entran) ────────────────

describe('parametrización — RBAC', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/flito/parametrizacion/companias')).status).toBe(401);
  });

  it('gestor_impuestos → lectura 403 (no entra a parametrización)', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(403);
  });

  it('proveedor (gestor SOAT) → lectura 403', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/proveedores-soat').set('Authorization', await auth('proveedor'));
    expect(r.status).toBe(403);
  });

  it('auditor → lectura 200 (solo lectura)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
  });

  it('auditor → escritura 403 (mutaciones solo operaciones)', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('auditor')).send({ soatAutogestionable: true });
    expect(r.status).toBe(403);
  });

  it('operaciones → lectura 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, name: 'Acme', document: '900', soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false, flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0' }]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].nit).toBe('900');
  });
});

// ───────────────────────────── Validaciones caras ────────────────────────────

describe('parametrización — validaciones', () => {
  it('cambiar modalidad con motivo < 5 → 400 (motivo obligatorio y explicativo)', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/organismos/11001/modalidad')
      .set('Authorization', await auth('admin')).send({ modalidad: 'requiere_gestion', motivo: 'x' });
    expect(r.status).toBe(400);
  });

  // Las validaciones de las reglas de enrutamiento se retiran con sus endpoints (HU #10979):
  // el proveedor se elige al enviar el SOAT al gestor, así que ya no hay ámbitos que validar ni
  // una regla global única que proteger.

  it('cambiar a la modalidad ya vigente → 400', async () => {
    // 1) organismo existe, 2) modalidadVigente → requiere_gestion
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '11001', alias: 'Bogotá', activo: true }]))
      .mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/organismos/11001/modalidad')
      .set('Authorization', await auth('admin')).send({ modalidad: 'requiere_gestion', motivo: 'ya está clasificado así' });
    expect(r.status).toBe(400);
  });
});

// ───────── HU #11913 (Feature #11912): «SOAT sin trámite» es un flag INDEPENDIENTE ─────────
//
// El AC3 no pide que el flag exista: pide que **no se contagie**. Un `set` mal encadenado —el
// clásico `if (soatAutogestionable !== undefined) { …; set.soatSinTramite = false; }`— dejaría los
// dos flags atados sin que ningún test que solo compruebe «persiste» lo notara. De ahí que estas
// pruebas miren el objeto que llega al UPDATE y no la respuesta.

/** El gestor por defecto del canal sin trámite (HU #12078): una compañía con el canal abierto lo
 *  tiene siempre, porque el CHECK `clients_sin_tramite_gestor_chk` no admite lo contrario. */
const GESTOR = '55555555-5555-4555-8555-555555555555';

/** Fila de `clients` tal como sale del `returning()` del PATCH. */
const compania = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'Acme', document: '900', soatAutogestionable: false, soatSinTramite: false,
  impuestosAutogestionable: false, logisticaAutogestionable: false, logisticaPermiteParcial: false,
  flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0',
  flitoProveedorSoatSinTramiteId: null, ...over,
});

/**
 * Captura el objeto del `.set(...)` del UPDATE y devuelve la fila que se le pida.
 *
 * **Desde la HU #12078 hay que registrar además la fila PREVIA**: el handler la lee antes de
 * construir el `set` —sin el estado previo no puede validar el estado RESULTANTE cuando el PATCH
 * trae solo una de las dos claves— y el 404 se adelantó a esa lectura.
 */
function capturarUpdate(devuelve: Record<string, unknown>, previo: Record<string, unknown> = {}) {
  const capturado: { set?: Record<string, unknown> } = {};
  selectMock.mockReturnValueOnce(chain([{
    id: 1, soatSinTramite: false, proveedorSinTramiteId: null, ...previo,
  }]));
  updateMock.mockReturnValueOnce({
    set: (v: Record<string, unknown>) => {
      capturado.set = v;
      return { where: () => ({ returning: () => Promise.resolve([devuelve]) }) };
    },
  });
  return capturado;
}

describe('compañías — flag «SOAT sin trámite» (AC3 de la HU #11913)', () => {
  it('GET /companias lo devuelve, y separado de la autogestión', async () => {
    selectMock.mockReturnValueOnce(chain([compania({ soatAutogestionable: true, soatSinTramite: false })]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    // Una compañía puede autogestionar SU SOAT y NO tener abierto el canal sin trámite: son dos
    // preguntas, y el DTO tiene que poder decir cosas distintas de cada una.
    expect(r.body[0].soatAutogestionable).toBe(true);
    expect(r.body[0].soatSinTramite).toBe(false);
  });

  it('PATCH del flag → persiste y NO toca la autogestión', async () => {
    // La compañía YA tiene gestor configurado: desde la HU #12078 encenderlo sin destino es 400
    // (AC2c), y ese caso tiene su propia suite. Aquí lo que se prueba sigue siendo el no-contagio.
    const cap = capturarUpdate(
      compania({ soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR }),
      { proveedorSinTramiteId: GESTOR },
    );
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin')).send({ soatSinTramite: true });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatSinTramite: true });
    expect(cap.set).not.toHaveProperty('soatAutogestionable');
    // Y el gestor NO se toca al encender el flag: el PATCH escribe lo que le mandan y nada más.
    expect(cap.set).not.toHaveProperty('flitoProveedorSoatSinTramiteId');
    expect(r.body.soatSinTramite).toBe(true);
  });

  it('PATCH de la autogestión → NO arrastra el flag nuevo (el contagio que el AC3 prohíbe)', async () => {
    const cap = capturarUpdate(
      compania({ soatAutogestionable: true, soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR }),
      { soatSinTramite: true, proveedorSinTramiteId: GESTOR },
    );
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin')).send({ soatAutogestionable: true });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatAutogestionable: true });
    expect(cap.set).not.toHaveProperty('soatSinTramite');
    // Y la compañía que ya tenía el canal abierto lo conserva tras encender la autogestión.
    expect(r.body.soatSinTramite).toBe(true);
  });

  it('los dos a la vez → los dos se escriben, que es una combinación válida', async () => {
    const cap = capturarUpdate(
      compania({ soatAutogestionable: true, soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR }),
      { proveedorSinTramiteId: GESTOR },
    );
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin'))
      .send({ soatAutogestionable: true, soatSinTramite: true });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatAutogestionable: true, soatSinTramite: true });
  });

  it('apagar el flag → false llega al UPDATE (y no se pierde por ser «falsy»)', async () => {
    const cap = capturarUpdate(
      compania({ soatSinTramite: false, flitoProveedorSoatSinTramiteId: GESTOR }),
      { soatSinTramite: true, proveedorSinTramiteId: GESTOR },
    );
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin')).send({ soatSinTramite: false });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatSinTramite: false });
  });

  it('el flag es de ESCRITURA de Operaciones: auditor → 403', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('auditor')).send({ soatSinTramite: true });
    expect(r.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ───────── HU #12373 (Feature #12365): tarifas como VIGENCIAS — contrato HTTP ─────────
//
// Lo que se prueba aquí es el CONTRATO: códigos, forma de la respuesta y, sobre todo, que las
// `capacidades` de la vista salen del MOTOR de permisos (AC12) y que el acceso se decide por REPARTO
// (AC16): se le quita la función a un rol y cae el 200, sin mirar el nombre del rol. El servicio va
// mockeado a nivel de `db`; la lógica de vigencias se prueba en flito-tarifas.test.ts.

const BASE = '/api/flito/parametrizacion';
const AHORA_ISO = '2026-09-10T15:00:00.000Z';
const compania7 = { id: 7, name: 'ACME', logisticaAutogestionable: false };
const abierta = (over: Record<string, unknown> = {}) => ({
  id: 'v-1', concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: '270000.00',
  vigenteDesde: new Date(AHORA_ISO), fijadoPorId: 2, fijadoPorNombre: 'Ana P.', ...over,
});
const filaTarifa = (over: Record<string, unknown> = {}) => ({
  id: 'v-2', companiaId: 7, companiaNombre: 'ACME', concepto: 'tramite_digital', tipoTramite: 'TRASPASO',
  valor: '320000.00', vigenteDesde: new Date(AHORA_ISO), vigenteHasta: null, fijadoEn: new Date(AHORA_ISO), ...over,
});

/** Un usuario cuyo ROL tiene exactamente estas funciones de tarifas (y nada más): la prueba por reparto. */
async function tokenConFunciones(sub: number, role: 'financiera' | 'auditor' | 'admin', funciones: string[]) {
  const token = `Bearer ${await testToken({ sub, role })}`;
  await registrarUsuarioDePrueba(sub, { rol: role, tipoPrincipal: 'interno', funcionesDelRol: funciones, excepciones: [] });
  return token;
}

describe('tarifas — vista por cliente y capacidades por motor (AC12, AC16)', () => {
  it('financiera (reparto de partida) → 200 con las 4 filas fijas, null donde no hay vigencia y capacidades true', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania7]))
      .mockReturnValueOnce(chain([abierta(), abierta({ id: 'v-lg', concepto: 'logistica', tipoTramite: null, valor: '45000.00' })]));
    const app = await buildApp();
    const r = await request(app).get(`${BASE}/tarifas/companias/7`).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(200);
    expect(r.body.companiaId).toBe(7);
    expect(r.body.tarifas.map((t: { concepto: string; tipoTramite: string | null }) => `${t.concepto}:${t.tipoTramite}`)).toEqual([
      'tramite_digital:MATRICULA', 'tramite_digital:TRASPASO', 'tramite_digital:OTROS', 'logistica:null',
    ]);
    expect(r.body.tarifas[0]).toEqual({
      concepto: 'tramite_digital', tipoTramite: 'MATRICULA', vigenciaId: 'v-1', valor: 270000,
      vigenteDesde: AHORA_ISO, fijadoPor: { id: 2, nombre: 'Ana P.' },
    });
    expect(r.body.tarifas[1]).toMatchObject({ tipoTramite: 'TRASPASO', vigenciaId: null, valor: null, vigenteDesde: null, fijadoPor: null });
    expect(r.body.tarifas[2].valor).toBeNull();
    expect(r.body.tarifas[3]).toMatchObject({ concepto: 'logistica', valor: 45000, flitoGestionaLogistica: true });
    // Ningún «no configurado» viene como 0.
    expect(r.body.tarifas.filter((t: { valor: number | null }) => t.valor === 0)).toHaveLength(0);
    expect(r.body.capacidades).toEqual({ editar: true, verHistorial: true });
    expect(intentoDenegadoMock).not.toHaveBeenCalled();
  });

  it('las capacidades salen del motor, no del nombre del rol: financiera con SOLO ver_por_cliente → false/false (mutante M3)', async () => {
    selectMock.mockReturnValueOnce(chain([compania7])).mockReturnValueOnce(chain([]));
    const token = await tokenConFunciones(71, 'financiera', ['parametrizacion.tarifas.ver_por_cliente']);
    const app = await buildApp();
    const r = await request(app).get(`${BASE}/tarifas/companias/7`).set('Authorization', token);
    expect(r.status).toBe(200);
    expect(r.body.capacidades).toEqual({ editar: false, verHistorial: false });
    // Una sonda de capacidad no es un intento: nada en la bitácora de denegados.
    expect(intentoDenegadoMock).not.toHaveBeenCalled();
  });

  it('`editar` exige las DOS funciones de escritura (la vista fija por POST y cambia por PATCH)', async () => {
    selectMock.mockReturnValueOnce(chain([compania7])).mockReturnValueOnce(chain([]));
    const token = await tokenConFunciones(72, 'admin', ['parametrizacion.tarifas.ver_por_cliente', 'parametrizacion.tarifas.editar', 'parametrizacion.tarifas.historial']);
    const app = await buildApp();
    const r = await request(app).get(`${BASE}/tarifas/companias/7`).set('Authorization', token);
    expect(r.body.capacidades).toEqual({ editar: false, verHistorial: true });
  });

  it('por REPARTO: quitarle la función al rol hace caer el 200 a 403 con el motivo del motor', async () => {
    const token = await tokenConFunciones(73, 'financiera', ['parametrizacion.tarifas.listar']);
    const app = await buildApp();
    const r = await request(app).get(`${BASE}/tarifas/companias/7`).set('Authorization', token);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'parametrizacion.tarifas.ver_por_cliente', motivo: 'sin_funcion' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('auditor (reparto tras la 0182) → 403 también en la LECTURA del cuadro de tarifas', async () => {
    const app = await buildApp();
    const lista = await request(app).get(`${BASE}/tarifas`).set('Authorization', await auth('auditor'));
    expect(lista.status).toBe(403);
    const vista = await request(app).get(`${BASE}/tarifas/companias/7`).set('Authorization', await auth('auditor'));
    expect(vista.status).toBe(403);
    expect(vista.body.motivo).toBeDefined();
  });

  it('compañía inexistente → 404; id no numérico → 400', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    expect((await request(app).get(`${BASE}/tarifas/companias/999`).set('Authorization', await auth('admin'))).status).toBe(404);
    expect((await request(app).get(`${BASE}/tarifas/companias/abc`).set('Authorization', await auth('admin'))).status).toBe(400);
  });
});

describe('tarifas — cuadro compat de la ventana de Clientes (AC17)', () => {
  it('GET /tarifas?companiaId con rol autorizado → 200 con las vigencias ABIERTAS en la forma que la modal entiende', async () => {
    selectMock.mockReturnValueOnce(chain([
      filaTarifa({ id: 'v-1', tipoTramite: 'MATRICULA', valor: '270000.00' }),
      filaTarifa({ id: 'v-lg', concepto: 'logistica', tipoTramite: null, valor: '45000.00' }),
    ]));
    const app = await buildApp();
    const r = await request(app).get(`${BASE}/tarifas?companiaId=7`).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    // Lo que `ModalTarifas`/`FormTarifa` leen: id (de la vigencia, para el PATCH), tipoTramite, valor, activo.
    expect(r.body[0]).toMatchObject({ id: 'v-1', companiaId: 7, companiaNombre: 'ACME', concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: 270000, activo: true });
    expect(r.body[1]).toMatchObject({ id: 'v-lg', concepto: 'logistica', tipoTramite: null, valor: 45000, activo: true });
    for (const t of r.body) {
      expect(typeof t.actualizadoEn).toBe('string');
      expect(t.vigenteDesde).toBe(AHORA_ISO);
    }
    expect(intentoDenegadoMock).not.toHaveBeenCalled();
  });
});

describe('tarifas — historial (AC13, AC14, AC15)', () => {
  it('admin → 200 con las vigencias; un rango con día inválido → 400 nombrando el campo', async () => {
    selectMock.mockReturnValueOnce(chain([compania7])).mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const ok = await request(app).get(`${BASE}/tarifas/companias/7/historial?concepto=tramite_digital&tipoTramite=traspaso&desde=2026-08-01&hasta=2026-08-31`)
      .set('Authorization', await auth('admin'));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([]);
    const mal = await request(app).get(`${BASE}/tarifas/companias/7/historial?desde=2026-13-01`).set('Authorization', await auth('admin'));
    expect(mal.status).toBe(400);
    expect(mal.body.error).toMatch(/desde/);
    const tipo = await request(app).get(`${BASE}/tarifas/companias/7/historial?concepto=tramite_digital&tipoTramite=Cancelacion`).set('Authorization', await auth('admin'));
    expect(tipo.status).toBe(400);
    expect(tipo.body.error).toMatch(/Matricula, Traspaso u Otros/);
  });

  it('el historial no se edita ni se borra: no existe ruta (404) y nada se escribe', async () => {
    const app = await buildApp();
    const token = await auth('admin');
    for (const [metodo, ruta] of [
      ['delete', `${BASE}/tarifas/v-1`], ['delete', `${BASE}/tarifas/companias/7/historial/v-1`],
      ['patch', `${BASE}/tarifas/companias/7/historial/v-1`], ['put', `${BASE}/tarifas/companias/7/historial/v-1`],
    ] as const) {
      const r = await request(app)[metodo](ruta).set('Authorization', token).send({ valor: 1 });
      expect(r.status, `${metodo.toUpperCase()} ${ruta}`).toBe(404);
    }
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('tarifas — fijar (POST) y cambiar/cerrar (PATCH) (AC4, AC5, AC8, AC9, AC10, AC11)', () => {
  it('financiera fija Traspaso en 320000 → 201 con la vigencia y auditoría create', async () => {
    selectMock.mockReturnValueOnce(chain([compania7])).mockReturnValueOnce(chain([filaTarifa()]));
    insertMock.mockReturnValueOnce(chain([{ id: 'v-2' }]));
    const app = await buildApp();
    const r = await request(app).post(`${BASE}/tarifas`).set('Authorization', await auth('financiera'))
      .send({ companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'Traspaso', valor: 320000 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'v-2', tipoTramite: 'TRASPASO', valor: 320000, activo: true, vigenteDesde: AHORA_ISO });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'create', resourceId: 'v-2', detail: expect.stringContaining('320000') }));
  });

  it('valores inválidos → 400 que nombra `valor` y la regla; nada se inserta (AC9)', async () => {
    const app = await buildApp();
    const token = await auth('financiera');
    const base = { companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'Matricula' };
    for (const [cuerpo, regla] of [
      [{ ...base, valor: -1 }, /mayor o igual a cero/],
      [{ ...base, valor: 'texto' }, /debe ser un número/],
      [{ ...base, valor: 1.005 }, /dos decimales/],
      [{ ...base }, /obligatorio/],
    ] as const) {
      const r = await request(app).post(`${BASE}/tarifas`).set('Authorization', token).send(cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.body.error).toMatch(/valor/);
      expect(r.body.error).toMatch(regla);
    }
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('cero exige confirmación explícita (AC10)', async () => {
    const app = await buildApp();
    const sin = await request(app).post(`${BASE}/tarifas`).set('Authorization', await auth('admin'))
      .send({ companiaId: 7, concepto: 'logistica', valor: 0 });
    expect(sin.status).toBe(400);
    expect(sin.body).toMatchObject({ requiereConfirmacion: 'cero' });
    expect(insertMock).not.toHaveBeenCalled();

    selectMock.mockReturnValueOnce(chain([compania7])).mockReturnValueOnce(chain([filaTarifa({ concepto: 'logistica', tipoTramite: null, valor: '0.00' })]));
    insertMock.mockReturnValueOnce(chain([{ id: 'v-2' }]));
    const con = await request(app).post(`${BASE}/tarifas`).set('Authorization', await auth('admin'))
      .send({ companiaId: 7, concepto: 'logistica', valor: 0, confirmarCero: true });
    expect(con.status).toBe(201);
    expect(con.body.valor).toBe(0);
  });

  it('tipo fuera del catálogo o vacío → 400; «matrícula» se acepta y se guarda como MATRICULA (AC11)', async () => {
    const app = await buildApp();
    const token = await auth('admin');
    for (const tipoTramite of ['Cancelacion', '']) {
      const r = await request(app).post(`${BASE}/tarifas`).set('Authorization', token)
        .send({ companiaId: 7, concepto: 'tramite_digital', tipoTramite, valor: 1000 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Matricula, Traspaso u Otros/);
    }
    selectMock.mockReturnValueOnce(chain([compania7])).mockReturnValueOnce(chain([filaTarifa({ tipoTramite: 'MATRICULA' })]));
    let grabado: unknown;
    insertMock.mockReturnValueOnce({ values: (v: unknown) => { grabado = v; return chain([{ id: 'v-2' }]); } });
    const ok = await request(app).post(`${BASE}/tarifas`).set('Authorization', token)
      .send({ companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'matrícula', valor: 1000 });
    expect(ok.status).toBe(201);
    expect(grabado).toMatchObject({ tipoTramite: 'MATRICULA' });
  });

  it('PATCH cambia el valor → 200 con valorAnterior/valorNuevo y auditoría update (AC5)', async () => {
    const tx = {
      select: vi.fn().mockReturnValueOnce(chain([{ id: 'v-1', companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: '270000.00', vigenteHasta: null }])),
      update: vi.fn().mockReturnValueOnce(chain([])),
      insert: vi.fn().mockReturnValueOnce(chain([{ id: 'v-2' }])),
    };
    transactionMock.mockImplementationOnce(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
    selectMock.mockReturnValueOnce(chain([filaTarifa({ tipoTramite: 'MATRICULA', valor: '300000.00' })]));
    const app = await buildApp();
    const r = await request(app).patch(`${BASE}/tarifas/v-1`).set('Authorization', await auth('admin')).send({ valor: 300000, activo: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'v-2', valor: 300000, valorAnterior: 270000, valorNuevo: 300000, activo: true });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update', detail: expect.stringMatching(/de 270000 a 300000/) }));
  });

  it('PATCH sobre una vigencia ya cerrada → 409 con la abierta de su llave', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(chain([{ id: 'v-1', companiaId: 7, concepto: 'logistica', tipoTramite: null, valor: '45000.00', vigenteHasta: new Date(AHORA_ISO) }]))
        .mockReturnValueOnce(chain([{ id: 'v-viva' }])),
      update: vi.fn(), insert: vi.fn(),
    };
    transactionMock.mockImplementationOnce(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
    const app = await buildApp();
    const r = await request(app).patch(`${BASE}/tarifas/v-1`).set('Authorization', await auth('financiera')).send({ valor: 50000 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: expect.stringMatching(/cerrada/), vigenciaId: 'v-viva' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('PATCH inexistente → 404; cuerpo vacío → 400; DELETE → 404 (la operación no existe, AC8)', async () => {
    transactionMock.mockImplementationOnce(async (cb: (t: unknown) => Promise<unknown>) => cb({ select: vi.fn().mockReturnValueOnce(chain([])), update: vi.fn(), insert: vi.fn() }));
    const app = await buildApp();
    const token = await auth('admin');
    expect((await request(app).patch(`${BASE}/tarifas/nada`).set('Authorization', token).send({ valor: 1 })).status).toBe(404);
    expect((await request(app).patch(`${BASE}/tarifas/v-1`).set('Authorization', token).send({})).status).toBe(400);
    expect((await request(app).delete(`${BASE}/tarifas/v-1`).set('Authorization', token)).status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('escritura por reparto: financiera sin `crear` → 403 en POST; auditor → 403 en PATCH', async () => {
    const app = await buildApp();
    const sinCrear = await tokenConFunciones(74, 'financiera', ['parametrizacion.tarifas.listar', 'parametrizacion.tarifas.editar']);
    const post = await request(app).post(`${BASE}/tarifas`).set('Authorization', sinCrear)
      .send({ companiaId: 7, concepto: 'logistica', valor: 1000 });
    expect(post.status).toBe(403);
    expect(post.body.funcion).toBe('parametrizacion.tarifas.crear');
    const patch = await request(app).patch(`${BASE}/tarifas/v-1`).set('Authorization', await auth('auditor')).send({ valor: 1 });
    expect(patch.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
