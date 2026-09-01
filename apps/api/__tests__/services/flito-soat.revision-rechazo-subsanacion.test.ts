// HU #11915 (Feature #11912) — revisión del admin, rechazo con causal y subsanación del Cliente.
// Un AC por bloque, y cada aserción escrita para morir si se quita el código que la sostiene.
//
// ── Cómo está montada, y por qué así ─────────────────────────────────────────────────────────────
//
// **Se mide la ESCRITURA, no la respuesta.** El mock de drizzle devuelve lo que el test le registre,
// así que afirmar sobre el cuerpo de la respuesta prueba el mock. Lo que se afirma aquí es el
// payload real que el servicio le pasó a `update().set()` / `insert().values()` (`espia-drizzle`):
// el estado destino, la causal, la observación y el contador de reenvíos salen de ahí. Cambiar
// `solicitado` por otra cosa en el servicio pone rojo este archivo; cambiar el mock, no.
//
// **Y donde importa la CONDICIÓN, se mide el SQL renderizado.** El doble de drizzle ignora el
// `where`: devuelve las filas que el test registró para esa tabla venga el filtro que venga. Por eso
// «solo se valida desde `pendiente_revision`», «la causal tiene que estar activa» y «la subsanación
// edita la fila de ESTE id» no se afirman mirando lo que responde el mock —pasarían con el filtro
// borrado— sino serializando la condición con el dialecto real (`PgDialect.sqlToQuery`), que es el
// SQL que Postgres recibiría, con sus parámetros.
//
// **Los dos routers suben montados como en `app.ts`** —el del canal primero, el del módulo después—
// y por `authMiddleware` real, así que el guarda de negación por defecto
// (`RUTAS_PERMITIDAS_CLIENTE`) está vivo en cada petición. Si alguien borra la entrada que esta HU
// inscribió, el bloque del AC3 entero se pone en 403.
//
// **Cada test usa un `sub` distinto** para el `cliente`: el limitador del canal es por usuario y su
// ventana es de 15 minutos, así que un `sub` compartido haría fallar con 429 los últimos tests del
// archivo sin que nadie entendiera por qué.
//
// ── Los cuatro mutantes que este archivo tiene que matar ─────────────────────────────────────────
//
//   1. Validar escribiendo un estado distinto de `solicitado`  → AC1, «el UPDATE lleva `solicitado`».
//   2. Rechazar aceptando sin causal válida o sin observación  → AC2, los tres casos + «cero escrituras».
//   3. La subsanación creando fila nueva en vez de editar      → AC3, «cero INSERT en `flito_soat`».
//   4. Un `proveedor` o un `cliente` colándose en validar/rechazar → AC4.
//
// Y los dos que dejó abiertos la revisión de UX, porque son la misma regla por otra puerta:
//
//   5. `reversar()` sacando una solicitud de `pendiente_revision` a `pendiente` — que es despacharla
//      al gestor sin validarla, el AC1 saltado por la puerta de al lado.
//   6. `ESTADOS` de la ruta sin los dos estados nuevos: la pill se ignora EN SILENCIO y la cola
//      devuelve todo presentándolo como el resultado del filtro.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const uploadMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const piiMock = vi.fn().mockResolvedValue(undefined);
const consultarVehiculoRuntMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  firmarDescargaEntidad: vi.fn(() => '/api/files?t=x'),
}));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));

const COMPANIA = 7;
const OTRA_COMPANIA = 999;
const SOAT_ID = '11111111-1111-4111-8111-111111111111';
const CAUSAL_ID = '22222222-2222-4222-8222-222222222222';
const PROVEEDOR_ID = '33333333-3333-4333-8333-333333333333';
const CAUSAL_NOMBRE = 'Factura de venta ilegible';

/** PDF de verdad: `file-type` reconoce el `%PDF-` de los primeros bytes, no la extensión. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

const dialecto = new PgDialect();
/** El SQL que Postgres recibiría para cada `where` de SELECT, en orden. */
const sqlDeLosSelect = (): Array<{ sql: string; params: unknown[] }> =>
  espia.condicionesLeidas().map((c) => dialecto.sqlToQuery(c as never));
/** Ídem para el `where` de una mutación concreta. */
const sqlDe = (m: { condiciones: unknown[] }) => m.condiciones.map((c) => dialecto.sqlToQuery(c as never));

let sub = 500;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  // El mismo orden de `app.ts`: el router del canal primero, el del módulo después.
  const { default: canal } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  const { default: modulo } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', canal);
  app.use('/api/flito/soat', modulo);
  return app;
}

const auth = async (role: string, id: number) => `Bearer ${await testToken({ sub: id, username: `${role}@flit.co`, role: role as never })}`;

/** La fila que `buscarConAcceso()` devuelve: `{ soat, dentroDeFrontera }`, no la fila plana. */
function filaAcceso(over: Record<string, unknown> = {}) {
  return {
    soat: {
      id: SOAT_ID, vin: '9FKRG2222T2042405', estado: 'pendiente_revision', origen: 'cliente',
      companiaId: COMPANIA, vehiculoId: 55, organismoCodigo: '25286',
      proveedorSoatId: null, gestionOperaciones: false, motivoRechazo: null, pagadoEn: null,
      ...over,
    },
    dentroDeFrontera: true,
  };
}

/**
 * El escenario por defecto.
 *
 * `flito_soat` se registra en DOS tiempos y eso es deliberado: la PRIMERA lectura es la de
 * `buscarConAcceso()`, que proyecta `{ soat, dentroDeFrontera }`; la siguiente es la del `SELECT …
 * FOR UPDATE SKIP LOCKED` de `enviarAlGestor`, que proyecta `{ id }`. Con una sola forma registrada,
 * el bloqueo devolvería `undefined` como id y la validación fallaría por el mock y no por el código.
 */
function escenario(opciones: { soat?: Record<string, unknown>; causales?: unknown[]; companiaUsuario?: number | null; bloqueo?: unknown[]; cas?: unknown[] } = {}) {
  kdb.when.scenario({
    users: [{ c: opciones.companiaUsuario === undefined ? COMPANIA : opciones.companiaUsuario, s: null }],
    clients: [{ id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme' }],
    // Lo que devuelve el `SELECT … FOR UPDATE SKIP LOCKED`: vacío = otro admin ganó la carrera.
    flito_soat: opciones.bloqueo ?? [{ id: SOAT_ID }],
    flito_estado_historial: [],
    flito_soat_causales_rechazo: opciones.causales ?? [{ id: CAUSAL_ID, nombre: CAUSAL_NOMBRE, activo: true, orden: 1 }],
    flito_compradores: [],
    flito_soportes: [],
    flito_tramites: [],
    flito_soat_solicitud: [],
  });
  kdb.when.selectOnce('flito_soat', [filaAcceso(opciones.soat)]);
  // Lo que devuelve el `.returning()` del compare-and-swap de `moverEstado()`: UNA fila = la
  // transición se aplicó; vacío = otro la movió entre la lectura y la escritura, y es un 409.
  kdb.when.update('flito_soat', opciones.cas ?? [{ id: SOAT_ID }]);
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/nueva.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  consultarVehiculoRuntMock.mockReset();
});

const validar = async (app: express.Express, token: string, cuerpo: Record<string, unknown> = { proveedorSoatId: PROVEEDOR_ID }) =>
  request(app).post(`/api/flito/soat/${SOAT_ID}/validar`).set('Authorization', token).send(cuerpo);

const rechazar = async (app: express.Express, token: string, cuerpo: Record<string, unknown>) =>
  request(app).post(`/api/flito/soat/${SOAT_ID}/rechazar-solicitud`).set('Authorization', token).send(cuerpo);

/**
 * `PATCH /:id/solicitud` con los campos del formulario y, si se pide, un adjunto.
 *
 * **Desde la HU #11966 el cuerpo es el MISMO del alta**: el titular partido (`nombres`/`apellidos`
 * XOR `razonSocial`) y `municipio`/`departamento` obligatorios. `nombreCompleto` salió del contrato
 * —lo deriva el servicio—, y esa es la mitad de por qué la subsanación entró en el alcance de esa
 * HU: si siguiera escribiendo solo la cadena fundida, la fila corregida saldría en el Excel con el
 * nombre VIEJO —el archivo lee las columnas partidas— mientras la cola muestra el nuevo.
 */
const CAMPOS: Record<string, string> = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ CORREGIDA',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function subsanar(app: express.Express, token: string, opciones: { campos?: Record<string, string | null>; archivo?: Buffer } = {}) {
  const req = request(app).patch(`/api/flito/soat/${SOAT_ID}/solicitud`).set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS, ...opciones.campos })) {
    // `null` = el campo NO se manda, que es distinto de mandarlo vacío.
    if (v !== null) req.field(k, v);
  }
  if (opciones.archivo) req.attach('facturaVenta', opciones.archivo, { filename: 'factura.pdf', contentType: 'application/pdf' });
  return req;
}

// ───────────────── AC1 — validar manda a `solicitado`, reusando el envío ─────

describe('AC1 — el admin valida y la solicitud llega a `solicitado`', () => {
  it('**el UPDATE escribe `solicitado`, no otro estado**', async () => {
    escenario();
    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: SOAT_ID, estado: 'solicitado' });
    // El aserto que mata al mutante: lo que el servicio pidió ESCRIBIR.
    const [update] = espia.updatesEn('flito_soat');
    expect(update).toBeDefined();
    expect(update.datos.estado).toBe('solicitado');
    // Y no queda en un estado del canal por descuido.
    expect(update.datos.estado).not.toBe('pendiente_revision');
    expect(update.datos.estado).not.toBe('pendiente');
  });

  it('**reúsa `enviarAlGestor` de verdad: mismo `set` completo y misma fila de historial**', async () => {
    escenario();
    await validar(await buildApp(), await auth('admin', siguienteUsuario()));

    // Un `update` paralelo escrito a mano no tendría estas columnas: son las que `enviarAlGestor`
    // pone en el MISMO movimiento que el estado. Si alguien reimplementa la transición, se van.
    const [update] = espia.updatesEn('flito_soat');
    expect(update.datos).toMatchObject({
      estado: 'solicitado',
      proveedorSoatId: PROVEEDOR_ID,
      proveedorSobrescrito: true,
    });
    expect(update.datos.enviadoPorId).toBeDefined();
    expect(update.datos.enviadoEn).toBeInstanceOf(Date);

    // El historial, con el estado de partida REAL. Que diga `pendiente` sería la señal de que se
    // reusó la función pero con su valor fijo, y el rastro mentiría sobre de dónde venía la fila.
    const [historial] = espia.insertsEn('flito_estado_historial');
    const filas = historial.datos as unknown as Array<Record<string, unknown>>;
    expect(filas[0]).toMatchObject({
      concepto: 'soat', registroId: SOAT_ID,
      estadoAnterior: 'pendiente_revision', estadoNuevo: 'solicitado',
    });
  });

  it('**el bloqueo exige `pendiente_revision` como estado de partida — medido sobre el SQL**', async () => {
    escenario();
    await validar(await buildApp(), await auth('admin', siguienteUsuario()));

    // El mock no filtra: si el `estadoOrigen` volviera a estar fijo en `pendiente`, la respuesta
    // sería idéntica. Lo único que lo delata es la condición que se le pasó a Postgres.
    const bloqueo = sqlDeLosSelect().find((q) => q.sql.includes('for update') || q.params.includes('pendiente_revision'));
    expect(bloqueo, 'el SELECT del bloqueo tiene que filtrar por el estado de partida').toBeDefined();
    expect(bloqueo!.params).toContain('pendiente_revision');
    expect(bloqueo!.params).not.toContain('pendiente');
  });

  it('un SOAT de TRÁMITE en `pendiente` no usa esta acción: 409 y ni una escritura', async () => {
    escenario({ soat: { origen: 'tramite', estado: 'pendiente' } });
    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('no_es_del_canal');
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
    expect(espia.insertsEn('flito_estado_historial')).toHaveLength(0);
  });

  it('una solicitud que ya no está en `pendiente_revision` → 409, sin tocar nada', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('estado_no_permite');
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('sin destino —o con los dos— es 400: un `solicitado` sin gestor es un SOAT en la cola de nadie', async () => {
    escenario();
    const app = await buildApp();
    const sinDestino = await validar(app, await auth('admin', siguienteUsuario()), {});
    expect(sinDestino.status).toBe(400);

    escenario();
    const conLosDos = await validar(app, await auth('admin', siguienteUsuario()), {
      proveedorSoatId: PROVEEDOR_ID, gestionOperaciones: true,
    });
    expect(conLosDos.status).toBe(400);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('la carrera perdida (otro admin ganó el `SKIP LOCKED`) responde 409 y no un 200 mentiroso', async () => {
    // El bloqueo no devuelve la fila: alguien más la tenía tomada.
    escenario({ bloqueo: [] });

    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });
});

// ───────────────── AC2 — rechazo: causal del catálogo Y observación ──────────

describe('AC2 — el rechazo exige causal de la lista general y observación, las dos', () => {
  it('**con las dos: `rechazada`, y la causal y la observación van a la SATÉLITE**', async () => {
    escenario();
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada y no se ve el número del chasis.',
    });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: SOAT_ID, estado: 'rechazada' });

    const [soat] = espia.updatesEn('flito_soat');
    expect(soat.datos.estado).toBe('rechazada');

    const [satelite] = espia.updatesEn('flito_soat_solicitud');
    expect(satelite.datos).toMatchObject({
      causalRechazoId: CAUSAL_ID,
      observacionRechazo: 'La factura está cortada y no se ve el número del chasis.',
    });
    expect(satelite.datos.revisadoEn).toBeInstanceOf(Date);
    expect(satelite.datos.revisadoPorNombre).toBe('admin@flit.co');
  });

  it('**NO escribe `flito_soat.motivo_rechazo`: esa columna es el rechazo del GESTOR**', async () => {
    escenario();
    await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'Vuelva a escanear la factura completa.',
    });

    const [soat] = espia.updatesEn('flito_soat');
    // Mezclar los dos rechazos haría que el Cliente viera el párrafo crudo de «Motivo de rechazo»
    // en vez de su bloque con causal, y dejaría ilegible el historial de una fila que pase por los
    // dos. El único campo que esta transición toca de `flito_soat` es el estado.
    expect(Object.keys(soat.datos).sort()).toEqual(['estado', 'updatedAt']);
    expect(soat.datos).not.toHaveProperty('motivoRechazo');
  });

  it('**sin observación → el estado NO cambia y no se escribe nada**', async () => {
    escenario();
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), { causalId: CAUSAL_ID });

    expect(r.status).toBe(400);
    expect(espia.updates).toHaveLength(0);
    expect(espia.inserts).toHaveLength(0);
  });

  it('**observación en blanco → tampoco pasa** (un `min(1)` sobre el crudo dejaría entrar «   »)', async () => {
    escenario();
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: '        ',
    });

    expect(r.status).toBe(400);
    expect(espia.updates).toHaveLength(0);
  });

  it('**sin causal → el estado NO cambia y no se escribe nada**', async () => {
    escenario();
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      observacion: 'Corrija los datos del propietario.',
    });

    expect(r.status).toBe(400);
    expect(espia.updates).toHaveLength(0);
    expect(espia.inserts).toHaveLength(0);
  });

  it('**una causal que no está en el catálogo → 400 `causal_invalida`, sin escribir**', async () => {
    escenario({ causales: [] }); // el catálogo no la tiene
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: '44444444-4444-4444-8444-444444444444',
      observacion: 'Corrija los datos del propietario.',
    });

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('causal_invalida');
    expect(espia.updates).toHaveLength(0);
  });

  it('**la causal se busca ACTIVA — medido sobre el SQL, porque el mock no filtra**', async () => {
    escenario();
    await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada.',
    });

    // Sin este aserto, quitar `eq(activo, true)` del servicio dejaría el test en verde: el doble
    // devuelve la causal registrada venga el filtro que venga.
    const consulta = sqlDeLosSelect().find((q) => q.params.includes(CAUSAL_ID));
    expect(consulta, 'la causal se consulta por id').toBeDefined();
    expect(consulta!.sql).toContain('"activo"');
    expect(consulta!.params).toContain(true);
  });

  it('el historial guarda el NOMBRE de la causal y NO la observación (texto libre con posible PII)', async () => {
    escenario();
    await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'El documento 1020304050 no coincide con la factura.',
    });

    const historial = espia.ultimoInsertEn('flito_estado_historial');
    expect(historial).toMatchObject({ estadoAnterior: 'pendiente_revision', estadoNuevo: 'rechazada' });
    expect(historial.motivo).toContain(CAUSAL_NOMBRE);
    expect(historial.motivo).not.toContain('1020304050');
  });

  it('no se rechaza un SOAT de trámite ni uno que ya no está en revisión', async () => {
    const app = await buildApp();
    const cuerpo = { causalId: CAUSAL_ID, observacion: 'Vuelva a subir la factura.' };

    escenario({ soat: { origen: 'tramite', estado: 'pendiente' } });
    expect((await rechazar(app, await auth('admin', siguienteUsuario()), cuerpo)).status).toBe(409);

    escenario({ soat: { estado: 'solicitado' } });
    expect((await rechazar(app, await auth('admin', siguienteUsuario()), cuerpo)).status).toBe(409);

    expect(espia.updates).toHaveLength(0);
  });
});

// ───────────────── AC3 — rechazada visible, y se subsana la MISMA fila ───────

describe('AC3 — el Cliente ve el rechazo y reenvía la misma fila', () => {
  it('**el detalle del Cliente lleva causal, observación y fecha de revisión**', async () => {
    kdb.when.scenario({
      users: [{ c: COMPANIA, s: null }],
      flito_tramites: [],
      flito_compradores: [],
      flito_soat_solicitud: [{
        solicitadoEn: new Date('2026-08-20T10:00:00Z'),
        revisadoPorNombre: 'Ana Gómez',
        revisadoEn: new Date('2026-08-28T15:00:00Z'),
        causalNombre: CAUSAL_NOMBRE,
        observacion: 'La factura está cortada.',
        reenvios: 1,
      }],
    });
    // 1ª lectura: `buscarConAcceso`. 2ª: la fila plana del detalle.
    kdb.when.selectOnce('flito_soat', [filaAcceso({ estado: 'rechazada' })]);
    kdb.when.select('flito_soat', [{
      id: SOAT_ID, vin: '9FKRG2222T2042405', estado: 'rechazada', origen: 'cliente',
      proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
      valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-08-20T10:00:00Z'),
      placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30', cilindraje: '1598', carroceria: null,
      tipoServicio: 'Particular', companiaNombre: 'ACME', organismoNombre: 'FUNZA',
      proveedorSoatNombre: null, proveedorSlaHoras: null, enviadoPorNombre: null,
    }]);

    const r = await request(await buildApp())
      .get(`/api/flito/soat/${SOAT_ID}`)
      .set('Authorization', await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('rechazada');
    expect(r.body.solicitud).toMatchObject({
      causalNombre: CAUSAL_NOMBRE,
      observacion: 'La factura está cortada.',
      reenvios: 1,
    });
    expect(r.body.solicitud.revisadoEn).toContain('2026-08-28');
    // Y NO el empleado que la rechazó: dato personal de un trabajador de FLIT (proyección #11913).
    expect(Object.keys(r.body.solicitud)).not.toContain('revisadoPorNombre');
  });

  it('**la subsanación EDITA: cero INSERT en `flito_soat`, y el UPDATE apunta a ESTE id**', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), { archivo: PDF });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: SOAT_ID, estado: 'pendiente_revision' });

    // El mutante «crea una fila nueva» muere aquí: no hay INSERT en la tabla del SOAT.
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);

    const [update] = espia.updatesEn('flito_soat');
    expect(update.datos.estado).toBe('pendiente_revision');
    // Mismo id: se mide sobre el SQL, porque el mock ignora el `where` y un UPDATE sin condición
    // —que en producción tocaría la tabla entera— pasaría igual.
    const [where] = sqlDe(update);
    expect(where.sql).toContain('"id" =');
    expect(where.params).toContain(SOAT_ID);
    // Y el estado de partida EN EL MISMO `where`: ver el bloque de la carrera, más abajo.
    expect(where.params).toContain('rechazada');
  });

  it('**ni el VIN ni el vehículo se tocan, aunque el cuerpo los mande** (sería un alta encubierta)', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { vin: 'OTROVIN1234567890', placa: 'XXX999' },
    });

    const [update] = espia.updatesEn('flito_soat');
    expect(update.datos).not.toHaveProperty('vin');
    expect(update.datos).not.toHaveProperty('vehiculoId');
    expect(update.datos).not.toHaveProperty('organismoCodigo');
    // Y tampoco se cuela por la ficha del vehículo, que es tabla compartida entre compañías.
    expect(espia.updatesEn('vehicles')).toHaveLength(0);
    expect(espia.insertsEn('vehicles')).toHaveLength(0);
  });

  it('el propietario corregido va a `flito_compradores`, y el rechazo se limpia entero', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()));

    const [comprador] = espia.updatesEn('flito_compradores');
    expect(comprador.datos).toMatchObject({
      numeroDocumento: '1020304050', tipoDocumento: 'CC',
      // **HU #11966: las CINCO columnas nuevas se escriben también aquí.** Sin esta mitad, una
      // solicitud corregida sale en el Excel con el nombre y el domicilio VIEJOS —el archivo lee
      // estas columnas— mientras la cola muestra el nuevo. El mutante que mata: borrar cualquiera de
      // las cinco líneas del `set` de `subsanarSolicitud`.
      nombres: 'JUANA', apellidos: 'PEREZ CORREGIDA', razonSocial: null,
      municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
    });
    // Y `nombre_completo` se sigue escribiendo, DERIVADO de las dos primeras: es lo que interroga la
    // búsqueda de la cola, y las dos vías tienen que decir lo mismo o divergen en silencio.
    expect(comprador.datos.nombreCompleto).toBe('JUANA PEREZ CORREGIDA');

    // Las cuatro caras del rechazo dejan de ser ciertas a la vez. Dejar la causal pondría al
    // siguiente revisor una solicitud «pendiente de revisión» con un rechazo pegado que ya no aplica.
    const [satelite] = espia.updatesEn('flito_soat_solicitud');
    expect(satelite.datos).toMatchObject({
      causalRechazoId: null, observacionRechazo: null,
      revisadoPorId: null, revisadoPorNombre: null, revisadoEn: null,
    });
    // Y el contador sube en SQL, no leyendo-y-escribiendo: dos reenvíos a la vez no se pisan.
    expect(String(dialecto.sqlToQuery(satelite.datos.reenvios as never).sql)).toContain('+ 1');
  });

  it('con factura nueva: la anterior se DESCARTA antes de insertar (índice único parcial)', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), { archivo: PDF });

    const [descarte] = espia.updatesEn('flito_soportes');
    expect(descarte.datos).toEqual({ descartado: true });
    const [where] = sqlDe(descarte);
    expect(where.params).toContain('factura_venta');
    expect(where.params).toContain(SOAT_ID);

    const nueva = espia.ultimoInsertEn('flito_soportes');
    expect(nueva).toMatchObject({ tipo: 'factura_venta', soatId: SOAT_ID });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('**la subsanación aplica la MISMA partición del titular que el alta** (HU #11966)', async () => {
    // El `superRefine` es una sola función compartida por los dos schemas. Con dos copias, corregir
    // a persona jurídica pasaría por una puerta y no por la otra, y la fila acabaría con razón
    // social Y nombres — que la base rechaza con 23514 (`flito_compradores_titular_chk`) y sale como
    // 500 en la cara del Cliente.
    const app = await buildApp();

    escenario({ soat: { estado: 'rechazada' } });
    const aJuridica = await subsanar(app, await auth('cliente', siguienteUsuario()), {
      campos: { tipoDocumento: 'NIT', numeroDocumento: '9001234561', nombres: null, apellidos: null, razonSocial: 'TRANSPORTES SINTETICOS SAS' },
    });
    expect(aJuridica.status).toBe(200);
    expect(espia.updatesEn('flito_compradores')[0].datos).toMatchObject({
      razonSocial: 'TRANSPORTES SINTETICOS SAS', nombres: null, apellidos: null,
      nombreCompleto: 'TRANSPORTES SINTETICOS SAS',
    });

    // Y las dos formas a la vez siguen siendo un 400, no un `set` a medias.
    escenario({ soat: { estado: 'rechazada' } });
    espia.reiniciar();
    const ambas = await subsanar(app, await auth('cliente', siguienteUsuario()), {
      campos: { razonSocial: 'TRANSPORTES SINTETICOS SAS' },
    });
    expect(ambas.status).toBe(400);
    expect(espia.updatesEn('flito_compradores')).toHaveLength(0);
  });

  it('**la subsanación también acota el DERIVADO: nombre partido de 401 → 400, no 500**', async () => {
    // `subsanacionSchema` comparte `titularCampos` y `refinarTitular` con el alta, así que comparte
    // el camino al `22001`: el UPDATE de `flito_compradores` escribe `nombre_completo`, que es
    // `varchar(200)` y NOT NULL. Sin la cota, este cuerpo moría dentro de la transacción y salía
    // como 500. Va aquí y no solo en el alta porque las DOS rutas escriben esa columna.
    escenario({ soat: { estado: 'rechazada' } });
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { nombres: 'N'.repeat(200), apellidos: 'A'.repeat(200) },
    });

    expect(r.status).toBe(400);
    expect(Object.keys(r.body.details?.fieldErrors ?? {}))
      .toEqual(expect.arrayContaining(['nombres', 'apellidos']));
    // Ni el propietario, ni el estado, ni el contador de reenvíos.
    expect(espia.updatesEn('flito_compradores')).toHaveLength(0);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('y el borde de 200 sigue entrando por la subsanación, entero y sin truncar', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { nombres: 'N'.repeat(99), apellidos: 'A'.repeat(100) },
    });

    expect(r.status).toBe(200);
    expect(String(espia.updatesEn('flito_compradores')[0].datos.nombreCompleto)).toHaveLength(200);
  });

  it.each(['municipio', 'departamento', 'correo', 'celular', 'direccion'])(
    'subsanar sin `%s` → 400: el canal los exige igual que en el alta',
    async (campo) => {
      escenario({ soat: { estado: 'rechazada' } });
      const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), {
        campos: { [campo]: null },
      });
      expect(r.status).toBe(400);
      expect(espia.updatesEn('flito_compradores')).toHaveLength(0);
    },
  );

  it('sin factura nueva: no se descarta la que había ni se sube nada', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_soportes')).toHaveLength(0);
    expect(espia.insertsEn('flito_soportes')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('solo desde `rechazada`, y solo sobre una fila del canal', async () => {
    const app = await buildApp();

    escenario({ soat: { estado: 'pendiente_revision' } });
    const enRevision = await subsanar(app, await auth('cliente', siguienteUsuario()));
    expect(enRevision.status).toBe(409);
    expect(enRevision.body.codigo).toBe('estado_no_permite');

    escenario({ soat: { origen: 'tramite', estado: 'pendiente' } });
    const deTramite = await subsanar(app, await auth('cliente', siguienteUsuario()));
    expect(deTramite.status).toBe(409);
    expect(deTramite.body.codigo).toBe('no_es_del_canal');

    expect(espia.updates).toHaveLength(0);
  });

  it('la solicitud de OTRA compañía es un 404, no un 403 (un 403 confirmaría que existe)', async () => {
    escenario({ soat: { estado: 'rechazada', companiaId: OTRA_COMPANIA } });
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('solicitud_no_encontrada');
    expect(espia.updates).toHaveLength(0);
  });

  it('**la ruta está inscrita en la allowlist del canal** — sin la entrada, esto es un 403', async () => {
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
    expect(rutaPermitidaParaCliente('PATCH', `/api/flito/soat/${SOAT_ID}/solicitud`)).toBe(true);
    // Y la lista sigue siendo una allowlist: las dos acciones de la revisión NO están, así que la
    // petición de un `cliente` ni siquiera llega al router.
    expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/${SOAT_ID}/validar`)).toBe(false);
    expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/${SOAT_ID}/rechazar-solicitud`)).toBe(false);

    // El catálogo es el caso que conviene dejar MEDIDO en vez de suponerlo: `GET /api/flito/soat/:id`
    // ya estaba en la lista desde la #11913 y `:id` casa CUALQUIER segmento, así que la allowlist
    // deja pasar también `/causales-rechazo` —igual que ya dejaba pasar `/facetas`, que sí es suyo—.
    // Quien lo niega es la SEGUNDA cerradura, `requireRole('admin')` del router, y por eso el 403 se
    // afirma sobre la respuesta HTTP real en el bloque del AC4 y no sobre esta función.
    expect(rutaPermitidaParaCliente('GET', '/api/flito/soat/causales-rechazo')).toBe(true);
  });
});

// ───────────────── AC4 — ni `proveedor` ni `cliente` revisan ─────────────────

describe('AC4 — solo `admin` valida y rechaza', () => {
  for (const rol of ['proveedor', 'cliente', 'auditor']) {
    it(`**${rol} NO puede validar: la API lo niega y no escribe nada**`, async () => {
      escenario();
      const r = await validar(await buildApp(), await auth(rol, siguienteUsuario()));

      expect(r.status).toBe(403);
      expect(espia.updates).toHaveLength(0);
      expect(espia.inserts).toHaveLength(0);
    });

    it(`**${rol} NO puede rechazar: la API lo niega y no escribe nada**`, async () => {
      escenario();
      const r = await rechazar(await buildApp(), await auth(rol, siguienteUsuario()), {
        causalId: CAUSAL_ID, observacion: 'Vuelva a subir la factura.',
      });

      expect(r.status).toBe(403);
      expect(espia.updates).toHaveLength(0);
    });
  }

  it('el catálogo de causales es de Operaciones: `admin` sí, `cliente` y `proveedor` no', async () => {
    const app = await buildApp();

    escenario();
    const ok = await request(app).get('/api/flito/soat/causales-rechazo').set('Authorization', await auth('admin', siguienteUsuario()));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([{ id: CAUSAL_ID, nombre: CAUSAL_NOMBRE, activo: true, orden: 1 }]);

    escenario();
    expect((await request(app).get('/api/flito/soat/causales-rechazo').set('Authorization', await auth('cliente', siguienteUsuario()))).status).toBe(403);
    escenario();
    expect((await request(app).get('/api/flito/soat/causales-rechazo').set('Authorization', await auth('proveedor', siguienteUsuario()))).status).toBe(403);
  });

  it('el catálogo pide solo las ACTIVAS y ordena por `orden` y luego por nombre', async () => {
    escenario();
    await request(await buildApp()).get('/api/flito/soat/causales-rechazo').set('Authorization', await auth('admin', siguienteUsuario()));

    const [consulta] = sqlDeLosSelect();
    expect(consulta.sql).toContain('"activo"');
    expect(consulta.params).toContain(true);
  });
});

// ───────── La puerta de al lado: la reversa no rodea la revisión ─────────────

describe('la reversa manual NO se salta la revisión (AC1 por la puerta de al lado)', () => {
  const reversar = async (app: express.Express, cuerpo: Record<string, unknown>) =>
    request(app).post(`/api/flito/soat/${SOAT_ID}/reversar`).set('Authorization', await auth('admin', siguienteUsuario())).send(cuerpo);

  it('**`pendiente_revision` → `pendiente` es 400: si no, `POST /enviar` la despacha sin validar**', async () => {
    // `reversar()` lee la fila PLANA (no pasa por `buscarConAcceso`).
    kdb.when.scenario({ users: [{ s: null }], flito_soat: [{ id: SOAT_ID, estado: 'pendiente_revision', origen: 'cliente' }] });
    const r = await reversar(await buildApp(), { estadoDestino: 'pendiente', motivo: 'me equivoqué de fila' });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/canal Cliente/i);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('`rechazada` tampoco se reversa: de ahí se sale subsanando', async () => {
    kdb.when.scenario({ users: [{ s: null }], flito_soat: [{ id: SOAT_ID, estado: 'rechazada', origen: 'cliente' }] });
    const r = await reversar(await buildApp(), { estadoDestino: 'pendiente', motivo: 'devolver a la cola' });

    expect(r.status).toBe(400);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('**tampoco se reversa HACIA `pendiente_revision`** (ADR-0008 §8), aunque el enum de la ruta se ampliara', async () => {
    // El `z.enum` de la ruta ya lo rechaza hoy; el aserto es que la REGLA vive en el servicio, que es
    // lo que sigue siendo cierto el día que alguien amplíe esa lista para que funcione una pill.
    const { reversar: reversarServicio, SoatError } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    kdb.when.scenario({ flito_soat: [{ id: SOAT_ID, estado: 'solicitado', origen: 'cliente' }] });

    await expect(reversarServicio(SOAT_ID, 'pendiente_revision' as never, 'devolver a revisión', {
      userId: 1, username: 'admin@flit.co', role: 'admin', proveedorSoatId: null, companiaId: null,
    })).rejects.toBeInstanceOf(SoatError);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('no-regresión: la reversa de un SOAT de trámite sigue funcionando igual', async () => {
    kdb.when.scenario({ users: [{ s: null }], flito_soat: [{ id: SOAT_ID, estado: 'solicitado', origen: 'tramite' }] });
    kdb.when.update('flito_soat', [{ id: SOAT_ID, estado: 'pendiente', motivoRechazo: null }]);

    const r = await reversar(await buildApp(), { estadoDestino: 'pendiente', motivo: 'se envió por error' });
    expect(r.status).toBe(200);
    const [update] = espia.updatesEn('flito_soat');
    expect(update.datos.estado).toBe('pendiente');
  });
});

// ───────── El filtro de la cola acepta los dos estados nuevos ────────────────

describe('la cola del admin puede filtrar por los estados del canal', () => {
  it('**`?estado=pendiente_revision` llega a la consulta** — si no, el filtro se ignora en silencio', async () => {
    kdb.when.scenario({ users: [{ s: null }], flito_soat: [], clients: [], flito_tramites: [], flito_compradores: [] });
    kdb.when.selectOnce('flito_soat', [{ total: 0 }]);

    const r = await request(await buildApp())
      .get('/api/flito/soat?estado=pendiente_revision')
      .set('Authorization', await auth('admin', siguienteUsuario()));

    expect(r.status).toBe(200);
    // El mock no filtra nada: lo único que distingue «el filtro se aplicó» de «el filtro se descartó
    // y la cola devolvió todo» es que el valor esté en la condición que Postgres recibiría. Ese
    // descarte silencioso —un estado desconocido se ignora, no da 400— es el modo de fallo que este
    // aserto existe para cazar.
    const conElEstado = sqlDeLosSelect().filter((q) => q.params.includes('pendiente_revision'));
    expect(conElEstado.length, 'el conteo Y la página tienen que llevar el filtro').toBe(2);
  });

  it('`rechazada` también, y un estado inventado se sigue ignorando sin tumbar la pantalla', async () => {
    kdb.when.scenario({ users: [{ s: null }], flito_soat: [], clients: [], flito_tramites: [], flito_compradores: [] });
    kdb.when.selectOnce('flito_soat', [{ total: 0 }]);
    const app = await buildApp();

    const r = await request(app).get('/api/flito/soat?estado=rechazada').set('Authorization', await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(sqlDeLosSelect().some((q) => q.params.includes('rechazada'))).toBe(true);

    espia.reiniciar();
    kdb.when.selectOnce('flito_soat', [{ total: 0 }]);
    const raro = await request(app).get('/api/flito/soat?estado=no_existe').set('Authorization', await auth('admin', siguienteUsuario()));
    expect(raro.status).toBe(200);
    expect(sqlDeLosSelect().some((q) => q.params.includes('no_existe'))).toBe(false);
  });
});


// ───────── El bloqueante de `db-review`: la carrera entre dos revisores ──────

describe('la transición es un compare-and-swap, no un UPDATE ciego (bloqueante db-review)', () => {
  // Lo que se prueba aquí NO se ve en el resultado de una petición aislada. En READ COMMITTED, un
  // `UPDATE … WHERE id = X` reevalúa su condición contra la versión ya commiteada por el otro, y
  // `id = X` sigue siendo cierto pase lo que pase con el estado: el segundo revisor espera el lock y
  // APLICA IGUAL. El interleaving concreto que eso permitía —A valida y la fila queda `solicitado`
  // con proveedor y en la cola del gestor; B, que leyó `pendiente_revision`, la deja `rechazada`
  // encima— dejaba además una fila de historial diciendo que venía de `pendiente_revision`. El
  // historial no quedaba incompleto: quedaba FALSO.
  //
  // Los tests anteriores no lo cubrían, y conviene decir por qué: solo ejercitan el caso en que la
  // primera petición YA commiteó, que es justo el único que la lectura previa sí atrapa.
  //
  // Se mide de las dos maneras, porque cada una caza un mutante distinto:
  //   · el `where` renderizado — muere si alguien quita el predicado de estado;
  //   · el `.returning()` vacío — muere si alguien deja de comprobar cuántas filas se movieron.

  it('**rechazar: el `where` del UPDATE lleva el estado de partida, no solo el id**', async () => {
    escenario();
    await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada.',
    });

    const [update] = espia.updatesEn('flito_soat');
    const [where] = sqlDe(update);
    expect(where.sql).toContain('"id" =');
    expect(where.sql).toContain('"estado" =');
    expect(where.params).toContain(SOAT_ID);
    // Sin este parámetro el UPDATE es ciego y el bloqueante vuelve.
    expect(where.params).toContain('pendiente_revision');
    // `origen` va también: es inmutable, así que no cierra ninguna carrera, pero hace que el
    // statement no dependa de la lectura previa para ninguno de los dos hechos que le importan.
    expect(where.params).toContain('cliente');
  });

  it('**rechazar: si otro revisor ganó la carrera → 409 y la transacción NO escribe nada**', async () => {
    // `cas: []` es exactamente lo que Postgres devuelve cuando el `WHERE` ya no casa: cero filas
    // movidas. Con el UPDATE ciego, este mismo escenario respondía 200 y dejaba la causal escrita
    // encima de un SOAT que ya estaba en otro estado.
    escenario({ cas: [] });
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada.',
    });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('estado_no_permite');
    // Ni la causal encima de la del otro, ni una fila de historial que mienta sobre el estado previo.
    expect(espia.updatesEn('flito_soat_solicitud')).toHaveLength(0);
    expect(espia.insertsEn('flito_estado_historial')).toHaveLength(0);
  });

  it('**subsanar: el `where` del UPDATE exige `rechazada`**', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()));

    const [update] = espia.updatesEn('flito_soat');
    const [where] = sqlDe(update);
    expect(where.sql).toContain('"estado" =');
    expect(where.params).toContain('rechazada');
    expect(where.params).toContain(SOAT_ID);
  });

  it('**subsanar: carrera perdida → 409, y ni el propietario ni la factura se tocan**', async () => {
    escenario({ soat: { estado: 'rechazada' }, cas: [] });
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()), { archivo: PDF });

    expect(r.status).toBe(409);
    // El CAS es el PRIMER statement de la transacción, y de ahí que no haya nada más escrito. Con el
    // UPDATE al final —donde estaba— este mismo caso terminaba en `reenvios` subido dos veces y dos
    // filas de historial, o en un 23505 contra `idx_flito_soportes_soat_factura_venta` (dos facturas
    // de venta vivas) que sale como 500 en vez de como 409.
    expect(espia.updatesEn('flito_compradores')).toHaveLength(0);
    expect(espia.updatesEn('flito_soportes')).toHaveLength(0);
    expect(espia.insertsEn('flito_soportes')).toHaveLength(0);
    expect(espia.updatesEn('flito_soat_solicitud')).toHaveLength(0);
    expect(espia.insertsEn('flito_estado_historial')).toHaveLength(0);

    // Lo que SÍ pasó, y queda escrito para que nadie lo lea como un fallo: el archivo ya se había
    // subido al bucket antes de abrir la transacción (CA-11, para no tener una llamada de red
    // dentro). Una carrera perdida deja ese objeto huérfano. Es el mismo tradeoff que el alta ya
    // documenta y no se compensa con un borrado: un `delete` en el camino de error puede fallar él
    // mismo, y el objeto no es alcanzable —ninguna fila de `flito_soportes` lo referencia—.
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('**el historial escribe el estado que el CAS COMPROBÓ, no el que trajo la lectura previa**', async () => {
    escenario();
    await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada.',
    });

    // Con el `estadoAnterior` sacado de la lectura previa, una carrera dejaba escrito un estado que
    // ya era falso. Ahora o el CAS pasó —y entonces era `pendiente_revision`— o esta fila no existe.
    const historial = espia.ultimoInsertEn('flito_estado_historial');
    expect(historial.estadoAnterior).toBe('pendiente_revision');
    expect(historial.estadoNuevo).toBe('rechazada');
  });

  it('no-regresión: `validarSolicitud` ya estaba protegida y lo sigue estando por otra vía', async () => {
    // La asimetría que encontró `db-review`: validar hereda el `FOR UPDATE … SKIP LOCKED` MÁS el
    // `eq(estado, estadoOrigen)` de `enviarAlGestor`, así que su carrera se cierra con el bloqueo de
    // fila y no con un CAS. Se afirma aquí para que quien unifique las tres transiciones mañana no
    // le quite a validar la protección creyendo que le falta.
    escenario({ bloqueo: [] });
    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });
});

// ───────────────── AC5 — leftJoin organismo; AC6 — transiciones sin esperar RUNT ─

describe('AC5 — cola y detalle no ocultan la fila con organismo NULL', () => {
  it('**TC-AC5-04: `conJoinsCola` es LEFT JOIN a organismos** (SQL PgDialect)', async () => {
    const { PgDialect, QueryBuilder } = await import('drizzle-orm/pg-core');
    const { flitoSoat } = await import('../../src/db/schema.js');
    const { conJoinsCola } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const q = new QueryBuilder()
      .select({ id: flitoSoat.id })
      .from(flitoSoat)
      .$dynamic();
    const sql = new PgDialect().sqlToQuery(conJoinsCola(q).getSQL()).sql.toLowerCase();
    expect(sql).toMatch(/left join "organismos_transito_config"/);
    expect(sql).not.toMatch(/inner join "organismos_transito_config"/);
    expect(sql).toMatch(/inner join "vehicles"/);
    expect(sql).toMatch(/inner join "clients"/);
  });

  it('**TC-AC5-05: `detalle` también LEFT JOIN a organismos** (SQL PgDialect)', async () => {
    const { PgDialect, QueryBuilder } = await import('drizzle-orm/pg-core');
    const {
      flitoSoat, vehicles, clients, organismosTransitoConfig, flitoProveedoresSoat, users,
    } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const q = new QueryBuilder()
      .select({ id: flitoSoat.id })
      .from(flitoSoat)
      .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
      .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
      .leftJoin(organismosTransitoConfig, eq(flitoSoat.organismoCodigo, organismosTransitoConfig.codigo))
      .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
      .leftJoin(users, eq(flitoSoat.enviadoPorId, users.id));
    const sql = new PgDialect().sqlToQuery(q.getSQL()).sql.toLowerCase();
    expect(sql).toMatch(/left join "organismos_transito_config"/);
    expect(sql).not.toMatch(/inner join "organismos_transito_config"/);
  });

  it('**TC-AC5-06: GET /:id con organismo NULL → 200**', async () => {
    kdb.when.scenario({
      users: [{ c: COMPANIA, s: null }],
      flito_tramites: [],
      flito_compradores: [],
      flito_soat_solicitud: [{
        solicitadoEn: new Date('2026-08-20T10:00:00Z'),
        revisadoPorNombre: null,
        revisadoEn: null,
        causalNombre: null,
        observacion: null,
        reenvios: 0,
        verificacionEstado: 'pendiente',
        soatVigente: null,
        soatVigenteHasta: null,
        verificacionCodigo: null,
      }],
    });
    kdb.when.selectOnce('flito_soat', [filaAcceso({ organismoCodigo: null })]);
    kdb.when.select('flito_soat', [{
      id: SOAT_ID, vin: '9FKRG2222T2042405', estado: 'pendiente_revision', origen: 'cliente',
      proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
      valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-08-20T10:00:00Z'),
      placa: 'JNH38H', marca: null, linea: null, cilindraje: null, carroceria: null,
      tipoServicio: null, companiaNombre: 'ACME', organismoNombre: null,
      proveedorSoatNombre: null, proveedorSlaHoras: null, enviadoPorNombre: null,
    }]);

    const r = await request(await buildApp())
      .get(`/api/flito/soat/${SOAT_ID}`)
      .set('Authorization', await auth('admin', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.id).toBe(SOAT_ID);
    expect(r.body.organismoNombre).toBeNull();
    expect(r.body.solicitud.verificacionEstado).toBe('pendiente');
  });
});

describe('AC6 — validar / rechazar / subsanar no esperan la verificación', () => {
  it('**TC-AC6-01: validar con verificación pendiente → 200 solicitado**', async () => {
    escenario();
    kdb.when.select('flito_soat_solicitud', [{ verificacionEstado: 'pendiente', soatVigente: null }]);
    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('solicitado');
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**TC-AC6-02: rechazar con verificación pendiente → 200 rechazada**', async () => {
    escenario();
    kdb.when.select('flito_soat_solicitud', [{ verificacionEstado: 'pendiente', soatVigente: null }]);
    const r = await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada.',
    });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('rechazada');
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**TC-AC6-03: subsanar con verificación pendiente → 200 pendiente_revision**', async () => {
    escenario({ soat: { estado: 'rechazada' } });
    kdb.when.select('flito_soat_solicitud', [{ verificacionEstado: 'pendiente', soatVigente: null }]);
    const r = await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('pendiente_revision');
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**TC-AC6-04: validar con SOAT vigente en el satélite es excepción permitida (200)**', async () => {
    escenario();
    kdb.when.select('flito_soat_solicitud', [{
      verificacionEstado: 'ok', soatVigente: true, soatVigenteHasta: '2027-02-01',
    }]);
    const r = await validar(await buildApp(), await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('solicitado');
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**TC-AC6-05: ninguna de las tres transiciones invoca `consultarVehiculoRunt`**', async () => {
    escenario();
    await validar(await buildApp(), await auth('admin', siguienteUsuario()));
    escenario();
    await rechazar(await buildApp(), await auth('admin', siguienteUsuario()), {
      causalId: CAUSAL_ID, observacion: 'La factura está cortada.',
    });
    escenario({ soat: { estado: 'rechazada' } });
    await subsanar(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });
});
