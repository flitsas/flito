// Certificación de impuestos — orquestación del endpoint individual (HU #11165).
//
// El motor de comparación ya está cubierto aparte y sin mocks
// (`flito-impuestos.certificacion-runt.test.ts`). Aquí se prueba lo OTRO: que cada respuesta del
// RUNT se traduzca al desenlace correcto, que un intento fallido NO deje fila, y que recertificar
// apague la anterior antes de insertar.
//
// El RUNT se mockea siempre: tiene 90 s de timeout y captcha de pago en modo directo, así que no es
// invocable desde CI. Mock keyed de drizzle (OPS-02b) para que el orden de los SELECT no importe.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { MotivoNoElegible, ResultadoCertificacion } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// `buscarConAcceso` aplica la frontera del gestor y ya tiene sus propias pruebas; aquí solo interesa
// QUÉ hace la certificación con el impuesto que le entregue.
const buscarConAccesoMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({
  buscarConAcceso: (...a: unknown[]) => buscarConAccesoMock(...a),
}));

const consultarVehiculoRuntMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: (...a: unknown[]) => consultarVehiculoRuntMock(...a),
}));

const { certificarImpuesto, ESTADOS_IMPUESTO_CERTIFICABLES } =
  await import('../../src/modules/flito-impuestos/certificacion.service.js');
const { flitoImpuestos, flitoImpuestoCertificaciones, vehicles, auditLogs } =
  await import('../../src/db/schema.js');
const { ImpuestoError } = await import('../../src/modules/flito-impuestos/flito-factura-venta.service.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_CERT = getTableName(flitoImpuestoCertificaciones);
const T_VEHICLES = getTableName(vehicles);
const T_AUDIT = getTableName(auditLogs);

const CTX = { userId: 7, username: 'gestor@flitsas.io', role: 'admin', organismos: [] };
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';

/** Fila de vehículo que devuelve `datosDelVehiculo` (join impuesto→trámite→vehículo). */
const vehiculoOk = (over: Record<string, unknown> = {}) => ({
  placa: 'QIU744', vin: '9BWZZZ377VT004251',
  marca: 'CHEVROLET', linea: 'SPARK GT', modelo: 2018, clase: 'AUTOMOVIL',
  ownerName: 'JOSÉ PÉREZ', ownerDocument: '43902633',
  ...over,
});

const runtOk = () => ({
  ok: true,
  data: {
    vehiculo: {
      placa: 'QIU744', vin: '9BWZZZ377VT004251',
      marca: 'CHEVROLET', linea: 'SPARK GT', modelo: '2018', claseVehiculo: 'AUTOMOVIL',
    },
    tipoDocPropietario: 'C',
  },
});

/** Fila que devuelve el INSERT ... RETURNING de la certificación. */
const filaCert = () => ({
  id: 'cert-1', impuestoId: ID, placaConsultada: 'QIU744', documentoConsultado: '43902633',
  tipoDocPropietario: 'C', propietarioNombre: 'JOSÉ PÉREZ', campos: [],
  certificadoPorNombre: CTX.username, createdAt: new Date(),
});

/**
 * Captura los `.values(...)` que se insertan en una tabla, envolviendo la cadena por defecto.
 *
 * El mock keyed enruta por tabla pero no guarda lo escrito, y aquí hace falta afirmar sobre el
 * CONTENIDO del INSERT: que el nombre del propietario quede congelado en la certificación no se
 * puede ver en el valor de retorno, porque ese valor lo fabrica el propio mock.
 */
function capturarInserts(tabla: string): Record<string, unknown>[] {
  const capturado: Record<string, unknown>[] = [];
  const porDefecto = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tbl: unknown) => {
    const cadena = porDefecto(tbl) as Record<string, unknown>;
    if (getTableName(tbl as never) === tabla) {
      const values = cadena.values as (v: unknown) => unknown;
      cadena.values = (v: unknown) => { capturado.push(v as Record<string, unknown>); return values(v); };
    }
    return cadena;
  });
  return capturado;
}

/** Prepara el camino feliz: impuesto solicitado + vehículo completo. */
function escenarioBase(over: { estado?: string; vehiculo?: Record<string, unknown> } = {}) {
  buscarConAccesoMock.mockResolvedValue({ id: ID, estado: over.estado ?? 'solicitado' });
  // El SELECT del join impuesto→trámite→vehículo arranca en flito_impuestos: es esa tabla la que
  // enruta el mock keyed, no `vehicles`.
  kdb.when.scenario({
    [T_IMPUESTOS]: [over.vehiculo ?? vehiculoOk()],
    [T_VEHICLES]: [over.vehiculo ?? vehiculoOk()],
  });
  kdb.when.insert(T_CERT, [filaCert()]);
  kdb.when.insert(T_AUDIT, []);
  kdb.when.update(T_CERT, []);
}

beforeEach(() => {
  kdb.reset();
  buscarConAccesoMock.mockReset();
  consultarVehiculoRuntMock.mockReset();
});

describe('elegibilidad', () => {
  it('solo `solicitado` es certificable (decisión del PO)', () => {
    expect([...ESTADOS_IMPUESTO_CERTIFICABLES]).toEqual(['solicitado']);
  });

  it('AC4 — un estado distinto de solicitado no es elegible y NO consulta el RUNT', async () => {
    for (const estado of ['pendiente', 'con_novedad', 'pagado']) {
      escenarioBase({ estado });
      const r = await certificarImpuesto(ID, CTX);

      expect(r.resultado).toBe(ResultadoCertificacion.NO_ELEGIBLE);
      if (r.resultado === ResultadoCertificacion.NO_ELEGIBLE) {
        expect(r.motivo).toBe(MotivoNoElegible.ESTADO_NO_ELEGIBLE);
      }
    }
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('AC6 — sin documento pero con VIN, consulta el RUNT por VIN', async () => {
    escenarioBase({ vehiculo: vehiculoOk({ ownerDocument: null }) });
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    const r = await certificarImpuesto(ID, CTX);

    // El RUNT identifica el vehículo por placa+documento o por VIN. Faltando el documento queda el
    // VIN, que es identidad de vehículo igual (RN-01): bloquear aquí dejaría sin certificar a toda
    // la flota cuyo titular FLITO no conoce.
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith('QIU744', '9BWZZZ377VT004251', undefined);
    expect(r.resultado).toBe(ResultadoCertificacion.CERTIFICADO);
  });

  it('AC6 — sin documento Y sin VIN no es elegible, y NO consulta el RUNT', async () => {
    escenarioBase({ vehiculo: vehiculoOk({ ownerDocument: null, vin: null }) });

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.NO_ELEGIBLE);
    if (r.resultado === ResultadoCertificacion.NO_ELEGIBLE) {
      expect(r.motivo).toBe(MotivoNoElegible.SIN_DOCUMENTO_PROPIETARIO);
    }
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('el documento del comprador suple al del vehículo cuando este no lo tiene', async () => {
    // El titular llega de FLIT en cada trámite y vive en `flito_compradores`; el vehículo solo lo
    // tiene desde que la sincronización empezó a copiarlo. Leer los dos hace que la certificación
    // funcione sobre lo sincronizado antes, sin esperar al backfill.
    escenarioBase({
      vehiculo: vehiculoOk({ ownerDocument: null, compradorDocumento: '43902633', compradorNombre: 'JOSÉ PÉREZ' }),
    });
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    const r = await certificarImpuesto(ID, CTX);

    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith('QIU744', undefined, '43902633');
    expect(r.resultado).toBe(ResultadoCertificacion.CERTIFICADO);
  });

  it('sin placa tampoco es elegible', async () => {
    escenarioBase({ vehiculo: vehiculoOk({ placa: '  ' }) });

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.NO_ELEGIBLE);
    if (r.resultado === ResultadoCertificacion.NO_ELEGIBLE) {
      expect(r.motivo).toBe(MotivoNoElegible.SIN_PLACA);
    }
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('un impuesto inaccesible da 404, no 403 — la frontera no revela que existe', async () => {
    buscarConAccesoMock.mockResolvedValue(null);

    await expect(certificarImpuesto(ID, CTX)).rejects.toBeInstanceOf(ImpuestoError);
    await expect(certificarImpuesto(ID, CTX)).rejects.toMatchObject({ status: 404 });
  });
});

describe('AC1 — certificación exitosa', () => {
  it('consulta el RUNT con placa y documento del propietario, y persiste', async () => {
    escenarioBase();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.CERTIFICADO);
    // RN-01: por placa + documento del propietario; el VIN NO se envía (saltaría la validación de
    // propiedad, que es justo la prueba en la que se apoya la certificación).
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith('QIU744', undefined, '43902633');
    expect(kdb.insert).toHaveBeenCalled();
  });

  it('deja constancia del documento con el que se autenticó la consulta (RN-02)', async () => {
    escenarioBase();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.CERTIFICADO);
    if (r.resultado === ResultadoCertificacion.CERTIFICADO) {
      expect(r.certificacion.documentoConsultado).toBe('43902633');
      expect(r.certificacion.placaConsultada).toBe('QIU744');
    }
  });

  it('congela el nombre del propietario que tenía FLITO al certificar (HU #11167)', async () => {
    escenarioBase();
    const insertado = capturarInserts(T_CERT);
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    await certificarImpuesto(ID, CTX);

    // No se compara con nada —el RUNT no devuelve al propietario— pero el certificado lo IMPRIME, y
    // leerlo en vivo al descargar haría que un certificado emitido hoy cambiara mañana.
    expect(insertado[0]).toMatchObject({ propietarioNombre: 'JOSÉ PÉREZ' });
  });

  it('sin nombre de propietario en FLITO guarda null, no una cadena vacía', async () => {
    escenarioBase({ vehiculo: vehiculoOk({ ownerName: '   ' }) });
    const insertado = capturarInserts(T_CERT);
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    await certificarImpuesto(ID, CTX);

    // El PDF distingue «no registrado» de un hueco en blanco; una cadena de espacios se imprimiría
    // como el hueco y el lector no sabría si el dato falta o si nadie lo miró.
    expect(insertado[0].propietarioNombre).toBeNull();
  });
});

describe('AC2 — discrepancia de datos', () => {
  it('no certifica y devuelve el detalle campo a campo', async () => {
    escenarioBase();
    const runt = runtOk();
    runt.data.vehiculo.placa = 'XYZ999';
    consultarVehiculoRuntMock.mockResolvedValue(runt);

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.CON_DIFERENCIAS);
    if (r.resultado === ResultadoCertificacion.CON_DIFERENCIAS) {
      expect(r.diferenciasBloqueantes).toHaveLength(1);
      expect(r.diferenciasBloqueantes[0].campo).toBe('placa');
      expect(r.diferenciasBloqueantes[0].valorFlito).toBe('QIU744');
      expect(r.diferenciasBloqueantes[0].valorRunt).toBe('XYZ999');
    }
  });

  it('un intento con diferencias NO deja fila de certificación', async () => {
    escenarioBase();
    const runt = runtOk();
    runt.data.vehiculo.placa = 'XYZ999';
    consultarVehiculoRuntMock.mockResolvedValue(runt);

    await certificarImpuesto(ID, CTX);

    // El registro conserva su certificación anterior si la tenía, y las métricas no se llenan de
    // intentos fallidos.
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });
});

describe('AC3 — RUNT no disponible', () => {
  it('devuelve error de servicio y no persiste', async () => {
    escenarioBase();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'Error comunicando con servicio RUNT' });

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.ERROR_SERVICIO);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('el RUNT responde OK pero sin vehículo detrás → no certifica', async () => {
    escenarioBase();
    // Lo que devuelve de verdad la pasarela ante una placa que el RUNT no conoce: ok:true, la placa
    // consultada de vuelta y el resto en null. Sin la guarda esto CERTIFICA —la placa "coincide"
    // consigo misma y ningún bloqueante difiere—, que es el peor desenlace: un certificado con
    // sello de válido sobre un vehículo del que el RUNT no dice nada.
    consultarVehiculoRuntMock.mockResolvedValue({
      ok: true,
      data: { vehiculo: { placa: 'QIU744', vin: null, marca: null, linea: null, modelo: null, clase: null, idAutomotor: null } },
    });

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.ERROR_SERVICIO);
    if (r.resultado === ResultadoCertificacion.ERROR_SERVICIO) {
      expect(r.mensaje).toContain('no tiene información registrada');
    }
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('un circuito abierto que LANZA tampoco tumba la certificación', async () => {
    escenarioBase();
    consultarVehiculoRuntMock.mockRejectedValue(new Error('Servicio runt-vehicle temporalmente no disponible'));

    const r = await certificarImpuesto(ID, CTX);

    // Debe devolver, no propagar: el masivo (HU #11166) procesa registro a registro y una excepción
    // aquí abortaría el lote entero.
    expect(r.resultado).toBe(ResultadoCertificacion.ERROR_SERVICIO);
    if (r.resultado === ResultadoCertificacion.ERROR_SERVICIO) {
      expect(r.mensaje).toContain('temporalmente no disponible');
    }
  });
});

describe('AC5 — traspaso reciente en sincronización (RN-08)', () => {
  it('se distingue del error de servicio', async () => {
    escenarioBase();
    consultarVehiculoRuntMock.mockResolvedValue({
      ok: false, message: 'El documento no corresponde al propietario del vehículo',
    });

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION);
    expect(r.resultado).not.toBe(ResultadoCertificacion.ERROR_SERVICIO);
    if (r.resultado === ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION) {
      expect(r.mensaje).toMatch(/24-72/);
    }
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('se comprueba ANTES de dar por caído el servicio', async () => {
    escenarioBase();
    // Mensaje que menciona al propietario y además suena a fallo: gana el traspaso.
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'Error: propietario no coincide' });

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION);
  });
});

describe('AC8 — recertificación', () => {
  it('apaga la certificación anterior antes de insertar la nueva', async () => {
    escenarioBase();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk());

    const r = await certificarImpuesto(ID, CTX);

    expect(r.resultado).toBe(ResultadoCertificacion.CERTIFICADO);
    // El UPDATE que apaga la vigente debe ocurrir; el índice único parcial de la migración 0121
    // rechazaría el INSERT si no.
    expect(kdb.update).toHaveBeenCalled();
    expect(kdb.insert).toHaveBeenCalled();
  });
});
