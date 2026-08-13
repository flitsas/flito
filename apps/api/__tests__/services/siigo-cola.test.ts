// Siigo — la cola de emisión (HU #11327). Un bloque por criterio.
//
// El test que importa de este archivo no es el del encolado feliz: es el del AC6. Que dos
// instancias no se lleven la misma fila **no se puede comprobar mirando el resultado** —con la base
// mockeada no hay concurrencia que observar—, así que se comprueba sobre el MECANISMO: que la fila
// se selecciona y se marca en UNA sola sentencia, con el candado dentro. La versión de dos pasos
// (SELECT ... FOR UPDATE SKIP LOCKED y luego UPDATE) devuelve exactamente lo mismo en el camino
// feliz y no excluye nada en producción, así que un test de resultado la daría por buena.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

/** Nadie de este módulo debería salir a la red. Si alguien lo intenta, que se vea. */
const siigoRequestOrThrowMock = vi.fn(async () => {
  throw new Error('la cola no puede llamar a Siigo');
});
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: siigoRequestOrThrowMock,
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

const {
  colaDeTramites, encolar, liberar, registrarDesenlace, SiigoColaError, tomarLote,
} = await import('../../src/modules/siigo/facturacion.cola.service.js');

const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTRO_TRAMITE = 'aaaaaaaa-2222-4111-8111-aaaaaaaaaaaa';
const LOTE = 'llllllll-1111-4111-8111-llllllllllll';
/** Lo que se factura hoy: solo el trámite digital. El resto va por reintegro (A1). */
const CONCEPTOS = ['tramite_digital'] as const;
const COLA = 'cccccccc-1111-4111-8111-cccccccccccc';
const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const AHORA = new Date('2026-08-11T15:00:00.000Z');

function filaCola(over: Record<string, unknown> = {}) {
  return {
    id: COLA,
    loteId: LOTE,
    ambiente: 'pruebas',
    estado: 'pendiente',
    intentos: 0,
    maxIntentos: 5,
    esperas: 0,
    maxEsperas: 20,
    proximoIntentoAt: AHORA,
    ultimoIntentoAt: null,
    facturaId: null,
    desenlace: null,
    errorCode: null,
    errorDetalle: null,
    createdAt: AHORA,
    updatedAt: AHORA,
    ...over,
  };
}

/** El lote ya existe y la cola está vacía: el camino de un encolado nuevo. */
function escenarioFeliz(): void {
  kdb.when
    .insert('siigo_lotes_facturacion', [{ id: LOTE }])
    .insert('siigo_lote_tramites', [])
    .select('siigo_lotes_facturacion', [{ id: LOTE }])
    .insert('siigo_cola_facturacion', [filaCola()])
    .select('siigo_cola_facturacion', [])
    .update('siigo_cola_facturacion', [filaCola()]);
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  vi.clearAllMocks();
  escenarioFeliz();
});

// ── AC1 — encolar devuelve sin esperar a Siigo ─────────────────────────────

describe('AC1 — encolar no llama a Siigo ni una sola vez', () => {
  it('crea el lote, la fila de cola y vuelve', async () => {
    const r = await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });

    expect(r.resultado).toBe('encolado');
    expect(r.estado).toBe('pendiente');
    expect(r.loteId).toBe(LOTE);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('la cita del alta es AHORA: lo recién pedido sale en el próximo ciclo', async () => {
    await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });
    expect(espia.ultimoInsertEn('siigo_cola_facturacion').proximoIntentoAt).toEqual(AHORA);
  });

  it('deja escrito qué contiene el lote: sin eso el trabajador no sabría qué facturar', async () => {
    // La huella IDENTIFICA el lote y no se puede invertir. El trabajador toma una fila con un
    // `loteId` y nada más.
    await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE, OTRO_TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });
    const pertenencia = espia.insertsEn('siigo_lote_tramites')[0]!.datos as unknown as Array<{ tramiteId: string }>;
    expect(pertenencia.map((p) => p.tramiteId).sort()).toEqual([TRAMITE, OTRO_TRAMITE].sort());
  });

  it('sin trámites no encola nada', async () => {
    await expect(encolar({ conceptos: CONCEPTOS, tramiteIds: [], ambiente: 'pruebas', usuarioId: 3 }))
      .rejects.toThrow(SiigoColaError);
  });

  it('deja rastro en la bitácora con la operación que el freno NO mide', async () => {
    const { OPERACION_ENCOLAR } = await import('../../src/modules/siigo/siigo.freno.service.js');
    await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });
    expect(registrarOperacionMock).toHaveBeenCalledWith(
      expect.objectContaining({ operacion: OPERACION_ENCOLAR, resultado: 'ok', createdBy: 3 }),
    );
  });
});

describe('encolar es idempotente, y lo garantiza el índice', () => {
  /** El INSERT choca con el índice único de lote: no hay fila nueva. */
  function conflictoCon(fila: Record<string, unknown>): void {
    kdb.when.insert('siigo_cola_facturacion', []).select('siigo_cola_facturacion', [fila]);
  }

  it('ya en cola — devuelve la que hay sin tocarla', async () => {
    conflictoCon(filaCola({ estado: 'error', intentos: 2 }));
    const r = await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });

    expect(r.resultado).toBe('ya_en_cola');
    expect(espia.updatesEn('siigo_cola_facturacion')).toHaveLength(0);
    expect(registrarOperacionMock).not.toHaveBeenCalled();
  });

  it('ya enviada — no se vuelve a encolar un documento que existe', async () => {
    conflictoCon(filaCola({ estado: 'enviado', facturaId: FACTURA }));
    const r = await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });

    expect(r.resultado).toBe('ya_enviado');
    expect(espia.updatesEn('siigo_cola_facturacion')).toHaveLength(0);
  });

  it('dada por perdida — NO se reactiva sola', async () => {
    // `fallido_definitivo` significa «esto no se arregla reintentando». Si el encolado normal lo
    // reactivara, una pantalla que reencola al refrescar volvería a poner en cola lo ya descartado.
    conflictoCon(filaCola({ estado: 'fallido_definitivo', intentos: 5 }));
    const r = await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });

    expect(r.resultado).toBe('fallido_definitivo');
    expect(espia.updatesEn('siigo_cola_facturacion')).toHaveLength(0);
  });

  it('dada por perdida y reactivada a petición — contadores a cero y cita para ya', async () => {
    conflictoCon(filaCola({ estado: 'fallido_definitivo', intentos: 5 }));
    kdb.when.update('siigo_cola_facturacion', [filaCola({ estado: 'pendiente' })]);

    const r = await encolar({
      conceptos: CONCEPTOS,
      tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA, reactivar: true,
    });

    expect(r.resultado).toBe('reactivado');
    const [update] = espia.updatesEn('siigo_cola_facturacion');
    expect(update!.datos).toMatchObject({
      estado: 'pendiente', intentos: 0, esperas: 0, proximoIntentoAt: AHORA,
      errorCode: null, errorDetalle: null, desenlace: null,
      // La factura del intento anterior también se borra. La columna dice «la factura que produjo
      // el trabajo», y la de antes no produjo ESTE: dejarla haría que una fila recién puesta en cola
      // afirmara un documento que todavía no tiene, sin que ningún CHECK lo impida.
      facturaId: null,
    });
    // La condición de estado viaja DENTRO del UPDATE: dos reactivaciones simultáneas leerían las dos
    // `fallido_definitivo` y la segunda pisaría los contadores de un trabajo ya en curso.
    expect(update!.filtros).toContain('fallido_definitivo');
  });

  it('si otro la reactivó primero, no se dice haberla reactivado', async () => {
    conflictoCon(filaCola({ estado: 'fallido_definitivo' }));
    kdb.when.update('siigo_cola_facturacion', []);

    const r = await encolar({
      conceptos: CONCEPTOS,
      tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA, reactivar: true,
    });
    expect(r.resultado).toBe('ya_en_cola');
    expect(registrarOperacionMock).not.toHaveBeenCalled();
  });

  it('si el lote desaparece mientras se crea, no se encola nada', async () => {
    kdb.when.insert('siigo_lotes_facturacion', []).select('siigo_lotes_facturacion', []);
    await expect(encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3 }))
      .rejects.toThrow(SiigoColaError);
    expect(espia.insertsEn('siigo_cola_facturacion')).toHaveLength(0);
  });
});

// ── AC6 — la exclusión la garantiza la base de datos ───────────────────────

/** Texto SQL de una plantilla drizzle, con los parámetros fuera. */
/**
 * Todos los `Date` que viajan dentro de la consulta, a cualquier profundidad.
 *
 * Drizzle mete los valores interpolados **directamente** como trozos —un `Date` es un chunk, no un
 * `Param` con `.value`—, así que hay que buscar la instancia, no una propiedad. Se cubren las dos
 * formas por si una versión futura los envuelve.
 */
function fechasEnLaConsulta(q: unknown): Date[] {
  const fechas: Date[] = [];
  const visitar = (n: unknown): void => {
    if (n instanceof Date) { fechas.push(n); return; }
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
    if ('value' in o && !Array.isArray(o.value)) visitar(o.value);
  };
  visitar(q);
  return fechas;
}

function textoSql(q: unknown): string {
  const trozos: string[] = [];
  const visitar = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.value) && o.value.every((v) => typeof v === 'string')) {
      trozos.push(...(o.value as string[]));
      return;
    }
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
  };
  visitar(q);
  return trozos.join(' ').replace(/\s+/g, ' ').trim();
}

describe('AC6 — una sola instancia procesa cada fila', () => {
  const TOMA = {
    ambiente: 'pruebas' as const, limite: 15, tomadoPor: 'host-1', ahora: AHORA,
  };

  beforeEach(() => {
    kdb.execute.mockResolvedValue([
      { id: COLA, lote_id: LOTE, intentos: 1, esperas: 2, max_intentos: 5, max_esperas: 20 },
    ]);
  });

  it('selecciona Y marca en la MISMA sentencia, con el candado dentro', async () => {
    await tomarLote(TOMA);

    expect(kdb.execute).toHaveBeenCalledTimes(1);
    const sql = textoSql(kdb.execute.mock.calls[0]![0]);

    // El candado se toma dentro de la sentencia que hace el UPDATE, así que no se suelta hasta que
    // esa sentencia confirma — y para entonces el arrendamiento ya está escrito.
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/UPDATE siigo_cola_facturacion c SET tomado_por =/);
    expect(sql.indexOf('UPDATE siigo_cola_facturacion c'))
      .toBeGreaterThan(sql.indexOf('FOR UPDATE SKIP LOCKED'));
  });

  it('ninguna fecha viaja como Date: el driver no sabe codificarla (regresión 2026-08-13)', async () => {
    // `db.execute` termina en `client.unsafe(query, params)` de postgres.js, que —a diferencia de su
    // plantilla etiquetada— NO aplica serializadores por tipo. Un `Date` ahí lanza «The "string"
    // argument must be of type string […]. Received an instance of Date», y lanza SIEMPRE: con un
    // solo `Date` en la consulta, el trabajador no podía tomar NI UNA fila contra una base real.
    //
    // La suite entera corre contra la base mockeada, que acepta cualquier parámetro, así que el
    // fallo sobrevivió a 30 pruebas de este mismo archivo. Esta guarda mira los PARÁMETROS, que es
    // lo único que el mock no puede disimular.
    await tomarLote(TOMA);

    expect(fechasEnLaConsulta(kdb.execute.mock.calls[0]![0])).toEqual([]);
  });

  it('NO usa el camino de dos pasos, que no excluye nada', async () => {
    // `SELECT ... FOR UPDATE SKIP LOCKED` suelto y luego `UPDATE` con los ids devuelve lo mismo en el
    // camino feliz y en producción deja pasar a las dos instancias: los candados de fila mueren con
    // la transacción, y una sentencia suelta es su propia transacción.
    await tomarLote(TOMA);
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('solo mira lo que está en cola y cuya cita venció', async () => {
    await tomarLote(TOMA);
    const sql = textoSql(kdb.execute.mock.calls[0]![0]);
    expect(sql).toMatch(/estado IN \('pendiente', 'error'\)/);
    expect(sql).toMatch(/proximo_intento_at <=/);
    // El arrendamiento vencido vuelve a ser elegible: si no, una instancia caída dejaría su fila
    // tomada para siempre.
    expect(sql).toMatch(/tomado_en IS NULL OR tomado_en </);
    // Por cita y luego antigüedad: una fila con muchos reintentos no se queda atrás para siempre.
    expect(sql).toMatch(/ORDER BY proximo_intento_at, created_at/);
  });

  it('devuelve los contadores de cada fila, que es lo que decide el reintento', async () => {
    const filas = await tomarLote(TOMA);
    expect(filas).toEqual([
      { id: COLA, loteId: LOTE, intentos: 1, esperas: 2, maxIntentos: 5, maxEsperas: 20 },
    ]);
  });

  it('con límite cero no pregunta nada', async () => {
    await tomarLote({ ...TOMA, limite: 0 });
    expect(kdb.execute).not.toHaveBeenCalled();
  });

  it('entiende las filas venga como venga el driver', async () => {
    // Un cambio de driver que rompiera esto dejaría al trabajador creyendo que la cola está vacía:
    // no hay error, simplemente deja de facturarse.
    kdb.execute.mockResolvedValue({
      rows: [{ id: COLA, lote_id: LOTE, intentos: 0, esperas: 0, max_intentos: 5, max_esperas: 20 }],
    } as never);
    expect(await tomarLote(TOMA)).toHaveLength(1);
  });
});

// ── Cerrar el trabajo ──────────────────────────────────────────────────────

describe('registrarDesenlace escribe el resultado y suelta el arrendamiento', () => {
  const COMUN = {
    colaId: COLA, tomadoPor: 'host-1', desenlace: 'emitida' as const,
    intentos: 1, esperas: 0, ahora: AHORA,
  };

  beforeEach(() => {
    kdb.when.update('siigo_cola_facturacion', [{ id: COLA }]);
  });

  it('enviado — guarda la factura y deja la fila sin arrendar', async () => {
    const ok = await registrarDesenlace({ ...COMUN, estado: 'enviado', facturaId: FACTURA });

    expect(ok).toBe(true);
    const [update] = espia.updatesEn('siigo_cola_facturacion');
    expect(update!.datos).toMatchObject({
      estado: 'enviado', facturaId: FACTURA, tomadoPor: null, tomadoEn: null, ultimoIntentoAt: AHORA,
    });
  });

  it('solo escribe si la fila SIGUE siendo nuestra', async () => {
    // Un ciclo puede tardar más que el arrendamiento; para entonces otra instancia ha podido tomar
    // la fila legítimamente. Sin la condición, el lento pondría el desenlace de su intento encima
    // del trabajo del otro.
    await registrarDesenlace({ ...COMUN, estado: 'enviado', facturaId: FACTURA });
    expect(espia.updatesEn('siigo_cola_facturacion')[0]!.filtros).toContain('host-1');
  });

  it('devuelve false cuando la fila ya era de otro', async () => {
    kdb.when.update('siigo_cola_facturacion', []);
    expect(await registrarDesenlace({ ...COMUN, estado: 'enviado', facturaId: FACTURA })).toBe(false);
  });

  it('error — agenda la cita y NO la deja arrendada esperando dos relojes', async () => {
    const cita = new Date(AHORA.getTime() + 60_000);
    await registrarDesenlace({
      ...COMUN, estado: 'error', desenlace: 'fallida', proximoIntentoAt: cita,
      errorCode: 'x', errorDetalle: 'y',
    });
    expect(espia.updatesEn('siigo_cola_facturacion')[0]!.datos).toMatchObject({
      estado: 'error', proximoIntentoAt: cita, tomadoPor: null, tomadoEn: null,
    });
  });

  it('los estados terminales no mueven la cita', async () => {
    // Moverla haría que un `fallido_definitivo` pareciera tener trabajo pendiente.
    await registrarDesenlace({
      ...COMUN, estado: 'fallido_definitivo', desenlace: 'fallida', errorCode: 'x', errorDetalle: 'y',
    });
    expect(espia.updatesEn('siigo_cola_facturacion')[0]!.datos).not.toHaveProperty('proximoIntentoAt');
  });

  it('el detalle del error pasa SIEMPRE por el saneador', async () => {
    // Un error del motor envuelto por drizzle llega con la sentencia y sus parámetros dentro, y esta
    // columna acaba en pantalla.
    await registrarDesenlace({
      ...COMUN,
      estado: 'fallido_definitivo',
      desenlace: 'fallida',
      errorCode: 'x',
      errorDetalle: 'Failed query: SELECT * FROM users WHERE cedula = $1 params: 1020304050',
    });
    const detalle = String(espia.updatesEn('siigo_cola_facturacion')[0]!.datos.errorDetalle);
    expect(detalle).not.toContain('1020304050');
  });

  it('el código se recorta a lo que cabe en la columna', async () => {
    await registrarDesenlace({
      ...COMUN, estado: 'fallido_definitivo', desenlace: 'fallida', errorCode: 'z'.repeat(200),
    });
    expect(String(espia.updatesEn('siigo_cola_facturacion')[0]!.datos.errorCode)).toHaveLength(80);
  });
});

describe('liberar devuelve el trabajo sin gastarlo (AC7)', () => {
  it('suelta el arrendamiento y no toca el estado ni la cita', async () => {
    kdb.when.update('siigo_cola_facturacion', [{ id: COLA }]);
    await liberar({ colaId: COLA, tomadoPor: 'host-1', ahora: AHORA });

    const [update] = espia.updatesEn('siigo_cola_facturacion');
    expect(update!.datos).toEqual({ tomadoPor: null, tomadoEn: null, updatedAt: AHORA });
    expect(update!.filtros).toContain('host-1');
  });
});

// ── I1 — la cola nunca escribe en siigo_facturas ───────────────────────────

describe('I1 — la cola no escribe en siigo_facturas', () => {
  const FUENTES = [
    'src/modules/siigo/facturacion.cola.service.ts',
    'src/modules/siigo/facturacion.trabajador.service.ts',
  ];

  it('ningún módulo de la cola actualiza la tabla de facturas', () => {
    // El estado del documento tiene un dueño —la emisión y, cuando aquella se queda a medias, la
    // reconciliación—. Un segundo escritor sobre una fila que representa un documento ante la DIAN
    // es la clase de cosa que produce una factura marcada como fallida estando viva.
    for (const f of FUENTES) {
      const fuente = readFileSync(path.resolve(process.cwd(), f), 'utf8');
      expect(fuente).not.toMatch(/update\(\s*siigoFacturas/);
      // Ni siquiera se importa la tabla: lo que no se tiene a mano no se escribe por descuido.
      const importes = [...fuente.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/\.\.\/db\/schema\.js'/g)];
      for (const i of importes) expect(i[1]).not.toContain('siigoFacturas');
    }
  });

  it('encolar no toca la tabla de facturas ni de lejos', async () => {
    await encolar({ conceptos: CONCEPTOS, tramiteIds: [TRAMITE], ambiente: 'pruebas', usuarioId: 3, ahora: AHORA });
    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
    expect(espia.insertsEn('siigo_facturas')).toHaveLength(0);
  });
});

// ── Consultar el estado mientras tanto (AC1) ───────────────────────────────

describe('el estado se puede consultar mientras el trabajador procesa', () => {
  it('resuelve por la pertenencia del lote, no recalculando la huella', async () => {
    // Con la huella solo se puede preguntar por el conjunto exacto que alguien encoló: el día que se
    // consolide, `huella([id])` no encontraría el lote de {A, B} y la pantalla diría que ese trámite
    // no está en cola cuando sí lo está.
    kdb.when
      .select('siigo_lote_tramites', [
        { loteId: LOTE, tramiteId: TRAMITE }, { loteId: LOTE, tramiteId: OTRO_TRAMITE },
      ])
      .select('siigo_cola_facturacion', [filaCola({ estado: 'error', intentos: 2 })]);

    const r = await colaDeTramites('pruebas', [TRAMITE, OTRO_TRAMITE]);

    expect(r).toHaveLength(2);
    expect(r[0]!.cola.estado).toBe('error');
    expect(r[0]!.cola.intentos).toBe(2);
  });

  it('un lote sin fila de cola no inventa una: la emisión directa no encola', async () => {
    kdb.when
      .select('siigo_lote_tramites', [{ loteId: LOTE, tramiteId: TRAMITE }])
      .select('siigo_cola_facturacion', []);
    expect(await colaDeTramites('pruebas', [TRAMITE])).toEqual([]);
  });

  it('sin trámites no pregunta nada', async () => {
    expect(await colaDeTramites('pruebas', [])).toEqual([]);
    expect(kdb.select).not.toHaveBeenCalled();
  });
});
