import { describe, it, expect, vi } from 'vitest';

// Integración FLIT (Fase 8 P1.1): mapeo del payload real y helpers de estado. Lógica pura; el grafo
// del sync importa db/client (crea el pool), así que se mockea. Ver docs/integracion/integracionFlit.md.
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const { aTramite } = await import('../../src/modules/flito-sync/flit-http.adapter.js');
const { estadoEnumDesdeFlit, esAsignado } = await import('../../src/modules/flito-sync/flito-sync.service.js');

// ─────────────── Mapeo del payload real (ejemplo del doc de integración) ───────────────

describe('aTramite — mapea el item del reporte real a TramiteFlit', () => {
  const item = {
    Id: 'FLIT-0125705', Vin: 'LRWYGCFJXTC771761', tipo: 'n', Placa: '', Ciudad: 'PALMIRA',
    Estado: 'Borrador', modelo: 'Y', Tramite: 'Matricula', celular: '3146144528', factura: '',
    nombres: 'LAS AMERICAS DISTRIBUCIONES SAS', Transito: 'STRIA TTOyTTE PALMIRA', apellidos: ' ',
    cedulanit: '900990426', direccion: 'CRA 43 A  16 SUR 47', CompaniaGestora: '901789698',
    fecha_aprobacion: null, correoelectronico: 'lasamericasdistribuciones@yahoo.com',
  };

  it('llaves y campos crudos', () => {
    const t = aTramite(item);
    expect(t.idFlit).toBe('FLIT-0125705');
    expect(t.estadoFlit).toBe('Borrador');
    expect(t.vin).toBe('LRWYGCFJXTC771761');
    expect(t.ciudad).toBe('PALMIRA');
    expect(t.tipoTramite).toBe('Matricula');
    expect(t.companiaNit).toBe('901789698');
    expect(t.transitoNombre).toBe('STRIA TTOyTTE PALMIRA');
    expect(t.fechaAprobacion).toBeNull();
    expect(t.raw).toBe(item);
  });

  it('campos vacíos → null (placa y factura del ejemplo vienen vacías)', () => {
    const t = aTramite(item);
    expect(t.placa).toBeNull();
    expect(t.facturaVentaFlitId).toBeNull();
    expect(t.organismoCodigo).toBeNull(); // el reporte da nombre, no código
  });

  it('un titular por trámite → un comprador (unico_propietario)', () => {
    const t = aTramite(item);
    expect(t.tipoPropiedad).toBe('unico_propietario');
    expect(t.compradores).toHaveLength(1);
    expect(t.compradores[0]).toMatchObject({
      nombreCompleto: 'LAS AMERICAS DISTRIBUCIONES SAS', numeroDocumento: '900990426',
      correo: 'lasamericasdistribuciones@yahoo.com', celular: '3146144528',
    });
  });

  it('factura presente se conserva como id', () => {
    expect(aTramite({ ...item, factura: 'e1f09b3b-560a-48bd-82a2-7b311701ebd6' }).facturaVentaFlitId)
      .toBe('e1f09b3b-560a-48bd-82a2-7b311701ebd6');
  });
});

// ─────────────── Estado: texto crudo → enum interno + gating ───────────────

describe('estadoEnumDesdeFlit', () => {
  it('mapea los estados con equivalente (case-insensitive)', () => {
    expect(estadoEnumDesdeFlit('Asignado')).toBe('asignado');
    expect(estadoEnumDesdeFlit('APROBADO')).toBe('aprobado');
    expect(estadoEnumDesdeFlit('entregado')).toBe('entregado');
  });
  it('estado sin equivalente (Borrador) → null (no se fuerza a un enum cerrado)', () => {
    expect(estadoEnumDesdeFlit('Borrador')).toBeNull();
    expect(estadoEnumDesdeFlit('En proceso')).toBeNull();
  });
});

describe('esAsignado — gating de SOAT/impuestos', () => {
  it('solo Asignado habilita (tolerante a mayúsculas/espacios)', () => {
    expect(esAsignado('Asignado')).toBe(true);
    expect(esAsignado('  asignado ')).toBe(true);
    expect(esAsignado('Borrador')).toBe(false);
    expect(esAsignado('Aprobado')).toBe(false);
  });
});
