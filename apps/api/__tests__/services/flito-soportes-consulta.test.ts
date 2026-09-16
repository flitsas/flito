// FLITO — consulta de soportes (shared/soportes/soportes-consulta).
//
// Este armado lo comparten cuatro pantallas (reporte de costos, Gestión de trámites, el detalle de
// un SOAT y el de un impuesto) y por eso se prueba aquí una vez, sobre el servicio, en vez de
// repetir la comprobación en cada ruta. Lo que se vigila es lo que se rompería en silencio: que
// aparezcan TODOS los orígenes —el fallo original era ver solo el primero que se encontraba— y que
// las URLs salgan firmadas. El descarte de los soportes rechazados es un WHERE y no se puede
// afirmar contra un mock de drizzle: vive en la consulta, no en este armado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const {
  soportesDeTramite, soportesDeSoat, soportesDeComprobantesAplicados,
} = await import('../../src/shared/soportes/soportes-consulta.js');

const soporte = (id: string, nombre: string, subidoEn: string) => ({
  id, tipo: 'comprobante', nombreArchivo: nombre, storageKey: `flito/${id}`, subidoEn: new Date(subidoEn),
});

beforeEach(() => { kdb.reset(); });

describe('soportesDeTramite', () => {
  it('trámite inexistente → null, para que la ruta pueda responder 404 y no una lista vacía', async () => {
    kdb.when.select('flito_tramites', []);
    expect(await soportesDeTramite('t1')).toBeNull();
  });

  it('devuelve los cinco orígenes, no el primero que encuentra', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: 'i1', derechoId: 'd1' }],
      flito_logistica_documentos: [{
        id: 'log-1', tipo: 'licencia', foto: 'flito/foto.jpg', createdAt: new Date('2026-07-04T00:00:00Z'),
        actaPdf: null, actaEn: null, actaId: null,
      }],
      // HU #11335: la factura electrónica no cuelga del trámite sino de la factura, y el puente es
      // esta tabla. Solo las vivas.
      siigo_factura_tramites: [{ facturaId: 'fac-1' }],
    });
    // Las cuatro consultas a flito_soportes salen en orden: SOAT, impuesto, derecho, factura.
    kdb.when
      .selectOnce('flito_soportes', [soporte('sop-soat', 'soat.pdf', '2026-07-01T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-imp', 'impuesto.pdf', '2026-07-03T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-der', 'recibo.pdf', '2026-07-02T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-fac', 'factura-FV-1.pdf', '2026-07-05T00:00:00Z')]);

    const salida = await soportesDeTramite('t1');

    expect(salida?.map((s) => s.origen).sort())
      .toEqual(['derecho', 'factura_electronica', 'impuesto', 'logistica', 'soat']);
  });

  it('los documentos de la factura salen por la MISMA lista que los demás, y firmados', async () => {
    // Es lo que resuelve el permiso del AC6 sin una ruta nueva: las dos rutas que sirven esta lista
    // ya exigen acceso a Gestión de trámites o al reporte de costos, y la URL es un enlace con
    // caducidad, no la ruta del almacenamiento.
    kdb.when.scenario({
      flito_tramites: [{ soatId: null, impuestoId: null, derechoId: null }],
      flito_logistica_documentos: [],
      siigo_factura_tramites: [{ facturaId: 'fac-1' }],
      flito_soportes: [soporte('sop-xml', 'factura-FV-1.xml', '2026-07-05T00:00:00Z')],
    });

    const salida = await soportesDeTramite('t1');

    expect(salida).toHaveLength(1);
    expect(salida?.[0]).toMatchObject({ origen: 'factura_electronica', nombreArchivo: 'factura-FV-1.xml' });
    expect(salida?.[0].url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
  });

  it('los ordena del más reciente al más antiguo: lo último cargado es lo que se viene a mirar', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: 'i1', derechoId: null }],
      flito_logistica_documentos: [],
    });
    kdb.when
      .selectOnce('flito_soportes', [soporte('viejo', 'soat.pdf', '2026-07-01T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('nuevo', 'impuesto.pdf', '2026-07-09T00:00:00Z')]);

    const salida = await soportesDeTramite('t1');

    expect(salida?.map((s) => s.id)).toEqual(['nuevo', 'viejo']);
  });

  it('un concepto sin registro no aparece ni rompe: simplemente no está', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: null, impuestoId: null, derechoId: null }],
      flito_logistica_documentos: [],
      flito_soportes: [soporte('no-deberia', 'x.pdf', '2026-07-01T00:00:00Z')],
    });

    // Sin soatId/impuestoId/derechoId no se consulta flito_soportes en absoluto.
    expect(await soportesDeTramite('t1')).toEqual([]);
  });

  it('el acta de entrega se lista UNA vez aunque cubra varios documentos del trámite', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: null, impuestoId: null, derechoId: null }],
      flito_logistica_documentos: [
        { id: 'l1', tipo: 'licencia', foto: null, createdAt: new Date('2026-07-04T00:00:00Z'), actaPdf: 'flito/acta.pdf', actaEn: new Date('2026-07-04T00:00:00Z'), actaId: 'acta-1' },
        { id: 'l2', tipo: 'placa', foto: null, createdAt: new Date('2026-07-04T00:00:00Z'), actaPdf: 'flito/acta.pdf', actaEn: new Date('2026-07-04T00:00:00Z'), actaId: 'acta-1' },
      ],
    });

    const salida = await soportesDeTramite('t1');

    expect(salida?.filter((s) => s.tipo === 'acta_entrega')).toHaveLength(1);
  });

  it('las URLs son enlaces firmados de la API, nunca la ruta del storage', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: null, derechoId: null }],
      flito_logistica_documentos: [],
      flito_soportes: [soporte('sop-1', 'soat.pdf', '2026-07-01T00:00:00Z')],
    });

    const salida = await soportesDeTramite('t1');

    expect(salida?.[0].url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
  });
});

describe('soportesDeSoat', () => {
  it('marca el origen para que el visor sepa agruparlo', async () => {
    kdb.when.select('flito_soportes', [soporte('sop-1', 'factura-soat.pdf', '2026-07-01T00:00:00Z')]);

    const salida = await soportesDeSoat('s1', { rol: 'admin', estadoSoat: 'pagado' });

    expect(salida).toHaveLength(1);
    expect(salida[0]).toMatchObject({ origen: 'soat', nombreArchivo: 'factura-soat.pdf' });
  });

  it('el comprobante del pago PSE solo entra para quien tiene derecho a verlo (HU #11678, AC5)', async () => {
    // El bloque de `conciliacion` es el único de esta lista que depende del ROL y no solo de la
    // pertenencia: `auditor` llega a esta ruta sin que `buscarConAcceso` le filtre nada. Los casos
    // por ruta están en `flito-soat-comprobante-conciliacion.test.ts`; aquí se fija el armado.
    kdb.when
      .select('flito_soportes', [soporte('sop-1', 'factura-soat.pdf', '2026-07-01T00:00:00Z')])
      .select('flito_conciliacion_lineas', [soporte('sop-pse', 'pse.pdf', '2026-08-20T00:00:00Z')]);

    const conDerecho = await soportesDeSoat('s1', { rol: 'proveedor', estadoSoat: 'pagado' });
    const auditoria = await soportesDeSoat('s1', { rol: 'auditor', estadoSoat: 'pagado' });

    expect(conDerecho.map((x) => x.origen).sort()).toEqual(['conciliacion', 'soat']);
    expect(auditoria.map((x) => x.origen)).toEqual(['soat']);
  });
});

describe('HU #12633 — los comprobantes aplicados aparecen en los soportes del trámite', () => {
  // El mock keyed responde por tabla e ignora el `on` y el `where`: devolvería la misma fila aunque
  // la consulta preguntara por la columna equivocada. Por eso, además de mirar la salida, se
  // captura lo que drizzle construyó para el SELECT sobre `flito_comprobantes` y se afirma sobre el
  // SQL renderizado (`PgDialect.sqlToQuery`), que es lo único que cae ante los mutantes de la HU.
  interface Consulta { tabla: string; uniones: unknown[]; condiciones: unknown[] }
  let consultas: Consulta[] = [];
  const aTexto = (q: unknown) => new PgDialect().sqlToQuery(q as never);
  const deComprobantes = () => {
    const c = consultas.find((q) => q.tabla === 'flito_comprobantes');
    if (!c) throw new Error('no se consultó flito_comprobantes');
    return c;
  };

  beforeEach(() => {
    consultas = [];
    const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const chain = base(...args);
      const registro: Consulta = { tabla: '__no_from__', uniones: [], condiciones: [] };
      consultas.push(registro);
      const from = chain.from as (t: unknown) => unknown;
      const innerJoin = chain.innerJoin as (t: unknown, on: unknown) => unknown;
      const where = chain.where as (c: unknown) => unknown;
      chain.from = (t: unknown) => { registro.tabla = getTableName(t as never); return from(t); };
      chain.innerJoin = (t: unknown, on: unknown) => { registro.uniones.push(on); return innerJoin(t, on); };
      chain.where = (c: unknown) => { registro.condiciones.push(c); return where(c); };
      return chain;
    });
  });

  const sinFk = () => kdb.when.scenario({
    flito_tramites: [{ soatId: null, impuestoId: null, derechoId: null }],
    flito_logistica_documentos: [],
    siigo_factura_tramites: [],
  });

  it('AC1 — honorarios/documentación sin FK salen con origen `comprobante`, firmados y con fecha', async () => {
    sinFk();
    kdb.when.select('flito_comprobantes', [
      { ...soporte('hijo-1', 'honorarios.pdf', '2026-09-10T00:00:00Z'), tipo: 'honorarios' },
    ]);

    const salida = await soportesDeTramite('t1');

    expect(salida).toHaveLength(1);
    expect(salida?.[0]).toMatchObject({
      id: 'hijo-1', origen: 'comprobante', tipo: 'honorarios', nombreArchivo: 'honorarios.pdf',
      subidoEn: '2026-09-10T00:00:00.000Z',
    });
    expect(salida?.[0].url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
  });

  it('AC1 — se enseña el HIJO recortado si lo hubo, y el original si no: COALESCE en la unión', async () => {
    // Mutante: unir por `soporte_id` a secas. El mock devolvería la misma fila y la salida sería
    // idéntica; lo que cae es este aserto sobre el `ON` real. Es lo que distingue «la página que se
    // aplicó a este trámite» de «el consolidado entero de N pagos».
    sinFk();
    kdb.when.select('flito_comprobantes', []);

    await soportesDeTramite('t1');

    const { uniones } = deComprobantes();
    expect(uniones).toHaveLength(1);
    const on = aTexto(uniones[0]).sql;
    expect(on).toContain('"flito_soportes"."id" = COALESCE('
      + '"flito_comprobantes"."soporte_aplicado_id", "flito_comprobantes"."soporte_id")');
  });

  it('AC2 — un SOAT aplicado por comprobante sale UNA vez, con origen `soat`, no otra como `comprobante`', async () => {
    // El soporte hijo lleva `soat_id` desde la HU #12629, así que `porRegistro` ya lo devuelve. El
    // bloque de comprobantes trae la MISMA fila; sin la deduplicación por id saldría dos veces.
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: null, derechoId: null }],
      flito_logistica_documentos: [],
      siigo_factura_tramites: [],
      flito_soportes: [{ ...soporte('sop-soat-hijo', 'soat.pdf', '2026-09-10T00:00:00Z'), tipo: 'factura_soat' }],
      flito_comprobantes: [{ ...soporte('sop-soat-hijo', 'soat.pdf', '2026-09-10T00:00:00Z'), tipo: 'factura_soat' }],
    });

    const salida = await soportesDeTramite('t1');

    expect(salida).toHaveLength(1);
    expect(salida?.[0]).toMatchObject({ id: 'sop-soat-hijo', origen: 'soat' });
    expect(salida?.map((s) => s.origen)).not.toContain('comprobante');
  });

  it('AC2 — la deduplicación conserva lo que NO sale por FK: honorarios junto al SOAT', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: null, derechoId: null }],
      flito_logistica_documentos: [],
      siigo_factura_tramites: [],
      flito_soportes: [{ ...soporte('sop-soat-hijo', 'soat.pdf', '2026-09-10T00:00:00Z'), tipo: 'factura_soat' }],
      flito_comprobantes: [
        { ...soporte('sop-soat-hijo', 'soat.pdf', '2026-09-10T00:00:00Z'), tipo: 'factura_soat' },
        { ...soporte('hijo-hon', 'honorarios.pdf', '2026-09-11T00:00:00Z'), tipo: 'honorarios' },
      ],
    });

    const salida = await soportesDeTramite('t1');

    expect(salida?.map((s) => [s.id, s.origen])).toEqual([
      ['hijo-hon', 'comprobante'], ['sop-soat-hijo', 'soat'],
    ]);
  });

  it('AC3 — solo `aplicado` y solo de este trámite: la condición está en el SQL, no en memoria', async () => {
    // Un pendiente no es de nadie todavía y un descartado no es evidencia de nada. El mock no filtra,
    // así que la prueba está en el WHERE renderizado: igualdad estricta a `aplicado` (no un IN que
    // cuele `pendiente`) y la llave del trámite enlazada.
    sinFk();
    kdb.when.select('flito_comprobantes', []);

    await soportesDeTramite('t1');

    const { condiciones } = deComprobantes();
    expect(condiciones).toHaveLength(1);
    const { sql, params } = aTexto(condiciones[0]);
    expect(sql).toContain('"flito_comprobantes"."tramite_id" = $1');
    expect(sql).toContain('"flito_comprobantes"."estado" = $2');
    expect(sql).toContain('"flito_soportes"."descartado" = $3');
    expect(params).toEqual(['t1', 'aplicado', false]);
    expect(sql).not.toMatch(/"estado" in \(/i);
  });

  it('AC3 — desde la lista del trámite no hay recorte por tipo (roles internos): sin `tipo IN` en el WHERE', async () => {
    sinFk();
    kdb.when.select('flito_comprobantes', []);

    await soportesDeTramite('t1');

    expect(aTexto(deComprobantes().condiciones[0]).sql).not.toContain('"flito_soportes"."tipo"');
  });

  it('AC3 — el recorte de tipos por actor va en la CONSULTA, con la misma firma que `porRegistro`', async () => {
    // Patrón `porRegistro`: `tipos` acota el SELECT, no solo un `filter` posterior. No se lee lo que
    // no se va a devolver (HU #11913).
    kdb.when.select('flito_comprobantes', [
      { ...soporte('hijo-1', 'honorarios.pdf', '2026-09-10T00:00:00Z'), tipo: 'honorarios' },
    ]);

    const salida = await soportesDeComprobantesAplicados('t1', ['honorarios', 'documentacion']);

    expect(salida.map((s) => s.origen)).toEqual(['comprobante']);
    const { sql, params } = aTexto(deComprobantes().condiciones[0]);
    expect(sql).toContain('"flito_soportes"."tipo" in ($4, $5)');
    expect(params).toEqual(['t1', 'aplicado', false, 'honorarios', 'documentacion']);
  });

  it('AC3 — con `null` no se recorta, y con una lista se recorta: son dos consultas distintas', async () => {
    kdb.when.select('flito_comprobantes', []);

    await soportesDeComprobantesAplicados('t1', null);
    await soportesDeComprobantesAplicados('t1', ['honorarios']);

    const [sinRecorte, conRecorte] = consultas.filter((q) => q.tabla === 'flito_comprobantes');
    expect(aTexto(sinRecorte.condiciones[0]).sql).not.toContain('"flito_soportes"."tipo"');
    expect(aTexto(conRecorte.condiciones[0]).sql).toContain('"flito_soportes"."tipo" in ($4)');
  });

  it('el bloque de comprobantes no altera los cinco orígenes que ya salían', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: 'i1', derechoId: 'd1' }],
      flito_logistica_documentos: [{
        id: 'log-1', tipo: 'licencia', foto: 'flito/foto.jpg', createdAt: new Date('2026-07-04T00:00:00Z'),
        actaPdf: null, actaEn: null, actaId: null,
      }],
      siigo_factura_tramites: [{ facturaId: 'fac-1' }],
      flito_comprobantes: [{ ...soporte('hijo-hon', 'honorarios.pdf', '2026-07-06T00:00:00Z'), tipo: 'honorarios' }],
    });
    kdb.when
      .selectOnce('flito_soportes', [soporte('sop-soat', 'soat.pdf', '2026-07-01T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-imp', 'impuesto.pdf', '2026-07-03T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-der', 'recibo.pdf', '2026-07-02T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-fac', 'factura-FV-1.pdf', '2026-07-05T00:00:00Z')]);

    const salida = await soportesDeTramite('t1');

    expect(salida?.map((s) => s.origen).sort())
      .toEqual(['comprobante', 'derecho', 'factura_electronica', 'impuesto', 'logistica', 'soat']);
  });
});
