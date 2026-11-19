// Torre de Control Gerencial (Épica #14590, ADR-0047, B1a · AC8) — Excel del detalle sin base: hojas «Registros» y
// «Definición», celdas por `textoSeguro`, nombre sin placa, sin columnas de dinero sin permiso, 422 si el total pasa de
// `FILAS_DETALLE_EXPORTAR_MAX` (nunca recorte silencioso), `logPiiAccess` con `export`, y el auditor (sin exportar) 403.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { COLUMNAS_DETALLE, TOPES_TORRE, type ResultadoDetalle } from '@operaciones/shared-types';

// `enTorre` corre sobre un `tx` falso: el conteo y el listado se sustituyen abajo.
vi.mock('../../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return {
    db: { select: () => c, transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => [] }) },
    getPoolStats: vi.fn(),
  };
});
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const pii = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/shared/pii-audit.js', () => ({ logPiiAccess: pii }));
const conteo = { total: vi.fn(), listar: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.conjuntos.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, totalFragmento: (...a: unknown[]) => conteo.total(...a), listarFragmento: (...a: unknown[]) => conteo.listar(...a) };
});

const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: router } = await import('../../../src/modules/flito-torre/flito-torre.detalle.routes.js');
const { celdaExcel, libroDetalle, nombreArchivoDetalle } = await import('../../../src/modules/flito-torre/flito-torre.detalle-export.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const filas = new Map<number, FilasPermisos>();
const de = (id: number, funciones: string[]) => {
  filas.set(id, { rol: `r${id}`, tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(funciones), excepciones: [] });
};
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const app = express();
app.use(express.json());
app.use('/api/flito/torre/detalle', router);
const exporta = async (sub: number, body: object) =>
  request(app).post('/api/flito/torre/detalle/exportar').set('Authorization', `Bearer ${await token(sub)}`).send(body)
    .buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });

const BODY = { origen: { tipo: 'conjunto', conjunto: 'sin_facturar' }, filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' } } };

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  for (const i of [1, 2, 3]) permisos.invalidarPermisosDe(i);
  pii.mockClear(); conteo.total.mockReset(); conteo.listar.mockReset();
  de(1, ['accion.torre_detalle.ver', 'accion.torre_detalle.exportar', 'accion.torre_financiera.ver']);          // sin dinero
  de(2, ['accion.torre_detalle.ver', 'accion.torre_financiera.ver', 'accion.torre_explorador.ver_dinero']);       // auditor: ve, no exporta
  de(3, ['accion.torre_detalle.ver', 'accion.torre_detalle.exportar', 'accion.torre_financiera.ver', 'accion.torre_explorador.ver_dinero']);
});

describe('AC8 · exportar', () => {
  it('422 DETALLE_EXCEDE_TOPE si el total pasa de FILAS_DETALLE_EXPORTAR_MAX, sin listar ninguna fila', async () => {
    conteo.total.mockResolvedValue({ total: TOPES_TORRE.FILAS_DETALLE_EXPORTAR_MAX + 1, valorTotal: 0 });
    const r = await request(app).post('/api/flito/torre/detalle/exportar').set('Authorization', `Bearer ${await token(1)}`).send(BODY);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('DETALLE_EXCEDE_TOPE');
    expect(r.body.error).toContain('Acote el periodo o los filtros');
    expect(conteo.listar).not.toHaveBeenCalled();
    expect(pii).not.toHaveBeenCalled();
  });

  it('con el total en el tope exporta un xlsx con nombre sin placa y registra `export` de la placa', async () => {
    conteo.total.mockResolvedValue({ total: 1, valorTotal: 500_000 });
    conteo.listar.mockResolvedValue([{ __id: 't1', __tramite: 't1', codigo_flit: '=HYPERLINK("x")', placa: 'ZQ1234', compania: null, organismo: '05001', estado: 'Aprobado', valor: '500000' }]);
    const r = await exporta(3, BODY);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toMatch(/filename="torre-detalle-sin-facturar-\d{8}\.xlsx"/);
    expect(r.headers['content-disposition']).not.toContain('ZQ1234');
    expect(pii).toHaveBeenCalledTimes(1);
    expect(pii.mock.calls[0]![1]).toMatchObject({ resourceTipo: 'flito_tramite', accion: 'export', camposAccedidos: ['placa'] });
    const ExcelJS = (await import('exceljs')).default;
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.body as Buffer);
    expect(libro.worksheets.map((w) => w.name)).toEqual(['Registros', 'Definición']);
    const hoja = libro.getWorksheet('Registros')!;
    expect(hoja.getRow(2).getCell(1).value).toBe('\'=HYPERLINK("x")');
  });

  it('el auditor (sin torre.detalle.exportar) recibe 403', async () => {
    expect((await exporta(2, BODY)).status).toBe(403);
  });
});

describe('libro puro', () => {
  const r: Omit<ResultadoDetalle, 'pagina' | 'tamano'> = {
    origen: { tipo: 'conjunto', conjunto: 'sin_facturar' }, segmentos: [{ dimension: 'compania', valores: ['7', null] }],
    definicion: { etiqueta: 'Trabajo sin facturar', definicion: '+definición', fechaBase: 'aprobacion', campoFecha: 'fecha_aprobacion' },
    total: 1, valorTotal: null, columnas: [COLUMNAS_DETALLE.placa, COLUMNAS_DETALLE.faltan_soportes, COLUMNAS_DETALLE.valor],
    filas: [{ id: '1', tramiteId: '1', celdas: { placa: '@ZQ1', faltan_soportes: ['SOAT', 'Derecho'], valor: null } }],
    truncado: false, filtrosIgnorados: [], rango: { desde: '2035-03-01', hasta: '2035-03-31' }, dineroVisible: false,
    frase: '1 trámite aprobado en el periodo aún no tiene factura.', fraseVacio: 'Todo lo aprobado en el periodo ya está facturado.',
    generadoEn: '2035-03-31T10:00:00.000Z',
  };

  it('sin dinero no lleva la columna de dinero; las celdas y la definición pasan por textoSeguro', () => {
    const l = libroDetalle(r, { rango: { preset: 'mes' } });
    expect(l.registros.columnas.map((c) => c.key)).toEqual(['placa', 'faltan_soportes']);
    expect(l.registros.filas[0]).toEqual({ placa: '\'@ZQ1', faltan_soportes: 'SOAT, Derecho' });
    expect(l.definicion.find((d) => d.concepto === 'Cómo se calcula')?.valor).toBe('\'+definición');
    expect(l.definicion.find((d) => d.concepto === 'Segmentos')?.valor).toBe('compania: 7, sin valor');
    expect(l.definicion.find((d) => d.concepto === 'Total de registros')?.valor).toBe(1);
  });

  it('celdaExcel y nombre de archivo', () => {
    expect(celdaExcel(true)).toBe('Sí');
    expect(celdaExcel(-3)).toBe(-3);
    expect(celdaExcel('-1')).toBe('\'-1');
    expect(nombreArchivoDetalle('borrador_abandonado', '2035-03-31T10:00:00.000Z')).toBe('torre-detalle-borrador-abandonado-20350331.xlsx');
  });
});

describe('B5 · los detalles de Equipo (entidad funcionario)', () => {
  const EQUIPO = ['gestiones_funcionario_periodo', 'carga_funcionario', 'fuera_ans_funcionario'] as const;
  const body = (conjunto: string) => ({ ...BODY, origen: { tipo: 'conjunto', conjunto }, segmentos: [{ dimension: 'funcionario', valores: ['7'] }] });
  beforeEach(() => {
    permisos.invalidarPermisosDe(4);
    de(4, ['accion.torre_detalle.ver', 'accion.torre_detalle.exportar', 'accion.torre_operativa.ver_equipo', 'accion.torre_explorador.ver_dinero']);
  });

  for (const conjunto of EQUIPO) {
    it(`${conjunto}: exportar es 403 DETALLE_SIN_EXPORTACION (sin Excel en v1), sin contar filas ni registrar lectura`, async () => {
      const r = await request(app).post('/api/flito/torre/detalle/exportar').set('Authorization', `Bearer ${await token(4)}`).send(body(conjunto));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ code: 'DETALLE_SIN_EXPORTACION', error: 'La lista de gestiones del equipo se puede consultar, pero no descargar.' });
      expect(conteo.total).not.toHaveBeenCalled();
      expect(pii).not.toHaveBeenCalled();
    });

    it(`${conjunto}: consultar registra la lectura de la placa Y del funcionario`, async () => {
      conteo.total.mockResolvedValue({ total: 1, valorTotal: null });
      conteo.listar.mockResolvedValue([{ __id: 'th:1', __tramite: null, placa: 'ZQ1234', funcionario: 'Ana Restrepo' }]);
      const r = await request(app).post('/api/flito/torre/detalle/consultar').set('Authorization', `Bearer ${await token(4)}`)
        .send({ ...body(conjunto), pagina: 1, tamano: 25 });
      expect(r.status).toBe(200);
      expect(pii).toHaveBeenCalledTimes(1);
      expect(pii.mock.calls[0]![1]).toMatchObject({ resourceTipo: 'flito_estado_historial', accion: 'read', camposAccedidos: ['placa', 'funcionario'] });
    });
  }

  it('un detalle que no es de Equipo sigue registrando solo la placa y sí se exporta', async () => {
    conteo.total.mockResolvedValue({ total: 1, valorTotal: 0 });
    conteo.listar.mockResolvedValue([]);
    const r = await exporta(3, BODY);
    expect(r.status).toBe(200);
    expect(pii.mock.calls[0]![1]).toMatchObject({ accion: 'export', camposAccedidos: ['placa'] });
  });
});
