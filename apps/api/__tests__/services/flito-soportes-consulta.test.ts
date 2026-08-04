// FLITO — consulta de soportes (shared/soportes/soportes-consulta).
//
// Este armado lo comparten cuatro pantallas (reporte de costos, Gestión de trámites, el detalle de
// un SOAT y el de un impuesto) y por eso se prueba aquí una vez, sobre el servicio, en vez de
// repetir la comprobación en cada ruta. Lo que se vigila es lo que se rompería en silencio: que
// aparezcan TODOS los orígenes —el fallo original era ver solo el primero que se encontraba— y que
// las URLs salgan firmadas. El descarte de los soportes rechazados es un WHERE y no se puede
// afirmar contra un mock de drizzle: vive en la consulta, no en este armado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const { soportesDeTramite, soportesDeSoat } = await import('../../src/shared/soportes/soportes-consulta.js');

const soporte = (id: string, nombre: string, subidoEn: string) => ({
  id, tipo: 'comprobante', nombreArchivo: nombre, storageKey: `flito/${id}`, subidoEn: new Date(subidoEn),
});

beforeEach(() => { kdb.reset(); });

describe('soportesDeTramite', () => {
  it('trámite inexistente → null, para que la ruta pueda responder 404 y no una lista vacía', async () => {
    kdb.when.select('flito_tramites', []);
    expect(await soportesDeTramite('t1')).toBeNull();
  });

  it('devuelve los cuatro orígenes, no el primero que encuentra', async () => {
    kdb.when.scenario({
      flito_tramites: [{ soatId: 's1', impuestoId: 'i1', derechoId: 'd1' }],
      flito_logistica_documentos: [{
        id: 'log-1', tipo: 'licencia', foto: 'flito/foto.jpg', createdAt: new Date('2026-07-04T00:00:00Z'),
        actaPdf: null, actaEn: null, actaId: null,
      }],
    });
    // Las tres consultas a flito_soportes salen en orden: SOAT, impuesto, derecho.
    kdb.when
      .selectOnce('flito_soportes', [soporte('sop-soat', 'soat.pdf', '2026-07-01T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-imp', 'impuesto.pdf', '2026-07-03T00:00:00Z')])
      .selectOnce('flito_soportes', [soporte('sop-der', 'recibo.pdf', '2026-07-02T00:00:00Z')]);

    const salida = await soportesDeTramite('t1');

    expect(salida?.map((s) => s.origen).sort()).toEqual(['derecho', 'impuesto', 'logistica', 'soat']);
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

    const salida = await soportesDeSoat('s1');

    expect(salida).toHaveLength(1);
    expect(salida[0]).toMatchObject({ origen: 'soat', nombreArchivo: 'factura-soat.pdf' });
  });
});
