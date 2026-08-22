// Siigo — la frontera HTTP de «enviar a facturación» (HU #11328). AC1, AC2, AC6 y AC7.
//
// Es la primera ruta del programa por la que un humano puede hacer que salga una factura, y nada de
// esta Feature se ha probado nunca contra Siigo real. Así que aquí no se prueba el camino feliz: se
// prueban las GUARDAS, y por mutación —cada test describe qué avería deja pasar si se cae—.
//
//   * quitar `.strict()` o leer el ambiente del cuerpo → se puede emitir en producción desde una
//     pantalla de pruebas, y una factura aceptada por la DIAN no se deshace;
//   * cambiar `exigirAccionSiigo('emitir')` por una lista de roles escrita a mano → dos definiciones
//     de quién emite, que es lo que el AC6 prohíbe;
//   * responder 4xx cuando un trámite es rechazado → facturar de uno en uno;
//   * quitar el rastro → nadie sabe quién pidió facturar qué cuando algo sale mal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import 'express-async-errors';
import { testToken, type TestRole } from '../helpers/auth.js';
import { ROLES_POR_ACCION, type SiigoRespuestaEnvio } from '@operaciones/shared-types';
import type { RegistroOperacion } from '../../src/modules/siigo/siigo.operaciones.repo.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const auditMock = vi.fn();
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const registrarMock = vi.fn<(r: RegistroOperacion) => Promise<void>>();
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: RegistroOperacion) => registrarMock(r) };
});

/** Qué acciones del catálogo pidió la ruta. Es lo que permite probar la guarda condicional. */
const accionesExigidas: string[] = [];
vi.mock('../../src/modules/siigo/siigo.permisos.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.permisos.js')>();
  return {
    ...real,
    exigirAccionSiigo: (accion: string) => {
      const guarda = real.exigirAccionSiigo(accion as never);
      return (req: unknown, res: unknown, next: unknown) => {
        accionesExigidas.push(accion);
        return (guarda as (a: unknown, b: unknown, c: unknown) => unknown)(req, res, next);
      };
    },
  };
});

const enviarMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.encolado.service.js', () => ({
  enviarAFacturacion: (...a: unknown[]) => enviarMock(...a),
  TOPE_TRAMITES_ENVIO: 200,
}));

const colaMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.cola.service.js', () => ({
  colaDeTramites: (...a: unknown[]) => colaMock(...a),
  encolar: vi.fn(),
  SiigoColaError: class SiigoColaError extends Error {
    codigo: string;

    constructor(codigo: string, mensaje: string) { super(mensaje); this.codigo = codigo; }
  },
}));

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
/** A1 — qué se factura viaja en el cuerpo y sin valor por omisión. Hoy, solo el trámite digital. */
const CONCEPTOS = ['tramite_digital'];
const B = 'bbbbbbbb-2222-4111-8111-bbbbbbbbbbbb';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/facturacion.routes.js');
  app.use('/api/siigo/facturacion', router);
  return app;
}

/**
 * Cada llamada estrena un `sub`, y desde la HU #11299 eso es una condición para que este archivo
 * pase, no una comodidad.
 *
 * `envioLimiter` pasó a ir DELANTE de las guardas —una denegación escribe en `siigo_operaciones`,
 * que es append-only, así que también hay que poder frenarla—, de modo que ahora cuenta también los
 * 403 y los 400. Con el `sub` fijo de antes, este archivo compartía una sola llave (`userOrIpKey`
 * la calcula por usuario) y sus más de veinte peticiones agotaban entre todas la ventana de 20 por
 * minuto: la mitad de las pruebas empezaba a recibir 429 por lo que hacía la prueba anterior. Es la
 * misma razón por la que `siigo-terceros-limitador.test.ts` estrena `sub` en cada caso.
 *
 * Lo que un caso necesita fijar —el `usuarioId` que llega al servicio— se pasa explícito.
 */
let subDeTurno = 100;
const auth = async (role: TestRole, sub = (subDeTurno += 1)) =>
  `Bearer ${await testToken({ sub, username: `${role}@flit.io`, role })}`;

function respuesta(over: Partial<SiigoRespuestaEnvio> = {}): SiigoRespuestaEnvio {
  return {
    ambiente: 'pruebas',
    items: [{
      tramiteId: A, resultado: 'encolado', motivos: [], estado: 'pendiente',
      colaId: 'c1', loteId: 'l1', detalle: null,
    }],
    resumen: {
      total: 1,
      encolados: 1,
      yaEstaban: 0,
      rechazados: 0,
      porResultado: {
        encolado: 1, ya_en_cola: 0, ya_enviado: 0, fallido_definitivo: 0,
        reactivado: 0, no_elegible: 0, error: 0,
      },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registrarMock.mockResolvedValue(undefined);
  auditMock.mockResolvedValue(undefined);
  enviarMock.mockResolvedValue(respuesta());
  colaMock.mockResolvedValue([]);
});

// ── AC6 — solo el rol autorizado emite ──────────────────────────────────────

describe('AC6 — quién puede emitir lo decide UNA constante compartida', () => {
  it('la lista de la acción `emitir` es la misma que la guarda de «Facturar»', () => {
    // `POST /flito/liquidacion/:tramiteId/facturar` usa `requireRole('admin', 'financiera')`, y la
    // emisión electrónica es el paso siguiente a ese botón: quien puede lo uno puede lo otro. Si
    // alguien cambia una de las dos sin la otra, aparece un botón que el servidor rechaza —o al
    // revés—, y ninguno de los dos fallos se ve en los tests de la otra mitad.
    expect([...ROLES_POR_ACCION.emitir].sort()).toEqual(['admin', 'financiera']);
  });

  it('y lo compara contra la guarda REAL del botón, no contra un literal copiado', async () => {
    // La versión anterior de este test afirmaba `['admin','financiera']` escrito a mano, así que
    // cambiar la guarda de «Facturar» no rompía nada y las dos definiciones se separaban en
    // silencio — que es exactamente lo que el comentario decía estar impidiendo. Ahora se compara
    // contra la lista que ese módulo exporta: editar una sin la otra falla aquí.
    const { ROLES_LIQUIDACION_ESCRITURA } = await import(
      '../../src/modules/flito-liquidacion/flito-liquidacion.routes.js');

    expect([...ROLES_POR_ACCION.emitir].sort())
      .toEqual([...ROLES_LIQUIDACION_ESCRITURA].sort());
  });

  it('reactivar lo dado por perdido exige la acción `reactivar`, no la de `emitir`', async () => {
    // Hoy las dos acciones resuelven a los mismos roles, así que comprobar el CÓDIGO de respuesta no
    // distinguiría nada: pasaría igual con la guarda quitada. Lo que se comprueba es el mecanismo —
    // qué acción se le pidió al catálogo—, que es lo único que seguirá siendo cierto el día que
    // alguien restrinja `reactivar` a administración.
    const app = await buildApp();
    accionesExigidas.length = 0;

    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A], reactivar: true });

    expect(accionesExigidas).toContain('reactivar');
  });

  it('un envío normal NO pide el permiso de reactivar: no ejerce lo que no hace', async () => {
    const app = await buildApp();
    accionesExigidas.length = 0;

    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    expect(accionesExigidas).toContain('emitir');
    expect(accionesExigidas).not.toContain('reactivar');
  });

  it.each<TestRole>(['admin', 'financiera'])('%s puede enviar → 202', async (role) => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth(role)).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });

  it('un rol de SOLO LECTURA consulta el estado pero no puede enviar', async () => {
    const app = await buildApp();
    const cabecera = await auth('auditor');

    const consulta = await request(app)
      .get(`/api/siigo/facturacion?tramiteIds=${A}`).set('Authorization', cabecera);
    const envio = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', cabecera).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    // Mirar la cola es exactamente lo que hace un revisor fiscal; llenarla no.
    expect(consulta.status).toBe(200);
    expect(envio.status).toBe(403);
    // La guarda va ANTES del handler: el rechazo no llega a tocar el servicio.
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('el intento denegado queda en la bitácora, con el rol y sin datos personales', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('auditor', 55)).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    const fila = registrarMock.mock.calls.map((c) => c[0])
      .find((r) => r.operacion === 'permiso_denegado');
    expect(fila).toBeTruthy();
    expect(fila!.mensaje).toContain('auditor');
    expect(fila!.createdBy).toBe(55);
    // Esa tabla prohíbe UPDATE y DELETE por disparador: un dato personal escrito ahí ya no se podría
    // rectificar ni suprimir (Ley 1581, art. 8).
    expect(JSON.stringify(fila)).not.toContain('@flit.io');
  });

  it.each<TestRole>(['proveedor', 'transito', 'gestor_impuestos', 'mensajero', 'conductor'])(
    '%s no entra ni a leer ni a enviar', async (role) => {
      const app = await buildApp();
      const cabecera = await auth(role);

      expect((await request(app).post('/api/siigo/facturacion')
        .set('Authorization', cabecera).send({ conceptos: CONCEPTOS, tramiteIds: [A] })).status).toBe(403);
      expect((await request(app).get(`/api/siigo/facturacion?tramiteIds=${A}`)
        .set('Authorization', cabecera)).status).toBe(403);
    },
  );

  it('sin token no se envía nada', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion').send({ conceptos: CONCEPTOS, tramiteIds: [A] });
    expect(r.status).toBe(401);
    expect(enviarMock).not.toHaveBeenCalled();
  });
});

// ── El ambiente NO lo elige el cliente ──────────────────────────────────────

describe('El ambiente sale del servidor, pase lo que pase', () => {
  it('un `ambiente` en el cuerpo se rechaza en vez de ignorarse', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'))
      .send({ conceptos: CONCEPTOS, tramiteIds: [A], ambiente: 'produccion' });

    // Ignorarlo también sería seguro, pero dejaría al que llama convencido de que eligió. Y si
    // alguien quitara el `.strict()` creyendo que el campo se usa, el fallo sería silencioso.
    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('el servicio recibe SIEMPRE el ambiente configurado en el servidor', async () => {
    const { env } = await import('../../src/config/env.js');
    const app = await buildApp();
    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('financiera', 42)).send({ conceptos: CONCEPTOS, tramiteIds: [A, B] });

    // El `sub` va explícito porque este caso comprueba que llega al servicio: con el de turno, la
    // aserción se compararía contra un número que cambia de una corrida a otra.
    expect(enviarMock.mock.calls[0]![0]).toMatchObject({
      ambiente: env.SIIGO_AMBIENTE, tramiteIds: [A, B], usuarioId: 42,
    });
  });

  it('y la respuesta dice contra qué ambiente se encoló', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });
    expect(r.body.ambiente).toBe('pruebas');
  });
});

// ── AC1 y AC2 — el desglose y los motivos ───────────────────────────────────

describe('AC1 — la respuesta trae el desglose completo, también con rechazos', () => {
  it('un trámite rechazado NO convierte la petición en un error', async () => {
    enviarMock.mockResolvedValue(respuesta({
      items: [
        {
          tramiteId: A,
          resultado: 'no_elegible',
          motivos: [{ motivo: 'documentacion_incompleta', detalle: 'Falta el SOAT.' }],
          estado: null,
          colaId: null,
          loteId: null,
          detalle: null,
        },
        {
          tramiteId: B, resultado: 'encolado', motivos: [], estado: 'pendiente',
          colaId: 'c2', loteId: 'l2', detalle: null,
        },
      ],
      resumen: {
        total: 2,
        encolados: 1,
        yaEstaban: 0,
        rechazados: 1,
        porResultado: {
          encolado: 1, ya_en_cola: 0, ya_enviado: 0, fallido_definitivo: 0,
          reactivado: 0, no_elegible: 1, error: 0,
        },
      },
    }));

    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A, B] });

    // Un 4xx global por un trámite malo obligaría a enviar de uno en uno.
    expect(r.status).toBe(202);
    expect(r.body.resumen).toMatchObject({ encolados: 1, rechazados: 1 });
    // AC2 — los motivos viajan enumerados uno por uno y con el texto de la elegibilidad.
    expect(r.body.items[0].motivos).toEqual([
      { motivo: 'documentacion_incompleta', detalle: 'Falta el SOAT.' },
    ]);
  });

  it('202 y no 201: cuando esto responde no existe ninguna factura todavía', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    expect(r.status).toBe(202);
    // Un 201 con `Location` prometería un documento que quizá nunca llegue a emitirse.
    expect(r.headers.location).toBeUndefined();
  });

  it('`reactivar` llega al servicio tal cual, y por omisión no viaja', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });
    expect(enviarMock.mock.calls[0]![0].reactivar).toBeUndefined();

    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A], reactivar: true });
    expect(enviarMock.mock.calls[1]![0].reactivar).toBe(true);
  });
});

describe('Validación del cuerpo', () => {
  const invalidos: Array<[string, unknown]> = [
    ['sin trámites', { tramiteIds: [] }],
    ['sin el campo', {}],
    ['identificadores que no son uuid', { tramiteIds: ['no-soy-un-uuid'] }],
    ['más de los que caben', { tramiteIds: Array.from({ length: 201 }, () => A) }],
    ['reactivar como texto', { tramiteIds: [A], reactivar: 'si' }],
  ];

  it.each(invalidos)('%s → 400 y no se toca la cola', async (_caso, cuerpo) => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send(cuerpo as object);

    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
  });
});

describe('Validación de la consulta', () => {
  it('un identificador que no es uuid se rechaza AQUÍ, no en el motor', async () => {
    // Sin esto, `?tramiteIds=abc` llegaba al `::uuid[]` de la consulta: PostgreSQL lanza un 22P02,
    // drizzle lo envuelve con la sentencia y sus parámetros dentro, y el manejador de errores lo
    // vuelca al log SIN sanear. Un 400 dice lo mismo y no ensucia el registro.
    const app = await buildApp();
    const r = await request(app)
      .get('/api/siigo/facturacion?tramiteIds=abc').set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
  });

  it('uno válido y otro inválido también se rechaza: no se consulta a medias', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get(`/api/siigo/facturacion?tramiteIds=${A},abc`).set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
  });
});

// ── El freno ────────────────────────────────────────────────────────────────

describe('Con el freno puesto no se encola', () => {
  it('la integración frenada responde 503, no 4xx', async () => {
    const { SiigoIntegracionFrenadaError } =
      await import('../../src/modules/siigo/siigo.freno.service.js');
    enviarMock.mockRejectedValue(new SiigoIntegracionFrenadaError({
      frenada: true, motivo: 'Demasiados errores en la ventana.',
    } as never));

    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    // 503 y no 409: no es que la petición esté mal, es que el servicio de abajo no está disponible
    // ahora. Un 4xx haría creer a quien integra que tiene que cambiar lo que envía.
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('integracion_frenada');
    expect(r.body.freno).toMatchObject({ frenada: true });
  });

  it('pero el estado de la cola se sigue pudiendo consultar', async () => {
    const app = await buildApp();
    const r = await request(app).get(`/api/siigo/facturacion?tramiteIds=${A}`)
      .set('Authorization', await auth('admin'));

    // Mirar qué hay atascado es justo lo que hace falta mientras se diagnostica el freno.
    expect(r.status).toBe(200);
  });
});

// ── AC7 — el rastro ─────────────────────────────────────────────────────────

describe('AC7 — queda rastro de quién envió y sobre qué trámites', () => {
  it('se registra en la auditoría general con la lista de trámites', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('financiera')).send({ conceptos: CONCEPTOS, tramiteIds: [A, B] });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0]![1] as Record<string, string>;
    expect(entrada.resource).toBe('siigo_cola_facturacion');
    // Los dos identificadores viajan: `audit` los mueve al `detail` cuando no caben en la columna,
    // pero perderlos aquí sería perder la respuesta a «¿sobre qué se pidió facturar?».
    expect(entrada.resourceId).toContain(A);
    expect(entrada.resourceId).toContain(B);
  });

  it('y en la bitácora del módulo, atribuido a quien lo pidió', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin', 91)).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    const fila = registrarMock.mock.calls.map((c) => c[0]).find((r) => r.operacion === 'emitir');
    expect(fila).toBeTruthy();
    expect(fila!.createdBy).toBe(91);
    expect(fila!.statusHttp).toBe(202);
    expect(fila!.entidadId).toBe(A);
  });

  it('el rastro se escribe AUNQUE no se haya encolado ni un trámite', async () => {
    enviarMock.mockResolvedValue(respuesta({
      items: [{
        tramiteId: A,
        resultado: 'no_elegible',
        motivos: [{ motivo: 'ya_facturado', detalle: 'Ya tiene factura viva.' }],
        estado: null,
        colaId: null,
        loteId: null,
        detalle: null,
      }],
      resumen: {
        total: 1,
        encolados: 0,
        yaEstaban: 0,
        rechazados: 1,
        porResultado: {
          encolado: 0, ya_en_cola: 0, ya_enviado: 0, fallido_definitivo: 0,
          reactivado: 0, no_elegible: 1, error: 0,
        },
      },
    }));

    const app = await buildApp();
    await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    // «Quién pidió facturar qué» es la pregunta que se hace después, cuando algo salió mal. Que no
    // entrara nada no la hace menos interesante: el intento existió.
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1].detail).toContain('0 encolados');
    expect(auditMock.mock.calls[0]![1].detail).toContain('1 rechazados');
  });

  it('un fallo de bitácora no convierte un envío correcto en un 500', async () => {
    auditMock.mockRejectedValue(new Error('la auditoría está caída'));
    registrarMock.mockRejectedValue(new Error('la bitácora está caída'));

    const app = await buildApp();
    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    // Los dos registradores se tragan sus errores por diseño; esto lo fija por si alguno dejara de
    // hacerlo. Perder el rastro es malo; perder el encolado que ya ocurrió, peor.
    expect(r.status).toBe(202);
  });
});

// ── Consulta del estado ─────────────────────────────────────────────────────

describe('GET / — el estado de la cola de unos trámites', () => {
  it('consulta por lista y contra el ambiente del servidor', async () => {
    const { env } = await import('../../src/config/env.js');
    const app = await buildApp();
    const r = await request(app).get(`/api/siigo/facturacion?tramiteIds=${A},${B}`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(colaMock).toHaveBeenCalledWith(env.SIIGO_AMBIENTE, [A, B]);
  });

  it('sin lista → 400', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(colaMock).not.toHaveBeenCalled();
  });

  it('más trámites de los que caben → 400 en vez de una consulta gigante', async () => {
    const app = await buildApp();
    const ids = Array.from({ length: 201 }, () => A).join(',');
    const r = await request(app).get(`/api/siigo/facturacion?tramiteIds=${ids}`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(colaMock).not.toHaveBeenCalled();
  });
});

// ── HU #11708 — el correo se elige en el cuerpo del envío ───────────────────

describe('el correo al cliente viaja en la petición de envío', () => {
  it('lo pedido llega al servicio con las direcciones marcadas como escritas a mano', async () => {
    // `manual` es lo que distingue después, en el acta, «el cliente tiene mal su ficha» de «quien
    // envió se equivocó al escribirlo». Sin la procedencia, las dos averías son la misma fila.
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'))
      .send({
        conceptos: CONCEPTOS,
        tramiteIds: [A],
        correo: { enviar: true, destinatarios: ['cartera@cliente.test'] },
      });

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledWith(expect.objectContaining({
      correo: {
        solicitado: true,
        destinatarios: [{ correo: 'cartera@cliente.test', origen: 'manual' }],
      },
    }));
  });

  it('sin `correo` en el cuerpo NO se pide correo, y eso es una decisión, no un olvido', async () => {
    // Antes de esta historia el correo salía siempre en producción. Que la ausencia lo apague en vez
    // de romper la petición es deliberado: un 400 no factura nada, mientras que un correo que no
    // salió se reenvía — y además queda acta diciendo que nadie lo pidió.
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin')).send({ conceptos: CONCEPTOS, tramiteIds: [A] });

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledWith(expect.objectContaining({
      correo: { solicitado: false, destinatarios: [] },
    }));
  });

  it('con la casilla apagada no se guarda ninguna dirección, aunque vengan en el cuerpo', async () => {
    // Una pantalla que conserva lo escrito mientras se desmarca la casilla es lo normal. Guardarlas
    // metería datos personales en el lote para un correo que nadie va a mandar, y ese lote acabaría
    // en la lista de cosas que el derecho de supresión tiene que ir a limpiar sin motivo.
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'))
      .send({
        conceptos: CONCEPTOS,
        tramiteIds: [A],
        correo: { enviar: false, destinatarios: ['cartera@cliente.test'] },
      });

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledWith(expect.objectContaining({
      correo: { solicitado: false, destinatarios: [] },
    }));
  });

  it('una dirección mal escrita se rechaza aquí, y el 400 no repite lo que rechaza', async () => {
    // La emisión vuelve a validar —es donde el AC5 lo pide— pero decírselo ahora a quien lo escribió
    // vale más que contárselo media hora después en un acta. Ley 1581: el mensaje de error acaba en
    // el log de la aplicación, así que no puede llevar la dirección dentro.
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'))
      .send({
        conceptos: CONCEPTOS,
        tramiteIds: [A],
        correo: { enviar: true, destinatarios: ['esto-no-es-un-correo'] },
      });

    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(JSON.stringify(r.body)).not.toContain('esto-no-es-un-correo');
  });

  it('más direcciones de las que Siigo admite se rechazan antes de encolar nada', async () => {
    const app = await buildApp();
    const seis = Array.from({ length: 6 }, (_, i) => `persona${i}@cliente.test`);

    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'))
      .send({ conceptos: CONCEPTOS, tramiteIds: [A], correo: { enviar: true, destinatarios: seis } });

    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('un campo inventado dentro de `correo` es un 400 ruidoso, no un campo ignorado', async () => {
    // `.strict()`, por lo mismo que en el resto del cuerpo: un campo ignorado deja a quien llama
    // convencido de que se le hizo caso. Aquí eso sería creer que se eligió a quién mandar.
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/facturacion')
      .set('Authorization', await auth('admin'))
      .send({
        conceptos: CONCEPTOS,
        tramiteIds: [A],
        correo: { enviar: true, ambiente: 'produccion' },
      });

    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
  });
});
