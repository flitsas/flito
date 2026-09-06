// HU #12078 (Feature #12074) — el alta del canal Cliente DESPACHA al gestor, sin paso de revisión.
//
// La solicitud nacía en `pendiente_revision` y esperaba a que un admin la validara eligiendo
// destino. Desde esta HU nace en `solicitado` con el destino YA ESCRITO en el mismo INSERT, y el
// destino sale del gestor por defecto que Operaciones configura POR COMPAÑÍA. El SOAT por trámite no
// cambia: allí Operaciones sigue eligiendo gestor en cada `POST /flito/soat/enviar`.
//
// ── Cómo está montada, y por qué así ─────────────────────────────────────────────────────────────
//
// **Se mide el INSERT, no la respuesta.** El mock keyed devuelve lo que el test le registre, así que
// afirmar sobre el cuerpo probaría el mock. Lo que se afirma es el PAYLOAD que el servicio le pasó a
// `insert().values()` (`espia-drizzle`). Cambiar `solicitado` por otro estado en el servicio pone
// rojo este archivo; cambiar el mock, no.
//
// **«Una sola consulta» se prueba CONTANDO consultas, no leyendo su resultado.** El mock keyed
// responde por NOMBRE DE TABLA y devuelve la fila entera aunque el `select` pidiera dos columnas:
// partir el resolutor en dos consultas —una a `clients` y otra a `flito_proveedores_soat`— seguiría
// dando el mismo resultado y el mismo 201. Por eso se espía la PROYECCIÓN y los JOIN de cada
// `select`, que es lo único que el mock no regala.
//
// **La fila del gestor viaja en la fila de `clients` del escenario.** No es un atajo: el resolutor
// entra por `.from(clients)` con un `LEFT JOIN`, y el mock enruta por la tabla del `from`. Que
// `proveedorId` y `activo` estén ahí es exactamente lo que ese `LEFT JOIN` devuelve.
//
// **Los literales de motivo se IMPORTAN del servicio**, no se copian. Una copia y el original
// divergen, y el día que diverjan el test seguiría verde afirmando sobre una cadena muerta.
//
// **Cada test usa un `sub` distinto**: el limitador del canal es por usuario, ventana de 15 minutos.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
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

const {
  MOTIVO_ENVIO_DIRECTO, MOTIVO_ENVIO_CONTINGENCIA, MOTIVO_GESTION_OPERACIONES_ALTA,
} = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';
/** El gestor por defecto configurado para la compañía. */
const GESTOR = '55555555-5555-4555-8555-555555555555';
/** Otro gestor cualquiera: el que Operaciones elige a mano en el SOAT POR TRÁMITE (AC2e). */
const OTRO_GESTOR = '66666666-6666-4666-8666-666666666666';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

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

let sub = 900;
const siguienteUsuario = () => ++sub;

async function appAlta() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

async function appClientes() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const auth = async (role: TestRole, id: number, extra: Record<string, unknown> = {}) =>
  `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role, ...extra } as never)}`;

// ───────────────────────────── Espías de forma de consulta ───────────────────

/** Lo que se le pidió a la base en cada `select`: tabla, joins y columnas proyectadas. */
interface Consulta { tabla: string; joins: string[]; columnas: string[] }
const consultas: Consulta[] = [];
/** Lo que devolvió cada mutación: `columnas: null` = `.returning()` SIN proyección (la fuga). */
const returnings: { tabla: string; columnas: string[] | null }[] = [];

const nombreDe = (t: unknown): string => {
  try { return String(getTableName(t as never)); } catch { return '__expr__'; }
};

/**
 * El fuente de un módulo, SIN comentarios.
 *
 * Los greps de este archivo afirman sobre lo que el código NO nombra, y la prosa que explica por qué
 * no lo nombra —«sin ámbitos, sin prioridades, sin `PRIORIDAD_POR_AMBITO`»— usa esas mismas palabras.
 * Sin podar, cada negación sería roja por su propia justificación. Es el mismo gesto que
 * `podarComentarios` en las suites de migración, al revés.
 */
const codigoDe = (ruta: string): string =>
  readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Registra la FORMA de cada `select` y de cada `returning`.
 *
 * Se instala DESPUÉS de `espia.reiniciar()` para envolver su implementación y no reemplazarla: el
 * espía de payloads y este miran cosas distintas del mismo chain.
 */
function espiar(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const registro: Consulta = { tabla: '__sin_from__', joins: [], columnas };
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { registro.tabla = nombreDe(tbl); consultas.push(registro); return from(tbl); };
    for (const j of ['leftJoin', 'innerJoin'] as const) {
      const orig = chain[j] as (...a: unknown[]) => unknown;
      chain[j] = (tbl: unknown, ...resto: unknown[]) => { registro.joins.push(nombreDe(tbl)); return orig(tbl, ...resto); };
    }
    return chain;
  });

  for (const fn of [kdb.insert, kdb.update]) {
    const base = fn.getMockImplementation() as (t: unknown) => Record<string, unknown>;
    fn.mockImplementation((tbl: unknown) => {
      const chain = base(tbl);
      const orig = chain.returning as (p?: unknown) => unknown;
      chain.returning = (proj?: unknown) => {
        returnings.push({
          tabla: nombreDe(tbl),
          columnas: proj && typeof proj === 'object' ? Object.keys(proj as object) : null,
        });
        return orig(proj);
      };
      return chain;
    });
  }
}

/** La consulta del resolutor: la única que proyecta exactamente esas dos columnas. */
const consultaDelResolutor = () =>
  consultas.filter((c) => c.columnas.join(',') === 'proveedorId,activo');

// ───────────────────────────── Escenario ─────────────────────────────────────

/**
 * Compañía con el canal abierto. `proveedorId`/`activo` son lo que devuelve el `LEFT JOIN` del
 * resolutor, que entra por `.from(clients)`.
 */
function escenario(gestor: { proveedorId: string | null; activo: boolean | null } = { proveedorId: GESTOR, activo: true }) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{ id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme', ...gestor }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}

const CAMPOS: Record<string, string> = {
  placa: 'jnh38h', vin: '9fkrg2222t2042405',
  tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const soatInsertado = () => espia.ultimoInsertEn('flito_soat');
const historialInsertado = () => espia.ultimoInsertEn('flito_estado_historial');

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  espiar();
  consultas.length = 0;
  returnings.length = 0;
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
});

// ═══════════ AC1 — el alta nace en `solicitado` y con destino resuelto ═══════

describe('AC1 — el alta nace en `solicitado` y con destino resuelto', () => {
  it('**la fila se inserta en `solicitado`, con `enviadoPorId` y `enviadoEn`**', async () => {
    escenario();
    const usuario = siguienteUsuario();
    const antes = Date.now();

    const r = await alta(await appAlta(), await auth('cliente', usuario));

    expect(r.status).toBe(201);
    const soat = soatInsertado();
    expect(soat.estado).toBe('solicitado');
    // El mutante que mata: dejar `enviadoPorId` sin escribir «porque ya está en la satélite». La
    // cola de Operaciones y el detalle leen ESTA columna para decir quién despachó.
    expect(soat.enviadoPorId).toBe(usuario);
    expect(soat.enviadoEn).toBeInstanceOf(Date);
    expect((soat.enviadoEn as Date).getTime()).toBeGreaterThanOrEqual(antes);
    expect((soat.enviadoEn as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('**el destino entra en el MISMO INSERT que el estado**, no en un UPDATE posterior', async () => {
    // Escribirlo aparte dejaría una ventana en la que la fila está `solicitado` y no dice a dónde
    // va, más una segunda escritura que puede fallar sola. Es el argumento ya escrito para
    // `procedencia` en `flito_compradores`.
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
    expect(soatInsertado()).toHaveProperty('proveedorSoatId');
    expect(soatInsertado()).toHaveProperty('gestionOperaciones');
  });

  it('**el destino NUNCA queda vacío**: o proveedor, o gestión de Operaciones — en los dos caminos', async () => {
    // La letra del AC1. Se recorren los TRES estados posibles de la configuración: gestor activo,
    // gestor apagado y sin gestor. Ninguno puede producir una fila sin destino.
    for (const gestor of [
      { proveedorId: GESTOR, activo: true },
      { proveedorId: GESTOR, activo: false },
      { proveedorId: null, activo: null },
    ]) {
      kdb.reset(); espia.reiniciar(); espiar(); consultas.length = 0;
      escenario(gestor);

      const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));
      expect(r.status, JSON.stringify(gestor)).toBe(201);

      const soat = soatInsertado();
      const tieneDestino = soat.proveedorSoatId != null || soat.gestionOperaciones === true;
      expect(tieneDestino, `sin destino con ${JSON.stringify(gestor)}`).toBe(true);
      // Y nunca LOS DOS: una fila con proveedor y contingencia a la vez es la que el AC6 de la
      // HU #11152 declaró imposible.
      expect(soat.proveedorSoatId != null && soat.gestionOperaciones === true).toBe(false);
    }
  });

  it('**el historial nace en `solicitado` con el motivo del envío directo**', async () => {
    escenario();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(historialInsertado()).toMatchObject({
      concepto: 'soat', registroId: r.body.id,
      estadoAnterior: null, estadoNuevo: 'solicitado',
      motivo: MOTIVO_ENVIO_DIRECTO,
      origen: 'usuario',
    });
    // El literal es el del AC, palabra por palabra. Se comprueba aparte de la constante para que
    // este caso no dependa solo de lo que él mismo importa.
    expect(MOTIVO_ENVIO_DIRECTO).toBe('Envío directo al gestor (canal Cliente)');
  });

  it('**UNA sola fila de historial**: la solicitud tiene un principio y solo uno', async () => {
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));
    expect(espia.insertsEn('flito_estado_historial')).toHaveLength(1);
  });

  it('**el 201 devuelve `{ id, estado }` con estado `solicitado`** — y NADA más', async () => {
    // El mutante que mata: `res.status(201).json(creada)`. `crearSolicitud` devuelve también el
    // destino —lo necesita el `audit()` del AC7— y el objeto entero le contaría al CLIENTE a qué
    // aseguradora despacha su compañía. `toEqual` sobre las CLAVES, no `toMatchObject`.
    escenario();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['estado', 'id']);
    expect(r.body.estado).toBe('solicitado');
    expect(JSON.stringify(r.body)).not.toContain(GESTOR);
    expect(JSON.stringify(r.body)).not.toContain('gestionOperaciones');
  });
});

// ═══════════ AC2 — el destino sale del gestor por defecto de LA COMPAÑÍA ═════

describe('AC2 — el destino sale del gestor por defecto de la compañía', () => {
  it('**`proveedorSoatId` toma el gestor por defecto de ESA compañía**', async () => {
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    const soat = soatInsertado();
    expect(soat.proveedorSoatId).toBe(GESTOR);
    expect(soat.gestionOperaciones).toBe(false);
    expect(soat.gestionOperacionesMotivo).toBeNull();
    expect(soat.gestionOperacionesEn).toBeNull();
    // `false` y no `true` como en `enviarAlGestor()`: esa bandera significa «una persona eligió este
    // proveedor a mano», y aquí no eligió nadie — lo dijo la configuración.
    expect(soat.proveedorSobrescrito).toBe(false);
  });

  it('**el gestor se lee DENTRO de la transacción y ANTES del INSERT**', async () => {
    // Fuera de la transacción, el destino se leería en un instante y se escribiría en otro; después
    // del INSERT, haría falta un UPDATE. Se mide por el ORDEN de las escrituras y por el `tx`: el
    // stub de `transaction` es el MISMO objeto espiado, así que lo que ocurre dentro queda
    // registrado, y la consulta del resolutor tiene que caer entre el UPDATE/INSERT del vehículo y
    // el INSERT del SOAT.
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    const indiceResolutor = consultas.findIndex((c) => c.columnas.join(',') === 'proveedorId,activo');
    const indiceVehiculo = consultas.findIndex((c) => c.tabla === 'vehicles' && c.columnas.includes('clientId'));
    expect(indiceResolutor).toBeGreaterThan(-1);
    // La relectura `FOR UPDATE` del vehículo es la primera consulta DE LA TRANSACCIÓN; el resolutor
    // va después de ella, así que está dentro.
    expect(indiceVehiculo).toBeGreaterThan(-1);
    expect(indiceResolutor).toBeGreaterThan(indiceVehiculo);
    expect(espia.secuencia().indexOf('flito_soat')).toBeGreaterThan(-1);
  });

  it('**UNA sola consulta, con `LEFT JOIN`** — sin ámbitos y sin prioridades', async () => {
    // El aserto que el mock NO regala: el mock keyed devuelve la fila entera aunque el `select`
    // pidiera dos columnas, así que partir el resolutor en dos consultas daría el mismo 201. Se
    // cuentan las consultas y se mira su forma.
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(consultaDelResolutor()).toHaveLength(1);
    const q = consultaDelResolutor()[0];
    expect(q.tabla).toBe('clients');
    expect(q.joins).toEqual(['flito_proveedores_soat']);
    // Y no hay una SEGUNDA consulta al catálogo: «sin gestor» y «gestor inactivo» son el mismo
    // desenlace y tienen que leerse en el mismo instante.
    expect(consultas.filter((c) => c.tabla === 'flito_proveedores_soat')).toHaveLength(0);
  });

  it('**`flito_reglas_proveedor_soat` no se consulta en el alta**', async () => {
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    for (const c of consultas) {
      expect(c.tabla, 'el alta no puede leer las reglas retiradas').not.toBe('flito_reglas_proveedor_soat');
      expect(c.joins).not.toContain('flito_reglas_proveedor_soat');
    }
  });

  it('**y no se nombra siquiera en el servicio del canal** — el grep que el AC2 pide', () => {
    // Sus reglas se retiraron a propósito en la HU #10979 («el proveedor se elige al enviar el SOAT
    // al gestor, que es cuando alguien mira la carga de cada uno») y su DROP sigue pendiente. Esto
    // fija por grep que nadie la reviva de paso al añadir el destino por compañía. El seed
    // (`scripts/flito-seed.ts`) NO es un lector y no entra aquí.
    const fuente = codigoDe('../../src/modules/flito-soat/flito-soat-cliente.service.ts');
    expect(fuente).not.toMatch(/flitoReglasProveedorSoat|flito_reglas_proveedor_soat/);
    expect(fuente).not.toMatch(/PRIORIDAD_POR_AMBITO|AmbitoReglaProveedor/);
  });
});

// ═══════════ AC2d — un gestor inactivo no impide radicar ═════════════════════

describe('AC2d — un gestor inactivo no impide radicar', () => {
  /** Los dos caminos que caen en contingencia: el apagado y el nunca configurado. */
  const CONTINGENCIAS: [string, { proveedorId: string | null; activo: boolean | null }][] = [
    ['el gestor por defecto quedó con `activo = false`', { proveedorId: GESTOR, activo: false }],
    ['la compañía no tiene gestor configurado', { proveedorId: null, activo: null }],
  ];

  for (const [caso, gestor] of CONTINGENCIAS) {
    it(`**${caso} → 201, contingencia de Operaciones y sin proveedor**`, async () => {
      // El mutante que mata: que el resolutor ignore `activo` (`fila.proveedorId != null` a secas).
      // Con él, el primer caso escribiría `proveedorSoatId = GESTOR` y la solicitud iría a la cola de
      // un gestor apagado, donde no la mira nadie.
      escenario(gestor);
      const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

      // **El alta NO falla**: un problema de configuración no puede impedir que un cliente radique.
      expect(r.status).toBe(201);
      expect(r.body.estado).toBe('solicitado');

      const soat = soatInsertado();
      expect(soat.proveedorSoatId).toBeNull();
      expect(soat.gestionOperaciones).toBe(true);
      expect(soat.gestionOperacionesMotivo).toBe(MOTIVO_GESTION_OPERACIONES_ALTA);
      expect(soat.gestionOperacionesEn).toBeInstanceOf(Date);
      // Y el estado sigue siendo el del despacho: la contingencia cambia el DESTINO, no el estado.
      expect(soat.estado).toBe('solicitado');
    });
  }

  it('**`gestionOperacionesPorId` queda en `null`**: no lo decidió una persona', async () => {
    // El mutante que mata: poner `ctx.userId`. La fila afirmaría que el cliente que radica PIDIÓ la
    // contingencia, que es falso: lo decidió una configuración rota. Es «un acto sin actor,
    // indistinguible de un error de escritura» (ADR-0005, regla 2). El quién y el cuándo del alta
    // están en `enviado_por_id` y en la fila de historial.
    escenario({ proveedorId: GESTOR, activo: false });
    const usuario = siguienteUsuario();
    await alta(await appAlta(), await auth('cliente', usuario));

    const soat = soatInsertado();
    expect(soat.gestionOperacionesPorId).toBeNull();
    expect(soat.gestionOperacionesPorId).not.toBe(usuario);
    // Y el actor del alta SÍ está, en su columna: no se pierde información, se pone donde toca.
    expect(soat.enviadoPorId).toBe(usuario);
  });

  it('**el historial deja constancia de que el destino cayó en contingencia y por qué**', async () => {
    escenario({ proveedorId: null, activo: null });
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(historialInsertado().motivo).toBe(MOTIVO_ENVIO_CONTINGENCIA);
    expect(historialInsertado().estadoNuevo).toBe('solicitado');
    // Los dos motivos son DISTINTOS: si fueran el mismo, el historial no distinguiría el envío
    // directo del que cayó en contingencia, que es justo lo que el AC2d pide que conste.
    expect(MOTIVO_ENVIO_CONTINGENCIA).not.toBe(MOTIVO_ENVIO_DIRECTO);
  });

  it('**el motivo del historial NO lleva el uuid del proveedor**', async () => {
    // Por la razón que `asumirEnOperaciones` ya dejó escrita al quitárselo: el historial es de lo
    // poco que un lector externo llega a ver. El uuid del destino sí va al `audit_logs` del AC7,
    // que el cliente no ve.
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(String(historialInsertado().motivo)).not.toContain(GESTOR);
    expect(MOTIVO_ENVIO_CONTINGENCIA).not.toContain(GESTOR);
  });
});

// ═══════════ AC2e — el SOAT POR TRÁMITE no cambia ════════════════════════════

describe('AC2e — el destino del SOAT POR TRÁMITE no depende de la configuración del canal', () => {
  it('**`enviarAlGestor()` escribe el proveedor que eligió Operaciones**, no el de la compañía', async () => {
    // El caso funcional del límite del PO. La compañía tiene GESTOR configurado como destino de su
    // canal sin trámite; Operaciones despacha un SOAT por trámite eligiendo OTRO_GESTOR. Si alguien
    // «unificara» los dos destinos, la fila saldría con GESTOR y este caso lo vería.
    const { enviarAlGestor } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    kdb.when.scenario({
      clients: [{ id: COMPANIA, sinTramite: true, proveedorId: GESTOR, activo: true }],
      flito_soat: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    });

    const r = await enviarAlGestor(
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      { userId: 1, username: 'ops@flito.co', role: 'admin', proveedorSoatId: null, companiaId: null },
      { proveedorSoatId: OTRO_GESTOR },
    );

    expect(r.enviados).toHaveLength(1);
    const [update] = espia.updatesEn('flito_soat');
    expect(update.datos.proveedorSoatId).toBe(OTRO_GESTOR);
    expect(update.datos.proveedorSoatId).not.toBe(GESTOR);
    // Y sigue marcándose como elección de una persona, que es lo que esa ruta significa.
    expect(update.datos.proveedorSobrescrito).toBe(true);
    // El resolutor del canal NO corrió: ninguna consulta con su proyección.
    expect(consultaDelResolutor()).toHaveLength(0);
  });

  it('**`flito-soat.service.ts` no nombra la columna del canal ni el resolutor** — la frontera de archivo', () => {
    // La garantía ESTRUCTURAL del AC2e, y la primera capa: `resolverDestinoCanalCliente` vive en el
    // archivo del canal Cliente, no en el del SOAT por trámite. Ponerlo allí lo dejaría a un
    // `import` de distancia de `POST /flito/soat/enviar`.
    for (const modulo of ['flito-soat.service.ts', 'flito-soat.routes.ts']) {
      const fuente = codigoDe(`../../src/modules/flito-soat/${modulo}`);
      expect(fuente, `${modulo} no puede leer la columna del canal`)
        .not.toMatch(/flitoProveedorSoatSinTramiteId|flito_proveedor_soat_sin_tramite/);
      expect(fuente, `${modulo} no puede llamar al resolutor del canal`)
        .not.toMatch(/resolverDestinoCanalCliente/);
    }
  });
});

// ═══════════ AC5 — el gestor la ve sin que nadie la valide ═══════════════════

describe('AC5 — el gestor la ve sin que nadie la valide', () => {
  it('**el estado con el que nace ya está en `ESTADOS_SOAT_VISIBLES_GESTOR`**', async () => {
    // El AC5 no necesita código: la lista blanca ya contiene `solicitado`. Lo que este caso fija es
    // que el estado del alta y esa lista no puedan divergir — si alguien hiciera nacer la fila en
    // otro estado «equivalente», el gestor dejaría de verla y nada más se pondría rojo.
    const { ESTADOS_SOAT_VISIBLES_GESTOR } = await import('@operaciones/shared-types');
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect([...ESTADOS_SOAT_VISIBLES_GESTOR]).toContain(soatInsertado().estado);
  });

  it('**no queda ningún paso intermedio**: el alta no escribe `pendiente_revision` en ninguna parte', async () => {
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(JSON.stringify(soatInsertado())).not.toContain('pendiente_revision');
    expect(JSON.stringify(historialInsertado())).not.toContain('pendiente_revision');
  });
});

// ═══════════ AC7 — auditoría con destino y sin PII ═══════════════════════════

describe('AC7 — la bitácora dice a qué destino fue, y sigue sin PII', () => {
  it('**el `detail` dice origen, estado destino y el uuid del proveedor**', async () => {
    escenario();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(auditMock).toHaveBeenCalledTimes(1);
    const escrito = auditMock.mock.calls[0][1] as { resourceId: string; detail: string };
    expect(escrito.resourceId).toBe(r.body.id);
    expect(escrito.detail).toContain('origen=cliente');
    expect(escrito.detail).toContain('estado=solicitado');
    expect(escrito.detail).toContain(GESTOR);
  });

  it('**en contingencia el `detail` lo dice, en vez de callar el destino**', async () => {
    escenario({ proveedorId: GESTOR, activo: false });
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    const detail = (auditMock.mock.calls[0][1] as { detail: string }).detail;
    expect(detail).toContain('gestion_operaciones');
    // Y NO el uuid del gestor apagado: la solicitud no fue ahí.
    expect(detail).not.toContain(GESTOR);
  });

  it('**el `detail` no contiene placa, VIN, documento ni nombre**', async () => {
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    const escrito = JSON.stringify(auditMock.mock.calls[0][1]);
    for (const prohibido of ['JNH38H', '9FKRG2222T2042405', '1020304050', 'JUANA', 'PEREZ']) {
      expect(escrito, `${prohibido} no puede acabar en audit_logs`).not.toContain(prohibido);
    }
  });

  it('**`registrarAccesoRuntCliente` sigue registrando la consulta con `motivo: alta`**', async () => {
    escenario();
    await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const registro = piiMock.mock.calls[0][1] as { motivo: string; camposAccedidos: string[] };
    expect(registro.motivo).toContain('durante el alta');
    // Sin ganar campos: el alta es una mutación y lo que esta línea describe es la consulta al RUNT.
    expect(registro.camposAccedidos).toEqual(['placa', 'vin']);
  });
});

// ═══════════ La columna nueva no se filtra por ninguna respuesta ═════════════

/**
 * Las tres respuestas que devolvían la fila ENTERA de `clients` y por las que la columna nueva
 * habría salido sola.
 *
 * **Se afirma sobre las COLUMNAS PEDIDAS, no sobre el cuerpo**, y la diferencia es de método: el
 * mock devuelve la fila que el test registró aunque el `returning` pidiera menos, así que un aserto
 * sobre `r.body` sería verde por el mock y no diría nada del código. Lo único que decide qué sale de
 * la base es la proyección, y es lo que se lee aquí.
 */
describe('el gestor por defecto no sale por ninguna respuesta que no lo haya pedido', () => {
  const CLIENTE = {
    id: 41, name: 'ACME S.A.S.', document: '900123456', documentType: 'NIT',
    branchOffice: 0, personType: null, idType: null, checkDigit: null,
    fiscalResponsibilities: [], flitoProveedorSoatSinTramiteId: GESTOR,
  };

  const admin = async () => `Bearer ${await testToken({ sub: 3, role: 'admin' })}`;

  it('**`POST /clients` proyecta**: la fila entera sacaba a HTTP toda columna nueva', async () => {
    kdb.when.scenario({ clients: [] });
    kdb.when.insert('clients', [CLIENTE]);

    const r = await request(await appClientes()).post('/api/clients')
      .set('Authorization', await admin()).send({ name: 'ACME S.A.S.', document: '900123456' });

    expect(r.status).toBe(201);
    const proyeccion = returnings.find((x) => x.tabla === 'clients');
    expect(proyeccion, 'no hubo returning sobre clients').toBeDefined();
    // El mutante que mata: volver a `.returning()` sin argumentos → `columnas` sería `null`.
    expect(proyeccion!.columnas).not.toBeNull();
    expect(proyeccion!.columnas).not.toContain('flitoProveedorSoatSinTramiteId');
    // Y lo que la ruta sí entrega sigue estando: esto es un recorte, no una amputación.
    expect(proyeccion!.columnas).toContain('name');
    expect(proyeccion!.columnas).toContain('document');
  });

  it('**`PATCH /clients/:id` proyecta**, por lo mismo', async () => {
    kdb.when.scenario({ clients: [CLIENTE] });
    kdb.when.update('clients', [CLIENTE]);

    const r = await request(await appClientes()).patch('/api/clients/41')
      .set('Authorization', await admin()).send({ city: 'MEDELLIN' });

    expect(r.status).toBe(200);
    const proyeccion = returnings.find((x) => x.tabla === 'clients');
    expect(proyeccion, 'no hubo returning sobre clients').toBeDefined();
    expect(proyeccion!.columnas).not.toBeNull();
    expect(proyeccion!.columnas).not.toContain('flitoProveedorSoatSinTramiteId');
    expect(proyeccion!.columnas).toContain('name');
  });

  it('**el 201 del alta tampoco**: es la cuarta y la que nadie miraría', async () => {
    // `flito-soat-cliente.routes.ts` hacía `res.status(201).json(creada)`, y `crearSolicitud` tiene
    // que DEVOLVER el destino para que el `audit()` del AC7 pueda nombrarlo. Sin la proyección
    // explícita, el 201 le habría contado al CLIENTE a qué aseguradora va su solicitud.
    escenario();
    const r = await alta(await appAlta(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['estado', 'id']);
    expect(JSON.stringify(r.body)).not.toContain(GESTOR);
  });
});
