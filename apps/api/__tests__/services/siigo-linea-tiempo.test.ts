// HU #11338 — la línea de tiempo del ciclo de facturación de un trámite (Feature #11244).
//
// La decisión que define esta HU es lo que **no** hace: no crea tabla de auditoría. `siigo_operaciones`
// ya es WORM de verdad y ya guarda lo que hace falta; lo que faltaba era la lectura. Hay una prueba
// dedicada a que nadie proponga la tabla otra vez dentro de tres meses.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const consultarBitacoraMock = vi.fn();
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...actual, consultarBitacora: consultarBitacoraMock, registrarOperacion: registrarOperacionMock };
});

const TRAMITE = '11111111-1111-4111-8111-111111111111';
const FACTURA = '22222222-2222-4222-8222-222222222222';

const EVENTO_LIQUIDACION = {
  id: 'e1', tramiteId: TRAMITE, accion: 'facturar', motivo: null, usuarioId: 7,
  snapshot: null, createdAt: new Date('2026-08-01T10:00:00Z'),
};

const OPERACION_SIIGO = {
  operacion: 'crear_factura', metodo: 'POST', ruta: '/v1/invoices',
  entidadTipo: 'factura', entidadId: FACTURA, resultado: 'ok',
  codigo: null, mensaje: null, createdBy: 7, createdAt: new Date('2026-08-01T10:05:00Z'),
};

const ESTADO_DIAN = {
  id: 'd1', facturaId: FACTURA, secuencia: 1, estado: 'aceptada', cufe: 'CUFE-X',
  motivo: null, fuente: 'sondeo', createdAt: new Date('2026-08-01T10:10:00Z'),
};

beforeEach(() => {
  selectMock.mockReset();
  consultarBitacoraMock.mockReset().mockResolvedValue([]);
  registrarOperacionMock.mockClear();
});

/** Encadena los tres `select` del servicio: eventos, vínculo de factura, estados DIAN. */
function prepararConsultas(opts: {
  eventos?: unknown[]; vinculo?: unknown[]; estados?: unknown[];
}) {
  selectMock
    .mockReturnValueOnce(chain(opts.eventos ?? []))
    .mockReturnValueOnce(chain(opts.vinculo ?? []))
    .mockReturnValueOnce(chain(opts.estados ?? []));
}

describe('AC1 — un solo relato, en orden', () => {
  it('cruza liquidación, Siigo y DIAN en una sola lista cronológica', async () => {
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({
      eventos: [EVENTO_LIQUIDACION], vinculo: [{ facturaId: FACTURA }], estados: [ESTADO_DIAN],
    });
    consultarBitacoraMock.mockResolvedValueOnce([OPERACION_SIIGO]);

    const r = await lineaTiempoDeTramite(TRAMITE);
    expect(r.hitos.map((h) => h.fuente)).toEqual(['liquidacion', 'siigo', 'dian']);
    // Ascendente: un relato se lee desde el principio.
    const fechas = r.hitos.map((h) => h.ocurridoEn);
    expect([...fechas].sort()).toEqual(fechas);
  });

  it('cada hito trae fecha, resultado y quién lo originó', async () => {
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({ eventos: [EVENTO_LIQUIDACION], vinculo: [] });

    const [hito] = (await lineaTiempoDeTramite(TRAMITE)).hitos;
    expect(hito).toMatchObject({ resultado: 'ok', usuarioId: 7 });
    expect(hito!.ocurridoEn).toBe('2026-08-01T10:00:00.000Z');
  });

  it('un hito sin usuario lo dice con null, no lo inventa', async () => {
    // Un cron no tiene usuario, y eso es información, no un hueco.
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({ eventos: [], vinculo: [{ facturaId: FACTURA }], estados: [ESTADO_DIAN] });

    const r = await lineaTiempoDeTramite(TRAMITE);
    expect(r.hitos.find((h) => h.fuente === 'dian')!.usuarioId).toBeNull();
  });

  it('el resultado viene en clave, no hay que interpretar el texto', async () => {
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({
      eventos: [], vinculo: [{ facturaId: FACTURA }],
      estados: [{ ...ESTADO_DIAN, estado: 'rechazada', motivo: 'Resolución vencida' }],
    });

    const r = await lineaTiempoDeTramite(TRAMITE);
    expect(r.hitos[0]).toMatchObject({ resultado: 'error' });
    expect(r.hitos[0]!.detalle).toContain('Resolución vencida');
  });
});

describe('AC6 — un trámite sin factura tiene relato igual', () => {
  it('lo dice explícitamente en vez de devolver una lista vacía', async () => {
    // Una lista vacía obligaría a adivinar si no pasó nada o si la consulta falló.
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({ eventos: [EVENTO_LIQUIDACION], vinculo: [] });

    const r = await lineaTiempoDeTramite(TRAMITE);
    expect(r.facturacionIniciada).toBe(false);
    expect(r.facturaId).toBeNull();
    // Y los hitos de la liquidación siguen ahí: el ciclo empieza antes de Siigo.
    expect(r.hitos).toHaveLength(1);
    expect(r.hitos[0]!.fuente).toBe('liquidacion');
  });

  it('sin factura no se consulta la bitácora de Siigo', async () => {
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({ eventos: [], vinculo: [] });

    await lineaTiempoDeTramite(TRAMITE);
    expect(consultarBitacoraMock).not.toHaveBeenCalled();
  });
});

describe('AC5 — sin secretos y sin datos personales de más', () => {
  it('NO devuelve el cuerpo de la petición ni el de la respuesta', async () => {
    // La bitácora los guarda saneados, pero saneado no es mínimo: ahí va el payload de la factura
    // con la identificación del cliente. Para entender un hito basta el código y el mensaje.
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({ eventos: [], vinculo: [{ facturaId: FACTURA }], estados: [] });
    consultarBitacoraMock.mockResolvedValueOnce([{
      ...OPERACION_SIIGO,
      requestBody: { customer: { identification: '900123456' } },
      responseBody: { cufe: 'X' },
    }]);

    const r = await lineaTiempoDeTramite(TRAMITE);
    const serializado = JSON.stringify(r);
    expect(serializado).not.toContain('900123456');
    expect(serializado).not.toContain('requestBody');
    expect(serializado).not.toContain('responseBody');
  });

  it('el detalle se acota', async () => {
    const { lineaTiempoDeTramite } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    prepararConsultas({ eventos: [], vinculo: [{ facturaId: FACTURA }], estados: [] });
    consultarBitacoraMock.mockResolvedValueOnce([{ ...OPERACION_SIIGO, mensaje: 'x'.repeat(1000) }]);

    const r = await lineaTiempoDeTramite(TRAMITE);
    expect(r.hitos[0]!.detalle!.length).toBeLessThanOrEqual(300);
  });
});

describe('AC2 — no se crea una bitácora nueva', () => {
  it('el servicio no define ninguna tabla propia', async () => {
    // Argumentado en la HU y fijado aquí para que nadie proponga la tabla dentro de tres meses:
    // `siigo_operaciones` ya es WORM y ya guarda lo necesario. Lo que faltaba era la lectura.
    const fuente = readFileSync(
      path.resolve(process.cwd(), 'src/modules/siigo/siigo.linea-tiempo.service.ts'), 'utf8',
    );
    expect(fuente).not.toMatch(/pgTable\s*\(/);
  });

  it('tampoco añade una migración: no hay nada que crear', async () => {
    const { readdirSync } = await import('node:fs');
    const migraciones = readdirSync(path.resolve(process.cwd(), 'src/db/migrations'));
    expect(migraciones.filter((m) => m.includes('linea_tiempo'))).toEqual([]);
  });
});

describe('AC3 — los hitos sin llamada también quedan escritos', () => {
  it('se escriben en la bitácora que ya existe, sin método ni ruta', async () => {
    // Que compartan tabla con las llamadas es lo que hace posible el relato ordenado: si vivieran
    // aparte, reconstruir el orden exigiría mezclar dos fuentes con relojes distintos.
    const { registrarHito } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    await registrarHito({ hito: 'encolada', facturaId: FACTURA, ambiente: 'pruebas', usuarioId: 7 });

    const arg = registrarOperacionMock.mock.calls.at(-1)![0];
    expect(arg).toMatchObject({ operacion: 'encolada', entidadTipo: 'factura', entidadId: FACTURA, createdBy: 7 });
    expect(arg.metodo).toBeUndefined();
    expect(arg.ruta).toBeUndefined();
  });

  it('un hito sin usuario queda con null, no se omite', async () => {
    const { registrarHito } = await import('../../src/modules/siigo/siigo.linea-tiempo.service.js');
    await registrarHito({ hito: 'marcada_fallido_definitivo', facturaId: FACTURA, ambiente: 'pruebas' });
    expect(registrarOperacionMock.mock.calls.at(-1)![0].createdBy).toBeNull();
  });
});

describe('AC7 — acceso por rol', () => {
  async function buildApp() {
    const app = express();
    app.use(express.json());
    const { default: router } = await import('../../src/modules/siigo/linea-tiempo.routes.js');
    app.use('/api/siigo/linea-tiempo', router);
    return app;
  }
  const auth = async (role: string) => `Bearer ${await testToken({ sub: 1, role })}`;

  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get(`/api/siigo/linea-tiempo/${TRAMITE}`)).status).toBe(401);
  });

  for (const rol of ['admin', 'financiera', 'auditor']) {
    it(`${rol} la consulta completa`, async () => {
      prepararConsultas({ eventos: [], vinculo: [] });
      const app = await buildApp();
      const r = await request(app).get(`/api/siigo/linea-tiempo/${TRAMITE}`)
        .set('Authorization', await auth(rol));
      expect(r.status).toBe(200);
    });
  }

  it('un rol sin lectura sobre el reporte no entra', async () => {
    const app = await buildApp();
    const r = await request(app).get(`/api/siigo/linea-tiempo/${TRAMITE}`)
      .set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
  });

  it('la ruta es de solo lectura: no expone ningún verbo de escritura', async () => {
    const fuente = readFileSync(
      path.resolve(process.cwd(), 'src/modules/siigo/linea-tiempo.routes.ts'), 'utf8',
    );
    expect(fuente).not.toMatch(/router\.(post|patch|put|delete)\(/);
  });

  it('un identificador malformado se rechaza antes de llegar a la base', async () => {
    // Un uuid inválido daría un error de sintaxis de PostgreSQL y se llevaría la transacción.
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/linea-tiempo/no-es-un-uuid')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
