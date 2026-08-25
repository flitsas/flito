// Siigo — la bandeja de fallidos: la CONSULTA (HU #11340, AC1). Un bloque por criterio.
//
// Lo que importa de este archivo no es que devuelva filas: es que la consulta diga lo que tiene que
// decir. Con la base mockeada, un test de resultado daría por buena cualquier consulta —el mock
// responde lo que el test registró, mire lo que mire la sentencia—, así que las garantías
// estructurales se comprueban sobre el SQL REAL que se construyó:
//
//   · que las tres patas están y son un UNION ALL (una sola paginación, un solo orden);
//   · que el filtro de cliente es un EXISTS y no un JOIN (un JOIN ensancharía la unión y la
//     paginación contaría filas que no son casos);
//   · que las rechazadas con corrección registrada salen de la bandeja;
//   · que solo se mira la ÚLTIMA acta de envío de cada factura;
//   · que ninguna fecha viaja como `Date` (la regresión que dejó `tomarLote` sin poder tomar filas).
//
// Y lo que sí es de resultado —la guía operativa, el estado nativo, los contadores— se comprueba
// contra el catálogo REAL de `siigo.errors.ts`, sin mockearlo: si el AC1 dice «motivo en lenguaje
// operativo, acción sugerida y quién debe resolverlo», eso tiene que salir del catálogo de verdad.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Nadie de la bandeja debería salir a la red. Si alguien lo intenta, que se vea. */
const siigoRequestOrThrowMock = vi.fn(async () => {
  throw new Error('la bandeja no puede llamar a Siigo');
});
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: siigoRequestOrThrowMock,
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

const { consultarBandeja, descartesVigentes, guiaDelCaso, resumenBandeja } =
  await import('../../src/modules/siigo/siigo.bandeja.service.js');

const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const OTRA = 'ffffffff-2222-4111-8111-ffffffffffff';
const LOTE = 'llllllll-1111-4111-8111-llllllllllll';
const COLA = 'cccccccc-1111-4111-8111-cccccccccccc';
const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ACTA = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const DIAN = 'dddddddd-1111-4111-8111-dddddddddddd';
const AHORA = new Date('2026-08-23T15:00:00.000Z');
const HACE_TRES_DIAS = new Date('2026-08-20T15:00:00.000Z');

/**
 * El texto SQL de una consulta construida con `sql\`\``, sin los valores enlazados.
 *
 * Es la misma técnica que `siigo-cola.test.ts` usa para el AC6 de la cola, y por el mismo motivo:
 * con la base mockeada no hay nada que observar en el resultado, así que se afirma sobre el
 * mecanismo.
 */
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

/** Los `Date` que viajan como parámetro. Tienen que ser CERO: el driver no sabe codificarlos. */
function fechasEnLaConsulta(q: unknown): unknown[] {
  const fechas: unknown[] = [];
  const visitar = (n: unknown): void => {
    if (n instanceof Date) { fechas.push(n); return; }
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (o.value !== undefined) visitar(o.value);
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
  };
  visitar(q);
  return fechas;
}

function casoEmision(over: Record<string, unknown> = {}) {
  return {
    fuente: 'emision',
    ref_id: FACTURA,
    factura_id: FACTURA,
    ocurrido_en: HACE_TRES_DIAS,
    codigo: 'invalid_dian_resolution',
    cola_id: COLA,
    descartado: false,
    ...over,
  };
}

/** El escenario de hidratación: una factura con su cola, su trámite y su cliente. */
function escenario(): void {
  kdb.when
    .select('siigo_facturas', [{ id: FACTURA, numero: 'FV-100', loteId: LOTE, errorCode: 'invalid_dian_resolution' }])
    .select('siigo_cola_facturacion', [{
      id: COLA, loteId: LOTE, estado: 'fallido_definitivo', intentos: 5, maxIntentos: 5,
    }])
    .select('siigo_factura_tramites', [{
      facturaId: FACTURA, tramiteId: TRAMITE, idFlit: 'FLIT-9001', companiaId: 7,
    }])
    .select('clients', [{ id: 7, name: 'Transportes del Norte SAS' }])
    .select('siigo_factura_estados_dian', [{ id: DIAN, estado: 'rechazada', motivo: 'CUFE duplicado' }])
    .select('siigo_factura_envios', [{ id: ACTA, resultado: 'no_realizado', motivo: 'Sin correo' }])
    .select('siigo_operaciones', []);
}

beforeEach(() => {
  kdb.reset();
  vi.clearAllMocks();
  escenario();
  kdb.execute.mockResolvedValue([casoEmision()]);
});

// ── AC1 — la bandeja reúne las tres patas ──────────────────────────────────

describe('AC1 — las tres patas, en una sola consulta paginada', () => {
  it('la fase 1 es un UNION ALL de emisión, DIAN y correo, con UN solo orden y UN solo límite', async () => {
    await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA });

    const sql = textoSql(kdb.execute.mock.calls[0]![0]);
    // Dos UNION ALL = tres patas. Con dos patas o con tres consultas separadas, la paginación
    // dejaría de decir la verdad: páginas de tamaño variable y casos que no salen en ninguna.
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(sql).toMatch(/FROM siigo_facturas f/);
    expect(sql).toMatch(/siigo_factura_estados_dian dd/);
    expect(sql).toMatch(/siigo_factura_envios ee/);
    expect(sql.match(/ORDER BY ocurrido_en DESC/g)).toHaveLength(1);
    expect(sql).toMatch(/LIMIT .* OFFSET/);
  });

  it('una emisión fallida trae trámite, cliente, momento, motivo, acción y responsable', async () => {
    const pagina = await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA });
    const item = pagina.items[0]!;

    expect(item.tramites).toEqual([{ tramiteId: TRAMITE, idFlit: 'FLIT-9001' }]);
    expect(item.clienteId).toBe(7);
    expect(item.clienteNombre).toBe('Transportes del Norte SAS');
    expect(item.ocurridoEn).toBe(HACE_TRES_DIAS.toISOString());
    expect(item.facturaNumero).toBe('FV-100');
    // El AC1 entero, y sale del catálogo REAL: no hay ningún texto redactado en la bandeja.
    expect(item.guia.descripcion).toMatch(/resoluci/i);
    expect(item.guia.accion.length).toBeGreaterThan(10);
    expect(item.guia.responsableEtiqueta).toBe('contabilidad, en Siigo Nube');
    expect(item.guia.responsable).toBe('contabilidad');
  });

  it('el ítem lleva `facturaId` y el código CRUDO, que es por lo que se agrupa y se filtra', async () => {
    // Sin `facturaId` la pantalla no puede ofrecer «registrar corrección»; sin `guia.codigo` no se
    // puede filtrar por motivo, porque agrupar por la FRASE partiría en dos un motivo que es uno
    // solo (la frase de Siigo lleva el campo señalado dentro).
    const item = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items[0]!;
    expect(item.facturaId).toBe(FACTURA);
    expect(item.guia.codigo).toBe('invalid_dian_resolution');
    expect(item.codigo).toBe('invalid_dian_resolution');
  });

  it('`ocurridoEn` ES el momento desde el que está detenido, y la antigüedad ya viene calculada', async () => {
    // Un caso no tiene dos relojes. Un `detenidoDesde` aparte sería una copia del mismo valor, y el
    // día que se calculara distinto el filtro de antigüedad y la columna dejarían de cuadrar.
    const item = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items[0]!;
    expect(item.ocurridoEn).toBe(HACE_TRES_DIAS.toISOString());
    expect(item.antiguedadDias).toBe(3);
  });

  it('cada caso conserva su estado NATIVO y no inventa ninguno', async () => {
    kdb.execute.mockResolvedValue([
      casoEmision(),
      casoEmision({ fuente: 'dian', ref_id: DIAN, cola_id: null, codigo: 'dian_rechazada' }),
      casoEmision({ fuente: 'correo', ref_id: ACTA, cola_id: null, codigo: 'cliente_sin_correo' }),
    ]);

    const items = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items;

    // Cada pata rellena SU campo y deja los otros dos nulos: no hay un cuarto estado de bandeja.
    expect(items[0]!.estado).toEqual({ cola: 'fallido_definitivo', dian: null, correo: null });
    expect(items[1]!.estado).toEqual({ cola: null, dian: 'rechazada', correo: null });
    expect(items[2]!.estado).toEqual({ cola: null, dian: null, correo: 'no_realizado' });
  });

  it('el detalle de la DIAN es el motivo de la DIAN, no una segunda versión del diagnóstico', async () => {
    kdb.execute.mockResolvedValue([
      casoEmision({ fuente: 'dian', ref_id: DIAN, cola_id: null, codigo: 'dian_rechazada' }),
    ]);
    const item = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items[0]!;
    expect(item.detalle).toBe('CUFE duplicado');
    expect(item.guia.responsable).toBe('contabilidad');
  });

  // Hasta esta HU el motivo del rechazo solo se leía en la ficha de UNA factura. Aquí sale en una
  // fila que además trae la razón social, y nombre + identificación juntos son una correlación que
  // `CAMPOS_PII_BANDEJA = ['name']` no declara. La escritura de ese campo
  // (`siigo.motivo-rechazo.service.ts`) sigue sin redactar: esto evita que salga, no que se guarde.
  it('el detalle de la DIAN sale ENMASCARADO: en esta fila va al lado de la razón social', async () => {
    kdb.execute.mockResolvedValue([
      casoEmision({ fuente: 'dian', ref_id: DIAN, cola_id: null, codigo: 'dian_rechazada' }),
    ]);
    kdb.when.select('siigo_factura_estados_dian', [{
      id: DIAN,
      estado: 'rechazada',
      motivo: 'Regla FAJ26: el NIT del adquiriente 901234567 no corresponde al del certificado',
    }]);

    const item = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items[0]!;

    expect(item.detalle).not.toContain('901234567');
    // La regla infringida se conserva: es lo que el operador necesita para actuar. Y la razón social
    // NO se toca —la fila existe para trabajarla—; lo que se quita es la identificación que sobra.
    expect(item.detalle).toContain('FAJ26');
    expect(item.clienteNombre).toBe('Transportes del Norte SAS');
  });

  // El motivo de la DIAN se entrega en la MISMA fila que la razón social, así que cotejarlo contra
  // ella no es un extra: es lo que impide entregar nombre e identificación juntos. Importa sobre
  // todo cuando el cliente es persona natural —su «razón social» ES el nombre del titular— y cuando
  // el motivo viene en mayúsculas, que es como la DIAN escribe media respuesta y donde la heurística
  // por forma, a propósito, no mira.
  it('un motivo que repite la razón social del caso la entrega enmascarada, no entera', async () => {
    kdb.execute.mockResolvedValue([
      casoEmision({ fuente: 'dian', ref_id: DIAN, cola_id: null, codigo: 'dian_rechazada' }),
    ]);
    kdb.when
      .select('clients', [{ id: 7, name: 'MARIA GOMEZ RESTREPO' }])
      .select('siigo_factura_estados_dian', [{
        id: DIAN,
        estado: 'rechazada',
        motivo: 'DOCUMENTO RECHAZADO POR LA DIAN, TITULAR MARIA GOMEZ RESTREPO',
      }]);

    const item = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items[0]!;

    expect(item.detalle).not.toContain('MARIA GOMEZ RESTREPO');
    expect(item.detalle).toBe('DOCUMENTO RECHAZADO POR LA DIAN, TITULAR M. G. R.');
    // Y la columna propia sigue intacta: la fila existe para trabajarla, y ahí el nombre es el dato.
    expect(item.clienteNombre).toBe('MARIA GOMEZ RESTREPO');
  });

  it('mirar la bandeja no gasta ni una petición de la cuota de Siigo', async () => {
    await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA });
    await resumenBandeja({ ambiente: 'pruebas', ahora: AHORA });
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('pide una fila de MÁS para saber si hay más, en vez de contar la unión entera', async () => {
    kdb.execute.mockResolvedValue([casoEmision(), casoEmision({ ref_id: OTRA, factura_id: OTRA })]);
    const pagina = await consultarBandeja({ ambiente: 'pruebas', limite: 1, ahora: AHORA });

    expect(pagina.items).toHaveLength(1);
    expect(pagina.hayMas).toBe(true);
    expect(textoSql(kdb.execute.mock.calls[0]![0])).not.toMatch(/COUNT\(\*\)/);
  });

  it('ninguna fecha viaja como Date: el driver no sabe codificarla (regresión de tomarLote)', async () => {
    // `db.execute` acaba en `client.unsafe(query, params)` de postgres.js, que NO aplica los
    // serializadores por tipo. Un `Date` ahí revienta SIEMPRE contra una base real, y la suite entera
    // corre contra la mockeada, que acepta cualquier parámetro. Esto mira los PARÁMETROS, que es lo
    // único que el mock no puede disimular.
    await consultarBandeja({
      ambiente: 'pruebas', antiguedadDiasMin: 5, antiguedadDiasMax: 30, ahora: AHORA,
    });
    expect(fechasEnLaConsulta(kdb.execute.mock.calls[0]![0])).toEqual([]);
  });
});

// ── AC1 — los filtros ──────────────────────────────────────────────────────

describe('AC1 — filtros por motivo, cliente y antigüedad', () => {
  it('el filtro de cliente es un EXISTS, no un JOIN que ensancharía la unión', async () => {
    await consultarBandeja({ ambiente: 'pruebas', clientes: [7, 9], ahora: AHORA });

    const sql = textoSql(kdb.execute.mock.calls[0]![0]);
    expect(sql).toMatch(/EXISTS \( SELECT 1 FROM siigo_factura_tramites sft/);
    expect(sql).toMatch(/t\.compania_id = ANY\(/);
    // Un JOIN a la pertenencia haría que una factura de N trámites saliera N veces: la paginación
    // contaría filas que no son casos y el mismo fallo aparecería repetido en pantalla.
    expect(sql).not.toMatch(/JOIN siigo_factura_tramites sft ON/);
  });

  it('sin filtro de cliente no aparece ninguna condición de compañía', async () => {
    await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA });
    expect(textoSql(kdb.execute.mock.calls[0]![0])).not.toMatch(/compania_id/);
  });

  it('el filtro por motivo va sobre el código, no sobre la frase', async () => {
    await consultarBandeja({ ambiente: 'pruebas', codigos: ['invalid_dian_resolution'], ahora: AHORA });
    expect(textoSql(kdb.execute.mock.calls[0]![0])).toMatch(/COALESCE\(codigo, .*\) = ANY\(/);
  });

  it('«lleva al menos N días» se traduce a una cita ANTERIOR, no posterior', async () => {
    await consultarBandeja({ ambiente: 'pruebas', antiguedadDiasMin: 7, ahora: AHORA });
    const sql = textoSql(kdb.execute.mock.calls[0]![0]);
    // Al revés, el filtro «lo que lleva más de una semana parado» devolvería justo lo recién roto.
    expect(sql).toMatch(/ocurrido_en <= /);
    expect(sql).not.toMatch(/ocurrido_en >= /);
  });

  it('el filtro por fuente se aplica SOBRE la unión, no dentro de una pata', async () => {
    await consultarBandeja({ ambiente: 'pruebas', fuentes: ['correo'], ahora: AHORA });
    const sql = textoSql(kdb.execute.mock.calls[0]![0]);
    expect(sql).toMatch(/FROM casos WHERE/);
    expect(sql).toMatch(/fuente = ANY\(/);
    // Las tres patas siguen escritas: filtrar dentro de cada una duplicaría la condición tres veces.
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
  });
});

// ── AC1 — lo que NO debe salir en la bandeja ───────────────────────────────

describe('AC1 — lo que ya no es trabajo pendiente sale de la bandeja', () => {
  it('una rechazada por la DIAN con corrección registrada no aparece', async () => {
    // Frontera 3 del diseño: un rechazo de la DIAN no se «marca fallido», se corrige. El hecho que lo
    // saca es la corrección registrada, no una decisión de nadie.
    const sql = await sqlDe();
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM siigo_factura_correcciones k/);
  });

  it('del correo se mira SOLO la última acta: si la última dice `enviado`, no hay caso', async () => {
    const sql = await sqlDe();
    expect(sql).toMatch(/FROM siigo_factura_envios ee WHERE ee\.factura_id = f\.id ORDER BY ee\.created_at DESC, ee\.id DESC LIMIT 1/);
    expect(sql).toMatch(/e\.resultado IN \('fallido', 'no_realizado'\)/);
  });

  it('el estado de la DIAN se decide por secuencia, nunca por fecha', async () => {
    // `created_at` es la hora de INICIO DE LA TRANSACCIÓN: dos filas pueden compartir instante y
    // «la última» se volvería ambigua.
    const sql = await sqlDe();
    expect(sql).toMatch(/ORDER BY dd\.secuencia DESC LIMIT 1/);
  });

  it('lo dado por perdido no sale por defecto, y sí cuando se pide (AC6)', async () => {
    await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA });
    expect(textoSql(kdb.execute.mock.calls[0]![0])).toMatch(/NOT descartado/);

    kdb.execute.mockClear();
    await consultarBandeja({ ambiente: 'pruebas', incluirDescartados: true, ahora: AHORA });
    expect(textoSql(kdb.execute.mock.calls[0]![0])).not.toMatch(/NOT descartado/);
  });

  it('una factura fallida SIN fila de cola sale igual: el LEFT JOIN es el que la salva', async () => {
    // Frontera 1 del diseño: la emisión directa histórica no dejó fila de cola. Con un INNER JOIN
    // habría desaparecido justo la que nadie más va a mirar.
    const sql = await sqlDe();
    expect(sql).toMatch(/LEFT JOIN siigo_cola_facturacion c ON c\.lote_id = f\.lote_id/);

    kdb.execute.mockResolvedValue([casoEmision({ cola_id: null })]);
    const item = (await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA })).items[0]!;
    expect(item.facturaId).toBe(FACTURA);
  });
});

// ── AC5 y AC6 — el descarte se lee de la bitácora, y manda el ÚLTIMO hito ──

describe('AC5/AC6 — quién dio algo por perdido se lee de la bitácora WORM', () => {
  it('manda el ÚLTIMO hito, no la existencia de uno: resucitar lo devuelve a la bandeja', async () => {
    const sql = await sqlDe();
    // Con un `NOT EXISTS` a secas, un caso descartado y luego resucitado quedaría oculto para
    // siempre: la bitácora es WORM y el hito del descarte NO se puede borrar.
    expect(sql).toMatch(/ORDER BY o\.created_at DESC, o\.id DESC LIMIT 1/);
    expect(sql).not.toMatch(/NOT EXISTS \( SELECT 1 FROM siigo_operaciones/);
  });

  it('devuelve motivo, nota, quién y cuándo del descarte vigente', async () => {
    kdb.execute.mockResolvedValue([casoEmision({ descartado: true })]);
    kdb.when.select('siigo_operaciones', [{
      entidadId: COLA, operacion: 'marcada_fallido_definitivo', codigo: 'tramite_anulado',
      mensaje: 'El cliente canceló', createdAt: HACE_TRES_DIAS, createdBy: 42,
    }]);

    const item = (await consultarBandeja({ ambiente: 'pruebas', incluirDescartados: true, ahora: AHORA })).items[0]!;

    expect(item.descarte).toEqual({
      motivo: 'tramite_anulado',
      motivoEtiqueta: 'El trámite se anuló',
      nota: 'El cliente canceló',
      usuarioId: 42,
      marcadoEn: HACE_TRES_DIAS.toISOString(),
    });
  });

  it('`descartesVigentes` NO devuelve lo que ya se resucitó', async () => {
    // El hito de descarte sigue en la tabla —el AC6 pide justamente que se conserve— pero la marca
    // vigente es el `factura_encolar` posterior.
    kdb.when.select('siigo_operaciones', [
      { entidadId: COLA, operacion: 'factura_encolar', codigo: 'reactivado', mensaje: null, createdAt: AHORA, createdBy: 1 },
      { entidadId: COLA, operacion: 'marcada_fallido_definitivo', codigo: 'tramite_anulado', mensaje: null, createdAt: HACE_TRES_DIAS, createdBy: 42 },
    ]);
    expect(await descartesVigentes('siigo_cola', [COLA])).toEqual(new Map());
  });

  it('sí lo devuelve cuando el último hito es el descarte', async () => {
    kdb.when.select('siigo_operaciones', [
      { entidadId: COLA, operacion: 'marcada_fallido_definitivo', codigo: 'tramite_anulado', mensaje: null, createdAt: AHORA, createdBy: 42 },
      { entidadId: COLA, operacion: 'factura_encolar', codigo: 'encolado', mensaje: null, createdAt: HACE_TRES_DIAS, createdBy: 1 },
    ]);
    const vigentes = await descartesVigentes('siigo_cola', [COLA]);
    expect(vigentes.get(COLA)?.motivo).toBe('tramite_anulado');
  });

  it('sin identificadores no pregunta nada', async () => {
    kdb.select.mockClear();
    expect(await descartesVigentes('factura_envio', [])).toEqual(new Map());
    expect(kdb.select).not.toHaveBeenCalled();
  });
});

// ── El resumen ─────────────────────────────────────────────────────────────

describe('AC1 — el resumen cuenta sobre el MISMO conjunto que ve la tabla', () => {
  beforeEach(() => {
    kdb.execute.mockResolvedValue([
      { fuente: 'emision', codigo: 'invalid_dian_resolution', total: 4 },
      { fuente: 'correo', codigo: 'cliente_sin_correo', total: 3 },
      { fuente: 'dian', codigo: 'dian_rechazada', total: 2 },
    ]);
  });

  it('agrupa en la base y sobre la misma unión, no en memoria sobre la página', async () => {
    await resumenBandeja({ ambiente: 'pruebas', ahora: AHORA });
    const sql = textoSql(kdb.execute.mock.calls[0]![0]);
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(sql).toMatch(/GROUP BY fuente/);
    // Sin paginación PROPIA: el resumen cuenta la bandeja entera. (Los `LIMIT 1` que sí hay son los
    // de los LATERAL —«la última fila de esta factura»— y esos no paginan nada.)
    expect(sql).not.toMatch(/OFFSET/);
    expect(sql.split('FROM casos')[1]).not.toMatch(/LIMIT/);
  });

  it('los contadores cuadran con el total y ninguna fuente desaparece por no tener casos', async () => {
    kdb.execute.mockResolvedValue([{ fuente: 'emision', codigo: 'error_interno', total: 5 }]);
    const r = await resumenBandeja({ ambiente: 'pruebas', ahora: AHORA });

    expect(r.total).toBe(5);
    // Un contador que desaparece se lee como «no aplica», que no es lo mismo que «ninguno».
    expect(r.porFuente).toEqual({ emision: 5, dian: 0, correo: 0 });
  });

  it('reparte por responsable usando el catálogo real: es la pregunta «¿esto es mío?»', async () => {
    const r = await resumenBandeja({ ambiente: 'pruebas', ahora: AHORA });

    // `invalid_dian_resolution` y `dian_rechazada` los resuelve contabilidad; `cliente_sin_correo`,
    // quien opera. El reparto sale del catálogo, no de una tabla paralela de esta bandeja.
    expect(r.porResponsable.contabilidad).toBe(6);
    expect(r.porResponsable.operacion).toBe(3);
    expect(r.total).toBe(9);
  });

  it('el desglose por motivo va del más frecuente al menos y dice si se reintenta', async () => {
    const r = await resumenBandeja({ ambiente: 'pruebas', ahora: AHORA });
    expect(r.porCodigo.map((x) => x.codigo)).toEqual([
      'invalid_dian_resolution', 'cliente_sin_correo', 'dian_rechazada',
    ]);
    expect(r.porCodigo.every((x) => x.reintentable === false)).toBe(true);
  });
});

// ── La guía de un código persistido ────────────────────────────────────────

describe('guiaDelCaso usa el MISMO predicado que el trabajador', () => {
  it('un error de un dato nuestro ni vuelve solo ni sirve reintentarlo', async () => {
    const { esReintentable } = await import('../../src/modules/siigo/siigo.errors.js');
    const guia = guiaDelCaso('invalid_dian_resolution');
    expect(guia.sirveReintentar).toBe(false);
    // El MISMO predicado que `planificarDesenlace`: si discreparan, la bandeja ofrecería reintentar
    // justo lo que el trabajador ya decidió que no se arregla reintentando.
    expect(guia.reintentable).toBe(esReintentable('invalid_dian_resolution', 400));
  });

  it('un fallo transitorio vuelve solo, y eso implica que no hay nadie a quien mandar', () => {
    const guia = guiaDelCaso('service_unavailable');
    expect(guia.reintentable).toBe(true);
    expect(guia.sirveReintentar).toBe(true);
    // La equivalencia que ancla el catálogo: si se reintenta sin ayuda, el responsable es nadie.
    expect(guia.responsable).toBe('automatico');
    expect(guia.texto).toContain('no hace falta intervenir');
  });

  it('lo que NO vuelve solo pero se desatasca pulsando lleva su propia frase', () => {
    // **Las dos preguntas no son la misma, y confundirlas hacía mentir a la bandeja.** La
    // reconciliación ya comprobó que Siigo no tiene esta factura: nadie la reintenta por su cuenta
    // —así que `reintentable` es `false`, y debe serlo, porque su responsable no es `automatico`—
    // pero volver a emitirla es lo correcto y es seguro. Con un solo campo, el AC3 habría
    // descartado justo el caso más claro de todos.
    const guia = guiaDelCaso('reconciliada_inexistente');
    expect(guia.reintentable).toBe(false);
    expect(guia.reintentoManual).toBe(true);
    expect(guia.sirveReintentar).toBe(true);
    expect(guia.texto).toContain('No vuelve solo');
    expect(guia.texto).not.toContain('Reintentar no lo arregla');
  });

  it('sin código cae a «no hubo desenlace», que es lo que de verdad pasó', () => {
    const guia = guiaDelCaso(null);
    expect(guia.codigo).toBe('sin_desenlace');
    // Sirve reintentarlo: nadie ha dicho que esto no se pueda emitir. Pero NO vuelve solo y NO es
    // `automatico`, porque este código cubre también la fila huérfana —una emisión que puede
    // existir en Siigo— y ahí hay que comprobar antes de volver a pulsar.
    expect(guia.sirveReintentar).toBe(true);
    expect(guia.reintentable).toBe(false);
    expect(guia.conocido).toBe(true);
  });

  it('`sin_codigo` NO está en el catálogo: silenciarlo apagaría una alarma real', () => {
    // Un error de Siigo sin `Code` es tan opaco como uno desconocido, y la HU #11339 dejó una
    // prueba que exige que se registre en `codigosSinCatalogar()`. Catalogarlo «para que la bandeja
    // se vea mejor» habría apagado el aviso de que hay que mirar qué está devolviendo Siigo.
    expect(guiaDelCaso('sin_codigo').conocido).toBe(false);
  });

  it('los códigos que escribe FLITO están traducidos: la bandeja no dice «no lo traduzco»', async () => {
    // Sin estas entradas, la mayoría de los casos de cada día se pintaban con el mensaje genérico
    // que toda la HU #11339 existe para no dar — y ensuciaban `codigosSinCatalogar()`, que es la
    // alarma de que falta un código DE SIIGO.
    const { codigosSinCatalogar, olvidarCodigosSinCatalogar } =
      await import('../../src/modules/siigo/siigo.errors.js');
    olvidarCodigosSinCatalogar();

    for (const c of [
      'no_elegible', 'error_interno', 'emision_en_curso', 'sin_desenlace', 'siigo_no_responde',
      'sin_factura_local', 'emision_sin_mapeo', 'emision_sin_configuracion', 'emision_datos',
      'emision_sin_tramites', 'cliente_sin_correo', 'factura_no_emitida', 'siigo_rechazo',
      'emision_sin_correo', 'destinatario_invalido', 'demasiados_destinatarios', 'dian_rechazada',
      'reconciliada_inexistente', 'resuelta_a_mano',
    ]) {
      expect(guiaDelCaso(c).conocido, `${c} debería estar en el catálogo`).toBe(true);
    }
    expect(codigosSinCatalogar()).toEqual([]);
  });
});

/** El SQL de una consulta sin filtros: lo que se afirma es la forma, no los valores. */
async function sqlDe(): Promise<string> {
  kdb.execute.mockClear();
  await consultarBandeja({ ambiente: 'pruebas', ahora: AHORA });
  return textoSql(kdb.execute.mock.calls[0]![0]);
}
