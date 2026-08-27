// HU #11340 — la bandeja de fallidos: fronteras HTTP. AC7, y las decisiones que solo se ven aquí.
//
// Lo que se prueba en este archivo es QUIÉN entra, QUÉ se rechaza antes de llegar al servicio y con
// qué código sale cada cosa. La lógica vive en `siigo-bandeja*.test.ts`, que la interrogan sin HTTP.
//
// La matriz de roles se recorre entera a propósito: una guarda mal puesta solo se nota probando el
// rol que NO debería pasar. El matiz de esta historia es `auditor`, que VE la bandeja entera y no
// ejecuta ni una acción — auditar es mirar, y reintentar emite un documento fiscal.
//
// Y hay una prueba que no es de roles y es la más importante del archivo: **el motivo del descarte
// se valida contra el catálogo cerrado**. Sin ella, la pantalla pintaría unos radios contra un
// servidor que acepta texto libre y la decisión de Habeas Data se saltaría con un `curl`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SIIGO_BANDEJA_MOTIVOS_DESCARTE } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const bitacoraMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: bitacoraMock,
  consultarBitacora: vi.fn().mockResolvedValue([]),
}));

const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: (...a: unknown[]) => piiMock(...a) }));

const consultarMock = vi.fn();
const resumenMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.bandeja.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.bandeja.service.js')>();
  return {
    ...real,
    consultarBandeja: (...a: unknown[]) => consultarMock(...a),
    resumenBandeja: (...a: unknown[]) => resumenMock(...a),
  };
});

const reintentarMock = vi.fn();
const reenviarMock = vi.fn();
const descartarMock = vi.fn();
const reactivarMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.bandeja-acciones.service.js', async (original) => {
  const real = await original<
    typeof import('../../src/modules/siigo/siigo.bandeja-acciones.service.js')
  >();
  return {
    ...real,
    reintentarEmision: (...a: unknown[]) => reintentarMock(...a),
    reenviarCorreo: (...a: unknown[]) => reenviarMock(...a),
    descartarCaso: (...a: unknown[]) => descartarMock(...a),
    reactivarCaso: (...a: unknown[]) => reactivarMock(...a),
  };
});

vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: vi.fn(async () => { throw new Error('sin red'); }),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const COLA = 'cccccccc-1111-4111-8111-cccccccccccc';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/bandeja.routes.js');
  app.use('/api/siigo/bandeja', router);
  return app;
}

/**
 * Un usuario NUEVO por petición.
 *
 * El limitador de acciones es de 20 por minuto y por USUARIO (`userOrIpKey` lleva el `sub`), con
 * store en memoria que vive lo que vive el módulo. Con un `sub` fijo, este archivo agotaría la cuota
 * a mitad de camino y los tests siguientes recibirían 429 — un rojo que no habla del código. Cada
 * petición con su propio usuario es además lo realista: quien opera la bandeja no es uno solo.
 *
 * El techo del limitador tiene su propia prueba, en `siigo-bandeja-limitador.test.ts`.
 */
let siguienteUsuario = 100;
const auth = async (role: TestRole) =>
  `Bearer ${await testToken({ sub: (siguienteUsuario += 1), username: `${role}@flit.io`, role })}`;

/** Ni admin ni financiera: ninguno ejecuta. `auditor` incluido, y ese es el matiz del AC7. */
const ROLES_SIN_ESCRITURA: TestRole[] = [
  'auditor', 'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

/** Los que ni siquiera pueden mirar. `auditor` y `financiera` NO están: ver la bandeja es auditar. */
const ROLES_SIN_LECTURA: TestRole[] = [
  'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

const ACCIONES: Array<[string, Record<string, unknown>]> = [
  ['/api/siigo/bandeja/reintentar', { facturaIds: [FACTURA] }],
  ['/api/siigo/bandeja/reenviar-correo', { facturaIds: [FACTURA] }],
  ['/api/siigo/bandeja/descartar', { fuente: 'emision', refId: FACTURA, motivo: 'tramite_anulado' }],
  ['/api/siigo/bandeja/reactivar', { fuente: 'emision', refId: FACTURA }],
];

beforeEach(() => {
  kdb.reset();
  vi.clearAllMocks();
  consultarMock.mockResolvedValue({
    ambiente: 'pruebas', items: [], limite: 50, offset: 0, hayMas: false,
  });
  resumenMock.mockResolvedValue({
    ambiente: 'pruebas', total: 0,
    porFuente: { emision: 0, dian: 0, correo: 0 },
    porResponsable: { operacion: 0, contabilidad: 0, soporte: 0, automatico: 0 },
    porCodigo: [],
  });
  reintentarMock.mockResolvedValue({
    ambiente: 'pruebas', items: [],
    resumen: { total: 0, encolados: 0, yaEstaban: 0, descartados: 0, porResultado: {} },
  });
  reenviarMock.mockResolvedValue({
    ambiente: 'pruebas', items: [],
    resumen: { total: 0, enviados: 0, descartados: 0, porResultado: {} },
  });
  descartarMock.mockResolvedValue({
    fuente: 'emision', refId: FACTURA, facturaId: FACTURA, colaId: COLA,
    estado: 'fallido_definitivo',
    descarte: {
      motivo: 'tramite_anulado', motivoEtiqueta: 'El trámite se anuló', nota: null,
      usuarioId: 9, marcadoEn: '2026-08-23T15:00:00.000Z',
    },
  });
  reactivarMock.mockResolvedValue({
    fuente: 'emision', refId: FACTURA, facturaId: FACTURA, colaId: COLA, estado: 'pendiente',
    resultado: 'reactivado', descarteAnterior: null,
  });
});

// ── AC7 — acceso por rol ───────────────────────────────────────────────────

describe('AC7 — ninguna ruta de la bandeja es pública', () => {
  it.each([
    ['post', '/api/siigo/bandeja/buscar'],
    ['get', '/api/siigo/bandeja/resumen'],
    ['post', '/api/siigo/bandeja/reintentar'],
    ['post', '/api/siigo/bandeja/reenviar-correo'],
    ['post', '/api/siigo/bandeja/descartar'],
    ['post', '/api/siigo/bandeja/reactivar'],
  ])('%s %s sin token → 401', async (verbo, ruta) => {
    const app = await buildApp();
    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbo]!(ruta);
    expect(r.status).toBe(401);
  });
});

describe('AC7 — los roles de solo lectura ven la bandeja y no ejecutan nada', () => {
  it('auditor consulta la bandeja', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/buscar')
      .set('Authorization', await auth('auditor')).send({});
    expect(r.status).toBe(200);
  });

  it('auditor lee el resumen', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/bandeja/resumen')
      .set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
  });

  it.each(ACCIONES)('auditor NO ejecuta %s → 403', async (ruta, cuerpo) => {
    const app = await buildApp();
    const r = await request(app).post(ruta)
      .set('Authorization', await auth('auditor')).send(cuerpo);

    expect(r.status).toBe(403);
    // Y la guarda para ANTES del servicio: un 403 que ya reencoló algo no protege de nada.
    expect(reintentarMock).not.toHaveBeenCalled();
    expect(descartarMock).not.toHaveBeenCalled();
    expect(reactivarMock).not.toHaveBeenCalled();
    expect(reenviarMock).not.toHaveBeenCalled();
  });
});

describe('AC7 — sin permiso se rechaza', () => {
  it.each(ROLES_SIN_LECTURA)('%s no ve la bandeja → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/buscar')
      .set('Authorization', await auth(role)).send({});
    expect(r.status).toBe(403);
    expect(consultarMock).not.toHaveBeenCalled();
  });

  it.each(ROLES_SIN_ESCRITURA)('%s no reintenta → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/reintentar')
      .set('Authorization', await auth(role)).send({ facturaIds: [FACTURA] });
    expect(r.status).toBe(403);
    expect(reintentarMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'financiera'] as TestRole[])('%s sí opera la bandeja', async (role) => {
    const app = await buildApp();
    for (const [ruta, cuerpo] of ACCIONES) {
      const r = await request(app).post(ruta).set('Authorization', await auth(role)).send(cuerpo);
      expect(r.status, `${role} en ${ruta}`).not.toBe(403);
    }
  });

  it('el 403 deja rastro en la bitácora del módulo', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('auditor'))
      .send({ fuente: 'emision', refId: FACTURA, motivo: 'tramite_anulado' });

    expect(bitacoraMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'permiso_denegado', resultado: 'error_negocio',
    }));
  });
});

// ── La decisión de Habeas Data, hecha efectiva ─────────────────────────────

describe('AC5 — el motivo sale del catálogo CERRADO, y el servidor lo hace cumplir', () => {
  it.each(SIIGO_BANDEJA_MOTIVOS_DESCARTE)('acepta el motivo «%s»', async (motivo) => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({ fuente: 'emision', refId: FACTURA, motivo });
    expect(r.status).toBe(200);
  });

  it('rechaza texto libre con 400 y NO llega al servicio', async () => {
    // ESTE es el punto donde la decisión se hace efectiva. Sin esto, un `curl` con
    // `motivo: "el NIT 900123456 está mal"` escribiría una identificación en una tabla que prohíbe
    // UPDATE y DELETE, y los arts. 8.d y 8.e de la Ley 1581 ya no se podrían ejercer sobre ella.
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({ fuente: 'emision', refId: FACTURA, motivo: 'el NIT 900123456 está mal' });

    expect(r.status).toBe(400);
    expect(descartarMock).not.toHaveBeenCalled();
  });

  it('sin motivo no se descarta nada: el AC5 lo exige', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({ fuente: 'emision', refId: FACTURA });

    expect(r.status).toBe(400);
    expect(descartarMock).not.toHaveBeenCalled();
  });

  it('la nota es OPCIONAL, y se acota', async () => {
    const { SIIGO_BANDEJA_NOTA_MAX } = await import('@operaciones/shared-types');
    const app = await buildApp();

    const corta = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({ fuente: 'emision', refId: FACTURA, motivo: 'tramite_anulado', nota: 'ok' });
    expect(corta.status).toBe(200);

    const larga = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({
        fuente: 'emision', refId: FACTURA, motivo: 'tramite_anulado',
        nota: 'x'.repeat(SIIGO_BANDEJA_NOTA_MAX + 1),
      });
    expect(larga.status).toBe(400);
  });
});

// ── AGENTS.md §14 — la identidad no viaja en la URL ────────────────────────

describe('Los filtros con cuasi-PII van en el cuerpo, nunca en la query', () => {
  it('`/buscar` es POST y toma los clientes del cuerpo', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/buscar?limite=10')
      .set('Authorization', await auth('admin'))
      .send({ clientes: [7, 9], fuentes: ['emision'] });

    expect(r.status).toBe(200);
    expect(consultarMock).toHaveBeenCalledWith(expect.objectContaining({
      clientes: [7, 9], fuentes: ['emision'], limite: 10,
    }));
  });

  it('un `?clientes=` en la query es un 400, no un filtro ignorado en silencio', async () => {
    // Ignorarlo también sería seguro —el filtro no se aplicaría— pero dejaría a quien llama
    // convencido de que filtró, que es peor.
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/buscar?clientes=7')
      .set('Authorization', await auth('admin')).send({});
    expect(r.status).toBe(400);
  });

  it('el ambiente NUNCA sale del cuerpo', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/buscar')
      .set('Authorization', await auth('admin'))
      .send({ ambiente: 'produccion' });

    // `.strict()`: intentarlo es un 400 ruidoso. Una pantalla de pruebas no puede operar producción.
    expect(r.status).toBe(400);
    expect(consultarMock).not.toHaveBeenCalled();
  });

  it('sin cuerpo es una búsqueda sin filtros, no un error', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/buscar')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
  });
});

describe('Registro de acceso PII: la respuesta entrega razón social', () => {
  it('`/buscar` deja constancia con las filas entregadas y SIN declarar el NIT', async () => {
    consultarMock.mockResolvedValue({
      ambiente: 'pruebas', limite: 50, offset: 0, hayMas: false,
      items: [{ facturaId: FACTURA, clienteId: 7, clienteNombre: 'Transportes SAS' }],
    });
    const app = await buildApp();
    await request(app).post('/api/siigo/bandeja/buscar')
      .set('Authorization', await auth('admin')).send({ clientes: [7] });

    expect(piiMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceTipo: 'client',
      accion: 'search',
      // Solo `name`. Declarar `document` haría que «¿quién ha leído identificaciones?» devolviera a
      // todo el que abrió la bandeja, y el NIT no viaja en esta respuesta.
      camposAccedidos: ['name'],
    }));
    expect(piiMock.mock.calls[0]![1].motivo).toContain('filas=1');
    expect(piiMock.mock.calls[0]![1].camposAccedidos).not.toContain('document');
  });

  it('`/resumen` NO lo deja: son conteos, no identidades', async () => {
    const app = await buildApp();
    await request(app).get('/api/siigo/bandeja/resumen').set('Authorization', await auth('admin'));

    // Un log que afirmara que alguien leyó identidades que nunca salieron de la base es tan
    // inservible como uno que falta.
    expect(piiMock).not.toHaveBeenCalled();
  });
});

// ── Los códigos de estado, que son la decisión de los dos endpoints ────────

describe('Dos endpoints de reintento, y cada uno dice la verdad con su código', () => {
  it('la emisión responde 202: cuando contesta no existe ninguna factura todavía', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/reintentar')
      .set('Authorization', await auth('admin')).send({ facturaIds: [FACTURA] });

    // Un 201 con `Location` prometería un documento que quizá nunca llegue a emitirse.
    expect(r.status).toBe(202);
  });

  it('el correo responde 200: el acta ya existe cuando esto contesta', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/reenviar-correo')
      .set('Authorization', await auth('admin')).send({ facturaIds: [FACTURA] });
    expect(r.status).toBe(200);
  });

  it('los topes son distintos, y el del correo es el estrecho', async () => {
    const { SIIGO_BANDEJA_TOPE_REENVIO, SIIGO_BANDEJA_TOPE_REINTENTO } =
      await import('@operaciones/shared-types');
    const app = await buildApp();

    const emision = await request(app).post('/api/siigo/bandeja/reintentar')
      .set('Authorization', await auth('admin'))
      .send({ facturaIds: Array.from({ length: SIIGO_BANDEJA_TOPE_REINTENTO + 1 }, () => FACTURA) });
    expect(emision.status).toBe(400);

    // El mismo número de facturas que la emisión admite de sobra es demasiado para el correo: son
    // peticiones reales a Siigo contra una cuota compartida, y correos reales a clientes reales.
    const correo = await request(app).post('/api/siigo/bandeja/reenviar-correo')
      .set('Authorization', await auth('admin'))
      .send({ facturaIds: Array.from({ length: SIIGO_BANDEJA_TOPE_REENVIO + 1 }, () => FACTURA) });
    expect(correo.status).toBe(400);
  });

  it('el reintento responde 202 con el desglose aunque no se encole ni una (AC3)', async () => {
    reintentarMock.mockResolvedValue({
      ambiente: 'pruebas',
      items: [{ facturaId: FACTURA, resultado: 'descartado_datos', motivo: 'corrige el cliente' }],
      resumen: { total: 1, encolados: 0, yaEstaban: 0, descartados: 1, porResultado: {} },
    });
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/reintentar')
      .set('Authorization', await auth('admin')).send({ facturaIds: [FACTURA] });

    // Un 4xx global por una factura descartada obligaría a operar la bandeja de una en una.
    expect(r.status).toBe(202);
    expect(r.body.resumen.descartados).toBe(1);
  });
});

describe('Los rechazos de dominio salen con el código que corresponde', () => {
  it('«se está procesando» es 409 y no 500: no está roto nada', async () => {
    const { SiigoBandejaError } =
      await import('../../src/modules/siigo/siigo.bandeja-acciones.service.js');
    descartarMock.mockRejectedValue(new SiigoBandejaError('en_proceso', 'Inténtalo en un minuto.'));

    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({ fuente: 'emision', refId: FACTURA, motivo: 'tramite_anulado' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('en_proceso');
    expect(r.body.error).toContain('minuto');
  });

  it('lo que no existe es 404', async () => {
    const { SiigoBandejaError } =
      await import('../../src/modules/siigo/siigo.bandeja-acciones.service.js');
    reactivarMock.mockRejectedValue(new SiigoBandejaError('no_existe', 'No existe.'));

    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/reactivar')
      .set('Authorization', await auth('admin')).send({ fuente: 'emision', refId: FACTURA });
    expect(r.status).toBe(404);
  });

  it('un rechazo de la DIAN no se da por perdido: 409 con la salida concreta', async () => {
    const { SiigoBandejaError } =
      await import('../../src/modules/siigo/siigo.bandeja-acciones.service.js');
    descartarMock.mockRejectedValue(
      new SiigoBandejaError('fuente_no_admite', 'Se corrige, no se da por perdido.'),
    );

    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({ fuente: 'dian', refId: FACTURA, motivo: 'tramite_anulado' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('fuente_no_admite');
  });
});

// ── El rastro de las acciones ──────────────────────────────────────────────

describe('Quién hizo qué queda escrito en los dos sitios', () => {
  it('el descarte deja auditoría y bitácora, con el motivo pero SIN la nota', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/bandeja/descartar')
      .set('Authorization', await auth('admin'))
      .send({
        fuente: 'emision', refId: FACTURA, motivo: 'tramite_anulado', nota: 'lo canceló el cliente',
      });

    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resource: 'siigo_cola_facturacion', resourceId: FACTURA,
    }));
    // La nota ya está en la bitácora del módulo, saneada y recortada. Copiarla a `audit_logs`
    // abriría una segunda copia que ninguna purga alcanza.
    // `auditMock.mock.calls` lleva el `req` de Express, que es circular: se mira el segundo
    // argumento, que es lo que de verdad se escribe en `audit_logs`.
    expect(JSON.stringify(auditMock.mock.calls[0]![1])).not.toContain('lo canceló el cliente');
    expect(bitacoraMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'marcar_fallido', codigo: 'tramite_anulado',
    }));
  });

  it('un fallo del rastro no convierte un reintento correcto en un 500', async () => {
    // Para cuando el rastro corre, la cola YA tiene las filas dentro. Un 500 aquí haría creer que no
    // se hizo nada, y lo normal entonces es volver a pulsar sobre un trabajo en marcha.
    auditMock.mockRejectedValue(new Error('audit caído'));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/bandeja/reintentar')
      .set('Authorization', await auth('admin')).send({ facturaIds: [FACTURA] });

    expect(r.status).toBe(202);
  });
});
