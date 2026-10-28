// HU #14131 (Feature #14013, ADR-0032) — recibir y validar la carga masiva de renovaciones (eslabón 1:
// el lote queda `en_cola`, SIN procesarlo; el worker es la HU #14132). AC1–AC9.
//
// Los XLSX son REALES (exceljs) y el "falso" es un ZIP verdadero sin partes OOXML o con una bomba de
// descompresión; el contenedor se verifica por bytes, no por extensión ni Content-Type. La base es un
// doble por COLA de respuestas (el orden de las lecturas del servicio es parte del contrato).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { testToken } from '../helpers/auth.js';
import { env } from '../../src/config/env.js';
const flagWorker = (v: boolean) => { (env as { SOAT_MASIVO_WORKER_ENABLED: boolean }).SOAT_MASIVO_WORKER_ENABLED = v; };

let cola: unknown[] = [];
const selectMock = vi.fn(() => {
  const q = {
    from: () => q, where: () => q, limit: () => q, for: () => q, groupBy: () => q, orderBy: () => q,
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(cola.length ? cola.shift() : []).then(ok, ko),
  };
  return q;
});
const insertados: Array<{ tabla: string; valores: unknown }> = [];
let falloTx: unknown = null;
const transactionMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
  if (falloTx) throw falloTx;
  let n = 0;
  const tx = {
    insert: (t: { [k: symbol]: unknown }) => ({
      values: (v: unknown) => {
        const tabla = n++ === 0 ? 'lotes' : 'filas';
        void t; insertados.push({ tabla, valores: v });
        return { returning: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] , then: (ok: (x: unknown) => unknown) => Promise.resolve(undefined).then(ok) };
      },
    }),
  };
  return cb(tx);
});
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn(), transaction: transactionMock },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));

const ctxMock = vi.fn();
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/flito-soat/flito-soat.service.js')>()),
  contextoSoat: () => ctxMock(),
}));

const ctx = (alcance: string, companiaId: number | null) => ({
  userId: 1, username: 'u', role: 'cliente', proyeccionCliente: alcance === 'compania', alcance, proveedorSoatId: null, companiaId,
});
const LOTE_ID = '11111111-1111-4111-8111-111111111111';
const ENC = ['Placa', 'Documento', 'Nombre', 'Correo', 'Celular'];

async function xlsx(filas: unknown[][], encabezados: unknown[] = ENC): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  ws.addRow(encabezados);
  for (const f of filas) ws.addRow(f);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const fila = (i: number) => [`ABC${100 + i}`, `10000${1000 + i}`, `Persona ${i}`, `p${i}@ejemplo.com`, `3101234${String(100 + i).slice(-3)}`];

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-masivo.routes.js');
  a.use('/api/flito/soat', router);
  return a;
}
let sub = 9500;
const auth = async (funciones: string[] = ['soat.solicitud.crear'], role: 'admin' | 'auditor' = 'admin') =>
  `Bearer ${await testToken({ sub: sub++, role, funciones })}`;

/** Lecturas del alta feliz: canal abierto, cliente operable, sin lote activo, nombre del usuario. */
const altaFeliz = () => { cola = [[{ id: 7, carpeta: null }], [{ name: 'ACME', active: true, deletedAt: null }], [], [{ nombre: 'Ana' }]]; };

async function subir(buf: Buffer | string, nombre = 'carga.xlsx', campos: Record<string, string> = { tipo: 'renovacion' }, rol: 'admin' | 'auditor' = 'admin') {
  const r = request(await app()).post('/api/flito/soat/cliente/masivo').set('Authorization', await auth(rol === 'admin' ? ['soat.solicitud.crear'] : [], rol));
  for (const [k, v] of Object.entries(campos)) r.field(k, v);
  return r.attach('archivo', Buffer.isBuffer(buf) ? buf : Buffer.from(buf), nombre);
}

beforeEach(() => {
  flagWorker(true);
  cola = []; insertados.length = 0; falloTx = null;
  selectMock.mockClear(); transactionMock.mockClear(); auditMock.mockClear(); piiMock.mockClear(); ctxMock.mockReset();
  ctxMock.mockResolvedValue(ctx('compania', 7));
});

describe('AC1 — plantilla de Renovación', () => {
  it('GET /cliente/masivo/plantilla devuelve un .xlsx con los encabezados Placa, Documento, Nombre, Correo, Celular y sin datos', async () => {
    const r = await request(await app()).get('/api/flito/soat/cliente/masivo/plantilla').set('Authorization', await auth())
      .buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/plantilla-soat-renovacion\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as Buffer);
    const ws = wb.worksheets[0]!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(ENC);
    expect(ws.rowCount).toBe(1);
  });
  it('sin sesión es 401 y con un tipo desconocido es 400 tipo_invalido', async () => {
    expect((await request(await app()).get('/api/flito/soat/cliente/masivo/plantilla')).status).toBe(401);
    const r = await request(await app()).get('/api/flito/soat/cliente/masivo/plantilla?tipo=otro').set('Authorization', await auth());
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('tipo_invalido');
  });
});

describe('AC2 — un .xlsx válido de 1–200 filas crea el lote en cola', () => {
  it('3 filas → 201; lote en_cola con quién/compañía/tipo/total/hash y UNA fila `pendiente` por registro; el lote no guarda filas ni el Excel', async () => {
    altaFeliz();
    const r = await subir(await xlsx([fila(1), fila(2), fila(3)]));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ loteId: LOTE_ID, tipo: 'renovacion', total: 3, aceptadasEnCola: 3, rechazadasDeEntrada: 0 });
    const lote = insertados.find((i) => i.tabla === 'lotes')!.valores as Record<string, unknown>;
    expect(lote).toMatchObject({ companiaId: 7, creadoPorId: 1, creadoPorNombre: 'Ana', tipoSoat: 'renovacion', estado: 'en_cola', totalFilas: 3 });
    expect(String(lote.archivoHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(lote).sort()).toEqual(['archivoHash', 'companiaId', 'creadoPorId', 'creadoPorNombre', 'estado', 'tipoSoat', 'totalFilas']);
    const filas = insertados.find((i) => i.tabla === 'filas')!.valores as Array<Record<string, unknown>>;
    expect(filas.map((f) => [f.nFila, f.estado])).toEqual([[2, 'pendiente'], [3, 'pendiente'], [4, 'pendiente']]);
    expect(filas[0]).toMatchObject({ placa: 'ABC101', documento: '100001001', nombre: 'Persona 1' });
  });
  it('exactamente 200 filas se aceptan', async () => {
    altaFeliz();
    const r = await subir(await xlsx(Array.from({ length: 200 }, (_, i) => fila(i))));
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(200);
  });
  it('una fila con formato inválido o repetida nace `rechazada` con su motivo y no tumba el archivo', async () => {
    altaFeliz();
    const mala = ['A1', '100001001', 'Ana', 'no-es-correo', '3101234567'];
    const r = await subir(await xlsx([fila(1), mala, fila(1)]));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ total: 3, aceptadasEnCola: 1, rechazadasDeEntrada: 2 });
    const filas = insertados.find((i) => i.tabla === 'filas')!.valores as Array<Record<string, unknown>>;
    expect(filas.map((f) => f.motivoRechazo)).toEqual([null, 'placa_invalida', 'fila_duplicada']);
  });
  it('las celdas se leen como TEXTO: placa/documento numéricos o con ceros no se deforman; las filas vacías se ignoran', async () => {
    altaFeliz();
    const r = await subir(await xlsx([['00123', 1.23456789012e11, 'Pedro Pérez', 'pedro@ejemplo.com', 3101234567], [null, null, null, null, null], [], fila(2)]));
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(2);
    const filas = insertados.find((i) => i.tabla === 'filas')!.valores as Array<Record<string, unknown>>;
    expect(filas[0]).toMatchObject({ placa: '00123', documento: '123456789012', celular: '3101234567' });
  });
});

describe('reglas por fila = las de la renovación individual (#14017) y las de #14132', () => {
  it('placa y documento usan EXACTAMENTE placaSchema y numeroDocumentoSchema del canal (mismos veredictos)', async () => {
    const { placaSchema, numeroDocumentoSchema } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
    const { parsearXlsxRenovacion } = await import('../../src/modules/flito-soat/flito-soat-masivo-parse.js');
    const muestras = ['abc123', 'AB-C 12', 'A1', 'ABCDEFGH', 'AB#123', '1234567'];
    const docs = ['1234', '123', '900.123.456-7', 'x'.repeat(31), ' 12345 '];
    const filas = muestras.map((p, i) => [p, docs[i % docs.length], 'Ana Gómez', 'a@ejemplo.com', '3101234567']);
    const { filas: out } = await parsearXlsxRenovacion(await xlsx(filas));
    muestras.forEach((p, i) => {
      const pOk = placaSchema.safeParse(p).success;
      const dOk = numeroDocumentoSchema.safeParse(docs[i % docs.length]).success;
      if (!pOk) expect(out[i]!.motivoRechazo, p).toBe('placa_invalida');
      else if (!dOk) expect(out[i]!.motivoRechazo).toBe('documento_invalido');
      else expect(out[i]!.motivoRechazo).toBeNull();
    });
  });
  it('celular: 10 dígitos y empieza por 3; correo: formato estándar', async () => {
    const { parsearXlsxRenovacion } = await import('../../src/modules/flito-soat/flito-soat-masivo-parse.js');
    const f = (pl: string, cel: string, cor = 'a@ejemplo.com') => [pl, '100001001', 'Ana Gómez', cor, cel];
    const { filas } = await parsearXlsxRenovacion(await xlsx([
      f('AAA111', '3101234567'), f('AAA112', '2101234567'), f('AAA113', '310123456'), f('AAA114', '31012345678'),
      f('AAA115', '3101234567', 'sin-arroba'), f('AAA116', '310 123 4567'),
    ]));
    expect(filas.map((x) => x.motivoRechazo)).toEqual([null, 'celular_invalido', 'celular_invalido', 'celular_invalido', 'correo_invalido', null]);
  });
  it('los textos de motivo nombran el campo y no devuelven el valor', async () => {
    const { MENSAJE_MOTIVO } = await import('../../src/modules/flito-soat/flito-soat-masivo-parse.js');
    expect(MENSAJE_MOTIVO.fila_duplicada).toBe('Placa repetida en el archivo');
    expect(MENSAJE_MOTIVO.celular_invalido).toBe('Celular inválido');
  });
});

describe('AC3 — encabezados', () => {
  it('sin distinguir mayúsculas ni tildes y en cualquier orden', async () => {
    altaFeliz();
    const buf = await xlsx([['3101234567', 'ana@ejemplo.com', 'Ana Gómez', '100001001', 'abc123']], ['CELULAR', 'cOrreo', 'NÓMBRE', 'Documentó', ' placa ']);
    const r = await subir(buf);
    expect(r.status).toBe(201);
    const filas = insertados.find((i) => i.tabla === 'filas')!.valores as Array<Record<string, unknown>>;
    expect(filas[0]).toMatchObject({ placa: 'ABC123', documento: '100001001', nombre: 'Ana Gómez', correo: 'ana@ejemplo.com', celular: '3101234567' });
  });
  it('un encabezado faltante rechaza TODO el archivo y no encola nada', async () => {
    altaFeliz();
    const r = await subir(await xlsx([['ABC123', '1', 'Ana', 'a@b.co']], ['Placa', 'Documento', 'Nombre', 'Correo']));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('encabezados_invalidos');
    expect(r.body.faltantes).toEqual(['Celular']);
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('un encabezado desconocido rechaza todo, y el mensaje no repite lo tecleado', async () => {
    altaFeliz();
    const r = await subir(await xlsx([fila(1).concat('x')], [...ENC, 'Secreto-Raro']));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('encabezados_invalidos');
    expect(JSON.stringify(r.body)).not.toContain('Secreto-Raro');
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('AC4 — el contenido real manda, no la extensión', () => {
  it.each([
    ['un CSV renombrado .xlsx', Buffer.from('Placa,Documento\nABC123,1\n')],
    ['bytes sueltos con firma PK', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)])],
  ])('%s → 400 formato_invalido y no se encola', async (_n, buf) => {
    altaFeliz();
    const r = await subir(buf, 'carga.xlsx');
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('formato_invalido');
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('un ZIP verdadero que no es un libro de Excel (sin partes OOXML) → rechazo', async () => {
    altaFeliz();
    const z = new JSZip(); z.file('hola.txt', 'hola');
    const r = await subir(Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('formato_invalido');
  });
  it('una zip bomb (partes OOXML + 30 MB que comprimen a casi nada) → rechazo sin pasar por exceljs', async () => {
    altaFeliz();
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types/>'); z.file('xl/workbook.xml', '<workbook/>'); z.file('xl/bomba.bin', Buffer.alloc(30 * 1024 * 1024));
    const buf = Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
    expect(buf.length).toBeLessThan(1024 * 1024);
    const r = await subir(buf);
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('formato_invalido');
  });
  it('un archivo con otra extensión (.csv) se corta en el filtro de multer', async () => {
    const r = await subir(Buffer.from('a,b'), 'carga.csv');
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('formato_invalido');
  });
});

describe('AC5 — vacío, demasiadas filas o más de 1 MB', () => {
  it('sin archivo → 400 archivo_requerido', async () => {
    altaFeliz();
    const r = await request(await app()).post('/api/flito/soat/cliente/masivo').set('Authorization', await auth()).field('tipo', 'renovacion');
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('archivo_requerido');
  });
  it('archivo de 0 bytes y libro con solo encabezados → 400 archivo_vacio', async () => {
    altaFeliz();
    expect((await subir(Buffer.alloc(0))).body.codigo).toBe('archivo_vacio');
    altaFeliz();
    const r = await subir(await xlsx([[], [null, null, null, null, null]]));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('archivo_vacio');
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('201 filas → 422 demasiadas_filas, sin encolar', async () => {
    altaFeliz();
    const r = await subir(await xlsx(Array.from({ length: 201 }, (_, i) => fila(i))));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('demasiadas_filas');
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('más de 1 MB → 413 archivo_muy_grande', async () => {
    altaFeliz();
    const r = await subir(Buffer.concat([Buffer.from([0x50, 0x4b]), Buffer.alloc(1024 * 1024 + 10)]));
    expect(r.status).toBe(413);
    expect(r.body.codigo).toBe('archivo_muy_grande');
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('AC6 — un lote activo por compañía', () => {
  it('con otro lote en cola o procesando → 409 lote_activo con el id opaco, sin leer el archivo', async () => {
    cola = [[{ id: 7, carpeta: null }], [{ name: 'ACME', active: true, deletedAt: null }], [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]];
    const r = await subir(await xlsx([fila(1)]));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'lote_activo', loteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(r.body.error).toMatch(/en curso/);
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('la carrera la cierra el índice único parcial: 23505 en la transacción → 409', async () => {
    altaFeliz();
    cola.push([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
    falloTx = Object.assign(new Error('duplicate key'), { code: '23505' });
    const r = await subir(await xlsx([fila(1)]));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('lote_activo');
  });
});

describe('AC7 — compañía y permiso', () => {
  it('admin (alcance todo) sin compañía elegida → 400 compania_requerida; no encola', async () => {
    ctxMock.mockResolvedValue(ctx('todo', null));
    const r = await subir(await xlsx([fila(1)]));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('compania_requerida');
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('admin que elige una compañía sin el canal abierto → 403 canal_desactivado', async () => {
    ctxMock.mockResolvedValue(ctx('todo', null));
    cola = [[]];
    const r = await subir(await xlsx([fila(1)]), 'carga.xlsx', { tipo: 'renovacion', companiaId: '9' });
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('canal_desactivado');
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('un usuario con compañía que pide OTRA → 403 compania_no_permitida', async () => {
    const r = await subir(await xlsx([fila(1)]), 'carga.xlsx', { tipo: 'renovacion', companiaId: '9' });
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('compania_no_permitida');
  });
  it('sin la función soat.solicitud.crear (auditor, que no la tiene de partida) → 403 en las tres rutas y no se llega al contexto ni a la base', async () => {
    expect((await subir(await xlsx([fila(1)]), 'carga.xlsx', { tipo: 'renovacion' }, 'auditor')).status).toBe(403);
    const a = await app();
    const sin = await auth([], 'auditor');
    expect((await request(a).get('/api/flito/soat/cliente/masivo/plantilla').set('Authorization', sin)).status).toBe(403);
    expect((await request(a).get(`/api/flito/soat/cliente/masivo/${LOTE_ID}`).set('Authorization', sin)).status).toBe(403);
    expect(ctxMock).not.toHaveBeenCalled();
  });
});

describe('AC8 — el avance solo lo ve la compañía dueña', () => {
  const lote = (companiaId: number) => ({ id: LOTE_ID, companiaId, estado: 'en_cola', tipoSoat: 'renovacion', totalFilas: 5, creadoEn: new Date('2026-10-27T10:00:00Z') });
  const get = async () => request(await app()).get(`/api/flito/soat/cliente/masivo/${LOTE_ID}`).set('Authorization', await auth());

  it('la dueña ve contadores por estado de fila y motivos, sin PII y sin caché', async () => {
    cola = [[lote(7)], [{ estado: 'pendiente', n: 3 }, { estado: 'rechazada', n: 2 }], [{ codigo: 'placa_invalida', n: 2 }]];
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      loteId: LOTE_ID, estado: 'en_cola', tipo: 'renovacion', total: 5, pendientes: 3, procesando: 0, aceptadas: 0, porValidar: 0, rechazadas: 2,
      motivosRechazo: [{ codigo: 'placa_invalida', mensaje: 'Placa inválida', cantidad: 2 }], creadoEn: '2026-10-27T10:00:00.000Z',
      resumen: null, descargaRechazadas: false,
    });
  });
  it('otra compañía → 404 (no 403); proveedor y alcance nada → 404; id no uuid → 404; inexistente → 404', async () => {
    cola = [[lote(8)]];
    expect((await get()).status).toBe(404);
    for (const a of ['proveedor', 'nada']) { ctxMock.mockResolvedValue(ctx(a, null)); expect((await get()).status).toBe(404); }
    ctxMock.mockResolvedValue(ctx('compania', 7)); cola = [[]];
    expect((await get()).status).toBe(404);
    const r = await request(await app()).get('/api/flito/soat/cliente/masivo/no-es-uuid').set('Authorization', await auth());
    expect(r.status).toBe(404);
  });
});

describe('AC9 — un registro de acceso PII por lote y nada de PII en logs', () => {
  it('un único logPiiAccess con el conteo de filas; ni el motivo ni la auditoría llevan placa/documento/nombre/correo/celular', async () => {
    altaFeliz();
    const espias = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const r = await subir(await xlsx([fila(1), fila(2)]));
    expect(r.status).toBe(201);
    expect(piiMock).toHaveBeenCalledTimes(1);
    const opts = piiMock.mock.calls[0]![1] as { resourceTipo: string; camposAccedidos: string[]; motivo: string };
    expect(opts.resourceTipo).toBe('flito_soat_masivo_lote');
    expect(opts.motivo).toBe(`alta_masivo lote=${LOTE_ID} tipo=renovacion filas=2`);
    const todo = JSON.stringify([piiMock.mock.calls.map((c) => c[1]), auditMock.mock.calls.map((c) => c[1]), ...espias.map((e) => e.mock.calls.map((c) => c.map(String).join(' ')))]);
    for (const dato of ['ABC101', '100001001', 'Persona 1', 'p1@ejemplo.com', '3101234101']) expect(todo).not.toContain(dato);
    espias.forEach((e) => e.mockRestore());
  });
  it('un alta rechazada no registra acceso (no se entregó ni guardó nada)', async () => {
    altaFeliz();
    await subir(Buffer.from('no es un excel'));
    expect(piiMock).not.toHaveBeenCalled();
  });
});

describe('HU #14132 — con el worker apagado el alta no crea nada', () => {
  it('POST /cliente/masivo responde 503 carga_masiva_no_disponible, sin leer el archivo ni crear lote; la plantilla sigue viva', async () => {
    flagWorker(false);
    altaFeliz();
    const r = await subir(await xlsx([fila(1)]));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ codigo: 'carga_masiva_no_disponible', error: 'La carga masiva no está disponible por ahora.' });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(insertados).toHaveLength(0);
    expect(selectMock).not.toHaveBeenCalled();
    const p = await request(await app()).get('/api/flito/soat/cliente/masivo/plantilla').set('Authorization', await auth());
    expect(p.status).toBe(200);
  });
});
