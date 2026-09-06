// HU #12078 (Feature #12074) — al GESTOR no se le dice QUIÉN radicó una solicitud del canal Cliente.
//
// ── El bloqueante que esto cierra ────────────────────────────────────────────────────────────────
//
// Hasta esta HU, una solicitud del canal nacía con `enviado_por_id = NULL` y solo `enviarAlGestor()`
// lo rellenaba —con el id del ADMIN de FLIT que la validaba—, así que lo que el gestor veía en
// `enviadoPorNombre` era siempre un empleado de FLIT. Desde la #12078 **el alta ES el envío**: la
// fila nace en `solicitado`, con `proveedorSoatId` puesto y con `enviado_por_id = ctx.userId`, que en
// este canal es **un empleado de la compañía cliente**. Entra de inmediato en la cola del gestor, y
// el gestor (rol `proveedor`) es una EMPRESA EXTERNA.
//
// Es la imagen espejo exacta de lo que `CAMPOS_SOLO_INTERNOS` ya prohíbe en la otra dirección
// («nombre del EMPLEADO de FLIT que la despachó; dato personal de un trabajador entregado a otra
// empresa»), en el sentido que nadie había mirado porque hasta hoy no existía.
//
// **Decisión tomada**: el gestor deja de ver ese nombre. `enviadoPorId` se conserva —Operaciones y la
// propia compañía siguen sabiendo quién radicó—; lo que no se emite es el NOMBRE, y solo al rol
// `proveedor`, y solo en filas de origen `cliente`. Si hay un problema con una solicitud, el
// interlocutor del gestor es la compañía (`companiaNombre`, que sí viaja), no la persona.
//
// ── Cómo se mide ─────────────────────────────────────────────────────────────────────────────────
//
// El recorte es POR FILA, no por rol, así que el test que de verdad lo fija es el de la página
// MIXTA: las dos filas en la MISMA respuesta, una del canal y otra de trámite. Un recorte hecho por
// rol —«el gestor nunca ve `enviadoPorNombre`»— pasaría el caso negativo y caería aquí; uno que no
// recorta nada cae en los dos.
//
// Y el CONTROL POSITIVO no es decoración: sin él, borrar el campo para todo el mundo sería verde.
// En una fila de trámite ese nombre es el del admin de FLIT que decidió despachársela — su contacto
// legítimo dentro de FLIT, y el comportamiento de siempre.
//
// El mock `chain` del repo devuelve la fila ENTERA aunque el `select` pidiera menos, así que los
// asertos van sobre lo que la RUTA SERIALIZA (la respuesta HTTP) y `chainProyectado` recorta a lo que
// la proyección pidió, como PostgreSQL.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, selectDistinct: selectMock,
    update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
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

const PROVEEDOR = '11111111-1111-4111-8111-111111111111';
const SOAT_CANAL = '00000000-0000-0000-0000-0000000000c1';
const SOAT_TRAMITE = '00000000-0000-0000-0000-0000000000a1';

/** El empleado de la COMPAÑÍA CLIENTE que radicó la solicitud. Nunca puede salir hacia el gestor. */
const RADICADOR = 'LUISA GOMEZ (ACME SAS)';
/**
 * Su correo CORPORATIVO, el que `registrarCambio` copia en `usuario_email` al escribir la fila del
 * historial. Es la alternativa que `historialDe` sirve cuando el usuario ya no existe, y es PEOR que
 * el nombre: con él se le escribe a la persona.
 */
const RADICADOR_CORREO = 'luisa.gomez@acme.com.co';
/** El admin de FLIT que despachó un SOAT de trámite. Este el gestor sí lo recibe, como siempre. */
const DESPACHADOR_FLIT = 'CARLOS RUIZ (FLIT)';
/** Un compañero del propio gestor (rol `proveedor`). También externo a FLIT, y también de su lado. */
const GESTOR_DEL_PROVEEDOR = 'ANA MESA (SURA)';

/** Fila de la cola tal como sale del join `flito_soat` × `vehicles` × … */
const filaCola = (over: Record<string, unknown> = {}) => ({
  id: SOAT_CANAL, vin: '9FKRG2222T2042405', estado: 'solicitado', origen: 'cliente',
  proveedorSoatId: PROVEEDOR, gestionOperaciones: false,
  enviadoEn: new Date('2026-09-04T12:00:00.000Z'), pagadoEn: null,
  valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-09-04T12:00:00.000Z'),
  placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
  cilindraje: '1598', carroceria: null, tipoServicio: 'Particular',
  companiaNombre: 'ACME SAS', organismoNombre: 'FUNZA', proveedorSoatNombre: 'SURA',
  proveedorSlaHoras: 24, enviadoPorNombre: RADICADOR,
  ...over,
});

/** La misma fila, pero entrada por la puerta de siempre: trámite digital despachado por un admin. */
const filaTramite = (over: Record<string, unknown> = {}) => filaCola({
  id: SOAT_TRAMITE, origen: 'tramite', vin: 'JN1TG4E28AW000111',
  enviadoPorNombre: DESPACHADOR_FLIT, ...over,
});

/** Propietario del canal, colgado de `soat_id`: la consulta extra que dispara `origen = cliente`. */
const propietarioCanal = () => ({
  id: 'p1', tramiteId: null, soatId: SOAT_CANAL,
  nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050', tipoDocumento: 'CC',
  orden: 0, porcentajeParticipacion: null,
});

/** `contextoSoat` lee el proveedor del gestor de la BD en cada petición, no del JWT (§9.3). */
const contextoGestor = () => selectMock.mockImplementationOnce(() => chain([{ p: PROVEEDOR }]));

describe('cola del gestor — el nombre de quien radica en el canal Cliente no se le emite', () => {
  it('**una solicitud del canal llega SIN `enviadoPorNombre`**', async () => {
    contextoGestor();
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));                                    // conteo
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()])); // página
    selectMock.mockImplementationOnce(() => chain([]));                                                // trámites: ninguno
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));                              // propietario del canal

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(200);
    expect(r.body.items[0].enviadoPorNombre).toBeNull();
    // Y no se cuela por ninguna otra clave de la respuesta: el aserto sobre el campo solo cubre el
    // campo, y este nombre no tiene por qué aparecer en ninguna parte del cuerpo.
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR);
    // La CLAVE sigue existiendo, a diferencia del recorte por rol de `sinCamposInternos`: aquí el
    // recorte es por fila, y una página mixta con la clave presente en unas y ausente en otras haría
    // que la forma del DTO dependiera del origen de cada renglón.
    expect(Object.keys(r.body.items[0])).toContain('enviadoPorNombre');
    // Lo que el gestor SÍ necesita para trabajar la fila sigue ahí — el recorte es del nombre de una
    // persona, no de su interlocutor: si hay un problema, habla con la compañía.
    expect(r.body.items[0].companiaNombre).toBe('ACME SAS');
  });

  it('**CONTROL POSITIVO — en una fila de TRÁMITE sigue recibiéndolo**: ahí es un empleado de FLIT', async () => {
    // El mutante que mata: recortar el campo para el gestor sin mirar el origen. Sería una
    // amputación, no una proyección: el gestor perdería el contacto de FLIT que despachó cada SOAT
    // de la cola de siempre, que es el 100 % de lo que hay hoy en producción.
    contextoGestor();
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaTramite()]));
    selectMock.mockImplementationOnce(() => chain([])); // trámites (sin filas del canal: no hay 5ª consulta)

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(200);
    expect(r.body.items[0].enviadoPorNombre).toBe(DESPACHADOR_FLIT);
  });

  it('**página MIXTA: el recorte es POR FILA, no por rol** — las dos en la misma respuesta', async () => {
    // El caso que distingue las dos implementaciones posibles. Un recorte por rol pasaría el primer
    // test de este archivo y caería aquí.
    contextoGestor();
    selectMock.mockImplementationOnce(() => chain([{ total: 2 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola(), filaTramite()]));
    selectMock.mockImplementationOnce(() => chain([]));                     // trámites
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));   // propietario del canal

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(200);
    const canal = r.body.items.find((i: { id: string }) => i.id === SOAT_CANAL);
    const tramite = r.body.items.find((i: { id: string }) => i.id === SOAT_TRAMITE);
    expect(canal.enviadoPorNombre).toBeNull();
    expect(tramite.enviadoPorNombre).toBe(DESPACHADOR_FLIT);
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR);
  });

  it('**OPERACIONES sí ve quién radicó**: el dato existe, y para el lector interno no cambia nada', async () => {
    // La no-regresión que hace que esto sea una proyección y no un borrado. `enviado_por_id` se sigue
    // escribiendo en el alta justamente para esto.
    selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()]));
    selectMock.mockImplementationOnce(() => chain([]));
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));

    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.items[0].enviadoPorNombre).toBe(RADICADOR);
  });
});

describe('detalle del gestor — la otra lectura que pasa por `ensamblarCola`', () => {
  /** `buscarConAcceso`: la fila cruda + la frontera de autogestión, antes de la consulta del DTO. */
  const acceso = (over: Record<string, unknown> = {}) => chain([{
    soat: {
      id: SOAT_CANAL, companiaId: 7, estado: 'solicitado', origen: 'cliente',
      proveedorSoatId: PROVEEDOR, gestionOperaciones: false, pagadoEn: null, extraccion: null,
      ...over,
    },
    dentroDeFrontera: true,
  }]);

  it('**el detalle de una solicitud del canal tampoco se lo da**', async () => {
    contextoGestor();
    selectMock.mockImplementationOnce(() => acceso());                                                  // buscarConAcceso
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaCola()])); // fila del detalle
    selectMock.mockImplementationOnce(() => chain([]));                                                 // trámites
    selectMock.mockImplementationOnce(() => chain([propietarioCanal()]));                               // propietario del canal

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_CANAL}`).set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(200);
    expect(r.body.enviadoPorNombre).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR);
  });

  it('**CONTROL POSITIVO — el detalle de un SOAT de trámite lo conserva**', async () => {
    contextoGestor();
    selectMock.mockImplementationOnce(() => acceso({ id: SOAT_TRAMITE, origen: 'tramite' }));
    selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [filaTramite()]));
    selectMock.mockImplementationOnce(() => chain([])); // trámites

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_TRAMITE}`).set('Authorization', await auth('proveedor'));

    expect(r.status).toBe(200);
    expect(r.body.enviadoPorNombre).toBe(DESPACHADOR_FLIT);
  });
});

// ═══════════════ La SEGUNDA puerta: `GET /:id/historial` ═════════════════════════════════════════
//
// El DTO recortado arriba no cerraba el asunto, porque el mismo nombre salía un endpoint más allá y
// por un camino que esta HU ABRIÓ SIN TOCARLO. La fila de historial del alta se escribe con el
// radicador (`flito-soat-cliente.service.ts`), y hasta la #12078 era inalcanzable para el gestor: la
// solicitud nacía en `pendiente_revision`, que no está en `ESTADOS_SOAT_VISIBLES_GESTOR`, así que
// `buscarConAcceso` respondía 404. Desde esta HU nace en `solicitado`, que sí lo está. La HU no creó
// el endpoint: **le quitó el cerrojo**. Y lo que sale por ahí es peor que el DTO, porque cuando el
// usuario ya no existe `historialDe` sirve el CORREO CORPORATIVO copiado en la fila.
//
// La regla es la misma de `enviadoPorNombreVisible` —depende del ORIGEN de la solicitud, no del rol
// a secas— y por eso NO se resolvió encendiendo `lectorExterno` para el `proveedor`: eso le habría
// quitado también los actores de FLIT en las filas de trámite, que son su interlocutor legítimo y el
// 100 % de lo que hay hoy en producción.
describe('historial del gestor — el actor de las filas del canal Cliente', () => {
  /** La fila cruda que devuelve `buscarConAcceso`; su `origen` es lo que decide la proyección. */
  const acceso = (origen: string, id: string) => chain([{
    soat: {
      id, companiaId: 7, estado: 'solicitado', origen,
      proveedorSoatId: PROVEEDOR, gestionOperaciones: false, pagadoEn: null, extraccion: null,
    },
    dentroDeFrontera: true,
  }]);

  /** Una fila de `flito_estado_historial` ya unida a `users` (de ahí `usuarioRol`). */
  const filaHistorial = (over: Record<string, unknown> = {}) => ({
    id: 1, estadoAnterior: null, estadoNuevo: 'solicitado', motivo: 'Alta del canal Cliente.',
    origen: 'usuario', usuarioNombre: null, usuarioEmail: null, usuarioRol: null,
    creadoEn: new Date('2026-09-04T12:00:00.000Z'), ...over,
  });

  /** El alta: la escribe el empleado de la compañía que radicó. */
  const altaDelRadicador = () => filaHistorial({
    id: 1, usuarioNombre: RADICADOR, usuarioEmail: RADICADOR_CORREO, usuarioRol: 'cliente',
  });
  /** Un movimiento posterior, de FLIT. El gestor SÍ tiene que seguir viendo quién fue. */
  const movimientoDeFlit = () => filaHistorial({
    id: 2, estadoAnterior: 'solicitado', estadoNuevo: 'con_novedad', motivo: 'Devuelto para revisión.',
    usuarioNombre: DESPACHADOR_FLIT, usuarioEmail: 'carlos.ruiz@flit.com.co', usuarioRol: 'admin',
  });
  /** Y uno del PROPIO gestor: rol `proveedor`, también externo a FLIT y también de su lado. */
  const movimientoDelGestor = () => filaHistorial({
    id: 4, estadoAnterior: 'solicitado', estadoNuevo: 'pagado', motivo: 'Póliza expedida.',
    usuarioNombre: GESTOR_DEL_PROVEEDOR, usuarioEmail: 'ana.mesa@sura.com.co', usuarioRol: 'proveedor',
  });

  const pedirHistorial = async (rol: string, id: string) =>
    request(await buildApp()).get(`/api/flito/soat/${id}/historial`).set('Authorization', await auth(rol));

  it('**ni el nombre NI EL CORREO del radicador**, y las filas de FLIT de la misma solicitud siguen ahí', async () => {
    contextoGestor();
    selectMock.mockImplementationOnce(() => acceso('cliente', SOAT_CANAL));
    selectMock.mockImplementationOnce(() => chain([movimientoDelGestor(), movimientoDeFlit(), altaDelRadicador()]));

    const r = await pedirHistorial('proveedor', SOAT_CANAL);

    expect(r.status).toBe(200);
    // Las dos afirmaciones sobre el cuerpo ENTERO: el aserto de campo solo cubre el campo, y lo que
    // se persigue es que ninguno de los dos identificadores salga por ninguna rendija.
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR);
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR_CORREO);
    const alta = r.body.find((i: { id: number }) => i.id === 1);
    expect(alta.usuario).toBe('La compañía');
    // Y el recorte es POR FILA dentro de la MISMA respuesta: esto es lo que distingue esta
    // implementación de encender `lectorExterno` para el gestor, que dejaría las tres en «FLITO».
    const devolucion = r.body.find((i: { id: number }) => i.id === 2);
    expect(devolucion.usuario).toBe(DESPACHADOR_FLIT);
    // Y a los SUYOS también los sigue viendo: `proveedor` es externo a FLIT igual que `cliente`, y
    // aun así se nombra. Lo que decide no es «de dónde es», es de qué lado del encargo está.
    expect(r.body.find((i: { id: number }) => i.id === 4).usuario).toBe(GESTOR_DEL_PROVEEDOR);
    // El resto de la línea de tiempo no se toca: esto no es `lectorExterno` en pequeño. El gestor
    // conserva el motivo, que es su herramienta de trabajo.
    expect(devolucion.motivo).toBe('Devuelto para revisión.');
    expect(alta).toMatchObject({ estadoAnterior: null, estadoNuevo: 'solicitado', origen: 'usuario' });
  });

  it('**dar de baja al radicador no destapa su correo**: sin rol, no se nombra', async () => {
    // `usuario_id` es `ON DELETE SET NULL`, así que borrar al usuario deja la fila con el correo
    // copiado y sin forma de saber de qué lado estaba. Si el recorte se hiciera solo sobre
    // `usuarioRol === 'cliente'`, bastaría dar de baja al radicador para que su correo volviera a
    // salir — el agujero se cerraría por la puerta grande y quedaría abierto por la de servicio.
    contextoGestor();
    selectMock.mockImplementationOnce(() => acceso('cliente', SOAT_CANAL));
    selectMock.mockImplementationOnce(() => chain([
      filaHistorial({ usuarioNombre: null, usuarioEmail: RADICADOR_CORREO, usuarioRol: null }),
    ]));

    const r = await pedirHistorial('proveedor', SOAT_CANAL);

    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR_CORREO);
    expect(r.body[0].usuario).toBeNull();
  });

  it('una fila SIN actor (`origen: sistema`) sigue saliendo `null`, no «La compañía»', async () => {
    // El recorte tapa a una persona; donde no hay persona no inventa un lado. Un cron etiquetado
    // como la compañía sería una afirmación falsa, y de las que se leen como verdad.
    contextoGestor();
    selectMock.mockImplementationOnce(() => acceso('cliente', SOAT_CANAL));
    selectMock.mockImplementationOnce(() => chain([filaHistorial({ origen: 'sistema' })]));

    const r = await pedirHistorial('proveedor', SOAT_CANAL);

    expect(r.status).toBe(200);
    expect(r.body[0].usuario).toBeNull();
    expect(r.body[0].origen).toBe('sistema');
  });

  it('**CONTROL POSITIVO — en el historial de un TRÁMITE el gestor sigue viendo a los de FLIT**', async () => {
    // El mutante que mata: recortar sin mirar el origen. El gestor perdería el actor de toda la cola
    // de siempre. La segunda fila —usuario dado de baja, con su correo copiado— fija además que en
    // trámite NO cambia NADA: el fallo del lado de callar solo aplica dentro del canal.
    contextoGestor();
    selectMock.mockImplementationOnce(() => acceso('tramite', SOAT_TRAMITE));
    selectMock.mockImplementationOnce(() => chain([
      movimientoDeFlit(),
      filaHistorial({ id: 3, usuarioNombre: null, usuarioEmail: 'ex.empleado@flit.com.co', usuarioRol: null }),
    ]));

    const r = await pedirHistorial('proveedor', SOAT_TRAMITE);

    expect(r.status).toBe(200);
    expect(r.body.find((i: { id: number }) => i.id === 2).usuario).toBe(DESPACHADOR_FLIT);
    expect(r.body.find((i: { id: number }) => i.id === 3).usuario).toBe('ex.empleado@flit.com.co');
  });

  for (const origen of ['cliente', 'tramite']) {
    it(`**CONTROL POSITIVO — Operaciones lo ve todo, también en origen \`${origen}\``, async () => {
      // La no-regresión que hace de esto una proyección y no un borrado: el dato existe, se sigue
      // escribiendo y el lector interno lo lee entero. `admin` no consulta su contexto (no es
      // gestor ni cliente), así que la primera consulta es ya `buscarConAcceso`.
      selectMock.mockImplementationOnce(() => acceso(origen, SOAT_CANAL));
      selectMock.mockImplementationOnce(() => chain([movimientoDeFlit(), altaDelRadicador()]));

      const r = await pedirHistorial('admin', SOAT_CANAL);

      expect(r.status).toBe(200);
      expect(r.body.find((i: { id: number }) => i.id === 1).usuario).toBe(RADICADOR);
      expect(r.body.find((i: { id: number }) => i.id === 2).usuario).toBe(DESPACHADOR_FLIT);
    });
  }

  it('el `cliente` sigue leyendo lo suyo EXACTAMENTE como hoy: «FLITO» y sin motivo', async () => {
    // `lectorExterno` no se ha tocado, y este es el aserto que lo fija desde el otro lado: el
    // interruptor nuevo es POR FILA y el suyo sigue siendo por respuesta. Que el actor de su propia
    // alta también salga «FLITO» es el comportamiento de la #11913, no una consecuencia de esto.
    selectMock.mockImplementationOnce(() => chain([{ c: 7 }])); // contextoSoat del cliente
    selectMock.mockImplementationOnce(() => acceso('cliente', SOAT_CANAL));
    selectMock.mockImplementationOnce(() => chain([movimientoDeFlit(), altaDelRadicador()]));

    const r = await pedirHistorial('cliente', SOAT_CANAL);

    expect(r.status).toBe(200);
    expect(r.body.map((i: { usuario: string }) => i.usuario)).toEqual(['FLITO', 'FLITO']);
    expect(r.body.every((i: { motivo: string | null }) => i.motivo === null)).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(RADICADOR_CORREO);
  });
});
