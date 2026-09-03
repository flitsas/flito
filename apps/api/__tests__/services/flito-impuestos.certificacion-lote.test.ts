// Certificación masiva de impuestos (HU #11166).
//
// Lo que importa aquí no es volver a probar la certificación —eso ya está cubierto en
// flito-impuestos.certificacion.service.test.ts— sino las tres propiedades del LOTE: que un registro
// que falla no tumbe a los demás, que nunca haya más de dos consultas al RUNT en vuelo, y que el
// tope se rechace antes de gastar una sola llamada.
//
// El lote NO se prueba mockeando `certificarImpuesto`: `certificarLote` lo invoca por referencia
// léxica dentro del mismo módulo, así que mockear el export no intercepta nada y el test pasaría en
// verde sin ejercitar el código real. Se mockea la frontera de verdad —el RUNT y la BD— y el lote
// atraviesa el servicio completo.
//
// La concurrencia se mide sobre el mock del RUNT, que es literalmente lo que dice el AC3: «nunca
// hay más de 2 consultas al RUNT en vuelo». Una prueba que solo contara llamadas pasaría igual con
// un Promise.all que abriera el circuit breaker.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  CONCURRENCIA_CERTIFICACION,
  MotivoNoElegible,
  ResultadoCertificacion,
  TOPE_LOTE_CERTIFICACION,
} from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const buscarConAccesoMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({
  buscarConAcceso: (...a: unknown[]) => buscarConAccesoMock(...a),
}));

const consultarVehiculoRuntMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: (...a: unknown[]) => consultarVehiculoRuntMock(...a),
}));

const { certificarLote } = await import('../../src/modules/flito-impuestos/certificacion.service.js');
const { ImpuestoError } = await import('../../src/modules/flito-impuestos/flito-factura-venta.service.js');
const { flitoImpuestos, flitoImpuestoCertificaciones, vehicles, auditLogs } =
  await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_CERT = getTableName(flitoImpuestoCertificaciones);
const T_VEHICLES = getTableName(vehicles);
const T_AUDIT = getTableName(auditLogs);

const CTX = { userId: 7, username: 'gestor@flitsas.io', role: 'admin', organismos: [] };

/** Ids válidos y distinguibles: el último bloque cambia por registro. */
const id = (n: number) => `71030cce-1a4c-4fb6-855d-fcc80aadc4e${n}`;

const VEHICULO = {
  placa: 'QIU744', vin: '9BWZZZ377VT004251',
  marca: 'CHEVROLET', linea: 'SPARK GT', modelo: 2018, clase: 'AUTOMOVIL',
  ownerName: 'JOSÉ PÉREZ', ownerDocument: '43902633',
};

const runtOk = (placa = 'QIU744') => ({
  ok: true,
  data: {
    vehiculo: { placa, vin: '9BWZZZ377VT004251', marca: 'CHEVROLET', linea: 'SPARK GT', modelo: '2018', claseVehiculo: 'AUTOMOVIL' },
    tipoDocPropietario: 'C',
  },
});

beforeEach(() => {
  kdb.reset();
  buscarConAccesoMock.mockReset();
  consultarVehiculoRuntMock.mockReset();

  // Por defecto: todo impuesto existe, está solicitado y su vehículo está completo.
  buscarConAccesoMock.mockImplementation(async (impId: string) => ({ id: impId, estado: 'solicitado' }));
  kdb.when.scenario({ [T_IMPUESTOS]: [VEHICULO], [T_VEHICLES]: [VEHICULO] });
  kdb.when.insert(T_CERT, () => [{
    id: 'cert-x', impuestoId: id(1), placaConsultada: 'QIU744', documentoConsultado: '43902633',
    tipoDocPropietario: 'C', campos: [], certificadoPorNombre: CTX.username, createdAt: new Date(),
  }]);
  kdb.when.insert(T_AUDIT, []);
  kdb.when.update(T_CERT, []);
  consultarVehiculoRuntMock.mockResolvedValue(runtOk());
});

describe('AC5/AC2 — validación del lote antes de tocar el RUNT', () => {
  it('un lote vacío se rechaza', async () => {
    await expect(certificarLote([], CTX)).rejects.toMatchObject({ status: 400 });
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('AC2 — pasarse del tope se rechaza sin gastar una sola consulta', async () => {
    const ids = Array.from({ length: TOPE_LOTE_CERTIFICACION + 1 }, (_, i) => id(i));

    await expect(certificarLote(ids, CTX)).rejects.toBeInstanceOf(ImpuestoError);
    await expect(certificarLote(ids, CTX)).rejects.toMatchObject({ status: 400 });
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('el mensaje del tope dice el máximo y cuántos se pidieron', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => id(i));

    await expect(certificarLote(ids, CTX)).rejects.toMatchObject({
      message: expect.stringContaining(String(TOPE_LOTE_CERTIFICACION)),
    });
    await expect(certificarLote(ids, CTX)).rejects.toMatchObject({
      message: expect.stringContaining('12'),
    });
  });

  it('un lote exactamente en el tope sí se procesa', async () => {
    const ids = Array.from({ length: TOPE_LOTE_CERTIFICACION }, (_, i) => id(i));

    const r = await certificarLote(ids, CTX);

    expect(r).toHaveLength(TOPE_LOTE_CERTIFICACION);
    expect(r.every((x) => x.resultado === ResultadoCertificacion.CERTIFICADO)).toBe(true);
  });

  it('los ids repetidos se colapsan — cada consulta al RUNT se cobra', async () => {
    const r = await certificarLote([id(1), id(1), id(2), id(1)], CTX);

    expect(r).toHaveLength(2);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(2);
  });
});

describe('AC3 — concurrencia acotada', () => {
  /** Instrumenta el RUNT para medir cuántas consultas coexisten. */
  function medirConcurrencia() {
    let enVuelo = 0;
    const medida = { maximo: 0 };
    consultarVehiculoRuntMock.mockImplementation(async () => {
      enVuelo++;
      medida.maximo = Math.max(medida.maximo, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo--;
      return runtOk();
    });
    return medida;
  }

  it('nunca hay más de 2 consultas al RUNT simultáneas', async () => {
    const medida = medirConcurrencia();
    const ids = Array.from({ length: TOPE_LOTE_CERTIFICACION }, (_, i) => id(i));

    await certificarLote(ids, CTX);

    expect(medida.maximo).toBeLessThanOrEqual(CONCURRENCIA_CERTIFICACION);
    expect(medida.maximo).toBe(2);
  });

  it('aun así procesa el lote entero', async () => {
    medirConcurrencia();
    const ids = Array.from({ length: TOPE_LOTE_CERTIFICACION }, (_, i) => id(i));

    const r = await certificarLote(ids, CTX);

    expect(r).toHaveLength(TOPE_LOTE_CERTIFICACION);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(TOPE_LOTE_CERTIFICACION);
  });

  it('un lote de uno no abre dos obreros', async () => {
    const medida = medirConcurrencia();

    await certificarLote([id(1)], CTX);

    expect(medida.maximo).toBe(1);
  });
});

describe('AC1 — lote con resultados mixtos', () => {
  it('devuelve un desenlace por id, con su detalle', async () => {
    consultarVehiculoRuntMock.mockImplementation(async (placa: string, _vin: unknown, _doc: string) => {
      void placa;
      const n = consultarVehiculoRuntMock.mock.calls.length;
      if (n === 2) return runtOk('XYZ999');                                    // discrepancia
      if (n === 3) return { ok: false, message: 'Error comunicando con servicio RUNT' };
      return runtOk();
    });

    const r = await certificarLote([id(1), id(2), id(3)], CTX);

    // El orden de terminación puede variar con la concurrencia; lo que se comprueba es que cada
    // desenlace aparezca exactamente una vez.
    const resultados = r.map((x) => x.resultado).sort();
    expect(resultados).toEqual([
      ResultadoCertificacion.CERTIFICADO,
      ResultadoCertificacion.CON_DIFERENCIAS,
      ResultadoCertificacion.ERROR_SERVICIO,
    ].sort());

    const conDif = r.find((x) => x.resultado === ResultadoCertificacion.CON_DIFERENCIAS);
    expect(conDif?.diferenciasBloqueantes?.[0].valorRunt).toBe('XYZ999');
  });

  it('los resultados vuelven en el orden de entrada, no en el de terminación', async () => {
    // El primero tarda más que el segundo: si el orden dependiera de quién acaba antes se
    // invertirían, y la tabla del gestor bailaría respecto a lo que seleccionó.
    consultarVehiculoRuntMock.mockImplementation(async (placa: string) => {
      void placa;
      const primero = consultarVehiculoRuntMock.mock.calls.length === 1;
      await new Promise((r) => setTimeout(r, primero ? 20 : 1));
      return runtOk();
    });

    const r = await certificarLote([id(1), id(2)], CTX);

    expect(r.map((x) => x.id)).toEqual([id(1), id(2)]);
  });
});

describe('AC6 / robustez — un registro malo no tumba el lote', () => {
  it('un id inaccesible se reporta como no elegible y el resto sigue', async () => {
    buscarConAccesoMock.mockImplementation(async (impId: string) =>
      impId === id(1) ? null : { id: impId, estado: 'solicitado' });

    const r = await certificarLote([id(1), id(2)], CTX);

    expect(r[0].resultado).toBe(ResultadoCertificacion.NO_ELEGIBLE);
    expect(r[0].motivo).toBe(MotivoNoElegible.NO_ACCESIBLE);
    expect(r[1].resultado).toBe(ResultadoCertificacion.CERTIFICADO);
  });

  it('un fallo inesperado (p. ej. de BD) tampoco aborta el lote', async () => {
    buscarConAccesoMock.mockImplementation(async (impId: string) => {
      if (impId === id(1)) throw new Error('connection terminated');
      return { id: impId, estado: 'solicitado' };
    });

    const r = await certificarLote([id(1), id(2)], CTX);

    expect(r[0].resultado).toBe(ResultadoCertificacion.ERROR_SERVICIO);
    expect(r[0].mensaje).toContain('connection terminated');
    expect(r[1].resultado).toBe(ResultadoCertificacion.CERTIFICADO);
  });

  it('AC4 — el circuito abierto sale como error de servicio, no como discrepancia', async () => {
    consultarVehiculoRuntMock.mockRejectedValue(new Error('Servicio runt-vehicle temporalmente no disponible'));

    const r = await certificarLote([id(1), id(2), id(3)], CTX);

    for (const item of r) {
      expect(item.resultado).toBe(ResultadoCertificacion.ERROR_SERVICIO);
      expect(item.resultado).not.toBe(ResultadoCertificacion.CON_DIFERENCIAS);
    }
  });

  it('AC6 — un estado no elegible conserva su motivo y el resto se procesa', async () => {
    buscarConAccesoMock.mockImplementation(async (impId: string) =>
      ({ id: impId, estado: impId === id(1) ? 'pagado' : 'solicitado' }));

    const r = await certificarLote([id(1), id(2)], CTX);

    expect(r[0].resultado).toBe(ResultadoCertificacion.NO_ELEGIBLE);
    expect(r[0].motivo).toBe(MotivoNoElegible.ESTADO_NO_ELEGIBLE);
    expect(r[1].resultado).toBe(ResultadoCertificacion.CERTIFICADO);
    // El no elegible no gasta consulta: solo el otro llegó al RUNT.
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(1);
  });

  it('un traspaso en sincronización se reporta aparte del error de servicio', async () => {
    consultarVehiculoRuntMock.mockImplementation(async () => {
      const primero = consultarVehiculoRuntMock.mock.calls.length === 1;
      return primero
        ? { ok: false, message: 'El documento no corresponde al propietario del vehículo' }
        : runtOk();
    });

    const r = await certificarLote([id(1), id(2)], CTX);

    const traspaso = r.find((x) => x.resultado === ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION);
    expect(traspaso).toBeDefined();
    expect(r.some((x) => x.resultado === ResultadoCertificacion.CERTIFICADO)).toBe(true);
  });
});
