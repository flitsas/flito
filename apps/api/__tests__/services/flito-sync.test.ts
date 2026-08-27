import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

// El grueso de este archivo cubre lógica pura (decisiones y mapeos) y no toca BD. La excepción es
// `upsertVehiculo`, que NO se exporta —es un paso interno del sync— y solo se puede ejercitar por
// donde entra de verdad: `sincronizar` con un puerto FLIT de mentira y el mock keyed de drizzle.
// Por eso `db` ya no es `{}`: es el mock enrutado por tabla (OPS-02b), inerte para el resto.
const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// El emparejamiento de organismo consulta la config; se mockea para probar SOLO el orden de
// preferencia (código → ciudad → nombre), que es la lógica nueva. `companiaPorNit` y
// `modalidadVigente` se fijan porque el recorrido completo de `sincronizar` las consulta.
const organismoPorCodigoMock = vi.fn();
const companiaPorNitMock = vi.fn();
const modalidadVigenteMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return {
    ...real,
    organismoPorCodigo: organismoPorCodigoMock,
    companiaPorNit: companiaPorNitMock,
    modalidadVigente: modalidadVigenteMock,
  };
});

// El guardián de longitud avisa por `log.warn` y esa llamada ES parte del contrato (un valor que se
// descarta sin dejar rastro es un dato que desaparece en silencio). Se mockea el logger entero para
// poder afirmarla; `loggerFor` devuelve siempre el MISMO objeto, así que el spy vale para el módulo
// que lo pidió al cargarse.
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({
  logger: logMock,
  loggerFor: () => logMock,
}));

const { flitoGestionaImpuesto } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { mapearCompradores } = await import('../../src/modules/flito-sync/mapeo-compradores.js');
const { intervalMsFromCron } = await import('../../src/modules/flito-sync/flito-sync.cron.js');
const { resolverOrganismoDeFlit } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { setVehiculoDesdeFlit, sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { aTramite, MAX_DATOS_VEHICULO } = await import('../../src/modules/flito-sync/flit-http.adapter.js');
const { vehicles } = await import('../../src/db/schema.js');

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

// ───────────── HU #11906: cilindraje, carrocería y tipo de servicio ─────────────────────────

// Los tres campos, con valores del reporte REAL (medido el 2026-08-27 sobre 2733 items del
// reportTypeId=18): cilindraje "220" es el más frecuente (917 filas, motos) y tipoServicio solo
// toma "Particular" y "Publico".
const itemConDatos = { ...itemFlit, cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular' };

describe('aTramite — los tres datos técnicos del vehículo (HU #11906)', () => {
  it('mapea cilindraje, carrocería y tipo de servicio tal cual los dice FLIT', () => {
    const t = aTramite(itemConDatos);
    expect(t.cilindraje).toBe('1598');
    expect(t.carroceria).toBe('DOBLE CABINA CON PLATON');
    expect(t.tipoServicio).toBe('Particular');
  });

  it('recorta espacios sobrantes, igual que el resto de campos del reporte', () => {
    const t = aTramite({ ...itemConDatos, cilindraje: '  220  ', carroceria: ' SUV ', tipoServicio: ' Publico ' });
    expect([t.cilindraje, t.carroceria, t.tipoServicio]).toEqual(['220', 'SUV', 'Publico']);
  });

  it('**vacío → null**, que es lo que la cola pinta como «—» (AC2): sin error y sin cadena vacía', () => {
    // Medido: 10 de 2733 traen cilindraje vacío y 14 carrocería vacía. La cadena vacía sería un
    // tercer valor para «no sé» y viajaría al frontend como un dato que existe.
    const t = aTramite({ ...itemConDatos, cilindraje: '', carroceria: '   ', tipoServicio: '' });
    expect([t.cilindraje, t.carroceria, t.tipoServicio]).toEqual([null, null, null]);
  });

  it('**clave ausente → null**, no `undefined`: el AC2 vale igual si FLIT deja de mandar el campo', () => {
    // `undefined` colaría por el spread condicional del sync igual que `null`, pero se le pasaría a
    // drizzle en el INSERT, donde significa «no escribas esta columna» y no «déjala en NULL».
    const t = aTramite(itemFlit);
    expect(t.cilindraje).toBeNull();
    expect(t.carroceria).toBeNull();
    expect(t.tipoServicio).toBeNull();
    for (const k of ['cilindraje', 'carroceria', 'tipoServicio']) expect(t).toHaveProperty(k);
  });

  it('el AC4 al pie de la letra: no aparecen celular, correo ni cédula fuera de `compradores`/`raw`', () => {
    // El payload de FLIT los trae y esta HU NO los promueve a campo de primer nivel. `raw` sí los
    // conserva (es la copia cruda de siempre) y `compradores` es donde ya vivían.
    const conPii = { ...itemConDatos, celular: '3001234567', correoelectronico: 'a@b.co', cedulanit: '1020304050' };
    const { raw: _raw, compradores: _c, ...plano } = aTramite(conPii) as Record<string, unknown>;
    for (const k of ['celular', 'correo', 'correoelectronico', 'cedulanit', 'documento']) {
      expect(Object.keys(plano), `${k} no puede subir al trámite`).not.toContain(k);
    }
    // Y tampoco se cuela `tipo` ni `modelo`, que el reporte trae y esta HU no pide.
    expect(Object.keys(plano)).not.toContain('tipo');
    expect(Object.keys(plano)).not.toContain('modelo');
  });
});

describe('aTramite — el guardián de longitud descarta, NO trunca', () => {
  it('un valor más largo que su columna se va a null y deja un warn (no un 22001 en el sync)', () => {
    logMock.warn.mockClear();
    const largo = '9'.repeat(MAX_DATOS_VEHICULO.cilindraje + 1);
    const t = aTramite({ ...itemConDatos, cilindraje: largo });
    // Truncar daría '9999999999', que es OTRO cilindraje con aspecto de dato bueno.
    expect(t.cilindraje).toBeNull();
    expect(t.cilindraje).not.toBe(largo.slice(0, MAX_DATOS_VEHICULO.cilindraje));
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0][0]).toMatchObject({ campo: 'cilindraje', longitud: largo.length });
  });

  it('el warn NO lleva el valor: un campo mal alineado por el proveedor podría traer PII', () => {
    logMock.warn.mockClear();
    aTramite({ ...itemConDatos, carroceria: `CL 45 # 12-34 APTO 201 BOGOTA ${'X'.repeat(60)}` });
    expect(JSON.stringify(logMock.warn.mock.calls[0][0])).not.toMatch(/APTO 201/);
  });

  it('el borde EXACTO cabe: descartar a los `max` caracteres sería perder datos buenos', () => {
    logMock.warn.mockClear();
    const justo = 'X'.repeat(MAX_DATOS_VEHICULO.carroceria);
    expect(aTramite({ ...itemConDatos, carroceria: justo }).carroceria).toBe(justo);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('los tres campos tienen guardián, no solo el primero', () => {
    const t = aTramite({
      ...itemConDatos,
      cilindraje: 'C'.repeat(MAX_DATOS_VEHICULO.cilindraje + 1),
      carroceria: 'B'.repeat(MAX_DATOS_VEHICULO.carroceria + 1),
      tipoServicio: 'S'.repeat(MAX_DATOS_VEHICULO.tipoServicio + 1),
    });
    expect([t.cilindraje, t.carroceria, t.tipoServicio]).toEqual([null, null, null]);
  });
});

// ───────────── Política de escritura del sync sobre `vehicles` (HU #11906) ───────────────────

describe('setVehiculoDesdeFlit — un vacío NO borra lo que ya estaba guardado', () => {
  const tf = (over: Record<string, unknown> = {}) => ({
    placa: 'JNH38H', marca: null, linea: null, compradores: [],
    cilindraje: null, carroceria: null, tipoServicio: null, ...over,
  } as never);

  it('**los tres ausentes → las tres columnas quedan FUERA del SET**', () => {
    // Este es el test que muere si alguien cambia el spread condicional por asignación directa:
    // con `cilindraje: tf.cilindraje` la clave aparecería con valor null, y el UPDATE del sync
    // pasaría a ser `SET cilindraje = NULL` sobre un vehículo que ya lo tenía.
    const set = setVehiculoDesdeFlit(tf());
    for (const k of ['cilindraje', 'carroceria', 'tipoServicio']) {
      expect(Object.keys(set), `${k} no puede viajar en el SET cuando FLIT no lo trajo`).not.toContain(k);
    }
  });

  it('con valor → sí van al SET, con el valor de FLIT', () => {
    const set = setVehiculoDesdeFlit(tf({ cilindraje: '220', carroceria: 'SUV', tipoServicio: 'Publico' }));
    expect(set).toMatchObject({ cilindraje: '220', carroceria: 'SUV', tipoServicio: 'Publico' });
  });

  it('campo a campo: el que viene se escribe y el que falta no pisa al otro', () => {
    const set = setVehiculoDesdeFlit(tf({ carroceria: 'SEDAN' }));
    expect(set).toMatchObject({ carroceria: 'SEDAN' });
    expect(Object.keys(set)).not.toContain('cilindraje');
    expect(Object.keys(set)).not.toContain('tipoServicio');
  });

  it('la misma política que el propietario, que es de donde se copió (contra-prueba)', () => {
    // Si alguien «unificara» las dos reglas por el lado equivocado, este par de aserciones cae junto
    // con el de arriba, y deja claro que eran la misma decisión.
    const set = setVehiculoDesdeFlit(tf({ compradores: [{ nombreCompleto: '', numeroDocumento: '' }] }));
    expect(Object.keys(set)).not.toContain('ownerName');
    expect(Object.keys(set)).not.toContain('ownerDocument');
    // `plate` SÍ es asignación directa y así seguía: FLIT siempre la trae.
    expect(Object.keys(set)).toContain('plate');
  });
});

// ───────────── AC1/AC3: lo que `upsertVehiculo` ESCRIBE en `vehicles` (HU #11906) ────────────
//
// `setVehiculoDesdeFlit` es solo el SET de la rama UPDATE. El AC1 dice «quedan guardados en la base
// de datos», y por la rama de ALTA es por donde entran los vehículos nuevos del sync: sin esto,
// borrar los tres campos del `.values({...})` del INSERT no rompía nada.

const T_VEHICLES = getTableName(vehicles);
const RANGO = { initialDate: '20260801', finalDate: '20260830' };
const VEHICULO_ID = 42;
const TRAMITE_ID = 'cccc0000-0000-0000-0000-00000000000c';

/** Trámite tal y como sale del adaptador, con los tres datos técnicos de la HU. */
const tramiteFlit = (over: Record<string, unknown> = {}) => ({
  idFlit: 'FLIT-044456', estadoFlit: 'Asignado', vin: '9FKRG2222T2042405', placa: 'JNH38H',
  ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA', organismoCodigo: '25286',
  fechaAprobacion: null, fechaCreacionFlit: null, tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: 'Ana', numeroDocumento: '1', correo: null, celular: null, direccion: null }],
  valorImpuestoLiquidado: null, processStatus: 5, raw: {},
  cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular',
  ...over,
});

/** Puerto FLIT de mentira: devuelve el reporte y nada más (la integración es de solo lectura). */
const puertoConUno = (tf: Record<string, unknown>) => ({
  obtenerTramites: async () => [tf],
  obtenerUrlFactura: async () => null,
  marcarEntregado: async () => undefined,
} as never);

/** El helper keyed enruta por tabla pero descarta lo escrito; aquí interesa justo eso. */
function espiarInserts() {
  const vistos: { tabla: string; values: Record<string, unknown> }[] = [];
  const base = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tabla: unknown) => {
    const c = base(tabla) as Record<string, unknown>;
    const values = c.values as (v: unknown) => unknown;
    c.values = (v: unknown) => {
      vistos.push({ tabla: getTableName(tabla as never), values: v as Record<string, unknown> });
      return values(v);
    };
    return c;
  });
  return vistos;
}

function espiarUpdates() {
  const vistos: { tabla: string; set: Record<string, unknown> }[] = [];
  const base = kdb.update.getMockImplementation()!;
  kdb.update.mockImplementation((tabla: unknown) => {
    const c = base(tabla) as Record<string, unknown>;
    const set = c.set as (v: unknown) => unknown;
    c.set = (v: unknown) => {
      vistos.push({ tabla: getTableName(tabla as never), set: v as Record<string, unknown> });
      return set(v);
    };
    return c;
  });
  return vistos;
}

describe('sincronizar → upsertVehiculo — los tres datos LLEGAN a la fila del vehículo (AC1)', () => {
  beforeEach(() => {
    kdb.reset();
    logMock.error.mockClear();
    organismoPorCodigoMock.mockReset().mockResolvedValue({ codigo: '25286' });
    // Compañía que autogestiona SOAT e impuestos: esta HU no es de SOAT ni de impuestos, y así el
    // recorrido se queda en el vehículo y el trámite.
    companiaPorNitMock.mockReset().mockResolvedValue({
      id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: true,
    });
    modalidadVigenteMock.mockReset().mockResolvedValue('autogestionado');
    // Alta limpia: ni el vehículo ni el trámite existen todavía.
    kdb.when
      .select('vehicles', [])
      .select('flito_tramites', [])
      .insert('vehicles', [{ id: VEHICULO_ID }])
      .insert('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
  });

  /** El INSERT que hizo el sync sobre `vehicles`, o undefined si no hubo alta. */
  const alta = (inserts: { tabla: string; values: Record<string, unknown> }[]) =>
    inserts.find((i) => i.tabla === T_VEHICLES)?.values;

  it('**ALTA (VIN nuevo): el INSERT lleva cilindraje, carrocería y tipo de servicio**', async () => {
    // Este es el hueco que dejó pasar el mutante: `setVehiculoDesdeFlit` es la rama UPDATE, y por
    // aquí —el alta— es por donde entran los vehículos nuevos de cada corrida del sync.
    const inserts = espiarInserts();

    const r = await sincronizar(RANGO, puertoConUno(tramiteFlit()));

    expect(logMock.error).not.toHaveBeenCalled(); // un fallo silencioso dejaría el test verde sin inserts
    expect(r.tramitesNuevos).toBe(1);
    expect(alta(inserts)).toMatchObject({
      vin: '9FKRG2222T2042405', plate: 'JNH38H',
      cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular',
    });
  });

  it('ALTA sin datos: los tres van como `null` explícito, no ausentes', async () => {
    // En el alta `null` es la respuesta correcta a «FLIT no lo trajo»; omitir la clave dejaría que
    // drizzle no escribiera la columna, que es lo mismo hoy pero no lo dice.
    const inserts = espiarInserts();

    await sincronizar(RANGO, puertoConUno(tramiteFlit({ cilindraje: null, carroceria: null, tipoServicio: null })));

    const values = alta(inserts)!;
    expect(values).toMatchObject({ cilindraje: null, carroceria: null, tipoServicio: null });
    for (const k of ['cilindraje', 'carroceria', 'tipoServicio']) expect(Object.keys(values)).toContain(k);
  });

  it('**ACTUALIZACIÓN (VIN ya existe): el UPDATE escribe los tres con el valor de FLIT**', async () => {
    kdb.when.select('vehicles', [{ id: VEHICULO_ID }]);
    const inserts = espiarInserts();
    const updates = espiarUpdates();

    await sincronizar(RANGO, puertoConUno(tramiteFlit()));

    expect(alta(inserts)).toBeUndefined(); // el vehículo existía: no se duplica
    const set = updates.find((u) => u.tabla === T_VEHICLES)?.set;
    expect(set).toMatchObject({
      plate: 'JNH38H', cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular',
    });
    // `updatedAt` lo pone `upsertVehiculo`, no `setVehiculoDesdeFlit`.
    expect(Object.keys(set!)).toContain('updatedAt');
  });

  it('ACTUALIZACIÓN sin datos: el SET NO lleva las tres claves (la política condicional, en su sitio)', async () => {
    // La contra-prueba del alta: sobre una fila que ya existe, un reporte incompleto no puede
    // convertirse en `SET cilindraje = NULL` y borrar lo que ya sabíamos.
    kdb.when.select('vehicles', [{ id: VEHICULO_ID }]);
    const updates = espiarUpdates();

    await sincronizar(RANGO, puertoConUno(tramiteFlit({ cilindraje: null, carroceria: null, tipoServicio: null })));

    const set = updates.find((u) => u.tabla === T_VEHICLES)!.set;
    for (const k of ['cilindraje', 'carroceria', 'tipoServicio']) {
      expect(Object.keys(set), `${k} no puede viajar en el UPDATE cuando FLIT no lo trajo`).not.toContain(k);
    }
    expect(Object.keys(set)).toContain('plate'); // el SET sigue siendo el de `setVehiculoDesdeFlit`
  });

  it('**AC3(a): el vehículo se escribe aunque el trámite no sea Asignado y no haya compañía ni organismo**', async () => {
    // `upsertVehiculo` se llama sin guarda previa: las de estado/compañía/organismo están más abajo
    // y solo cubren SOAT e impuestos. De eso depende que el histórico se complete solo en el
    // siguiente sync, sin backfill (AC3).
    organismoPorCodigoMock.mockReset().mockResolvedValue(null);
    const inserts = espiarInserts();

    const r = await sincronizar(RANGO, puertoConUno(tramiteFlit({
      estadoFlit: 'Rechazado', companiaNit: null, organismoCodigo: null, transitoNombre: null, ciudad: null,
    })));

    expect(companiaPorNitMock).not.toHaveBeenCalled(); // sin NIT no hay compañía que emparejar
    expect(alta(inserts)).toMatchObject({
      cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular',
    });
    expect(r.soatCreados).toBe(0);
    expect(r.impuestosCreados).toBe(0);
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
