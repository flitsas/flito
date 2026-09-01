// HU #11966 — `GET /flito/soat/:id` entrega el propietario PARTIDO de una solicitud del canal.
//
// Sale del UX slim de la #11967 §6, y el problema que resuelve es concreto: con el propietario
// partido del AC5 y el `subsanacionSchema` exigiendo nombres/apellidos —o razón social— más
// municipio y departamento, la pantalla de subsanación obligaría al Cliente a **reteclear a ciegas**
// datos que ya están guardados. El detalle proyectaba solo `{ nombreCompleto, numeroDocumento,
// tipoDocumento, orden, porcentajeParticipacion }` en `compradores`.
//
// ── Las DOS mitades, y la segunda es la que importa ─────────────────────────────────────────────
//
// Ampliar una respuesta con PII es ampliar superficie. Este archivo afirma las dos:
//
//   1. **Que sale**: el dueño de una fila `origen='cliente'` recibe la clave `propietarioCanal` con
//      el titular partido, el contacto y el domicilio, y la ruta declara esos campos en
//      `pii_access_log`.
//   2. **Que NO se desborda**: una fila de TRÁMITE no gana ni una clave; la COLA no cambia ni un
//      campo; y el GESTOR del proveedor no la recibe ni aunque la solicitud esté en su cola.
//
// Sin la segunda mitad, esto sería una ampliación de superficie sin prueba de contención.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
const piiMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));

const COMPANIA = 7;
const OTRA_COMPANIA = 99;
const SOAT_ID = '22222222-2222-2222-2222-222222222222';
const PROVEEDOR = '33333333-3333-3333-3333-333333333333';

/**
 * Datos sintéticos: ni una cédula ni un correo reales.
 *
 * `municipio` y `departamento` son centinelas y NO «FUNZA»/«CUNDINAMARCA» a propósito: el organismo
 * de la fixture se llama FUNZA y la cola lo publica en `organismoNombre`, así que un municipio con
 * ese valor haría pasar en verde el aserto de no-fuga de la cola por pura colisión de cadenas.
 */
const TITULAR = {
  tipoDocumento: 'CC',
  nombres: 'JUANA',
  apellidos: 'PEREZ SINTETICA',
  razonSocial: null,
  numeroDocumento: '1020304050',
  correo: 'juana@empresa.co',
  celular: '3001234567',
  direccion: 'CALLE 1 # 2-3',
  municipio: 'CENTINELA-MUNICIPIO-TITULAR',
  departamento: 'CENTINELA-DEPARTAMENTO-TITULAR',
} as const;

/**
 * Las proyecciones de cada `select`, por tabla — el único aserto inmune al mock.
 *
 * `keyed-db` devuelve la fila ENTERA que el escenario registró, sin recortarla a las claves del
 * `select`: comparar el cuerpo de la respuesta con `toEqual` diría que la proyección trae `id`,
 * `orden` y `tramite_id` cuando el servicio no los pide. Lo que decide qué columnas SALEN de la base
 * es la proyección, y aquí se lee.
 */
const proyecciones: { tabla: string; columnas: string[] }[] = [];

function espiarProyecciones(): void {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = base(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => {
      let tabla = '__expr__';
      try { tabla = String((tbl as { [k: symbol]: unknown })?.constructor && getTableName(tbl as never)); } catch { /* no es tabla */ }
      proyecciones.push({ tabla, columnas });
      return from(tbl);
    };
    return chain;
  });
}

/**
 * La fila de `flito_soat` tal como la devuelve `buscarConAcceso`: `{ soat, dentroDeFrontera }`.
 *
 * El mock keyed no evalúa la proyección, así que la MISMA fila sirve para las dos lecturas que hace
 * `detalle()` —`buscarConAcceso` y la del DTO—: la primera lee `.soat`, la segunda las claves
 * planas. Por eso van las dos formas en el mismo objeto.
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
    soat,
    dentroDeFrontera: true,
    ...soat,
    placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
    cilindraje: '1598', carroceria: 'WAGON', tipoServicio: 'Particular',
    companiaNombre: 'ACME', organismoNombre: 'FUNZA',
    proveedorSoatNombre: null, proveedorSlaHoras: null, enviadoPorNombre: null,
  };
};

function escenario(over: Partial<Record<string, unknown[]>> = {}, companiaUsuario: number | null = COMPANIA) {
  kdb.when.scenario({
    users: [{ c: companiaUsuario, s: null }],
    flito_soat: [filaSoat()],
    flito_tramites: [],
    flito_compradores: [{ id: 'c1', soatId: SOAT_ID, tramiteId: null, orden: 0, porcentajeParticipacion: null, nombreCompleto: 'JUANA PEREZ SINTETICA', ...TITULAR }],
    flito_soat_solicitud: [{
      solicitadoEn: new Date('2026-09-01T10:00:00Z'), revisadoPorNombre: null, revisadoEn: null,
      nombre: null, observacion: null, reenvios: 0,
      verificacionEstado: 'ok', soatVigente: false, soatVigenteHasta: null, verificacionCodigo: null,
    }],
    ...(over as Record<string, unknown[]>),
  });
}

let sub = 400;
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: TestRole, extra: Record<string, unknown> = {}) =>
  `Bearer ${await testToken({ sub: ++sub, username: 'u@empresa.co', role, ...extra } as never)}`;

const detalle = async (token: string) =>
  request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}`).set('Authorization', token);

beforeEach(() => {
  kdb.reset();
  espiarProyecciones();
  proyecciones.length = 0;
  piiMock.mockClear();
});

// ═══════════════ Mitad 1 — que SALE ══════════════════════════════════════════

describe('el dueño de una solicitud del canal recibe el propietario guardado', () => {
  it('**el `cliente` de la compañía recibe `propietarioCanal` con el titular partido y su domicilio**', async () => {
    escenario();
    const r = await detalle(await auth('cliente'));

    expect(r.status).toBe(200);
    expect(r.body.propietarioCanal).toMatchObject(TITULAR);

    // **Y la proyección de la lectura del propietario es EXACTAMENTE esa lista** — el aserto que el
    // mock no puede regalar (devuelve la fila entera aunque el `select` pidiera menos). Escrito
    // campo a campo, igual que el export (RN-E1): `select()` sin proyección traería la fila completa
    // y una columna personal que alguien añada mañana saldría por esta ruta por el mero hecho de
    // existir. `orden` y `nombre_completo` no están a propósito: el primero no significa nada con un
    // solo propietario y el segundo ya va en `compradores`.
    const delPropietario = proyecciones.filter((p) => p.tabla === 'flito_compradores').at(-1);
    expect(delPropietario?.columnas.sort()).toEqual([
      'apellidos', 'celular', 'correo', 'departamento', 'direccion', 'municipio',
      'nombres', 'numeroDocumento', 'razonSocial', 'tipoDocumento',
    ]);
  });

  it('el `admin` que revisa también lo recibe: es quien valida esos datos contra la factura', async () => {
    escenario();
    const r = await detalle(await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body.propietarioCanal).toMatchObject({ nombres: TITULAR.nombres, municipio: TITULAR.municipio });
  });

  it('una fila del canal con NIT devuelve la razón social y nombres/apellidos en null', async () => {
    escenario({
      flito_compradores: [{
        id: 'c1', soatId: SOAT_ID, tramiteId: null, orden: 0, porcentajeParticipacion: null,
        nombreCompleto: 'TRANSPORTES SINTETICOS SAS',
        tipoDocumento: 'NIT', nombres: null, apellidos: null, razonSocial: 'TRANSPORTES SINTETICOS SAS',
        numeroDocumento: '9001234561', correo: 'contacto@empresa.co', celular: '3001234567',
        direccion: 'CALLE 1 # 2-3', municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
      }],
    });

    const r = await detalle(await auth('cliente'));
    expect(r.body.propietarioCanal).toMatchObject({
      razonSocial: 'TRANSPORTES SINTETICOS SAS', nombres: null, apellidos: null,
    });
  });

  it('sin fila de propietario, la clave viaja en `null` y el detalle SALE igual', async () => {
    escenario({ flito_compradores: [] });
    const r = await detalle(await auth('cliente'));
    expect(r.status).toBe(200);
    expect(r.body.propietarioCanal).toBeNull();
  });

  it('**la ruta DECLARA la PII que entrega**, y no la de la cola', async () => {
    // Es la regla que `flito-soat.pii.ts` se aplica desde su primera línea: quien añade una columna
    // personal a lo que una ruta devuelve, la declara en la misma edición. El mutante que mata:
    // dejar la llamada con los campos por defecto.
    escenario();
    await detalle(await auth('cliente'));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const campos = piiMock.mock.calls[0][1].camposAccedidos as string[];
    for (const c of ['nombres', 'apellidos', 'razon_social', 'correo', 'celular', 'direccion', 'municipio', 'departamento']) {
      expect(campos, `falta ${c} en camposAccedidos`).toContain(c);
    }
    // Y lo que ya declaraba sigue estando: la lista AMPLÍA, no sustituye.
    expect(campos).toEqual(expect.arrayContaining(['nombre_completo', 'numero_documento', 'tipo_documento', 'placa', 'vin']));
  });

  it('el motivo del rastro no lleva placa ni documento: solo el uuid, que es opaco', async () => {
    escenario();
    await detalle(await auth('cliente'));
    const motivo = String(piiMock.mock.calls[0][1].motivo);
    expect(motivo).toContain(SOAT_ID);
    expect(motivo).not.toContain('JNH38H');
    expect(motivo).not.toContain(TITULAR.numeroDocumento);
  });
});

// ═══════════════ Mitad 2 — que NO se desborda ════════════════════════════════

describe('la contención: fila de trámite, cola y gestor NO cambian', () => {
  it('**una fila `origen=tramite` no gana la clave, ni siquiera en `null`**', async () => {
    // Bifurcar por «no encontré propietario por trámite» habría hecho que un SOAT de trámite
    // huérfano publicara el domicilio del titular. Es el mismo criterio que el export: por `origen`.
    escenario({ flito_soat: [filaSoat({ origen: 'tramite', estado: 'pendiente' })] });

    const r = await detalle(await auth('admin'));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).not.toContain('propietarioCanal');
  });

  it('y su rastro de PII sigue declarando exactamente lo de siempre', async () => {
    escenario({ flito_soat: [filaSoat({ origen: 'tramite', estado: 'pendiente' })] });
    await detalle(await auth('admin'));

    const campos = piiMock.mock.calls[0][1].camposAccedidos as string[];
    expect(campos).toEqual(['nombre_completo', 'numero_documento', 'tipo_documento', 'placa', 'vin']);
    // Declarar de más hace que `campos_accedidos` deje de decir la verdad, que es lo único que ese
    // registro tiene que hacer. Ya fue un bloqueante en este módulo.
    for (const c of ['correo', 'municipio', 'departamento']) {
      expect(campos, `${c} no se entrega en una fila de trámite`).not.toContain(c);
    }
  });

  it('**el `cliente` de OTRA compañía no distingue «no es tuya» de «no existe»: 404 y sin PII**', async () => {
    escenario({}, OTRA_COMPANIA);

    const r = await detalle(await auth('cliente'));
    expect(r.status).toBe(404);
    expect(r.body.propietarioCanal).toBeUndefined();
    // Un 404 no entregó datos de nadie: no se registra. La guarda de propiedad de esta clave ES
    // `buscarConAcceso`, y esto lo demuestra.
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('**el GESTOR del proveedor NO lo recibe**, aunque la solicitud esté en su cola', async () => {
    // Una solicitud validada entra en `solicitado` y el gestor la abre con todo derecho. El correo,
    // el teléfono y el domicilio del titular no son suyos — mismo corte que `revisionDeSolicitud`.
    escenario({
      // `contextoSoat` lee el proveedor de la BASE y no del JWT: sin esta clave el gestor entra con
      // `proveedorSoatId: null`, `buscarConAcceso` le da 404 y el caso no probaría nada — pasaría en
      // verde por la puerta equivocada.
      users: [{ p: PROVEEDOR, c: null, s: null }],
      flito_soat: [filaSoat({ estado: 'solicitado', proveedorSoatId: PROVEEDOR })],
      flito_proveedores_soat: [{ id: PROVEEDOR }],
    });

    const r = await detalle(await auth('proveedor'));
    // 200: la solicitud SÍ está en su cola y la abre con todo derecho…
    expect(r.status).toBe(200);
    // …y aun así no recibe el titular ni su contacto.
    expect(r.body.propietarioCanal ?? null).toBeNull();
    const cuerpo = JSON.stringify(r.body);
    for (const secreto of [TITULAR.correo, TITULAR.celular, TITULAR.direccion, TITULAR.municipio, TITULAR.departamento]) {
      expect(cuerpo, 'el gestor del proveedor no ve los datos personales del titular').not.toContain(secreto);
    }
    // Y la consulta ni se emite: no es que se lea y se recorte después.
    expect(proyecciones.filter((p) => p.tabla === 'flito_compradores' && p.columnas.includes('municipio')))
      .toHaveLength(0);
  });

  it('**la COLA no cambia: ningún campo nuevo por fila**', async () => {
    // La proyección de `compradores` la comparten `cola()` y `detalle()` (`ensamblarCola`), así que
    // ampliarla habría publicado correo, celular, dirección y domicilio EN CADA FILA del listado —
    // una fuga multiplicada por página. Este aserto es la razón por la que `propietarioCanal` es una
    // clave aparte del detalle y no un campo más de `compradores`.
    escenario();
    kdb.when.select('flito_soat', [{ total: 1, ...filaSoat() }]);

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);

    const cuerpo = JSON.stringify(r.body);
    for (const secreto of [TITULAR.correo, TITULAR.celular, TITULAR.direccion, TITULAR.municipio, TITULAR.departamento]) {
      expect(cuerpo, 'la cola no puede publicar el contacto ni el domicilio del titular').not.toContain(secreto);
    }
    expect(cuerpo).not.toContain('propietarioCanal');
    // Y las claves de `compradores` siguen siendo las cinco de siempre.
    const comprador = r.body.items?.[0]?.compradores?.[0];
    if (comprador) {
      expect(Object.keys(comprador).sort())
        .toEqual(['nombreCompleto', 'numeroDocumento', 'orden', 'porcentajeParticipacion', 'tipoDocumento']);
    }
  });
});
