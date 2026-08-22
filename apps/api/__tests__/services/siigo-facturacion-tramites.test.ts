// Siigo — la ficha de facturación que pinta el reporte de costos (HU #11337).
//
// Dos cosas se prueban aquí: la combinación de los dos ejes —que es pura y decide lo que lee quien
// opera— y las fronteras HTTP. La consulta que cruza cuatro tablas se verificó contra PostgreSQL 16
// real; el mock de drizzle no distingue un `LATERAL` bien escrito de uno que multiplica filas.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
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
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const { estadoCombinado, facturacionDeTramites, TOPE_TRAMITES_CONSULTA } = await import(
  '../../src/modules/siigo/siigo.facturacion-tramites.service.js');

const TRAMITE = 'dddddddd-5555-4555-8555-dddddddddddd';
const RUTA = '/api/siigo/facturacion/tramites';

function fila(over: Record<string, unknown> = {}) {
  return {
    tramite_id: TRAMITE, factura_id: 'fact-1', numero: 'FV-1-9', estado_emision: 'emitida',
    cufe: 'cufe-9', estado_dian: 'aceptada', motivo: null, verificado_en: new Date('2026-08-10T10:00:00Z'),
    revision_motivo: null,
    pdf: true, xml: false, envios: 2, ultimo_enviado_en: new Date('2026-08-09T10:00:00Z'),
    ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/facturacion-tramites.routes.js');
  app.use('/api/siigo/facturacion', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 5, username: `${role}@flit.io`, role })}`;

beforeEach(() => { kdb.reset(); registrarOperacionMock.mockClear(); });

describe('Los dos ejes se combinan en el orden correcto', () => {
  it('un fallo de emisión manda sobre lo que diga la DIAN', () => {
    // Si no salió, la DIAN no tiene nada que decir sobre ella. Que el historial traiga algo es
    // teóricamente imposible, pero el orden de las preguntas no depende de esa suposición.
    expect(estadoCombinado('fallida', 'aceptada')).toBe('fallido');
    expect(estadoCombinado('fallida', null)).toBe('fallido');
  });

  it('en proceso manda sobre la ausencia de pronunciamiento', () => {
    expect(estadoCombinado('en_proceso', null)).toBe('en_proceso');
  });

  it('lo que dijo la DIAN, cuando llegó a emitirse', () => {
    expect(estadoCombinado('emitida', 'aceptada')).toBe('aceptado');
    expect(estadoCombinado('emitida', 'rechazada')).toBe('rechazado');
    expect(estadoCombinado('emitida', 'anulada')).toBe('anulado');
  });

  it('emitida sin pronunciamiento definitivo es «emitido», no «aceptado»', () => {
    // La diferencia importa: «aceptado» cierra el ciclo y «emitido» no. Confundirlos haría creer
    // que hay facturas cerradas que la DIAN todavía puede rechazar.
    expect(estadoCombinado('emitida', null)).toBe('emitido');
    expect(estadoCombinado('emitida', 'en_validacion')).toBe('emitido');
  });

  it('coincide con la escalera que usa el reporte', () => {
    // Son dos implementaciones —una en SQL para contar, otra en TypeScript para la ficha— y tienen
    // que decir lo mismo de la misma factura. Si divergen, la pastilla de la fila contradiría al
    // contador de arriba en la misma pantalla.
    const casos: Array<[string, Parameters<typeof estadoCombinado>[1], string]> = [
      ['fallida', null, 'fallido'],
      ['en_proceso', null, 'en_proceso'],
      ['emitida', 'aceptada', 'aceptado'],
      ['emitida', 'rechazada', 'rechazado'],
      ['emitida', 'anulada', 'anulado'],
      ['emitida', null, 'emitido'],
    ];
    for (const [emision, dian, esperado] of casos) {
      expect(estadoCombinado(emision, dian), `${emision}+${dian}`).toBe(esperado);
    }
  });
});

describe('La ficha que se devuelve', () => {
  it('separa «no hay motivo» de «el motivo está pendiente»', async () => {
    const { SIIGO_MOTIVO_RECHAZO_PENDIENTE } = await import('@operaciones/shared-types');
    kdb.execute.mockResolvedValueOnce([fila({
      estado_dian: 'rechazada', motivo: SIIGO_MOTIVO_RECHAZO_PENDIENTE,
    })]);

    const [f] = await facturacionDeTramites([TRAMITE]);

    // Un motivo que solo dice «pendiente de consultar» no es una explicación. La pantalla necesita
    // poder decirlo en vez de enseñar una frase que no explica nada.
    expect(f.motivo).toBeNull();
    expect(f.motivoPendiente).toBe(true);
  });

  it('un motivo de verdad llega tal cual', async () => {
    kdb.execute.mockResolvedValueOnce([fila({
      estado_dian: 'rechazada', motivo: 'La resolución DIAN no es válida o está vencida.',
    })]);

    const [f] = await facturacionDeTramites([TRAMITE]);

    expect(f.motivoPendiente).toBe(false);
    expect(f.motivo).toContain('resolución DIAN');
  });

  it('una sola fila por trámite aunque la consulta devuelva varias', async () => {
    kdb.execute.mockResolvedValueOnce([
      fila({ factura_id: 'la-que-manda' }),
      fila({ factura_id: 'un-intento-viejo' }),
    ]);

    const r = await facturacionDeTramites([TRAMITE]);

    // El `ORDER BY` de la consulta pone primero la que manda; quedarse con más de una haría que la
    // tabla pintara dos pastillas para el mismo trámite.
    expect(r).toHaveLength(1);
    expect(r[0].facturaId).toBe('la-que-manda');
  });

  it('un identificador que no es UUID no llega a la consulta', async () => {
    const r = await facturacionDeTramites(['no-soy-un-uuid', '']);
    expect(r).toEqual([]);
    expect(kdb.execute).not.toHaveBeenCalled();
  });

  it('sin trámites no se consulta nada', async () => {
    expect(await facturacionDeTramites([])).toEqual([]);
    expect(kdb.execute).not.toHaveBeenCalled();
  });

  it('los identificadores repetidos se consultan una vez', async () => {
    kdb.execute.mockResolvedValueOnce([]);
    await facturacionDeTramites([TRAMITE, TRAMITE, TRAMITE]);

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { params } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(params[0]).toEqual([TRAMITE]);
  });

  it('la consulta va parametrizada, no concatenada', async () => {
    kdb.execute.mockResolvedValueOnce([]);
    await facturacionDeTramites([TRAMITE]);

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(texto).toContain('ANY($1::uuid[])');
    expect(texto).not.toContain(TRAMITE);
  });

  it('no esconde las fallidas: `activo` sola las dejaría fuera', async () => {
    kdb.execute.mockResolvedValueOnce([]);
    await facturacionDeTramites([TRAMITE]);

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);

    // El disparador de la 0135 define `activo = (estado <> 'fallida')`, así que filtrar solo por
    // `activo` haría que un trámite con emisión fallida pareciera no haberse intentado nunca.
    expect(texto).toContain("sft.activo OR sf.estado = 'fallida'");
  });
});

describe('AC6 — la marca de revisión llega con su explicación', () => {
  // El motivo de la marca es un DATO DEL SERVIDOR, no una resta de la pantalla. Sin proyectarlo, la
  // fila enseñaba «Pendiente de revisión» y no había forma de decir por qué: el AC6 pide los dos
  // totales y la diferencia, y el único sitio donde existen es la frase que compuso `revisionDeTotal`
  // al emitir. Restarlos en el navegador daría otro número, porque el total con el que el servidor
  // contrasta es la suma de los conceptos facturados y no el de la liquidación.
  const DESCUADRE = 'El total devuelto por Siigo (200000.00) no coincide con la suma de los '
    + 'conceptos facturados (150000.00). Diferencia: 50000.00.';

  it('la frase con los dos totales y la diferencia viaja tal cual', async () => {
    kdb.execute.mockResolvedValueOnce([fila({ revision_motivo: DESCUADRE })]);

    const [f] = await facturacionDeTramites([TRAMITE]);

    expect(f.revisionMotivo).toBe(DESCUADRE);
    // Las tres cifras, no solo la marca: es lo que convierte «hay que mirarla» en «mira esto».
    expect(f.revisionMotivo).toContain('200000.00');
    expect(f.revisionMotivo).toContain('150000.00');
    expect(f.revisionMotivo).toContain('50000.00');
  });

  it('una factura que cuadra no trae motivo, y `null` no se vuelve cadena vacía', async () => {
    kdb.execute.mockResolvedValueOnce([fila()]);

    const [f] = await facturacionDeTramites([TRAMITE]);

    // `null` y no `''` porque la pantalla decide con la ausencia: una cadena vacía es un valor
    // presente, y pintaría un bloque de explicación sin explicación dentro.
    expect(f.revisionMotivo).toBeNull();
  });

  it('el descuadre no es el único motivo: lo que escribe la reconciliación llega igual', async () => {
    // La reconciliación marca así lo que no puede concluir, y la resolución a mano deja escrito
    // quién la resolvió. Un contrato de dos cifras no sabría contar ninguna de las dos cosas.
    const AMANO = 'Resuelta a mano: una persona la localizó en Siigo y FLITO comprobó el documento.';
    kdb.execute.mockResolvedValueOnce([fila({ revision_motivo: AMANO })]);

    const [f] = await facturacionDeTramites([TRAMITE]);

    expect(f.revisionMotivo).toBe(AMANO);
  });

  it('la consulta pide la columna, no la deduce', async () => {
    kdb.execute.mockResolvedValueOnce([]);
    await facturacionDeTramites([TRAMITE]);

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(texto).toContain('sf.revision_motivo');
  });
});

describe('AC1 — acceso y permisos', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get(`${RUTA}?ids=${TRAMITE}`)).status).toBe(401);
  });

  it.each(['proveedor', 'conductor', 'mensajero', 'compliance'] as TestRole[])(
    '%s no consulta el estado de facturación → 403', async (role) => {
      const app = await buildApp();
      const r = await request(app).get(`${RUTA}?ids=${TRAMITE}`).set('Authorization', await auth(role));
      expect(r.status).toBe(403);
    });

  it.each(['admin', 'financiera', 'auditor'] as TestRole[])('%s sí lo consulta', async (role) => {
    kdb.execute.mockResolvedValueOnce([]);
    const app = await buildApp();
    const r = await request(app).get(`${RUTA}?ids=${TRAMITE}`).set('Authorization', await auth(role));

    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});

describe('Lo que la ruta rechaza', () => {
  it('sin lista de trámites → 400', async () => {
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(400);
  });

  it('una lista desmedida → 400, y sin tocar la base', async () => {
    const muchos = Array.from({ length: TOPE_TRAMITES_CONSULTA + 1 }, () => TRAMITE).join(',');
    const app = await buildApp();
    const r = await request(app).get(`${RUTA}?ids=${muchos}`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(400);
    expect(r.body.error).toContain(String(TOPE_TRAMITES_CONSULTA));
    expect(kdb.execute).not.toHaveBeenCalled();
  });
});

describe('AC5 — la pantalla no gasta cuota de Siigo', () => {
  it('el servicio no importa el cliente HTTP de Siigo', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(
      new URL('../../src/modules/siigo/siigo.facturacion-tramites.service.ts', import.meta.url), 'utf8');

    // La pantalla se abre constantemente. Si cada apertura gastara peticiones de la ventana de 100
    // por minuto que comparte con la emisión, mirar el reporte frenaría facturar.
    expect(fuente).not.toContain('siigo.client');
    expect(fuente).not.toContain('siigoRequest');
  });
});

describe('AC1 — la pantalla y el servidor leen LA MISMA tabla de permisos', () => {
  it('el catálogo vive en tipos compartidos, alcanzable desde las dos mitades', async () => {
    const compartido = await import('@operaciones/shared-types');
    const delServidor = await import('../../src/modules/siigo/siigo.permisos.js');

    // Mientras el catálogo vivió solo en `apps/api`, la pantalla reimplementaba la regla
    // (`role === 'admin' || 'financiera'`) y eran dos definiciones de lo mismo que coincidían por
    // costumbre. El día que una cambiara, la pantalla ofrecería un botón que el servidor rechaza —o
    // escondería uno que sí se puede pulsar— y ninguno de los dos fallos aparece en los tests de la
    // otra mitad.
    expect(compartido.ROLES_POR_ACCION).toBe(delServidor.ROLES_POR_ACCION);
    expect(compartido.puedeEjecutar).toBe(delServidor.puedeEjecutar);
  });

  it('quien reenvía el correo es exactamente quien el servidor deja reenviar', async () => {
    const { puedeEjecutar } = await import('@operaciones/shared-types');

    for (const rol of ['admin', 'financiera']) {
      expect(puedeEjecutar(rol, 'reenviar_correo'), rol).toBe(true);
    }
    // `auditor` lee el estado y no reenvía: auditar es mirar.
    for (const rol of ['auditor', 'proveedor', 'conductor', 'transito']) {
      expect(puedeEjecutar(rol, 'reenviar_correo'), rol).toBe(false);
    }
    expect(puedeEjecutar(null, 'reenviar_correo')).toBe(false);
  });

  it('`auditor` sí puede consultar: la ficha se ve, la acción no', async () => {
    const { puedeEjecutar } = await import('@operaciones/shared-types');
    expect(puedeEjecutar('auditor', 'consultar')).toBe(true);
  });
});

describe('Correcciones de la auditoría de seguridad', () => {
  it('un soporte DESCARTADO no cuenta como archivado', async () => {
    kdb.execute.mockResolvedValueOnce([]);
    await facturacionDeTramites([TRAMITE]);

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);

    // Sin este filtro, un soporte descartado en revisión contaría como archivado y la pantalla
    // afirmaría que el PDF está cuando no está — el AC6 mentiría justo cuando alguien va a
    // descargarlo. Y de paso el índice parcial de la tabla, que es sobre esta misma condición,
    // deja de ser usable: recorrido entero de la tabla de TODOS los documentos, 400 veces.
    expect(texto).toContain('s.descartado = false');
  });

  it('la consulta parte del trámite, que es por donde ahora hay índice', async () => {
    kdb.execute.mockResolvedValueOnce([]);
    await facturacionDeTramites([TRAMITE]);

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);

    // El índice que ya existía es PARCIAL (`WHERE activo`) y el planificador no puede usarlo aquí,
    // porque la consulta incluye las fallidas —que tienen `activo = false`—. La migración 0142
    // añade el btree plano. Medido con EXPLAIN: Seq Scan → Bitmap Index Scan.
    expect(texto).toContain('sft.tramite_id = ANY');
  });
});
