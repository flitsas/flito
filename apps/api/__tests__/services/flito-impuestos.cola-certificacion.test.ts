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

/**
 * Fila del join de la cola.
 *
 * `tipoTitularFlit` es la clave `tipo` de `flit_raw` ya extraída por la expresión `->>` que la
 * HU #11947 sumó a `SELECT_COLA` (`keyed-db` no evalúa la proyección, así que aquí se escribe con el
 * nombre del CAMPO, no con el de la clave de FLIT).
 */
const filaCola = (over: Record<string, unknown> = {}) => ({
  id: ID, tramiteId: 't1', idFlit: 'FLIT-1001', tipoTramite: 'traspaso',
  fechaAprobacion: null, fechaCreacion: null, marca: 'KIA', linea: 'K3 CROSS',
  estado: 'solicitado', organismoCodigo: '05001', valorLiquidado: null, valorPagado: null,
  marcadoPorDiferencia: false, facturaVentaFlitId: null, enviadoEn: null, pagadoEn: null,
  motivoRechazo: null, createdAt: new Date('2026-08-01T12:00:00Z'),
  placa: 'QIU744', vin: '3KPFF51ABTE156687', companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', organismoSla: 24, enviadoPorNombre: null,
  tipoTitularFlit: 'cc',
  ...over,
});

/**
 * Propietario del trámite. `tipoDocumento` es la COLUMNA de `flito_compradores`, que está a 0 de
 * 7 052 para las filas del sync: se pone a un valor CONTRADICTORIO en los casos de la HU #11947 para
 * poder ver cuál de las dos fuentes manda.
 */
const filaComprador = (over: Record<string, unknown> = {}) => ({
  id: 'c1', tramiteId: 't1', soatId: null,
  nombreCompleto: 'JUANA PEREZ', numeroDocumento: '1020304050', tipoDocumento: null,
  correo: null, celular: null, direccion: null, orden: 0, porcentajeParticipacion: null,
  ...over,
});

const filaCert = () => ({
  id: 'cert-1', impuestoId: ID,
  createdAt: new Date('2026-08-01T15:00:00Z'),
  certificadoPorNombre: 'gestor@flitsas.io',
});

function escenario(certificaciones: unknown[], over: Record<string, unknown> = {}, compradores: unknown[] = []) {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso()])
    .selectOnce(T_IMPUESTOS, [filaCola(over)])
    .select(T_COMPRADORES, compradores)
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

// ── El tipo de documento del comprador (HU #11947) ───────────────────────────────────────────────
//
// Pasa por el MISMO `ensamblar` que la cola, por lo mismo que el resto de este archivo: encolar dos
// respuestas para el `Promise.all` de conteo + página es el flake que `keyed-db` existe para evitar.

describe('`compradorTipoDocumento` sale del `tipo` del payload, no de la columna', () => {
  it('**la columna dice `CC` y el payload dice `n`: gana el payload** (`NIT`)', async () => {
    // Las dos fuentes en contradicción a propósito: es la única forma de ver cuál manda.
    // `flito_compradores.tipo_documento` está a 0 de 7 052 para las filas del sync —solo lo escribe
    // el canal Cliente, que en Impuestos ni siquiera existe—, así que leerla dejaría la columna
    // vacía en el 100 % de lo que esta pantalla enseña.
    escenario([], { tipoTitularFlit: 'n' }, [filaComprador({ tipoDocumento: 'CC' })]);

    const r = await detalleImpuesto(ID, CTX);

    expect(r?.compradorTipoDocumento).toBe('NIT');
    // Y sale el código RESUELTO, no el crudo de FLIT: si `n` viajara al navegador, la página
    // necesitaría su propia copia de la tabla (AC6).
    expect(r?.compradorTipoDocumento).not.toBe('n');
    expect(JSON.stringify(r)).not.toContain('"n"');
  });

  it('`cc` → `CC`, `ps` → `PP`, `ce` → `CE`, `otro` → `null`', async () => {
    // `PP` y NUNCA `PAS`: `TIPOS_DOCUMENTO_RUNT` es el catálogo del canal Cliente y de la
    // certificación, otro vocabulario, que el AC8 deja intacto.
    for (const [tipo, esperado] of [['cc', 'CC'], ['ps', 'PP'], ['ce', 'CE'], ['otro', null]] as const) {
      kdb.reset();
      escenario([], { tipoTitularFlit: tipo }, [filaComprador()]);
      const r = await detalleImpuesto(ID, CTX);
      expect(r?.compradorTipoDocumento, `tipo=${tipo}`).toBe(esperado);
    }
  });

  it('**`c`, desconocido, vacío y ausente → `null`**, y el nombre del comprador SIGUE saliendo', async () => {
    // La rama por defecto (AC5). El mutante que esto mata: devolver `CC` en vez de `null` marcaría
    // con cédula a cada titular cuyo tipo el origen no afirma. `c` está en la lista a propósito: la
    // tabla acepta `cc` y no `c` (decisión de David, 2026-09-01; `c` no aparece en las 7 052 filas).
    for (const tipo of ['c', 'xx', '', ' ', null, undefined]) {
      kdb.reset();
      escenario([], { tipoTitularFlit: tipo }, [filaComprador({ tipoDocumento: 'CC' })]);
      const r = await detalleImpuesto(ID, CTX);
      expect(r?.compradorTipoDocumento, `tipo=${JSON.stringify(tipo)}`).toBeNull();
      // El resto de la fila no se vacía: no saber el TIPO no borra al comprador.
      expect(r?.compradorNombre).toBe('JUANA PEREZ');
      expect(r?.compradorDocumento).toBe('1020304050');
    }
  });

  it('sin comprador, el tipo va `null` aunque el payload lo afirme', async () => {
    // `compradorNombre` y `compradorDocumento` ya van vacíos ahí; un tipo de documento suelto sería
    // un dato con aspecto de cierto colgado de dos celdas vacías.
    escenario([], { tipoTitularFlit: 'n' }, []);

    const r = await detalleImpuesto(ID, CTX);

    expect(r?.compradorNombre).toBeNull();
    expect(r?.compradorTipoDocumento).toBeNull();
  });
});
