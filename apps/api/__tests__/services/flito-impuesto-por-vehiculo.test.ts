// FLITO — el impuesto es del VEHÍCULO y del año gravable, no del trámite.
//
// El SOAT nunca tuvo este agujero porque `flito_soat.vin` es UNIQUE. El impuesto sí: hay una fila
// por trámite, así que anular un trámite y crear otro para el mismo vehículo generaba un impuesto
// `pendiente` —solicitable y pagable— aunque el del año ya estuviera pagado. Un segundo desembolso
// real de dinero. Estos tests son el corazón del arreglo: fijan CUÁNDO se bloquea y, sobre todo,
// cuándo NO, porque un falso positivo deja un vehículo sin poder tramitar su impuesto en silencio.
//
// La otra mitad de la regla es a quién NO se mira: un `solicitado` que quedó colgando en un trámite
// anulado no puede bloquear al vehículo para siempre, pero un `pagado` sí sigue bloqueando aunque su
// trámite esté muerto, porque el dinero salió igual.
//
// Sin BD: `impuestoBloqueantePorVehiculo` recibe el ejecutor por parámetro, así que se le pasa un
// doble que devuelve las filas del caso. Lo que el doble NO puede reproducir es la consulta (el
// helper `chain()` descarta los argumentos de `where()` y las filas se las inventa el test), y ahí
// se juega media regla —el filtro de estados, el join por vehículo y la columna del estado del
// trámite—, así que esa parte se verifica compilando la condición con el dialecto de drizzle e
// inspeccionando la proyección, en vez de darla por supuesta.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { chain } from '../helpers/db.js';

// El módulo importa `db/client` solo para tipar el ejecutor; nada de esto abre un pool.
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const {
  ESTADOS_IMPUESTO_BLOQUEAN_POR_VEHICULO, anioGravableEnCurso, impuestoBloqueantePorVehiculo,
} = await import('../../src/modules/flito-impuestos/impuesto-por-vehiculo.js');

const VEHICULO = 42;
const TRAMITE_ACTUAL = 'aaaa0000-0000-0000-0000-00000000000a';
const OTRO_TRAMITE = 'bbbb0000-0000-0000-0000-00000000000b';

/** Fila tal como la devuelve el SELECT con join a `flito_tramites`. El trámite, vivo por defecto. */
function filaImpuesto(over: Record<string, unknown> = {}) {
  return {
    id: 'imp-1', tramiteId: OTRO_TRAMITE, estado: 'pagado',
    extraccion: null as unknown, pagadoEn: null as Date | null,
    estadoTramite: 'asignado' as string | null, ...over,
  };
}

/** Campo del OCR: siempre viaja con su confianza, nunca como valor pelado. */
const anioGravable = (valor: unknown) => ({ anioGravable: { valor, confianza: 0.99, confiable: true } });

/** Ejecutor de mentira: captura proyección y WHERE, y devuelve las filas del caso. */
function ejecutorCon(filas: unknown[]) {
  const wheres: unknown[] = [];
  const proyecciones: Record<string, unknown>[] = [];
  const tx = {
    select: (proyeccion: Record<string, unknown>) => {
      proyecciones.push(proyeccion);
      const c = chain(filas) as unknown as Record<string, unknown>;
      c.where = (cond: unknown) => { wheres.push(cond); return c; };
      return c;
    },
  };
  return { tx: tx as never, wheres, proyecciones };
}

afterEach(() => { vi.useRealTimers(); });

describe('anioGravableEnCurso — el huso no es un detalle', () => {
  it('el 31 de diciembre a las 9 p.m. en Bogotá todavía es el año viejo', () => {
    // En UTC ya es 1 de enero. Tomar el año del servidor haría que el impuesto de diciembre
    // se comparara contra el año siguiente y dejara de bloquear justo la noche de fin de año.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T02:00:00Z'));
    expect(anioGravableEnCurso()).toBe(2026);
  });

  it('a media mañana del 1 de enero ya es el año nuevo', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T15:00:00Z'));
    expect(anioGravableEnCurso()).toBe(2027);
  });
});

describe('ESTADOS_IMPUESTO_BLOQUEAN_POR_VEHICULO — qué cuenta como «ya salió plata»', () => {
  it('bloquean solicitado y pagado; pendiente y con_novedad no', () => {
    // `pendiente` y `con_novedad` todavía no han movido dinero: el trámite nuevo es justamente el
    // que debe llevarlos adelante, y bloquearlos dejaría el impuesto huérfano en un trámite muerto.
    expect([...ESTADOS_IMPUESTO_BLOQUEAN_POR_VEHICULO]).toEqual(['solicitado', 'pagado']);
  });
});

describe('impuestoBloqueantePorVehiculo — la consulta, que el doble no puede reproducir', () => {
  it('filtra por el vehículo del trámite y solo por los estados que bloquean', async () => {
    // La exclusión de `pendiente`/`con_novedad` vive en el SQL, no en el bucle: si alguien quitara
    // el `inArray` el bucle las aceptaría alegremente y volveríamos a bloquear de más.
    const { tx, wheres } = ejecutorCon([]);
    await impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026);

    const { sql, params } = new PgDialect().sqlToQuery(wheres[0] as never);
    expect(sql).toContain('"flito_tramites"."vehiculo_id"');
    expect(sql).toContain('"flito_impuestos"."estado"');
    expect(params).toEqual([VEHICULO, 'solicitado', 'pagado']);
  });

  it('trae el estado del trámite, del que depende saltar los muertos', async () => {
    // Los tests de abajo fabrican las filas, así que no notarían que la columna dejó de pedirse:
    // `estadoTramite` llegaría `undefined`, ninguna fila se consideraría muerta y volveríamos al
    // bloqueo permanente sin que fallara nada. Por eso la proyección se comprueba aquí.
    const { tx, proyecciones } = ejecutorCon([]);
    await impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026);

    const columna = proyecciones[0].estadoTramite as { name: string; table: unknown };
    expect(getTableName(columna.table as never)).toBe('flito_tramites');
    expect(columna.name).toBe('estado');
  });

  it('el corte por trámite muerto NO está en el WHERE, y tiene que ser así', async () => {
    // Filtrar los terminados en SQL se llevaría por delante el `pagado` de un trámite anulado, que
    // es justo el que debe seguir bloqueando. Por eso la decisión se toma fila a fila.
    const { tx, wheres } = ejecutorCon([]);
    await impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026);

    const { params } = new PgDialect().sqlToQuery(wheres[0] as never);
    expect(params).not.toContain('anulado');
    expect(params).not.toContain('rechazado');
  });
});

describe('impuestoBloqueantePorVehiculo — año gravable del recibo', () => {
  it('pagado con año gravable igual al consultado → bloquea', async () => {
    const { tx } = ejecutorCon([filaImpuesto({ extraccion: anioGravable('2026') })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ id: 'imp-1', tramiteId: OTRO_TRAMITE, estado: 'pagado', anio: 2026 });
  });

  it('pagado de 2025 no bloquea el impuesto de 2026: es otro año gravable', async () => {
    // El impuesto se paga todos los años. Si el año pagado bastara para bloquear, el vehículo
    // nunca volvería a tramitar su impuesto.
    const { tx } = ejecutorCon([filaImpuesto({ extraccion: anioGravable('2025') })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('el año gravable también se reconoce si el OCR lo dejó como número', async () => {
    // `extraccion` es jsonb: nada garantiza que el valor llegue como texto, y un `2026` numérico
    // que no se reconociera dejaría pasar el impuesto duplicado.
    const { tx } = ejecutorCon([filaImpuesto({ extraccion: anioGravable(2026) })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ anio: 2026 });
  });

  it('un año gravable con basura cae al respaldo en vez de creerse el dato', async () => {
    // El OCR puede leer "26" o "N/A". Ninguno de los dos es un año: se usa la fecha de pago.
    const { tx } = ejecutorCon([filaImpuesto({
      extraccion: anioGravable('N/A'), pagadoEn: new Date('2026-03-05T15:00:00Z'),
    })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ anio: 2026 });
  });

  it('un número que no es un año tampoco pasa: cae al mismo respaldo que el texto', async () => {
    // `extraccion` es jsonb y el listón debe ser el mismo llegue como texto o como número. Un `1`
    // aceptado por ser "entero" sería un año inventado que decide si se bloquea o no.
    for (const bruto of [1, 202600, 99, 20260]) {
      const { tx } = ejecutorCon([filaImpuesto({
        extraccion: anioGravable(bruto), pagadoEn: new Date('2026-03-05T15:00:00Z'),
      })]);
      await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
        .resolves.toMatchObject({ anio: 2026 }); // 2026 viene de `pagadoEn`, no del número
    }
  });

  it('un número que no es un año y sin fecha de pago deja el impuesto sin año → no bloquea', async () => {
    // Sin respaldo al que caer, «no se sabe» es la respuesta honesta, y un pagado sin año no bloquea.
    const { tx } = ejecutorCon([filaImpuesto({ extraccion: anioGravable(202600) })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('un año gravable decimal no es un año', async () => {
    const { tx } = ejecutorCon([filaImpuesto({ extraccion: anioGravable(2026.5) })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });
});

describe('impuestoBloqueantePorVehiculo — cuando el año no viene en el recibo', () => {
  it('sin año gravable pero pagado dentro del año consultado → bloquea', async () => {
    // `anioGravable` es un campo OCR opcional; la fecha de conciliación es la mejor aproximación
    // que queda, porque el impuesto se paga dentro de su vigencia.
    const { tx } = ejecutorCon([filaImpuesto({ pagadoEn: new Date('2026-03-05T15:00:00Z') })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ estado: 'pagado', anio: 2026 });
  });

  it('pagado sin año gravable y sin fecha de pago → NO bloquea', async () => {
    // Ante la duda no se bloquea: un impuesto de más lo ve una persona y lo descarta; un vehículo
    // bloqueado por error no lo ve nadie hasta que el cliente reclama.
    const { tx } = ejecutorCon([filaImpuesto()]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('solicitado sin ningún dato de año → SÍ bloquea: está en vuelo ahora mismo', async () => {
    // Un solicitado no tiene fecha de pago todavía, por definición. Es el caso más peligroso —el
    // gestor ya lo tiene sobre la mesa— y tratarlo como «año desconocido» abriría el doble pago.
    const { tx } = ejecutorCon([filaImpuesto({ estado: 'solicitado' })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ estado: 'solicitado', anio: null });
  });

  it('solicitado sin año no bloquea un año distinto del que se está evaluando', async () => {
    // «Está en vuelo ahora» significa el año en curso, no cualquier año que se pregunte.
    const { tx } = ejecutorCon([filaImpuesto({ estado: 'solicitado', extraccion: anioGravable('2024') })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });
});

describe('impuestoBloqueantePorVehiculo — el impuesto colgado de un trámite muerto', () => {
  // Este es el escenario del bug original visto del revés: el trámite se anula y se crea otro para
  // el mismo vehículo. Si el `solicitado` que quedó en el trámite anulado bloqueara, el vehículo se
  // quedaría sin poder tramitar su impuesto para siempre —nadie va a ir a limpiar a mano un registro
  // de un trámite muerto— y el fallo sería mudo, que es lo peor que puede hacer esta regla.

  it('un solicitado colgando en un trámite ANULADO no bloquea', async () => {
    const { tx } = ejecutorCon([filaImpuesto({ estado: 'solicitado', estadoTramite: 'anulado' })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('un solicitado colgando en un trámite RECHAZADO tampoco bloquea', async () => {
    const { tx } = ejecutorCon([filaImpuesto({ estado: 'solicitado', estadoTramite: 'rechazado' })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('un PAGADO en un trámite anulado SÍ bloquea: anular el trámite no devuelve el dinero', async () => {
    // La asimetría es el corazón del corte. Anular no es un botón de reembolso: el impuesto del año
    // ya está pagado en la secretaría y volver a pagarlo es exactamente el bug que se está tapando.
    const { tx } = ejecutorCon([filaImpuesto({
      estado: 'pagado', estadoTramite: 'anulado', extraccion: anioGravable('2026'),
    })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ estado: 'pagado', anio: 2026 });
  });

  it('un pagado en trámite anulado sigue respetando el año: el de 2025 no bloquea 2026', async () => {
    const { tx } = ejecutorCon([filaImpuesto({
      estado: 'pagado', estadoTramite: 'anulado', extraccion: anioGravable('2025'),
    })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('un solicitado en un trámite vivo sigue bloqueando, esté como esté', async () => {
    // El corte es por estado TERMINAL, no por «cualquier estado que no sea asignado». Entregado y
    // aprobado son etapas normales de un trámite en curso y su impuesto está de verdad en vuelo.
    for (const estadoTramite of ['asignado', 'entregado', 'aprobado']) {
      const { tx } = ejecutorCon([filaImpuesto({ estado: 'solicitado', estadoTramite })]);
      await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
        .resolves.toMatchObject({ estado: 'solicitado' });
    }
  });

  it('un trámite sin estado FLITO mapeado no cuenta como muerto', async () => {
    // `flito_tramites.estado` es null cuando el estado crudo de FLIT no tiene equivalente interno
    // (Borrador, por ejemplo). Es un trámite que existe y avanza: tratarlo como terminal por no
    // saber qué es sería inventarse una muerte.
    const { tx } = ejecutorCon([filaImpuesto({ estado: 'solicitado', estadoTramite: null })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ estado: 'solicitado', anio: null });
  });

  it('el impuesto vivo de otro trámite no queda tapado por el del trámite anulado', async () => {
    // Saltar la fila muerta tiene que ser `continue`, no `return`: si cortara el recorrido, el
    // registro que sí bloquea se quedaría sin mirar por el orden en que PostgreSQL devolvió las filas.
    const { tx } = ejecutorCon([
      filaImpuesto({ id: 'imp-muerto', estado: 'solicitado', estadoTramite: 'anulado' }),
      filaImpuesto({ id: 'imp-vivo', estado: 'solicitado', estadoTramite: 'asignado' }),
    ]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ id: 'imp-vivo' });
  });
});

describe('impuestoBloqueantePorVehiculo — a quién se mira y a quién no', () => {
  it('el impuesto del propio trámite que se evalúa se ignora', async () => {
    // Si no, reevaluar un trámite se bloquearía a sí mismo y el impuesto nunca avanzaría.
    const { tx } = ejecutorCon([filaImpuesto({
      tramiteId: TRAMITE_ACTUAL, extraccion: anioGravable('2026'),
    })]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026, TRAMITE_ACTUAL))
      .resolves.toBeUndefined();
  });

  it('ignorar el propio trámite no tapa el de OTRO trámite del mismo vehículo', async () => {
    const { tx } = ejecutorCon([
      filaImpuesto({ id: 'imp-propio', tramiteId: TRAMITE_ACTUAL, extraccion: anioGravable('2026') }),
      filaImpuesto({ id: 'imp-ajeno', tramiteId: OTRO_TRAMITE, extraccion: anioGravable('2026') }),
    ]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026, TRAMITE_ACTUAL))
      .resolves.toMatchObject({ id: 'imp-ajeno', tramiteId: OTRO_TRAMITE });
  });

  it('un vehículo sin impuestos no bloquea nada', async () => {
    const { tx } = ejecutorCon([]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026)).resolves.toBeUndefined();
  });

  it('varias filas: se devuelve la primera que coincide con el año, no la primera que llega', async () => {
    // El SELECT no ordena; si el vehículo arrastra impuestos de años anteriores, quedarse con la
    // fila 0 haría que el bloqueo dependiera del orden del plan de PostgreSQL.
    const { tx } = ejecutorCon([
      filaImpuesto({ id: 'imp-2024', extraccion: anioGravable('2024') }),
      filaImpuesto({ id: 'imp-2026', extraccion: anioGravable('2026') }),
    ]);
    await expect(impuestoBloqueantePorVehiculo(tx, VEHICULO, 2026))
      .resolves.toMatchObject({ id: 'imp-2026' });
  });
});
