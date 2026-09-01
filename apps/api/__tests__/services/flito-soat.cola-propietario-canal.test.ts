// HU #11914 (Feature #11912) — la cola enseña el propietario de una solicitud del canal Cliente.
//
// ── El agujero que esto cierra ───────────────────────────────────────────────────────────────────
//
// `flito_compradores` cuelga de DOS padres desde la migración 0167, con un CHECK que exige uno y
// solo uno: `tramite_id` (el flujo de siempre) o `soat_id` (el canal Cliente). `ensamblarCola` leía
// únicamente por el primero, así que una fila del canal —que tiene `tramite_id IS NULL`— salía con
// `compradores: []`.
//
// No es un detalle de la pantalla de revisión del admin: quien radica la solicitud abre su ÚNICA
// pantalla y ve su fila **sin el propietario que acaba de teclear**. El dato se captura, se valida
// contra el catálogo RUNT y se persiste en esta HU; que ninguna pantalla lo muestre es esta HU a
// medio entregar, no un pendiente de la #11915.
//
// ── Cómo está montado ────────────────────────────────────────────────────────────────────────────
//
// Las respuestas se encolan por POSICIÓN, que es como lo hacen los demás tests de esta cola, y aquí
// esa rigidez es justo lo que se quiere: la lectura nueva añade una consulta y el orden en que
// aparece ES parte de lo que se comprueba. `chainProyectado` devuelve solo las claves que el
// `select({…})` pidió —como PostgreSQL—, para que el mock no invente columnas que la consulta no
// trajo. Con el chain normal, un test así seguiría verde aunque la proyección dejara de pedirlas.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
    // La cola registra el acceso a PII desde la HU #11913: sin un `insert` utilizable, el helper
    // falla, lo atrapa su propio catch y la salida se llena de ERROR que no son de esta prueba.
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string, sub = 1) => `Bearer ${await testToken({ sub, username: 'u', role: role as never })}`;

/** Chain que RESPETA la proyección: de cada fila devuelve solo lo que el `select({…})` pidió. */
function chainProyectado(proyeccion: Record<string, unknown>, filas: Record<string, unknown>[]) {
  const claves = Object.keys(proyeccion);
  return chain(filas.map((f) => Object.fromEntries(claves.map((k) => [k, k in f ? f[k] : null]))));
}

const SOAT_CANAL = '00000000-0000-0000-0000-0000000000c1';
const SOAT_TRAMITE = '00000000-0000-0000-0000-0000000000t1'.replace('t', 'a');

/** Fila de la cola tal como sale del join `flito_soat` × `vehicles` × … */
const filaCola = (over: Record<string, unknown> = {}) => ({
  id: SOAT_CANAL, vin: '9FKRG2222T2042405', estado: 'pendiente_revision', origen: 'cliente',
  proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
  valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-08-29T12:00:00.000Z'),
  placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
  cilindraje: '1598', carroceria: null, tipoServicio: 'Particular',
  companiaNombre: 'ACME SAS', organismoNombre: 'FUNZA', proveedorSoatNombre: null,
  proveedorSlaHoras: null, enviadoPorNombre: null,
  ...over,
});

/** Propietario tal como lo dejó el alta del canal: colgado de `soat_id`, sin trámite. */
const propietarioCanal = (over: Record<string, unknown> = {}) => ({
  id: 'p1', tramiteId: null, soatId: SOAT_CANAL,
  nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050', tipoDocumento: 'CC',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  orden: 0, porcentajeParticipacion: null, ...over,
});

describe('cola SOAT — el propietario de una solicitud del canal Cliente sale en su fila', () => {
  it('**una fila con `origen = cliente` trae su propietario, leído por `soat_id`**', async () => {
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));                        // conteo
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()])); // página
    selectMock.mockImplementationOnce(() => chain([]));                                    // trámites: ninguno
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));                  // propietario por soat_id

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    // Con el VALOR, no solo la longitud: un `[{}]` pasaría un `toHaveLength(1)`.
    //
    // **`tipoDocumento: null` aunque la fila de la BD traiga `tipo_documento: 'CC'`** (HU #11947):
    // el DTO publica el código resuelto desde `flit_raw->>'tipo'` del TRÁMITE, y una solicitud del
    // canal no tiene trámite —luego no tiene payload, luego no tiene tipo—. Sale por la rama por
    // defecto y sin un `if` de origen. Publicar la columna homónima daría `CC` justo aquí y vacío en
    // el 100 % de las filas del sync, que es exactamente al revés de lo que hace falta.
    expect(r.body.items[0].compradores).toEqual([
      { nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050', tipoDocumento: null, orden: 0, porcentajeParticipacion: null },
    ]);
    // No tiene trámite y no se lo inventa: es una solicitud sin trámite digital, ese es el canal.
    expect(r.body.items[0].tramitesFlit).toEqual([]);
    expect(r.body.items[0].tipoPropiedad).toBe('unico_propietario');
  });

  it('**el CLIENTE que la radicó ve al propietario que tecleó** (su fila, su única pantalla)', async () => {
    selectMock.mockImplementationOnce(() => chain([{ c: 7 }]));                             // contextoSoat
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));                         // conteo
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()])); // página
    selectMock.mockImplementationOnce(() => chain([]));                                     // trámites
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));                   // propietario

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
    expect(r.body.items[0].compradores[0]).toMatchObject({ nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050' });
    // Y la proyección por rol sigue quitándole lo interno: esto AÑADE un dato suyo, no abre el DTO.
    for (const interno of ['proveedorSoatId', 'proveedorSoatNombre', 'gestionOperaciones', 'valorPagado', 'enviadoPorNombre']) {
      expect(Object.keys(r.body.items[0])).not.toContain(interno);
    }
  });

  it('página MIXTA: cada fila se queda con su propietario y ninguno se cruza', async () => {
    const filaTramite = filaCola({ id: SOAT_TRAMITE, origen: 'tramite', vin: 'JN1TG4E28AW000111', estado: 'pendiente' });
    selectMock.mockImplementationOnce(() => chain([{ total: 2 }]));                                    // conteo
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola(), filaTramite])); // página
    selectMock.mockImplementationOnce(() => chain([{ id: 'tr1', soatId: SOAT_TRAMITE, idFlit: 'FLIT-1', tipoPropiedad: 'unico_propietario', tipoTramite: 'Traspaso', fechaAprobacion: null, fechaCreacion: null }]));
    selectMock.mockImplementationOnce(() => chain([{ id: 'p2', tramiteId: 'tr1', soatId: null, nombreCompleto: 'PEDRO GOMEZ', numeroDocumento: '999', orden: 0, porcentajeParticipacion: null }]));
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));                              // propietario del canal

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);

    const canal = r.body.items.find((i: { id: string }) => i.id === SOAT_CANAL);
    const tramite = r.body.items.find((i: { id: string }) => i.id === SOAT_TRAMITE);
    expect(canal.compradores.map((c: { nombreCompleto: string }) => c.nombreCompleto)).toEqual(['JUANA PEREZ']);
    expect(tramite.compradores.map((c: { nombreCompleto: string }) => c.nombreCompleto)).toEqual(['PEDRO GOMEZ']);
    // La vía vieja sigue intacta: la fila de trámite conserva su `tramitesFlit`.
    expect(tramite.tramitesFlit).toEqual(['FLIT-1']);
  });

  it('una cola de PURO trámite no paga la consulta nueva — por eso `origen` está en la proyección', async () => {
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola({ origen: 'tramite' })]));
    selectMock.mockImplementationOnce(() => chain([])); // trámites: ninguno → tampoco compradores

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    // Tres consultas y ni una más. Es lo que hace que los mocks posicionales de las pruebas de la
    // #11913 —cuyas filas son todas de trámite— sigan encolando lo que encolaban.
    expect(selectMock).toHaveBeenCalledTimes(3);
    expect(r.body.items[0].compradores).toEqual([]);
  });

  it('el detalle de una solicitud del canal también trae al propietario', async () => {
    selectMock.mockImplementationOnce(() => chain([{ soat: { id: SOAT_CANAL, companiaId: 7, estado: 'pendiente_revision', proveedorSoatId: null, gestionOperaciones: false, pagadoEn: null, extraccion: null }, dentroDeFrontera: true }])); // buscarConAcceso
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()])); // la fila del detalle
    selectMock.mockImplementationOnce(() => chain([]));                                    // trámites
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));                  // propietario

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_CANAL}`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body.compradores[0]).toMatchObject({ nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050' });
  });

  it('**el tipo de documento sale del `tipo` del TRÁMITE dueño de cada comprador** (HU #11947)', async () => {
    // Página mixta otra vez, y aquí la pregunta es otra: de dónde sale `tipoDocumento`.
    //
    //   · la fila del canal cuelga de `soat_id`, no tiene trámite → `null`, aunque su columna
    //     `tipo_documento` diga `CC`;
    //   · la fila de trámite cuelga de SU trámite → el código RESUELTO de `flit_raw->>'tipo'`
    //     (`n` → `NIT`), y **no** el crudo, que es lo que hace cumplible el AC6.
    //
    // Aquí NO se reconcilia con `comun()`: cada comprador cuelga de un trámite concreto y la
    // relación es 1:1. Pasarlo por `comun()` vaciaría el dato de dos propietarios correctos porque
    // sus trámites discrepan entre sí.
    const filaTramite = filaCola({ id: SOAT_TRAMITE, origen: 'tramite', vin: 'JN1TG4E28AW000111', estado: 'pendiente' });
    selectMock.mockImplementationOnce(() => chain([{ total: 2 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola(), filaTramite]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [{
      id: 'tr1', soatId: SOAT_TRAMITE, idFlit: 'FLIT-1', tipoPropiedad: 'unico_propietario',
      tipoTramite: 'Traspaso', fechaAprobacion: null, fechaCreacion: null,
      // La clave `tipo` del payload, ya extraída por la expresión `->>`.
      tipoTitularFlit: 'n',
    }]));
    selectMock.mockImplementationOnce(() => chain([{ id: 'p2', tramiteId: 'tr1', soatId: null, nombreCompleto: 'TRANSPORTES ABC SAS', numeroDocumento: '9001234561', tipoDocumento: null, orden: 0, porcentajeParticipacion: null }]));
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);

    const canal = r.body.items.find((i: { id: string }) => i.id === SOAT_CANAL);
    const tramite = r.body.items.find((i: { id: string }) => i.id === SOAT_TRAMITE);

    expect(tramite.compradores[0].tipoDocumento).toBe('NIT');
    // El crudo de FLIT no sale del API: si viajara, cada página necesitaría su copia de la tabla.
    expect(tramite.compradores[0].tipoDocumento).not.toBe('n');
    expect(JSON.stringify(r.body)).not.toContain('"n"');
    // Y el del canal sigue vacío en la MISMA respuesta: los dos casos no se cruzan.
    expect(canal.compradores[0].tipoDocumento).toBeNull();
  });

  it('`origen` es de uso interno: decide por qué padre leer, y NO viaja al DTO', async () => {
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()]));
    selectMock.mockImplementationOnce(() => chain([]));
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(Object.keys(r.body.items[0])).not.toContain('origen');
  });
});
