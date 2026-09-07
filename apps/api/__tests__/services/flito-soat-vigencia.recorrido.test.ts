// FLITO SOAT — el RECORRIDO de la verificación diaria de vigencia (Feature #12075, HU #12096).
//
// Lo que este archivo mide, y por qué está escrito como está:
//
//   · **El censo (AC2) se afirma sobre el SQL RENDERIZADO, nunca sobre las filas devueltas.** El mock
//     de drizzle de esta suite es passthrough en `where` y su `chain` devuelve la fila entera aunque
//     el `select` pida menos: `expect(vehiculos).toEqual([...])` es una tautología —el test recibe lo
//     que el test registró— y pasaría con el `where` borrado. Por eso `condicionCenso` se exporta y
//     se renderiza con `PgDialect` (`helpers/sql-ligado.ts`), que es donde SÍ se ve qué valor quedó
//     ligado a qué comparación.
//   · **El orden del clasificador (AC5) se ejerce sobre la función pura**, con las cuatro respuestas
//     posibles, incluida la que sale con el circuito abierto sin haber consultado.
//   · **Lo que se escribe se mira en el `set()` real** (`espia-drizzle`), no en la fila que el mock
//     devuelve. Y se mira sobre todo lo que NO está en el payload, que es la mitad del contrato.
//
// `TZ = 'UTC'` para todo el archivo, como en `flito-soat-vigencia.cron.test.ts`: el corte del censo
// es medianoche de Bogotá y en una máquina en `-05` un corte calculado con el reloj del proceso daría
// el mismo instante. El mutante del reloj sobreviviría sin esta línea.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, renderizar, vecesLigado } from '../helpers/sql-ligado.js';
import type { SQL } from 'drizzle-orm';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** Consultas al RUNT, en orden, con el VIN por el que se preguntó. */
const consultas: Array<string | undefined> = [];
let respuestasPorVin: Record<string, unknown[]> = {};
let respuestaPorDefecto: unknown = null;

/**
 * `consultarVehiculoRunt` se mockea aquí y no `consultarRuntCrudo`, y no es un detalle: lo que se
 * quiere ejercer es la CADENA REAL —`consultarRuntCrudo` → `clasificarVigencia` con
 * `runtSinRegistro`, `soatVigenteSegunRunt` y `fechaVencimientoSoatRunt` de verdad—. Mockear un
 * escalón más arriba dejaría sin probar justamente la asimetría de firmas que el diseño señala como
 * trampa (una recibe la respuesta entera y la otra `data`).
 *
 * Las respuestas se registran POR VIN, no en una cola posicional: el recorrido usa un pool de
 * promesas y el orden de terminación no está garantizado.
 */
const runtMock = vi.fn(async (_placa?: string, vin?: string) => {
  consultas.push(vin);
  const cola = respuestasPorVin[vin ?? ''];
  if (cola && cola.length > 0) return cola.length === 1 ? cola[0] : cola.shift();
  return respuestaPorDefecto;
});
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: (placa?: string, vin?: string) => runtMock(placa, vin),
}));

/** El breaker, controlado desde el test: es de proceso y no hay forma de sembrarlo desde fuera. */
let circuitoAbiertoAhora = false;
/** Se abre justo cuando esta consulta número N haya salido. `null` = nunca. */
let abrirCircuitoTras: number | null = null;
vi.mock('../../src/services/circuitBreaker.js', () => ({
  circuitoAbierto: (nombre: string) => {
    if (nombre !== 'runt-vehicle') throw new Error(`circuito inesperado: ${nombre}`);
    if (abrirCircuitoTras !== null && consultas.length >= abrirCircuitoTras) return true;
    return circuitoAbiertoAhora;
  },
  withCircuitBreaker: <T>(_n: string, fn: () => Promise<T>) => fn(),
  CircuitoAbiertoError: class extends Error {},
}));

const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const {
  MAX_REINTENTOS_VEHICULO,
  PRESUPUESTO_CORRIDA_MS,
  clasificarVigencia,
  condicionCenso,
  corteDelDia,
  payloadDeDesenlace,
  recorrerVigenciaSoat,
} = await import('../../src/modules/flito-soat/flito-soat-vigencia.service.js');

const espia = crearEspia(kdb);

// ── Respuestas del RUNT, con la forma REAL que los extractores esperan ──────────────────────────
//
// `runtSinRegistro` mira las diez señales de `data.vehiculo` y NO la placa/VIN, que son el eco de la
// consulta; `derivePreflightChecks` mira `data.soat`. Una respuesta de mentirijillas que no respete
// esas dos formas haría verdes los cuatro desenlaces por el camino equivocado.

const respVigente = (poliza?: string) => ({
  ok: true,
  data: {
    vehiculo: { marca: 'MAZDA', linea: 'CX-30', numChasis: '9BW' },
    soat: [{ estadoSoat: 'VIGENTE', fechaVencimSoat: '2027-03-12', ...(poliza ? { numeroPoliza: poliza } : {}) }],
  },
});

/** El RUNT respondió y dice que la póliza NO está viva. Es un «no» legítimo: vehículo VERIFICADO. */
const respVencido = {
  ok: true,
  data: {
    vehiculo: { marca: 'MAZDA', linea: 'CX-30', numChasis: '9BW' },
    soat: [{ estadoSoat: 'NO VIGENTE', fechaVencimSoat: '2026-03-12' }],
  },
};

/** `ok:true` con el vehículo vacío salvo el eco de la consulta: el registro no lo conoce. */
const respSinRegistro = { ok: true, data: { vehiculo: { numChasis: null, placa: 'ABC123' } } };

/** Transporte caído. `causaDeCaida` lo clasifica por el MENSAJE, sin echarlo al log. */
const respTimeout = { ok: false, message: 'ETIMEDOUT: socket hang up al consultar' };

const VIN_A = '9BWZZZ377VT004251';
const VIN_B = 'JN1TANT31Z0123456';
const SOAT_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const SOAT_B = 'bbbbbbbb-2222-2222-2222-222222222222';

/** El censo que `vehiculosAVerificar` devolverá en esta prueba. */
function censo(filas: Array<{ soatId: string; vin: string; estadoVigencia: string }>): void {
  kdb.when.select('flito_soat', filas);
}

const updatesDeSoat = () => espia.updatesEn('flito_soat').map((m) => m.datos);
const auditorias = () => espia.insertsEn('audit_logs').map((m) => m.datos as Record<string, string>);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultas.length = 0;
  registros.length = 0;
  respuestasPorVin = {};
  respuestaPorDefecto = respVigente();
  circuitoAbiertoAhora = false;
  abrirCircuitoTras = null;
  runtMock.mockClear();
});

// ─────────────────────────────── AC2 — el censo, sobre el SQL real ──────────────────────────────

describe('AC2 — qué vehículos entran, medido sobre el SQL que Postgres recibiría', () => {
  const corte = corteDelDia('2026-09-04');

  it('exige comprobante de tipo `factura_soat` **y `descartado = false`**', () => {
    const q = renderizar(condicionCenso(corte));

    // MUTANTE — quitar `descartado = false` del EXISTS: `ligadosA` LANZA cuando la columna no
    // aparece comparada (es su doctrina, para que un `not.toContain` no pase por ausencia), así que
    // esta línea se pone roja. Sin ella, un SOAT cuyo único comprobante fue RECHAZADO en la revisión
    // OCR se consultaría al RUNT cada noche para siempre.
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('factura_soat');
    // La correlación con el SOAT de fuera: sin ella el EXISTS sería «hay ALGUNA factura de SOAT en
    // la tabla», es decir, verdadero para toda la tabla.
    expect(q.sql).toContain('"flito_soportes"."soat_id" = "flito_soat"."id"');
  });

  it('**es un EXISTS y no un JOIN**: `factura_soat` puede repetirse por SOAT', () => {
    const q = renderizar(condicionCenso(corte));
    expect(q.sql).toMatch(/^\(exists \(select/);
    // MUTANTE — cambiarlo por un `innerJoin` a `flito_soportes`: duplicaría la fila del SOAT una vez
    // por comprobante, inflaría `considerados` y consultaría el RUNT dos veces por el mismo VIN. El
    // único índice único parcial por `soat_id` acota `factura_venta`, no este tipo.
    expect(q.sql).not.toMatch(/\bjoin\b/i);
  });

  it('la exclusión del AC6 es **una sola cláusula** y liga el corte UNA vez', () => {
    const q = renderizar(condicionCenso(corte));

    // `verificada_en IS NULL OR verificada_en < corte`. Se puede escribir así de simple porque la
    // rama `no_verificado` NO toca la columna: el que falló hoy conserva la fecha vieja y vuelve a
    // caer del lado de «por verificar».
    expect(q.sql).toContain('"flito_soat"."verificada_en" is null');
    expect(q.sql).toMatch(/"flito_soat"\."verificada_en" < \$\d+/);
    // El corte, en JS y no con `AT TIME ZONE`: un solo parámetro. Drizzle no deduplica literales, así
    // que un corte interpolado dos veces serían DOS parámetros (la clase de error del Bug #12058).
    expect(vecesLigado(q, '2026-09-04T05:00:00.000Z')).toBe(1);
  });

  it('el corte es medianoche de **Bogotá**, no del proceso (que aquí corre en UTC)', () => {
    // Control del control: si alguien quita el `TZ='UTC'` de la cabecera, en una máquina en -05 este
    // aserto pasaría con un corte calculado con `new Date(dia)` y el mutante del reloj sobreviviría.
    expect(process.env.TZ).toBe('UTC');
    expect(corteDelDia('2026-09-04').toISOString()).toBe('2026-09-04T05:00:00.000Z');
    // Y NO las 00:00 UTC, que en Bogotá son las 19:00 del día anterior.
    expect(corteDelDia('2026-09-04').toISOString()).not.toBe('2026-09-04T00:00:00.000Z');
  });

  it('**la consulta REAL lleva el predicado entero** — no basta con que la función lo construya', async () => {
    // ── El hueco que este test cierra (gate B, M2) ───────────────────────────────────────────────
    //
    // Los asertos de arriba renderizan `condicionCenso(corte)`, la función exportada, y muerden bien
    // SOBRE ELLA. Lo que nadie comprobaba es que `vehiculosAVerificar` la USE. Este mutante
    // sobrevivía a los 126 tests de este WI y a los 752 de los 33 specs `flito-soat*`:
    //
    //     - .where(condicionCenso(corteDelDia(dia)))
    //     + .where(EXISTS_COMPROBANTE_SOAT)
    //
    // En producción hace que cada reintento horario cense el universo ENTERO en vez de solo lo no
    // verificado: hasta 4× el tráfico contra el breaker `runt-vehicle` —que es COMPARTIDO con el
    // camino de usuario— y `considerados` deja de significar «lo que falta».
    //
    // **Repetir aquí `renderizar(condicionCenso(...))` NO lo mataría**: sería el mismo verde vacío un
    // renglón más abajo. El aserto tiene que caer sobre lo que la consulta REALMENTE llevó, y eso es
    // lo que `espia.condicionesLeidas()` captura: el `where` tal como lo recibió drizzle.
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' }]);

    await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    const [wherePasado] = espia.condicionesLeidas();
    expect(wherePasado, 'el censo no emitió ninguna consulta').toBeDefined();
    const q = renderizar(wherePasado as SQL);

    // La exclusión del AC6, en la consulta que salió de verdad.
    expect(q.sql).toContain('"flito_soat"."verificada_en" is null');
    expect(q.sql).toMatch(/"flito_soat"\."verificada_en" < \$\d+/);
    expect(vecesLigado(q, '2026-09-04T05:00:00.000Z')).toBe(1);
    // Y el EXISTS del comprobante con sus tres ligaduras: las dos mitades viajan juntas o el censo
    // deja de ser el censo.
    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('factura_soat');
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
    expect(q.sql).toContain('"flito_soportes"."soat_id" = "flito_soat"."id"');
  });

  it('el `dia` de la firma es el que acota la consulta, no uno fijo ni el reloj del proceso', async () => {
    // La otra mitad de la misma costura: `dia` viaja hacia adentro para que el reintento excluya lo
    // ya verificado HOY (AC6). Un corte incrustado, o leído de `new Date()` en vez del parámetro,
    // haría que el reintento de las 01:10 volviera a tomar lo que el de las 00:10 ya verificó — y
    // ningún aserto sobre `condicionCenso(corte)` lo vería, porque a esa función el test le pasa el
    // corte que quiere.
    censo([]);
    await recorrerVigenciaSoat({ dia: '2026-12-25', intento: 3 });

    const q = renderizar(espia.condicionesLeidas()[0] as SQL);
    expect(vecesLigado(q, '2026-12-25T05:00:00.000Z')).toBe(1);
  });

  it('NO acota por estado de la solicitud ni por la frontera de autogestión', () => {
    const q = renderizar(condicionCenso(corte));
    // El criterio elegido es el COMPROBANTE. `estado = 'pagado'` sería un subconjunto estricto —deja
    // fuera el SOAT cuya factura espera en la cola de revisión OCR— y afirmaría sobre el flujo
    // interno de FLITO en vez de sobre el documento.
    expect(q.params).not.toContain('pagado');
    // Y el AC2 dice «los que tienen comprobante, y solo esas»: añadir la frontera de autogestión o
    // excluir `gestion_operaciones` sería inventar alcance.
    expect(q.sql).not.toContain('gestion_operaciones');
    expect(q.sql).not.toContain('excepcion_autogestion');
  });
});

// ───────────────── AC3/AC4/AC5 — el clasificador: el ORDEN, sobre la función pura ───────────────

describe('AC5 — transporte primero: un silencio del RUNT NO es un «no»', () => {
  it('circuito abierto (no se consultó) → `no_verificado`, motivo `circuito`', () => {
    expect(clasificarVigencia(null)).toEqual({ estado: 'no_verificado', motivo: 'circuito' });
  });

  it('el RUNT no respondió → `no_verificado` con la CAUSA, nunca `sin_registro`', () => {
    // MUTANTE — el que el diseño mide y que hay que atajar: escribir
    // `soatVigenteSegunRunt(r) ? 'vigente' : 'sin_registro'` sin la guarda de transporte. Con la
    // pasarela caída `soatVigenteSegunRunt` devuelve `false` (el check sale `unknown` y solo cuenta
    // `status === 'ok'`), así que ese código escribiría `sin_registro`: dar por vencido por silencio.
    expect(clasificarVigencia(respTimeout)).toEqual({ estado: 'no_verificado', motivo: 'timeout' });
    expect(clasificarVigencia({ ok: false, message: 'ECONNRESET' }))
      .toEqual({ estado: 'no_verificado', motivo: 'red' });
    expect(clasificarVigencia({ ok: false, message: 'circuit breaker abierto' }))
      .toEqual({ estado: 'no_verificado', motivo: 'circuito' });
    // Lo que no casa ninguna regla sale como `otro`, NUNCA como el texto original.
    expect(clasificarVigencia({ ok: false, message: 'RUNT: placa ABC123 sin respuesta' }))
      .toEqual({ estado: 'no_verificado', motivo: 'otro' });
  });

  it('HUECO MEDIDO: el mensaje REAL de `CircuitoAbiertoError` se clasifica `otro`, no `circuito`', () => {
    // No es un aserto de lo que se quiere, es el registro de lo que HAY, medido: `causaDeCaida` casa
    // `/circuit|circuito/i` y el mensaje que produce `CircuitoAbiertoError` es literalmente
    // «Servicio runt-vehicle temporalmente no disponible» — que no contiene ninguna de las dos.
    // `consultarVehiculoRunt` atrapa ese error y lo devuelve como `{ok:false, message}`, así que por
    // esa vía el token nunca sale `circuito`.
    //
    // **No afecta a la corrección de esta HU** —los dos desenlaces son `no_verificado` y el conteo de
    // `circuito` que sí importa lo produce la guarda previa de {@link verificarVehiculo}, que devuelve
    // `null` sin consultar— pero SÍ degrada la telemetría que ADR-0010 prometió («poder distinguir un
    // timeout de un circuito abierto») para el canal Cliente, que es de otra HU. Queda escrito aquí
    // para que quien lo corrija en `causaDeCaida` sepa que este archivo cambia con él.
    expect(clasificarVigencia({ ok: false, message: 'Servicio runt-vehicle temporalmente no disponible' }))
      .toEqual({ estado: 'no_verificado', motivo: 'otro' });
  });

  it('el motivo es un token CERRADO: el mensaje del tercero no sobrevive a la clasificación', () => {
    const d = clasificarVigencia({ ok: false, message: 'timeout consultando placa ABC123 doc 1098765432' });
    expect(JSON.stringify(d)).not.toContain('ABC123');
    expect(JSON.stringify(d)).not.toContain('1098765432');
  });

  it('respondió y el registro no conoce el vehículo → `sin_registro` (eso SÍ es un «no»)', () => {
    expect(clasificarVigencia(respSinRegistro)).toEqual({ estado: 'sin_registro' });
  });

  it('respondió y la póliza está vencida → `sin_registro`, no `no_verificado`', () => {
    // Un «no» legítimo es un vehículo VERIFICADO. Contarlo como pendiente reprogramaría la corrida
    // cada hora contra un RUNT que está respondiendo perfectamente.
    expect(clasificarVigencia(respVencido)).toEqual({ estado: 'sin_registro' });
  });

  it('respondió y la póliza está viva → `vigente` **con fecha y póliza**', () => {
    // MUTANTE — pasarle la respuesta ENTERA a `fechaVencimientoSoatRunt` en vez de `data`: devuelve
    // `null` siempre, sin error y sin excepción. Es la asimetría de firmas que el diseño señala, y
    // este aserto es lo único que la mata.
    expect(clasificarVigencia(respVigente('RUNT-777')))
      .toEqual({ estado: 'vigente', venceEl: '2027-03-12', poliza: 'RUNT777' });
  });

  it('`vigente` sin fecha ni póliza es legítimo: el RUNT reporta a veces solo por estado', () => {
    const soloEstado = { ok: true, data: { vehiculo: { marca: 'MAZDA' }, soat: [{ estadoSoat: 'VIGENTE' }] } };
    expect(clasificarVigencia(soloEstado)).toEqual({ estado: 'vigente', venceEl: null, poliza: null });
  });

  it('**el orden importa**: un `ok:false` que además trajera datos no se lee como vigencia', () => {
    // MUTANTE — invertir transporte y vigencia (mirar `soatVigenteSegunRunt` antes que `ok`). Esta
    // respuesta tiene un SOAT vigente dentro Y `ok:false`: quien mire la vigencia primero diría
    // `vigente` sobre una consulta que no se completó.
    const contradictoria = { ...respVigente(), ok: false, message: 'ETIMEDOUT' };
    expect(clasificarVigencia(contradictoria)).toEqual({ estado: 'no_verificado', motivo: 'timeout' });
  });
});

// ──────────────────────────── AC5 — lo que se escribe, y lo que NO ──────────────────────────────

describe('AC5 — el payload por desenlace: las claves AUSENTES son la mitad del contrato', () => {
  const ahora = new Date('2026-09-04T05:12:00.000Z');

  it('`vigente` con datos: estado, fecha de respuesta, vencimiento y póliza del RUNT', () => {
    expect(payloadDeDesenlace({ estado: 'vigente', venceEl: '2027-03-12', poliza: 'RUNT777' }, ahora))
      .toEqual({ estadoVigencia: 'vigente', verificadaEn: ahora, venceEl: '2027-03-12', polizaRunt: 'RUNT777' });
  });

  it('`vigente` sin fecha ni póliza: las claves NO viajan, para no borrar lo que hubiera', () => {
    const p = payloadDeDesenlace({ estado: 'vigente', venceEl: null, poliza: null }, ahora);
    expect(p).toEqual({ estadoVigencia: 'vigente', verificadaEn: ahora });
    expect(p).not.toHaveProperty('venceEl');
    expect(p).not.toHaveProperty('polizaRunt');
  });

  it('`sin_registro`: refresca la fecha de respuesta y **conserva** vencimiento y póliza', () => {
    const p = payloadDeDesenlace({ estado: 'sin_registro' }, ahora);
    expect(p).toEqual({ estadoVigencia: 'sin_registro', verificadaEn: ahora });
    // La fecha vieja es la última verdad conocida (AC5). Un `venceEl: null` explícito la borraría, y
    // con ella la única pista de cuándo dejó de estar el vehículo en el registro.
    expect(p).not.toHaveProperty('venceEl');
  });

  it('`no_verificado`: **`verificada_en` NO se toca, ni siquiera con `null`**', () => {
    const p = payloadDeDesenlace({ estado: 'no_verificado', motivo: 'timeout' }, ahora);
    expect(p).toEqual({ estadoVigencia: 'no_verificado' });
    // MUTANTE — mover `verificada_en` en esta rama. Es el fallo más silencioso de la HU: la métrica
    // del Feature («cuánto lleva sin actualizarse el dato más viejo») se vería FRESCA justo con el
    // RUNT caído, y el predicado del censo excluiría del reintento horario a los que fallaron.
    expect(p).not.toHaveProperty('verificadaEn');
    expect(p).not.toHaveProperty('venceEl');
    expect(p).not.toHaveProperty('polizaRunt');
  });

  it('RN-D7 — ningún payload toca la solicitud, la póliza del OCR ni `updated_at`', () => {
    const todos = [
      payloadDeDesenlace({ estado: 'vigente', venceEl: '2027-03-12', poliza: 'RUNT777' }, ahora),
      payloadDeDesenlace({ estado: 'sin_registro' }, ahora),
      payloadDeDesenlace({ estado: 'no_verificado', motivo: 'red' }, ahora),
    ];
    for (const p of todos) {
      // MUTANTE — escribir la póliza del RUNT en `numeroPoliza`: borraría la llave con la que una
      // boleta de pago externo cruza contra el SOAT (Feature #11623), y nada se pondría rojo.
      expect(p).not.toHaveProperty('numeroPoliza');
      expect(p).not.toHaveProperty('estado');
      expect(p).not.toHaveProperty('pagadoEn');
      expect(p).not.toHaveProperty('motivoRechazo');
      // `updated_at` la mueven acciones HUMANAS. Moverla cada noche la vacía de significado.
      expect(p).not.toHaveProperty('updatedAt');
    }
  });
});

// ───────────────────────── El recorrido completo: conteos y escrituras ──────────────────────────

describe('AC3/AC4 — el recorrido escribe, audita solo lo que cambió y cuenta bien', () => {
  it('un vehículo que responde vigente: UPDATE con la fila correcta y auditoría de cambio', async () => {
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'no_verificado' }]);
    respuestaPorDefecto = respVigente('RUNT-777');

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    expect(r).toMatchObject({ considerados: 1, verificados: 1, pendientes: 0, cambiaron: 1 });
    expect(consultas).toEqual([VIN_A]);
    const [set] = updatesDeSoat();
    expect(set).toMatchObject({ estadoVigencia: 'vigente', venceEl: '2027-03-12', polizaRunt: 'RUNT777' });
    // El UPDATE va por el id del SOAT y no a ciegas.
    expect(espia.updatesEn('flito_soat')[0]!.filtros).toContain(SOAT_A);

    const deLaFila = auditorias().filter((a) => a.resource === 'flito_soat');
    expect(deLaFila).toHaveLength(1);
    expect(deLaFila[0]).toMatchObject({ userId: null, userEmail: 'sistema', action: 'update', resourceId: SOAT_A });
    expect(deLaFila[0]!.detail).toContain('no_verificado → vigente');
  });

  it('**una vigencia que NO cambia se escribe pero NO se audita**', async () => {
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' }]);
    respuestaPorDefecto = respVigente();

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    // El UPDATE sí ocurre: `verificada_en` tiene que refrescarse aunque la etiqueta no cambie, o la
    // antigüedad del dato mentiría.
    expect(updatesDeSoat()).toHaveLength(1);
    expect(r.cambiaron).toBe(0);
    // MUTANTE — auditar siempre: `audit_logs` responde «quién CAMBIÓ qué», y N filas por noche
    // diciendo «seguía vigente» la dejan inservible para lo que existe.
    expect(auditorias().filter((a) => a.resource === 'flito_soat')).toHaveLength(0);
  });

  it('la corrida deja UNA fila de auditoría con los totales, sin identificadores de vehículo', async () => {
    censo([
      { soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'no_verificado' },
      { soatId: SOAT_B, vin: VIN_B, estadoVigencia: 'vigente' },
    ]);
    respuestasPorVin = { [VIN_A]: [respVigente()], [VIN_B]: [respSinRegistro] };

    await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 2 });

    const corrida = auditorias().filter((a) => a.resource === 'flito_soat_verificacion_corridas');
    expect(corrida).toHaveLength(1);
    expect(corrida[0]).toMatchObject({ userId: null, userEmail: 'sistema', resourceId: '2026-09-04#2' });
    expect(corrida[0]!.detail).toContain('Considerados 2');
    // Ni placa, ni VIN, ni documento en el detalle de nada de lo que se auditó.
    const todo = JSON.stringify(auditorias());
    expect(todo).not.toContain(VIN_A);
    expect(todo).not.toContain(VIN_B);
  });

  it('**un fallido NO cuenta como verificado** — el mutante que apaga el reintento para siempre', async () => {
    censo([
      { soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' },
      { soatId: SOAT_B, vin: VIN_B, estadoVigencia: 'vigente' },
    ]);
    respuestasPorVin = { [VIN_A]: [respVigente()], [VIN_B]: [respTimeout, respTimeout] };

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    // `pendientes > 0` es lo ÚNICO que reprograma la corrida a la hora siguiente. Contar el fallido
    // en `verificados` cierra el día como `completa` y el vehículo no se vuelve a mirar hasta mañana.
    expect(r).toMatchObject({ considerados: 2, verificados: 1, pendientes: 1 });
    expect(r.motivos).toMatchObject({ timeout: 1 });
    // Y el que falló conserva su fecha: su payload no lleva `verificadaEn`.
    const delFallido = espia.updatesEn('flito_soat').find((m) => m.filtros.includes(SOAT_B))!;
    expect(delFallido.datos).toEqual({ estadoVigencia: 'no_verificado' });
  });

  it('un «no» legítimo del RUNT es un VERIFICADO, no un pendiente', async () => {
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' }]);
    respuestaPorDefecto = respVencido;

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    expect(r).toMatchObject({ verificados: 1, pendientes: 0, cambiaron: 1 });
    expect(updatesDeSoat()[0]).toEqual(expect.objectContaining({ estadoVigencia: 'sin_registro' }));
  });

  it('nunca llama a `consultarYClasificar` ni extrae datos del propietario', async () => {
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'no_verificado' }]);
    respuestaPorDefecto = {
      ok: true,
      data: {
        vehiculo: { marca: 'MAZDA', nombrePropietario: 'JUANA PEREZ', placa: 'ABC123' },
        soat: [{ estadoSoat: 'VIGENTE' }],
      },
    };

    await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    // La garantía estructural del «sin datos del propietario»: el nombre viene EN la respuesta del
    // RUNT y no llega ni al UPDATE, ni a la auditoría, ni al log. Es también lo que sostiene la
    // decisión de no escribir `pii_access_log` por vehículo — no hay campo accedido que declarar.
    const todo = JSON.stringify([updatesDeSoat(), auditorias(), registros]);
    expect(todo).not.toContain('JUANA PEREZ');
    expect(todo).not.toContain('ABC123');
    expect(espia.insertsEn('pii_access_log')).toHaveLength(0);
  });
});

// ─────────────────────── AC6 — ritmo, breaker compartido y tope por vehículo ────────────────────

describe('AC6 — la corrida no puede degradar las consultas de usuarios', () => {
  it('**con el circuito abierto no consulta NADA** y todo vuelve como pendiente', async () => {
    censo([
      { soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' },
      { soatId: SOAT_B, vin: VIN_B, estadoVigencia: 'vigente' },
    ]);
    circuitoAbiertoAhora = true;

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    // MUTANTE — quitar la guarda de `circuitoAbierto` antes de la tanda: las llamadas rebotarían al
    // instante, el censo entero se quemaría en milisegundos marcando todo `no_verificado`, gastaría
    // un reintento horario sin haber intentado nada y —lo caro— mantendría el circuito COMPARTIDO
    // abierto, con lo que cualquier persona usando el sistema recibiría 503.
    expect(consultas).toHaveLength(0);
    expect(runtMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ considerados: 2, verificados: 0, pendientes: 2 });
    expect(r.motivos).toMatchObject({ circuito: 2 });
    // Y con el circuito abierto NO se escribe nada: ni un `no_verificado` que borre la etiqueta
    // buena de una fila que nadie llegó a consultar.
    expect(updatesDeSoat()).toHaveLength(0);
    expect(registros.some((l) => String(l[1]).includes('circuito del RUNT abierto'))).toBe(true);
  });

  it('el tope por vehículo está DECLARADO y son 2 consultas como mucho', async () => {
    expect(MAX_REINTENTOS_VEHICULO).toBe(1);

    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' }]);
    respuestaPorDefecto = respTimeout;

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    // 1 + MAX_REINTENTOS_VEHICULO. Con 4 reintentos horarios encima, cada unidad de más aquí
    // multiplica el tráfico contra el registro nacional por el número de corridas del día.
    expect(consultas).toHaveLength(1 + MAX_REINTENTOS_VEHICULO);
    expect(r.motivos).toMatchObject({ reintentos: MAX_REINTENTOS_VEHICULO });
  });

  it('un vehículo que responde a la SEGUNDA no gasta el reintento del siguiente', async () => {
    censo([
      { soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' },
      { soatId: SOAT_B, vin: VIN_B, estadoVigencia: 'vigente' },
    ]);
    respuestasPorVin = { [VIN_A]: [respTimeout, respVigente()], [VIN_B]: [respVigente()] };

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    expect(r).toMatchObject({ verificados: 2, pendientes: 0 });
    expect(consultas.filter((v) => v === VIN_A)).toHaveLength(2);
    expect(consultas.filter((v) => v === VIN_B)).toHaveLength(1);
  });

  it('si el circuito se abre a mitad, el reintento de ese vehículo no se gasta', async () => {
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' }]);
    respuestaPorDefecto = respTimeout;
    abrirCircuitoTras = 1; // se abre en cuanto sale la primera consulta

    await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    // Con el circuito abierto la llamada no sale a la red: rebota y consumiría el tope sin haber
    // intentado nada. Preguntar antes cuesta un `Map.get`.
    expect(consultas).toHaveLength(1);
  });

  it('el presupuesto está declarado y es MENOR que el TTL del candado', async () => {
    // Pasarse del TTL (50 min) no es ir lento: es que el candado caduca y otra instancia entra EN
    // PARALELO a consultar los mismos vehículos. 80 % es el margen.
    expect(PRESUPUESTO_CORRIDA_MS).toBeLessThan(50 * 60_000);
    expect(PRESUPUESTO_CORRIDA_MS).toBe(40 * 60_000);
  });

  it('el censo NO lleva LIMIT: `considerados` es el censo real, y el corte se ve en `pendientes`', () => {
    const q = renderizar(condicionCenso(corteDelDia('2026-09-04')));
    // Un `LIMIT` truncaría en silencio y `total` diría «500» donde había 3 000. El presupuesto corta
    // DESPUÉS de contar, así que la diferencia aparece donde tiene que aparecer.
    expect(q.sql).not.toMatch(/\blimit\b/i);
  });
});

// ───────────────────────────── AC7 — de aquí solo salen conteos ─────────────────────────────────

describe('AC7 — el recorrido devuelve conteos y nada más', () => {
  it('el resultado no contiene ningún identificador, y `motivos` es vocabulario cerrado', async () => {
    censo([
      { soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' },
      { soatId: SOAT_B, vin: VIN_B, estadoVigencia: 'vigente' },
    ]);
    respuestasPorVin = { [VIN_A]: [respTimeout, respTimeout], [VIN_B]: [{ ok: false, message: 'ECONNREFUSED' }] };

    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });

    expect(JSON.stringify(r)).not.toContain(VIN_A);
    expect(JSON.stringify(r)).not.toContain(SOAT_A);
    for (const k of Object.keys(r.motivos)) {
      expect(['timeout', 'red', 'circuito', 'otro', 'reintentos']).toContain(k);
    }
    for (const v of Object.values(r.motivos)) expect(typeof v).toBe('number');
    // MUTANTE — usar `err.message` como clave del mapa: un mensaje de la pasarela puede traer la
    // placa dentro y acabaría en una columna `jsonb` y en el log del cron.
    expect(Object.keys(r.motivos).join(' ')).not.toMatch(/ECONNREFUSED|ETIMEDOUT/);
  });

  it('un censo vacío es una corrida completa, no un fallo', async () => {
    censo([]);
    const r = await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 });
    expect(r).toEqual({ considerados: 0, verificados: 0, pendientes: 0, cambiaron: 0, motivos: {} });
    expect(consultas).toHaveLength(0);
  });
});

// ────────────────────────── El error propio: nombre sí, mensaje no ──────────────────────────────

describe('el fallo de base sale con NOMBRE propio y sin el mensaje del driver', () => {
  it('un censo que revienta lanza `RecorridoVigenciaError` y no propaga el texto', async () => {
    kdb.when.selectThrow('flito_soat', new Error('timeout consultando placa ABC123'));

    await expect(recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 })).rejects.toMatchObject({
      name: 'RecorridoVigenciaError',
    });
    // El cron loguea `err.name`. Que el mensaje del driver no viaje es lo que hace que la regla del
    // AC7 no dependa de cómo redacte sus excepciones el módulo `pg`.
    await recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 }).catch((e: Error) => {
      expect(e.message).not.toContain('ABC123');
    });
  });

  it('un RUNT caído NO lanza: es un `pendiente`, no una excepción', async () => {
    censo([{ soatId: SOAT_A, vin: VIN_A, estadoVigencia: 'vigente' }]);
    respuestaPorDefecto = respTimeout;

    // MUTANTE — convertir el silencio del RUNT en un `throw`: el primer timeout abortaría el censo
    // entero y el cron contaría 1 pendiente donde había 3 000.
    await expect(recorrerVigenciaSoat({ dia: '2026-09-04', intento: 1 })).resolves.toMatchObject({
      pendientes: 1,
    });
  });
});
