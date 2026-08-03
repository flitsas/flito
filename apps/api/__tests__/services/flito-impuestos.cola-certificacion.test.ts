// La certificación vigente viaja en el listado de impuestos (HU #11168).
//
// Por qué esto necesita prueba propia: la cola es lo que decide qué filas muestran el botón
// Certificar y cuáles el estado Certificado. Si el campo dejara de viajar, la interfaz no fallaría —
// mostraría el botón en registros ya certificados, invitando a gastar otra consulta al RUNT (que se
// cobra) sobre algo que ya estaba verificado. Un fallo silencioso y caro.
//
// Se ejercita a través de `detalleImpuesto` y no de `colaImpuestos` a propósito: las dos pasan por el
// MISMO `ensamblar`, pero la cola lanza el conteo y la página en un `Promise.all` sobre la misma
// tabla, y encolar dos respuestas para un par de consultas cuyo orden no está garantizado es
// exactamente el flake que el mock keyed existe para evitar.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { detalleImpuesto } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
const {
  flitoImpuestos, flitoImpuestoCertificaciones, flitoCompradores, flitoSoportes,
} = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_CERT = getTableName(flitoImpuestoCertificaciones);
const T_COMPRADORES = getTableName(flitoCompradores);
const T_SOPORTES = getTableName(flitoSoportes);

const CTX = { userId: 1, username: 'ops@flitsas.io', role: 'admin', transitoCodigo: null };
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';

/** Fila del impuesto tal como la devuelve `buscarConAcceso` (con la frontera ya resuelta). */
const filaAcceso = () => ({
  imp: { id: ID, tramiteId: 't1', estado: 'solicitado', extraccion: null, extraccionFacturaVenta: null, pagadoEn: null },
  dentroDeFrontera: true,
});

/** Fila del join de la cola. */
const filaCola = () => ({
  id: ID, tramiteId: 't1', idFlit: 'FLIT-1001', tipoTramite: 'traspaso',
  fechaAprobacion: null, fechaCreacion: null, marca: 'KIA', linea: 'K3 CROSS',
  estado: 'solicitado', organismoCodigo: '05001', valorLiquidado: null, valorPagado: null,
  marcadoPorDiferencia: false, facturaVentaFlitId: null, enviadoEn: null, pagadoEn: null,
  motivoRechazo: null, createdAt: new Date('2026-08-01T12:00:00Z'),
  placa: 'QIU744', vin: '3KPFF51ABTE156687', companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', organismoSla: 24, enviadoPorNombre: null,
});

const filaCert = () => ({
  id: 'cert-1', impuestoId: ID,
  createdAt: new Date('2026-08-01T15:00:00Z'),
  certificadoPorNombre: 'gestor@flitsas.io',
});

function escenario(certificaciones: unknown[]) {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso()])
    .selectOnce(T_IMPUESTOS, [filaCola()])
    .select(T_COMPRADORES, [])
    .select(T_CERT, certificaciones)
    .select(T_SOPORTES, []);
}

beforeEach(() => { kdb.reset(); });

describe('la cola expone la certificación vigente', () => {
  it('un impuesto certificado trae quién y cuándo', async () => {
    escenario([filaCert()]);

    const r = await detalleImpuesto(ID, CTX);

    expect(r?.certificacion).toEqual({
      id: 'cert-1',
      certificadoEn: '2026-08-01T15:00:00.000Z',
      certificadoPorNombre: 'gestor@flitsas.io',
    });
  });

  it('un impuesto sin certificar trae null, no el campo ausente', async () => {
    escenario([]);

    const r = await detalleImpuesto(ID, CTX);

    // `null` explícito y no `undefined`: la interfaz distingue «no certificado» de «el backend no
    // me lo mandó», y un campo que a veces falta acabaría leyéndose como lo segundo.
    expect(r).toHaveProperty('certificacion', null);
  });

  it('no expone el snapshot del RUNT ni el documento del propietario', async () => {
    escenario([{ ...filaCert(), snapshotRunt: { vehiculo: {} }, documentoConsultado: '43902633' }]);

    const r = await detalleImpuesto(ID, CTX);

    // PII (Ley 1581) y un payload que la tabla no pinta. La cola manda lo que se ve; el resto vive
    // en el certificado PDF, que sí está auditado al descargarse.
    expect(r?.certificacion).not.toHaveProperty('snapshotRunt');
    expect(r?.certificacion).not.toHaveProperty('documentoConsultado');
    expect(JSON.stringify(r)).not.toContain('43902633');
  });
});
