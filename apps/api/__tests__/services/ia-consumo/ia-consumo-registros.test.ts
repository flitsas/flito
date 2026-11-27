// Épica #14548 (ADR-0051, bloque A) — rutas y servicio del visor de consumo de IA, de punta a punta con supertest.
// La base se sustituye por un `tx` que registra cada consulta: el WHERE, el LIMIT y las columnas se serializan con
// `PgDialect` y se afirma sobre el SQL real, no sobre lo que el mock devolvió. La auditoría (`logPiiAccess`) se mockea:
// lo que se fija es QUÉ se le pasa, igual que en `flito-comparendos-acceso-pii.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import { hoyColombia } from '../../../src/shared/utils/fecha-rango.js';
import { calcularVentana } from '../../../src/modules/ia-consumo/ia-consumo.service.js';

const { estado, logPiiAccessMock, fakeDb } = vi.hoisted(() => {
  type Registro = { cols?: Record<string, unknown>; where?: unknown; limit?: number; orden?: unknown[]; sql?: unknown };
  const estado = {
    consultas: [] as Registro[],
    respuestas: [] as unknown[][],
    concedidas: new Set<string>(),
  };
  const selectFalso = (cols: Record<string, unknown>) => {
    const registro: Registro = { cols };
    estado.consultas.push(registro);
    const builder = {
      from: () => builder,
      where: (cond: unknown) => {
        registro.where = cond;
        return builder;
      },
      orderBy: (...orden: unknown[]) => {
        registro.orden = orden;
        return builder;
      },
      limit: (n: number) => {
        registro.limit = n;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(estado.respuestas.shift() ?? []).then(resolve, reject),
    };
    return builder;
  };
  const tx = {
    execute: async (consulta: unknown) => {
      estado.consultas.push({ sql: consulta });
      return [];
    },
    select: selectFalso,
  };
  return {
    estado,
    logPiiAccessMock: vi.fn().mockResolvedValue(undefined),
    fakeDb: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
  };
});

vi.mock('../../../src/db/client.js', () => ({ db: fakeDb }));
vi.mock('../../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));
vi.mock('../../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../src/shared/middleware/auth.js', () => ({
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }
    (req as Request & { user?: unknown }).user = { sub: 7, username: 'ops@flit.io', role: 'admin' };
    next();
  },
}));
vi.mock('../../../src/shared/middleware/exigir-funcion.js', () => ({
  exigirFuncion: (codigo: string) => (_req: Request, res: Response, next: NextFunction) => {
    if (estado.concedidas.has(codigo)) {
      next();
      return;
    }
    res.status(403).json({ error: 'No tienes permiso para esta acción.', funcion: codigo });
  },
  tieneFuncion: async () => false,
}));

const dialecto = new PgDialect();
const BASE = '/api/ia-consumo';
const AUTH = 'Bearer prueba';
const UUID = '0190c0de-0000-7000-8000-000000000001';
const CORRELACION = '0190c0de-0000-7000-8000-0000000000aa';
const uuidDe = (n: number): string => `0190c0de-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const sumarDias = (fecha: string, dias: number): string =>
  new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

const hoy = hoyColombia();
const hace6 = sumarDias(hoy, -6); // 7 días naturales, ambos extremos incluidos
const ventana = calcularVentana(hoy, 3);

/** Fila de la lista tal como la devuelve la base (columnas de la lista blanca, más el cursor en texto). */
function filaLista(over: Record<string, unknown> = {}) {
  return {
    id: uuidDe(1), correlacionId: CORRELACION, intento: 1, pasada: 1,
    fechaInicio: new Date('2026-11-20T20:00:00Z'), fechaFin: new Date('2026-11-20T20:00:02Z'),
    latenciaMs: 120, aplicativo: 'flit', servicio: 'ocr', ambiente: 'dev', tenantId: null,
    usuarioId: '7', usuarioLogin: 'ana@ejemplo.co', origen: 'usuario', modulo: 'soat',
    proceso: 'ocr_factura_soat', tipoTarea: 'ocr', placa: 'ABC123', entidadTipo: 'soat', entidadId: 'ent-1',
    archivoMime: null, archivoBytes: null, archivoPaginas: null, archivoSha256: null,
    proveedor: 'anthropic', modeloSolicitado: 'claude-haiku-4-5', modeloRespondido: 'claude-haiku-4-5-20251001',
    idRespuestaProveedor: 'msg_1', maxTokens: 1024, promptCodigo: 'factura', promptVersion: '1', promptHash: 'h1',
    httpStatus: 200, resultado: 'exito', stopReason: 'end_turn', errorCodigo: null,
    tokensEntrada: 10, tokensSalida: 20, tokensCacheLectura: 0, tokensCacheEscritura: 0, costoUsdEstimado: '0.000100',
    fechaCursor: '2026-11-20T15:00:00.000000Z',
    ...over,
  };
}

/** Fila del detalle: la lista más errorMensaje y las columnas calculadas en la base. */
function filaDetalle(over: Record<string, unknown> = {}) {
  const { fechaCursor: _cursor, ...lista } = filaLista();
  return {
    ...lista, id: UUID, errorMensaje: null, bytesPrompt: 120, bytesRespuesta: 300, tieneContenido: true,
    metadatosBytes: 42, metadatos: { cache: 'hit' }, ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../../src/modules/ia-consumo/ia-consumo.routes.js');
  app.use(BASE, router);
  return app;
}

const pedirCatalogos = (app: express.Express) => request(app).get(`${BASE}/catalogos`).set('Authorization', AUTH);
const pedirDetalle = (app: express.Express, id: string) => request(app).get(`${BASE}/registros/${id}`).set('Authorization', AUTH);
const pedirBuscar = (app: express.Express, cuerpo: unknown, query = '') =>
  request(app).post(`${BASE}/registros/buscar${query}`).set('Authorization', AUTH).send(cuerpo as object);
const cuerpo = (over: Record<string, unknown> = {}) => ({ desde: hace6, hasta: hoy, ...over });

/** Texto SQL y parámetros de una condición. */
const condicionDe = (cond: unknown) => dialecto.sqlToQuery(cond as SQL);
/** Las consultas con LIMIT (la lista y el detalle), en orden. */
const consultasConLimite = () => estado.consultas.filter((c) => c.limit !== undefined);
const ultimaLista = () => consultasConLimite().filter((c) => c.limit === 51).at(-1)!;
const ultimoDetalle = () => consultasConLimite().filter((c) => c.limit === 1).at(-1)!;

beforeEach(() => {
  estado.consultas.length = 0;
  estado.respuestas.length = 0;
  estado.concedidas.clear();
  estado.concedidas.add('ia_consumo.registros.ver');
  logPiiAccessMock.mockClear();
});

describe('permiso por ruta (A-01)', () => {
  it('sin `ia_consumo.registros.ver` las tres rutas responden 403 con la función y no tocan la base', async () => {
    estado.concedidas.clear();
    const app = await buildApp();
    const respuestas = [
      await pedirCatalogos(app),
      await pedirBuscar(app, cuerpo()),
      await pedirDetalle(app, UUID),
    ];
    for (const r of respuestas) {
      expect(r.status).toBe(403);
      expect(r.body.funcion).toBe('ia_consumo.registros.ver');
    }
    expect(estado.consultas).toHaveLength(0);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

describe('catálogos (A-02)', () => {
  it('trae las listas cerradas y la ventana vigente, sin filas de datos', async () => {
    const app = await buildApp();
    const r = await pedirCatalogos(app);
    expect(r.status).toBe(200);
    expect(r.body.origenes).toEqual(['usuario', 'job', 'sistema', 'ciudadano', 'prueba_prompt']);
    expect(r.body.proveedores).toContain('anthropic');
    expect(r.body.procesos).toEqual(expect.arrayContaining([{ proceso: 'ocr_factura_soat', modulo: 'soat' }]));
    expect(r.body.modulos).toContain('desconocido');
    expect(r.body.ventana).toEqual(ventana);
    expect(estado.consultas).toHaveLength(0);
  });
});

describe('búsqueda y paginación (A-03, A-04, A-15)', () => {
  it('devuelve 50 items como máximo, cursor si hay una más, sin total, con LIMIT 51 y orden (fecha, id) desc', async () => {
    const filas = Array.from({ length: 51 }, (_, i) => filaLista({ id: uuidDe(i + 1), fechaCursor: `2026-11-20T15:00:${String(i).padStart(2, '0')}.000000Z` }));
    estado.respuestas.push(filas);
    const app = await buildApp();
    const r = await pedirBuscar(app, cuerpo());
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(50);
    expect(r.body.siguienteCursor).toEqual(expect.any(String));
    expect(r.body).not.toHaveProperty('total');
    expect(ultimaLista().limit).toBe(51);
    const orden = (ultimaLista().orden ?? []).map((o) => condicionDe(o).sql);
    expect(orden).toEqual([expect.stringMatching(/"fecha_inicio" desc$/), expect.stringMatching(/"id" desc$/)]);
  });

  it('la lista no trae error_mensaje ni metadatos, y su SQL no toca ia_consumo_detalle', async () => {
    estado.respuestas.push([filaLista()]);
    const app = await buildApp();
    const r = await pedirBuscar(app, cuerpo());
    expect(Object.keys(r.body.items[0])).not.toContain('errorMensaje');
    expect(Object.keys(r.body.items[0])).not.toContain('metadatos');
    expect(Object.keys(r.body.items[0])).not.toContain('fechaCursor');
    const textos = Object.values(ultimaLista().cols ?? {}).map((v) => condicionDe(sql`${v}`).sql).join('\n');
    expect(textos).not.toMatch(/ia_consumo_detalle|prompt_texto|respuesta_texto|error_mensaje|"metadatos"/);
  });

  it('el cursor de la página siguiente conserva el instante exacto (microsegundos) y el id de la última fila', async () => {
    const filas = Array.from({ length: 51 }, (_, i) => filaLista({ id: uuidDe(i + 1), fechaCursor: `2026-11-20T15:00:${String(i).padStart(2, '0')}.000000Z` }));
    estado.respuestas.push(filas);
    const app = await buildApp();
    const primera = await pedirBuscar(app, cuerpo({ filtros: { origen: 'usuario' } }));
    estado.respuestas.push([filaLista({ id: uuidDe(99) })]);
    const segunda = await pedirBuscar(app, cuerpo({ cursor: primera.body.siguienteCursor, filtros: { origen: 'usuario' } }));
    expect(segunda.status).toBe(200);
    const condicion = condicionDe(ultimaLista().where);
    expect(condicion.sql).toMatch(/\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
    expect(condicion.params).toEqual(expect.arrayContaining(['2026-11-20T15:00:49.000000Z', uuidDe(50)]));
  });

  it('un cursor solo vale con los mismos filtros: con otros, cursor_invalido', async () => {
    estado.respuestas.push(Array.from({ length: 51 }, (_, i) => filaLista({ id: uuidDe(i + 1) })));
    const app = await buildApp();
    const primera = await pedirBuscar(app, cuerpo({ filtros: { origen: 'usuario' } }));
    const otros = await pedirBuscar(app, cuerpo({ cursor: primera.body.siguienteCursor, filtros: { origen: 'job' } }));
    expect(otros.status).toBe(400);
    expect(otros.body.codigo).toBe('cursor_invalido');
  });

  it('un cursor manipulado responde cursor_invalido sin llegar a la base', async () => {
    const app = await buildApp();
    const basura = Buffer.from(JSON.stringify({ f: '2026-11-20; DROP TABLE x', i: uuidDe(1), h: 'x' })).toString('base64url');
    const r = await pedirBuscar(app, cuerpo({ cursor: basura }));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('cursor_invalido');
    expect(consultasConLimite()).toHaveLength(0);
  });
});

describe('rango de fechas (A-05 … A-08)', () => {
  it('desde posterior a hasta: rango_invalido, sin intercambiar y sin consultar', async () => {
    const app = await buildApp();
    const r = await pedirBuscar(app, { desde: hoy, hasta: sumarDias(hoy, -2) });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('rango_invalido');
    expect(estado.consultas).toHaveLength(0);
  });

  it('32 días: rango_demasiado_amplio; 31 días: 200', async () => {
    const app = await buildApp();
    const largo = await pedirBuscar(app, { desde: sumarDias(hoy, -31), hasta: hoy });
    expect(largo.status).toBe(400);
    expect(largo.body.codigo).toBe('rango_demasiado_amplio');
    estado.respuestas.push([]);
    const justo = await pedirBuscar(app, { desde: sumarDias(hoy, -30), hasta: hoy });
    expect(justo.status).toBe(200);
  });

  it('hasta posterior a hoy en Colombia: rango_invalido', async () => {
    const app = await buildApp();
    const r = await pedirBuscar(app, { desde: hoy, hasta: sumarDias(hoy, 1) });
    expect(r.body.codigo).toBe('rango_invalido');
  });

  it('antes de la ventana: fuera_de_ventana con la fecha mínima, sin consultar', async () => {
    const app = await buildApp();
    const r = await pedirBuscar(app, { desde: sumarDias(ventana.desde, -1), hasta: hoy });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('fuera_de_ventana');
    expect(r.body.error).toContain(ventana.desde);
    expect(estado.consultas).toHaveLength(0);
  });
});

describe('detalle (A-11 … A-14, A-31)', () => {
  it('trae la fila sin texto, los tamaños, el recorte aproximado y los relacionados', async () => {
    estado.respuestas.push([filaDetalle({ bytesPrompt: 65533, bytesRespuesta: 10 })]);
    estado.respuestas.push([filaLista({ id: uuidDe(7) })]);
    const app = await buildApp();
    const r = await pedirDetalle(app, UUID);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: UUID, tieneContenido: true, bytesPrompt: 65533, bytesRespuesta: 10, posiblementeRecortado: true });
    expect(r.body.relacionados).toHaveLength(1);
    expect(r.body).not.toHaveProperty('promptTexto');
    expect(r.body).not.toHaveProperty('respuestaTexto');
  });

  it('bytes por debajo de 65 533 no marcan el recorte', async () => {
    estado.respuestas.push([filaDetalle({ bytesPrompt: 65532, bytesRespuesta: 65532 })]);
    estado.respuestas.push([]);
    const app = await buildApp();
    const r = await pedirDetalle(app, UUID);
    expect(r.body.posiblementeRecortado).toBe(false);
  });

  it('un inexistente y uno fuera de ventana responden lo mismo: 404 no_encontrado, con la ventana en la consulta', async () => {
    const app = await buildApp();
    estado.respuestas.push([]);
    const inexistente = await pedirDetalle(app, UUID);
    estado.respuestas.push([]);
    const fueraDeVentana = await pedirDetalle(app, uuidDe(2));
    expect(inexistente.status).toBe(404);
    expect(fueraDeVentana.status).toBe(404);
    expect(fueraDeVentana.body).toEqual(inexistente.body);
    expect(inexistente.body).toEqual({ error: 'No encontramos ese registro.', codigo: 'no_encontrado' });
    expect(condicionDe(ultimoDetalle().where).params).toEqual(expect.arrayContaining([ventana.desde, ventana.hasta]));
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('metadatos: el CASE solo los devuelve hasta 4 096 bytes; el tamaño va siempre', async () => {
    estado.respuestas.push([filaDetalle({ metadatos: null, metadatosBytes: 5000 })]);
    estado.respuestas.push([]);
    const app = await buildApp();
    const grande = await pedirDetalle(app, UUID);
    expect(grande.body.metadatos).toBeNull();
    expect(grande.body.metadatosBytes).toBe(5000);
    const caso = condicionDe(ultimoDetalle().cols?.metadatos);
    expect(caso.sql).toMatch(/CASE WHEN octet_length\("ia_consumo_log"\."metadatos"::text\) <= \$\d+ THEN "ia_consumo_log"\."metadatos" END/);
    expect(caso.params).toContain(4096);
  });

  it('el SQL del detalle solo mide el texto dentro de octet_length y nunca lo proyecta (A-14)', async () => {
    estado.respuestas.push([filaDetalle()]);
    estado.respuestas.push([]);
    const app = await buildApp();
    await pedirDetalle(app, UUID);
    for (const valor of Object.values(ultimoDetalle().cols ?? {})) {
      const texto = condicionDe(sql`${valor}`).sql;
      const sinMedidas = texto.replace(/octet_length\("ia_consumo_detalle"\."(prompt|respuesta)_texto"\)/g, '');
      expect(sinMedidas).not.toMatch(/prompt_texto|respuesta_texto/);
    }
    const texto = Object.values(ultimoDetalle().cols ?? {}).map((v) => condicionDe(sql`${v}`).sql).join('\n');
    expect(texto).toMatch(/EXISTS \(SELECT 1 FROM "ia_consumo_detalle"/);
  });

  it('los relacionados se buscan dentro de la ventana y sin el propio registro (A-31)', async () => {
    estado.respuestas.push([filaDetalle({ correlacionId: CORRELACION })]);
    estado.respuestas.push([]);
    const app = await buildApp();
    await pedirDetalle(app, UUID);
    const relacionados = consultasConLimite().find((c) => c.limit === 20)!;
    expect(condicionDe(relacionados.where).params).toEqual(expect.arrayContaining([ventana.desde, ventana.hasta, UUID, CORRELACION]));
  });
});

describe('filtros (A-16, A-17)', () => {
  it('modelo: casa el respondido o el solicitado con o sin fecha; el patrón va bindeado y el punto se escapa', async () => {
    const app = await buildApp();
    estado.respuestas.push([]);
    await pedirBuscar(app, cuerpo({ filtros: { modelo: 'claude-haiku-4-5' } }));
    const condicion = condicionDe(ultimaLista().where);
    expect(condicion.sql).toContain('coalesce(');
    expect(condicion.sql).not.toContain('claude-haiku');
    expect(condicion.params).toContain('^claude-haiku-4-5(-[0-9]{8})?$');
    const patron = new RegExp('^claude-haiku-4-5(-[0-9]{8})?$');
    expect(patron.test('claude-haiku-4-5-20251001')).toBe(true);
    expect(patron.test('claude-haiku-4-5x')).toBe(false);

    estado.respuestas.push([]);
    await pedirBuscar(app, cuerpo({ filtros: { modelo: 'gpt.4' } }));
    expect(condicionDe(ultimaLista().where).params).toContain('^gpt\\.4(-[0-9]{8})?$');
    expect(new RegExp('^gpt\\.4(-[0-9]{8})?$').test('gptx4')).toBe(false);
  });

  it('un valor fuera de catálogo o un identificador con formato libre responde 400 datos_invalidos sin consultar', async () => {
    const app = await buildApp();
    const casos = [{ origen: 'x' }, { resultado: 'ok' }, { tipoTarea: 'x' }, { proveedor: 'x' }, { proceso: 'Mayus' }, { modulo: 'con-guion' }];
    for (const filtros of casos) {
      const r = await pedirBuscar(app, cuerpo({ filtros }));
      expect(r.status, JSON.stringify(filtros)).toBe(400);
      expect(r.body.codigo, JSON.stringify(filtros)).toBe('datos_invalidos');
    }
    expect(estado.consultas).toHaveLength(0);
  });
});

describe('sin datos personales en la URL (A-18)', () => {
  it('la búsqueda no existe por GET y ninguna ruta admite query string', async () => {
    const app = await buildApp();
    const porGet = await request(app).get(`${BASE}/registros?usuario=ana%40ejemplo.co`).set('Authorization', AUTH);
    expect(porGet.status).toBe(404);
    const conQuery = await pedirBuscar(app, cuerpo(), '?usuario=ana');
    expect(conQuery.status).toBe(400);
    expect(conQuery.body.codigo).toBe('datos_invalidos');
    const detalleConQuery = await request(app).get(`${BASE}/registros/${UUID}?placa=ABC123`).set('Authorization', AUTH);
    expect(detalleConQuery.status).toBe(400);
    expect(estado.consultas).toHaveLength(0);
  });
});

describe('cabeceras (A-19)', () => {
  it('todas las respuestas llevan Cache-Control: no-store, también las 401, 403 y 400', async () => {
    const app = await buildApp();
    const ok = await pedirCatalogos(app);
    const sinToken = await request(app).get(`${BASE}/catalogos`);
    estado.concedidas.clear();
    const prohibida = await pedirCatalogos(app);
    estado.concedidas.add('ia_consumo.registros.ver');
    const malaFecha = await pedirBuscar(app, { desde: '2026-02-30', hasta: hoy });
    for (const r of [ok, sinToken, prohibida, malaFecha]) expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('auditoría de lectura (A-21 … A-23)', () => {
  it('una búsqueda válida queda como search con sus columnas personales y el conteo de filas', async () => {
    estado.respuestas.push([filaLista({ id: uuidDe(1) }), filaLista({ id: uuidDe(2) })]);
    const app = await buildApp();
    await pedirBuscar(app, cuerpo({ filtros: { usuario: 'ana@ejemplo.co', placa: 'abc123' } }));
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const opts = logPiiAccessMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).toMatchObject({
      resourceTipo: 'ia_consumo_log', accion: 'search', resourceId: null,
      camposAccedidos: ['usuario_id', 'usuario_login', 'placa', 'entidad_id'],
    });
    expect(opts.motivo).toBe('filas=2 filtros_pii=usuario,placa');
  });

  it('una búsqueda sin filas también se audita, sin filtros personales dice ninguno', async () => {
    estado.respuestas.push([]);
    const app = await buildApp();
    await pedirBuscar(app, cuerpo());
    expect(logPiiAccessMock.mock.calls[0]![1]).toMatchObject({ motivo: 'filas=0 filtros_pii=ninguno' });
  });

  it('el valor de un filtro personal no llega a la auditoría: solo la clave (A-22)', async () => {
    const valor = 'ana@ejemplo.co';
    estado.respuestas.push([]);
    const app = await buildApp();
    await pedirBuscar(app, cuerpo({ filtros: { usuario: valor } }));
    const opts = logPiiAccessMock.mock.calls[0]![1];
    expect(JSON.stringify(opts)).not.toContain(valor);
    expect((opts as { motivo: string }).motivo).toBe('filas=0 filtros_pii=usuario');
  });

  it('el detalle se audita como read con su id; un 404 no se audita', async () => {
    const app = await buildApp();
    estado.respuestas.push([filaDetalle()], []);
    const r = await pedirDetalle(app, UUID);
    expect(r.status).toBe(200);
    expect(logPiiAccessMock.mock.calls.at(-1)![1]).toMatchObject({
      resourceTipo: 'ia_consumo_log', accion: 'read', resourceId: null, motivo: `id:${UUID}`,
    });
    estado.respuestas.push([]);
    const noEncontrado = await pedirDetalle(app, uuidDe(3));
    expect(noEncontrado.status).toBe(404);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
  });

  it('si la escritura de auditoría falla, la respuesta sale igual (vía abierta)', async () => {
    logPiiAccessMock.mockRejectedValueOnce(new Error('pool agotado'));
    estado.respuestas.push([filaDetalle()], []);
    const app = await buildApp();
    const r = await pedirDetalle(app, UUID);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(UUID);
  });
});

// Va al final: consume el cupo del limitador de la ruta, compartido por todos los casos anteriores.
describe('límite de consultas (A-20)', () => {
  it('pasado el límite de 60 por minuto responde 429 con el mensaje de la ruta y no-store', async () => {
    const app = await buildApp();
    let r = await pedirCatalogos(app);
    for (let i = 0; i < 80 && r.status !== 429; i++) r = await pedirCatalogos(app);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('Demasiadas consultas seguidas. Espera un minuto.');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
