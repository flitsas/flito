import { describe, it, expect, vi } from 'vitest';

// El grafo de la sincronización importa db/client (crea el pool). Mock mínimo: estos tests
// cubren lógica pura (decisiones y mapeos), no tocan BD. El flujo completo se verifica contra
// PostgreSQL real (smoke E2E de sincronización).
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

// El emparejamiento de organismo consulta la config; se mockea para probar SOLO el orden de
// preferencia (código → ciudad → nombre), que es la lógica nueva.
const organismoPorCodigoMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, organismoPorCodigo: organismoPorCodigoMock };
});

const { flitoGestionaImpuesto } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { mapearCompradores } = await import('../../src/modules/flito-sync/mapeo-compradores.js');
const { intervalMsFromCron } = await import('../../src/modules/flito-sync/flito-sync.cron.js');
const { resolverOrganismoDeFlit } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { aTramite } = await import('../../src/modules/flito-sync/flit-http.adapter.js');

// ───────────── Emparejamiento de la secretaría (codigoSecretaria del reporte) ────────────────

const itemFlit = {
  Id: 'FLIT-044456', Vin: '9FKRG2222T2042405', Placa: 'JNH38H', Ciudad: 'FUNZA', Estado: 'Aprobado',
  Tramite: 'Otros', Transito: 'STRIA TTOyTTE MCPAL FUNZA', CompaniaGestora: '901789698',
  codigoSecretaria: '25286', fecha_aprobacion: '2026-06-18T10:16:47.179',
};

describe('aTramite — el reporte ya trae el código DIVIPOLA', () => {
  it('mapea codigoSecretaria a organismoCodigo', () => {
    expect(aTramite(itemFlit).organismoCodigo).toBe('25286');
  });
  it('sin codigoSecretaria queda null y el sync tendrá que deducirlo', () => {
    const { codigoSecretaria: _omitido, ...sinCodigo } = itemFlit;
    expect(aTramite(sinCodigo).organismoCodigo).toBeNull();
  });
  it('conserva el payload crudo completo para trazabilidad', () => {
    expect(aTramite(itemFlit).raw).toEqual(itemFlit);
  });
});

describe('resolverOrganismoDeFlit — código primero, ciudad y nombre como respaldo', () => {
  const tf = (over: Record<string, unknown> = {}) => ({
    organismoCodigo: null, ciudad: null, transitoNombre: null, ...over,
  } as never);

  it('usa el código del reporte cuando está configurado', async () => {
    organismoPorCodigoMock.mockReset().mockResolvedValueOnce({ codigo: '25286' });
    const r = await resolverOrganismoDeFlit(tf({ organismoCodigo: '25286', ciudad: 'FUNZA' }));
    expect(r).toEqual({ codigo: '25286' });
    expect(organismoPorCodigoMock).toHaveBeenCalledExactlyOnceWith('25286');
  });

  it('código presente pero SIN configurar → cae a la ciudad en vez de rendirse', async () => {
    // Antes, un código presente cortaba la búsqueda y el trámite quedaba "sin emparejar".
    organismoPorCodigoMock.mockReset()
      .mockResolvedValueOnce(null)              // 99999 no configurado
      .mockResolvedValueOnce({ codigo: '25286' }); // resuelto por ciudad
    const r = await resolverOrganismoDeFlit(tf({ organismoCodigo: '99999', ciudad: 'Funza' }));
    expect(r).toEqual({ codigo: '25286' });
    expect(organismoPorCodigoMock).toHaveBeenNthCalledWith(2, '25286');
  });

  it('sin código ni ciudad reconocible → resuelve por el nombre de la secretaría', async () => {
    organismoPorCodigoMock.mockReset().mockResolvedValueOnce({ codigo: '25286' });
    const r = await resolverOrganismoDeFlit(tf({ transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA' }));
    expect(r).toEqual({ codigo: '25286' });
  });

  it('nada reconocible → null (queda sin emparejar, no se inventa organismo)', async () => {
    organismoPorCodigoMock.mockReset();
    const r = await resolverOrganismoDeFlit(tf({ ciudad: 'Ciudad Inexistente' }));
    expect(r).toBeNull();
  });

  it('ignora espacios sobrantes en el código', async () => {
    organismoPorCodigoMock.mockReset().mockResolvedValueOnce({ codigo: '25286' });
    await resolverOrganismoDeFlit(tf({ organismoCodigo: ' 25286 ' }));
    expect(organismoPorCodigoMock).toHaveBeenCalledWith('25286');
  });
});

// ───────────── RN-01 Impuestos: FLITO gestiona solo si no se autogestiona (compañía ni organismo) ──

describe('flitoGestionaImpuesto', () => {
  it('organismo REQUIERE_GESTION + compañía no autogestiona → FLITO gestiona (crea registro)', () => {
    expect(flitoGestionaImpuesto(false, 'requiere_gestion')).toBe(true);
  });
  it('organismo AUTOGESTIONADO → NO gestiona (exento, sin registro)', () => {
    expect(flitoGestionaImpuesto(false, 'autogestionado')).toBe(false);
  });
  it('compañía autogestiona impuestos → NO gestiona aunque el organismo requiera gestión', () => {
    expect(flitoGestionaImpuesto(true, 'requiere_gestion')).toBe(false);
  });
});

// ───────────── Mapeo de compradores por tipo de propiedad (§9.6 SOAT) ───────────────────────

const comprador = (n: string) => ({ nombreCompleto: n, numeroDocumento: '1', correo: null, celular: null, direccion: null });
const tramiteBase = { idFlit: 'T1', processStatus: 5, plateComplete: 'ABC123', vin: 'V', placa: 'ABC123', marca: 'X', linea: 'Y', cilindraje: 0, capacidad: 0, tipoVehiculo: 'auto', companiaNit: '900', organismoCodigo: '11001', valorImpuestoLiquidado: null };

describe('mapearCompradores', () => {
  it('único propietario → un comprador con 100%', () => {
    const r = mapearCompradores({ ...tramiteBase, tipoPropiedad: 'unico_propietario', compradores: [comprador('Ana')] } as never);
    expect(r).toHaveLength(1);
    expect(r[0].orden).toBe(0);
    expect(r[0].porcentajeParticipacion).toBe(100);
  });
  it('único propietario con 2 compradores → lanza (datos contradictorios, no elige en silencio)', () => {
    expect(() => mapearCompradores({ ...tramiteBase, tipoPropiedad: 'unico_propietario', compradores: [comprador('Ana'), comprador('Beto')] } as never)).toThrow(/único propietario/);
  });
  it('múltiple propietario → conserva orden de FLIT', () => {
    const r = mapearCompradores({ ...tramiteBase, tipoPropiedad: 'multiple_propietario', compradores: [comprador('Ana'), comprador('Beto')] } as never);
    expect(r.map((c) => [c.orden, c.nombreCompleto])).toEqual([[0, 'Ana'], [1, 'Beto']]);
  });
  it('múltiple propietario con 1 comprador → lanza', () => {
    expect(() => mapearCompradores({ ...tramiteBase, tipoPropiedad: 'multiple_propietario', compradores: [comprador('Ana')] } as never)).toThrow(/múltiple propietario/);
  });
  it('tipo de propiedad desconocido → lanza', () => {
    expect(() => mapearCompradores({ ...tramiteBase, tipoPropiedad: 'otro', compradores: [comprador('Ana')] } as never)).toThrow(/tipo de propiedad desconocido/);
  });
});

// ───────────── Cron: intervalo derivado de SYNC_CRON ─────────────────────────────────────────

describe('intervalMsFromCron', () => {
  it('"0 */5 * * * *" → 5 min', () => { expect(intervalMsFromCron('0 */5 * * * *')).toBe(5 * 60000); });
  it('"0 */10 * * * *" → 10 min', () => { expect(intervalMsFromCron('0 */10 * * * *')).toBe(10 * 60000); });
  it('expresión no soportada → 5 min por defecto', () => { expect(intervalMsFromCron('0 30 8 * * 1')).toBe(5 * 60000); });
});
