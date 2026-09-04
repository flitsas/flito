// HU #12093 (Feature #12073) — de dónde salió cada dato del propietario, y cuándo respondió el RUNT.
//
// Dos columnas nuevas y una pregunta que Operaciones no podía responder: desde la HU #12092 el
// formulario del canal ya no se teclea entero —el OCR lee el comprador de la factura y el RUNT
// confirma el vehículo—, así que «este nombre lo puso el concesionario» y «esta dirección la escribió
// el cliente» dejaron de distinguirse mirando la fila.
//
// ── Cómo está montado, y por qué así ─────────────────────────────────────────────────────────────
//
// **Se mide el INSERT, no la respuesta.** El mock keyed de drizzle devuelve lo que el test le
// registre, así que afirmar sobre el cuerpo del 201 probaría el mock. Lo que se afirma es el PAYLOAD
// que el servicio le pasó a `insert().values()` (`espia-drizzle`): el mapa de procedencia y la fecha
// del RUNT salen de ahí. Cambiar el defecto `manual` en el servicio pone rojo este archivo; cambiar
// el mock, no.
//
// **La API sube por su router real y por `authMiddleware` real**, igual que la suite del alta: si
// alguien sacara las rutas del canal de `RUTAS_PERMITIDAS_CLIENTE`, todo esto se pondría en 403, que
// es exactamente la señal que se quiere.
//
// **Cada test usa un `sub` distinto**: el limitador del canal es por usuario y su ventana es de 15
// minutos.
//
// **La fecha se prueba con un reloj, no con un `toBeDefined()`.** El mutante que interesa no es
// «no se escribe» sino «se escribe la fecha equivocada»: tomar `new Date()` dentro de la transacción
// en vez de al responder el RUNT deja un test verde y una ficha que promete «datos del RUNT del …»
// midiendo otra cosa. Por eso la subida a S3 tarda a propósito y el aserto es de ORDEN.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { CAMPOS_COMPRADOR_FACTURA, PROCEDENCIAS_DATO } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken, type TestRole } from '../helpers/auth.js';

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
const SOAT_ID = '44444444-4444-4444-4444-444444444444';
const PROVEEDOR = '55555555-5555-5555-5555-555555555555';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** Respuesta del RUNT con el vehículo registrado y sin SOAT vigente — el camino feliz del alta. */
const runtOk = () => ({
  ok: true,
  data: {
    vehiculo: {
      placa: 'JNH38H', vin: '9FKRG2222T2042405',
      idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
      marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
      cilindraje: '1598', tipoServicio: 'Particular',
      tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5',
      organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
      nombrePropietario: 'JUANA PEREZ',
    },
    soat: { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' },
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sub = 700;
const siguienteUsuario = () => ++sub;

async function appAlta() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

async function appDetalle() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: TestRole, id: number, extra: Record<string, unknown> = {}) =>
  `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role, ...extra } as never)}`;

function escenarioAlta(over: Partial<Record<string, unknown[]>> = {}) {
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

/** El formulario, tal como lo manda el `multipart` del navegador: todo texto. */
const CAMPOS: Record<string, string> = {
  placa: 'jnh38h', vin: '9fkrg2222t2042405',
  tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

/**
 * `POST /cliente`. `procedencia` viaja como CADENA JSON porque el alta es `multipart/form-data` y
 * ahí no hay objetos: es exactamente lo que manda el formulario, y por eso el test no lo esquiva
 * mandando `application/json`.
 */
function alta(app: express.Express, token: string, procedencia?: unknown) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
  if (procedencia !== undefined) {
    req.field('procedencia', typeof procedencia === 'string' ? procedencia : JSON.stringify(procedencia));
  }
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const procedenciaDelInsert = () =>
  espia.ultimoInsertEn('flito_compradores').procedencia as Record<string, string> | undefined;

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
});

// ═══════════ AC2 — el alta acepta y VALIDA el mapa de procedencia ════════════

describe('AC2 — Zod valida el mapa contra los campos del comprador y los tres valores', () => {
  it('**un mapa válido se guarda tal cual en `flito_compradores.procedencia`**', async () => {
    escenarioAlta();
    const mapa = {
      nombres: 'factura', apellidos: 'factura', razonSocial: 'manual',
      tipoDocumento: 'factura', numeroDocumento: 'factura',
      direccion: 'manual', municipio: 'runt', departamento: 'runt', celular: 'manual',
    };

    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), mapa);

    expect(r.status).toBe(201);
    expect(procedenciaDelInsert()).toEqual(mapa);
  });

  it('**los TRES valores se aceptan, y cada uno llega intacto**', async () => {
    // Uno por uno sobre el mismo campo: si alguien colapsara el enum a dos valores —o normalizara
    // `runt` a `manual` «porque total lo revisa una persona»— este caso lo ve.
    for (const valor of PROCEDENCIAS_DATO) {
      kdb.reset(); espia.reiniciar(); escenarioAlta();
      const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { nombres: valor });
      expect(r.status, `el valor ${valor} debería aceptarse`).toBe(201);
      expect(procedenciaDelInsert()?.nombres).toBe(valor);
    }
  });

  it('**los NUEVE campos del comprador se aceptan** — la lista es la compartida, no una copia', async () => {
    // `CAMPOS_COMPRADOR_FACTURA` es la constante que ya usa el OCR de la #12092. El mutante que mata:
    // escribir la lista a mano en la ruta y olvidarse de uno; ese campo respondería 400 y el
    // formulario no podría declarar su procedencia.
    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      kdb.reset(); espia.reiniciar(); escenarioAlta();
      const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { [campo]: 'factura' });
      expect(r.status, `el campo ${campo} debería aceptarse`).toBe(201);
      expect(procedenciaDelInsert()?.[campo]).toBe('factura');
    }
  });

  it('**un campo desconocido responde 400 y NO crea la solicitud**', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), {
      nombres: 'factura', placa: 'runt',
    });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    // `placa` no es un campo del comprador: es del vehículo y no lo teclea nadie. Aceptarlo en
    // silencio —que es lo que Zod hace por omisión con las claves que no declara— dejaría al front
    // creyendo que declaró una procedencia que no se guardó.
    expect(JSON.stringify(r.body.details)).toContain('placa');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
  });

  it('**`correo` también es un campo desconocido**, y eso es deliberado: la factura no lo trae', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { correo: 'factura' });

    expect(r.status).toBe(400);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('**un valor desconocido responde 400 y NO crea la solicitud**', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { nombres: 'ocr' });

    expect(r.status).toBe(400);
    // El error cuelga de `procedencia` y no de `procedencia.nombres`: `flatten()` agrupa por la clave
    // de primer nivel, que es lo que este router ya devuelve para todo lo demás. Lo que el formulario
    // necesita —y lo que se comprueba— es que el mensaje diga cuáles son los valores admitidos.
    expect(Object.keys(r.body.details.fieldErrors)).toContain('procedencia');
    expect(JSON.stringify(r.body.details)).toContain("'factura' | 'runt' | 'manual'");
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('**un JSON roto es 400, no un mapa vacío guardado en silencio**', async () => {
    // Tragárselo y persistir `{}` escribiría «todo manual» sobre un alta cuyo formulario sí sabía la
    // procedencia. El AC3 completa lo que NO se declaró, no lo que se declaró mal.
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), '{nombres:');

    expect(r.status).toBe(400);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
  });

  it('el alta NO consulta al RUNT cuando el mapa es inválido: se corta en el borde', async () => {
    // Zod corre antes que nada. Si la validación se hubiera colado en el servicio, cada mapa mal
    // escrito costaría una llamada a Kyverum.
    escenarioAlta();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { nombres: 'ocr' });
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });
});

// ═══════════ AC3 — el defecto es `manual`, y el mapa nunca tiene huecos ══════

describe('AC3 — lo no declarado queda en `manual`, nunca nulo ni ausente', () => {
  it('**sin `procedencia`, los nueve campos se guardan en `manual`**', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(201);
    const mapa = procedenciaDelInsert();
    expect(Object.keys(mapa ?? {}).sort()).toEqual([...CAMPOS_COMPRADOR_FACTURA].sort());
    expect(Object.values(mapa ?? {})).toEqual(Array(9).fill('manual'));
  });

  it('**un mapa PARCIAL conserva lo declarado y completa el resto con `manual`**', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), {
      nombres: 'factura', numeroDocumento: 'runt',
    });

    expect(r.status).toBe(201);
    expect(procedenciaDelInsert()).toEqual({
      nombres: 'factura', numeroDocumento: 'runt',
      apellidos: 'manual', razonSocial: 'manual', tipoDocumento: 'manual',
      direccion: 'manual', municipio: 'manual', departamento: 'manual', celular: 'manual',
    });
  });

  it('un mapa vacío `{}` es lo mismo que no mandarlo: nueve `manual`', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), {});

    expect(r.status).toBe(201);
    expect(Object.values(procedenciaDelInsert() ?? {})).toEqual(Array(9).fill('manual'));
  });

  it('**ningún valor queda en `null` ni en `undefined`**, que es la letra del AC', async () => {
    // El mutante que mata: `completa[campo] = declarada?.[campo]` sin el `?? 'manual'`. Con
    // `toMatchObject` o con un `toBeDefined()` sobre una clave suelta, eso pasaría en verde.
    escenarioAlta();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { celular: 'factura' });

    const mapa = procedenciaDelInsert() ?? {};
    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      expect(mapa, `falta ${campo}`).toHaveProperty(campo);
      expect([...PROCEDENCIAS_DATO], `${campo} tiene un valor fuera del vocabulario`).toContain(mapa[campo]);
    }
  });
});

// ═══════════ AC4 — la fecha de la consulta al RUNT ═══════════════════════════

describe('AC4 — `runt_consultado_en` guarda cuándo RESPONDIÓ el RUNT', () => {
  it('**el instante es el de la respuesta del RUNT, no el del INSERT**', async () => {
    escenarioAlta();
    let respondioEn = 0;
    consultarVehiculoRuntMock.mockImplementation(async () => {
      const r = runtOk();
      respondioEn = Date.now();
      return r;
    });
    // La subida a S3 va DESPUÉS de la compuerta y ANTES de la transacción. Que tarde es lo que
    // separa los dos instantes: si la fecha se tomara al insertar, quedaría por detrás de esto.
    let subidaTerminadaEn = 0;
    uploadMock.mockImplementation(async () => {
      await sleep(40);
      subidaTerminadaEn = Date.now();
      return 'clientes/acme/soat/facturas-venta/abc.pdf';
    });

    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);

    const guardado = espia.ultimoInsertEn('flito_soat_solicitud').runtConsultadoEn;
    expect(guardado).toBeInstanceOf(Date);
    const t = (guardado as Date).getTime();
    // Pegado a la respuesta del RUNT…
    expect(t).toBeGreaterThanOrEqual(respondioEn);
    expect(t - respondioEn).toBeLessThan(40);
    // …y ESTRICTAMENTE antes de que terminara la subida, que es lo que mata al mutante «tomar la
    // fecha dentro de la transacción».
    expect(subidaTerminadaEn).toBeGreaterThan(0);
    expect(t).toBeLessThan(subidaTerminadaEn);
  });

  it('la fecha va en la satélite y NO en `flito_compradores` ni en `flito_soat`', async () => {
    escenarioAlta();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(espia.ultimoInsertEn('flito_soat_solicitud')).toHaveProperty('runtConsultadoEn');
    expect(espia.ultimoInsertEn('flito_soat')).not.toHaveProperty('runtConsultadoEn');
    expect(espia.ultimoInsertEn('flito_compradores')).not.toHaveProperty('runtConsultadoEn');
  });

  it('si el RUNT no respondió no hay alta, así que no hay fecha que anotar', async () => {
    escenarioAlta();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'Timeout 90s' });

    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(503);
    expect(espia.insertsEn('flito_soat_solicitud')).toHaveLength(0);
  });
});

// ═══════════ AC4 (segunda mitad) — el DETALLE la devuelve ════════════════════

/**
 * La fila de `flito_soat` tal como la devuelve `buscarConAcceso`: `{ soat, dentroDeFrontera }`.
 * El mock keyed no evalúa la proyección, así que la MISMA fila sirve para las dos lecturas que hace
 * `detalle()`; por eso van las dos formas en el mismo objeto. Calcado de la suite de la #11966.
 */
const filaSoat = (over: Record<string, unknown> = {}) => {
  const soat = {
    id: SOAT_ID, origen: 'cliente', vin: '9FKRG2222T2042405', estado: 'pendiente_revision',
    companiaId: COMPANIA, proveedorSoatId: null, gestionOperaciones: false,
    enviadoEn: null, pagadoEn: null, valorPagado: null, motivoRechazo: null,
    createdAt: new Date('2026-09-01T10:00:00Z'), extraccion: null,
    ...over,
  };
  return {
    soat, dentroDeFrontera: true, ...soat,
    placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
    cilindraje: '1598', carroceria: 'WAGON', tipoServicio: 'Particular',
    companiaNombre: 'ACME', organismoNombre: 'FUNZA',
    proveedorSoatNombre: null, proveedorSlaHoras: null, enviadoPorNombre: null,
  };
};

const CONSULTADO_EN = new Date('2026-09-02T15:30:45.000Z');

/** Las proyecciones de cada `select`, por tabla — el único aserto inmune al mock keyed. */
const proyecciones: { tabla: string; columnas: string[] }[] = [];

function espiarProyecciones(): void {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = base(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => {
      let tabla = '__expr__';
      try { tabla = String(getTableName(tbl as never)); } catch { /* no es tabla */ }
      proyecciones.push({ tabla, columnas });
      return from(tbl);
    };
    return chain;
  });
}

function escenarioDetalle(over: Partial<Record<string, unknown[]>> = {}, satelite: Record<string, unknown> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    flito_soat: [filaSoat()],
    flito_tramites: [],
    flito_compradores: [{
      id: 'c1', soatId: SOAT_ID, tramiteId: null, orden: 0, porcentajeParticipacion: null,
      nombreCompleto: 'JUANA PEREZ', tipoDocumento: 'CC', nombres: 'JUANA', apellidos: 'PEREZ',
      razonSocial: null, numeroDocumento: '1020304050', correo: 'juana@empresa.co',
      celular: '3001234567', direccion: 'CALLE 1 # 2-3', municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
      procedencia: { nombres: 'factura', celular: 'manual' },
    }],
    flito_soat_solicitud: [{
      solicitadoEn: new Date('2026-09-01T10:00:00Z'), revisadoPorNombre: null, revisadoEn: null,
      nombre: null, observacion: null, reenvios: 0,
      verificacionEstado: 'ok', soatVigente: false, soatVigenteHasta: null, verificacionCodigo: null,
      runtConsultadoEn: CONSULTADO_EN, ...satelite,
    }],
    ...(over as Record<string, unknown[]>),
  });
}

const detalle = async (token: string) =>
  request(await appDetalle()).get(`/api/flito/soat/${SOAT_ID}`).set('Authorization', token);

describe('AC4 — el detalle devuelve la fecha para que la ficha diga de cuándo son los datos', () => {
  beforeEach(() => { espiarProyecciones(); proyecciones.length = 0; });

  it('**el `cliente` dueño de la solicitud la recibe, en ISO**', async () => {
    escenarioDetalle();
    const r = await detalle(await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.solicitud.runtConsultadoEn).toBe(CONSULTADO_EN.toISOString());
    // Y NO es `solicitadoEn` con otro nombre: son dos hechos distintos y esa sustitución es lo que la
    // columna vino a evitar.
    expect(r.body.solicitud.solicitadoEn).toBe('2026-09-01T10:00:00.000Z');
    expect(r.body.solicitud.runtConsultadoEn).not.toBe(r.body.solicitud.solicitadoEn);
  });

  it('**la columna viaja en la PROYECCIÓN de la satélite** — el aserto que el mock no regala', async () => {
    escenarioDetalle();
    await detalle(await auth('admin', siguienteUsuario()));

    const delSatelite = proyecciones.filter((p) => p.tabla === 'flito_soat_solicitud').at(-1);
    expect(delSatelite?.columnas).toContain('runtConsultadoEn');
  });

  it('el `admin` que revisa también la recibe: necesita saber si mira una lectura de hace tres semanas', async () => {
    escenarioDetalle();
    const r = await detalle(await auth('admin', siguienteUsuario()));
    expect(r.body.solicitud.runtConsultadoEn).toBe(CONSULTADO_EN.toISOString());
  });

  it('**una solicitud anterior a la 0174 la devuelve en `null`, no la inventa**', async () => {
    escenarioDetalle({}, { runtConsultadoEn: null });
    const r = await detalle(await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.solicitud.runtConsultadoEn).toBeNull();
    // La clave EXISTE aunque esté vacía: una ausente obligaría a la ficha a distinguir «no consta»
    // de «esta versión del API no lo manda».
    expect(Object.keys(r.body.solicitud)).toContain('runtConsultadoEn');
  });
});

// ═══════════ AC5 — sin PII nueva ═════════════════════════════════════════════

describe('AC5 — ni la procedencia ni la fecha se escriben en `audit_logs`', () => {
  it('**la bitácora del alta no menciona la procedencia ni la fecha del RUNT**', async () => {
    escenarioAlta();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()), {
      nombres: 'factura', direccion: 'runt',
    });
    expect(r.status).toBe(201);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const escrito = JSON.stringify(auditMock.mock.calls[0][1]);
    for (const prohibido of ['procedencia', 'factura_venta', 'runtConsultado', 'runt_consultado']) {
      expect(escrito, `${prohibido} no puede acabar en audit_logs`).not.toContain(prohibido);
    }
    // Y lo que la bitácora sí dice sigue siendo lo de siempre: el uuid opaco y el estado.
    expect(escrito).toContain('flito_soat');
    expect(escrito).toContain('pendiente_revision');
  });

  it('**el rastro de PII no gana campos**: la procedencia no es un dato del titular, es su origen', async () => {
    // `pii_access_log` declara QUÉ columnas personales se entregaron. La procedencia dice de dónde
    // salió un dato, no cuál es; declararla sería declarar de más, que ya fue un bloqueante en este
    // módulo. El alta sigue registrando lo de la consulta al RUNT y nada más.
    escenarioAlta();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()), { nombres: 'factura' });

    expect(piiMock).toHaveBeenCalledTimes(1);
    const campos = piiMock.mock.calls[0][1].camposAccedidos as string[];
    expect(campos).toEqual(['placa', 'vin']);
  });
});

describe('AC5 — la fila que recibe el gestor no gana ninguna columna de datos personales', () => {
  beforeEach(() => { espiarProyecciones(); proyecciones.length = 0; });

  it('**el gestor del proveedor no recibe la fecha ni la procedencia**, aunque la solicitud esté en su cola', async () => {
    escenarioDetalle({
      users: [{ p: PROVEEDOR, c: null, s: null }],
      flito_soat: [filaSoat({ estado: 'solicitado', proveedorSoatId: PROVEEDOR })],
      flito_proveedores_soat: [{ id: PROVEEDOR }],
    });

    const r = await detalle(await auth('proveedor', siguienteUsuario(), { proveedorSoatId: PROVEEDOR }));

    // 200: la solicitud SÍ está en su cola y la abre con todo derecho…
    expect(r.status).toBe(200);
    // …y aun así el bloque entero sigue siendo `null`, como desde la #11915.
    expect(r.body.solicitud ?? null).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(CONSULTADO_EN.toISOString());
    expect(JSON.stringify(r.body)).not.toContain('procedencia');
  });

  it('**`procedencia` no entra en NINGUNA proyección del detalle**: es una columna de escritura', async () => {
    // No la lee ni el detalle del `cliente` ni el del `admin`. Ninguna pantalla la consume todavía
    // (ver el HANDOFF de la HU): la columna se escribe en el alta y se leerá cuando un AC la pida.
    // Mientras tanto, no ensancha ninguna respuesta.
    //
    // **Se afirma sobre la PROYECCIÓN y no sobre el cuerpo**, y la diferencia es de método: el mock
    // keyed devuelve la fila ENTERA que el escenario registró —con `procedencia` incluida— aunque el
    // `select` pidiera diez columnas. En producción la proyección de `propietarioDelCanal` está
    // escrita campo a campo (RN-E1) y esta columna no está en ella, así que lo único que decide qué
    // sale de la base es lo que se lee aquí. Un aserto sobre `r.body` sería rojo por el mock y verde
    // por el código, que es la peor combinación posible.
    escenarioDetalle();
    const r = await detalle(await auth('admin', siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(proyecciones.length).toBeGreaterThan(0);
    for (const p of proyecciones) {
      expect(p.columnas, `${p.tabla} no debe proyectar procedencia`).not.toContain('procedencia');
    }
  });
});
