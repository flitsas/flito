// FLITO comparendos — poda del payload crudo a lista blanca (HU #11511, AC1).
//
// El hallazgo que origina esta HU: `payload_simit` / `payload_municipal` guardaban la respuesta
// ÍNTEGRA del proveedor, y en SIMIT eso arrastra normalmente el NOMBRE y el DOCUMENTO del infractor
// —una persona natural que no es la empresa monitoreada—. Decisión humana del 2026-08-13: podar a
// lista blanca en vez de cifrar, porque lo que no se guarda no hay que cifrarlo, ni purgarlo, ni
// auditar quién lo leyó.
//
// Lo que se demuestra, por orden de importancia:
//
//   1. **Los campos de persona NO sobreviven.** Es el AC entero: si esto se rompe, todo lo demás de
//      la HU (purga, registro de acceso) protege un dato que no debería existir.
//   2. **Los campos de la lista blanca SÍ sobreviven**, o la red de ADR-0003 se pierde entera y el
//      spike #11501 se queda sin materia prima.
//   3. **La lista sale del `field_map`**: añadir un `source_path` amplía la lista sin tocar código
//      ni migrar. Es lo que impide que haya dos fuentes de verdad desincronizadas.
//   4. **Un `__proto__` en el mapa o en el ítem no contamina nada** (RN-14): la lista blanca la
//      decide una columna de texto de la base. Y no solo no contamina: no se persiste, para que
//      tampoco contamine al consumidor futuro que rehidrate la fila.
//   5. **Solo se persisten ESCALARES.** La lista blanca filtra por clave; sin un filtro por forma,
//      un `source_path` permitido cuyo valor sea un subárbol devolvía la PII por una clave
//      autorizada.
//   6. **Una lista blanca VACÍA no vacía nada** (bloqueante del gate): significa que el mapa vigente
//      no describe ese origen, no que sus datos sobren.
//
// Va aparte de `flito-comparendos-merge.test.ts` porque la poda es una regla de protección de datos
// y no de homologación: tiene que fallar en un archivo que se lea como tal.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const {
  acumularMunicipal,
  acumularSimit,
  camposConservables,
  cargarMapaHomologacion,
  candidatosDe,
  podarPayload,
} = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

type FilaMapa = {
  version: number; origen: string; sourcePath: string; targetField: string;
  prioridad: number; provisional: boolean;
};

const fila = (
  origen: string, sourcePath: string, targetField: string, prioridad = 1, version = 1,
): FilaMapa => ({ version, origen, sourcePath, targetField, prioridad, provisional: true });

/** Recorte del mapa v1 que siembra la 0150. */
const MAPA_V1: FilaMapa[] = [
  fila('simit', 'numeroComparendo', 'numeroComparendo'),
  fila('simit', 'placa', 'placa'),
  fila('simit', 'codigoInfraccion', 'codigoInfraccion'),
  fila('simit', 'fechaComparendo', 'fechaComparendo'),
  fila('simit', 'secretariaNombre', 'organismo'),
  fila('simit', 'valorAPagar', 'monto'),
  fila('simit', 'estado', 'estadoFuente'),
  fila('simit', 'comparendo', 'numeroComparendo', 2),
  fila('municipal', 'numero', 'numeroComparendo'),
  fila('municipal', 'placa', 'placa'),
  fila('municipal', 'descripcion', 'descripcionInfraccion'),
  fila('municipal', 'valor', 'monto'),
];

/**
 * Lo que devuelve Verifik de verdad: el comparendo **y** quién lo tiene encima.
 *
 * `nombreInfractor`, `documentoInfractor`, `tipoDocumento`, `direccionNotificacion` y
 * `correoInfractor` son datos personales de un TERCERO que el canónico no mapea y que, hasta esta
 * HU, se guardaban tal cual en el JSONB.
 */
const ITEM_SIMIT_CRUDO = {
  numeroComparendo: 'C-0001',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  fechaComparendo: '2026-05-14',
  secretariaNombre: 'Secretaría de Medellín',
  valorAPagar: '604100',
  estado: 'Pendiente de pago',
  nombreInfractor: 'JUAN CARLOS PEREZ GOMEZ',
  documentoInfractor: '1036640908',
  tipoDocumento: 'CC',
  direccionNotificacion: 'CRA 43 # 12-34 APTO 501',
  correoInfractor: 'juan.perez@example.com',
  telefonoInfractor: '3003427829',
};

const CAMPOS_DE_PERSONA = [
  'nombreInfractor', 'documentoInfractor', 'tipoDocumento',
  'direccionNotificacion', 'correoInfractor', 'telefonoInfractor',
];

const conMapa = (filas: FilaMapa[]) => kdb.when.select('flito_comparendos_field_map', filas);

beforeEach(() => { kdb.reset(); });

// ─────────────────────────── La lista blanca sale del field_map ─────────────────────────────────

describe('camposConservables — la lista blanca (AC1)', () => {
  it('son exactamente los `source_path` del mapa vigente, todos los candidatos incluidos', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();

    const permitidos = camposConservables(candidatosDe(mapa, 'simit'));

    // Incluye `comparendo`, que es candidato de prioridad 2 para el número: un campo que el mapa
    // sabe leer tiene que sobrevivir aunque hoy gane otro candidato, o al re-mergear con el mapa v2
    // faltaría justo el respaldo que la fila describe.
    expect([...permitidos].sort()).toEqual([
      'codigoInfraccion', 'comparendo', 'estado', 'fechaComparendo',
      'numeroComparendo', 'placa', 'secretariaNombre', 'valorAPagar',
    ]);
  });

  it('cada origen tiene la suya: el municipal no hereda los campos de SIMIT', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();

    const municipal = camposConservables(candidatosDe(mapa, 'municipal'));

    expect([...municipal].sort()).toEqual(['descripcion', 'numero', 'placa', 'valor']);
    // Si las listas se fundieran, un `secretariaNombre` del UTS se colaría en el payload municipal
    // sin que nadie lo haya decidido — y la lista dejaría de ser «lo que este origen sabe leer».
    expect(municipal.has('secretariaNombre')).toBe(false);
  });

  it('**añadir un `source_path` al mapa amplía la lista sin tocar una línea de código**', async () => {
    // El corolario del diseño (RN-25): la lista se DERIVA del `field_map`, así que ampliarla es
    // insertar una fila. Sin migración, sin despliegue y sin dos fuentes de verdad.
    conMapa([...MAPA_V1, fila('simit', 'fechaNotificacion', 'fechaComparendo', 3)]);
    const mapa = await cargarMapaHomologacion();

    const permitidos = camposConservables(candidatosDe(mapa, 'simit'));

    expect(permitidos.has('fechaNotificacion')).toBe(true);
    expect(podarPayload({ numeroComparendo: 'C-1', fechaNotificacion: '2026-06-01' }, permitidos))
      .toEqual({ numeroComparendo: 'C-1', fechaNotificacion: '2026-06-01' });
  });

  it('solo la versión VIGENTE manda: un campo que la v2 dejó de mapear ya no se conserva', async () => {
    conMapa([
      ...MAPA_V1,
      fila('simit', 'numeroComparendo', 'numeroComparendo', 1, 2),
      fila('simit', 'placa', 'placa', 1, 2),
    ]);
    const mapa = await cargarMapaHomologacion();

    const permitidos = camposConservables(candidatosDe(mapa, 'simit'));

    // La v2 no mapea `valorAPagar`, así que el payload deja de guardarlo: la lista blanca es la del
    // mapa que el merge USA, no la unión histórica de todos los mapas que existieron.
    expect(mapa.version).toBe(2);
    expect([...permitidos].sort()).toEqual(['numeroComparendo', 'placa']);
  });
});

// ─────────────────────────── La poda en sí ──────────────────────────────────────────────────────

describe('podarPayload — qué se persiste y qué no (AC1)', () => {
  it('**los campos de persona del infractor NO sobreviven a la poda**', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();

    const podado = podarPayload(ITEM_SIMIT_CRUDO, camposConservables(candidatosDe(mapa, 'simit')))!;

    for (const campo of CAMPOS_DE_PERSONA) {
      expect(Object.prototype.hasOwnProperty.call(podado, campo)).toBe(false);
    }
    // Y no queda ni rastro serializado: es lo que de verdad se escribe en el JSONB.
    const json = JSON.stringify(podado);
    expect(json).not.toContain('JUAN CARLOS');
    expect(json).not.toContain('1036640908');
    expect(json).not.toContain('juan.perez@example.com');
  });

  it('los campos de la lista blanca sí sobreviven, con su valor intacto', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();

    const podado = podarPayload(ITEM_SIMIT_CRUDO, camposConservables(candidatosDe(mapa, 'simit')));

    // Sin esto la red de ADR-0003 se pierde entera: el payload existe para poder re-mergear con un
    // mapa de versión mayor sin volver a llamar al proveedor.
    expect(podado).toEqual({
      numeroComparendo: 'C-0001',
      placa: 'ABC123',
      codigoInfraccion: 'C29',
      fechaComparendo: '2026-05-14',
      secretariaNombre: 'Secretaría de Medellín',
      valorAPagar: '604100',
      estado: 'Pendiente de pago',
    });
  });

  it('no inventa claves: un candidato del mapa que el proveedor no mandó no aparece con `null`', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();

    const podado = podarPayload({ numeroComparendo: 'C-9' }, camposConservables(candidatosDe(mapa, 'simit')))!;

    // Un `placa: undefined` en el objeto desaparecería al serializar el JSONB, pero un `placa: null`
    // sería mentir: diría que el proveedor lo mandó vacío cuando ni lo mandó.
    expect(Object.keys(podado)).toEqual(['numeroComparendo']);
  });

  it('**un valor que NO es escalar se descarta aunque su clave esté permitida**', async () => {
    // La lista blanca filtra por CLAVE; esto es el filtro por FORMA, y es la última grieta entre «la
    // lista blanca es lo que el merge sabe leer» y lo que de verdad se escribía: un `valorAPagar`
    // que llega como subárbol se persistía ENTERO —con el titular dentro— aunque `montoCanonico` no
    // sepa leer un objeto y devuelva `null`. Dato que ningún re-merge aprovecha y que sí se filtra.
    const permitidos = camposConservables(new Map([['monto', ['valorAPagar']]]) as never);

    const podado = podarPayload({
      valorAPagar: { total: 604100, titular: { nombre: 'JUAN CARLOS PEREZ', documento: '1036640908' } },
      otro: 1,
    }, permitidos);

    expect(podado).toEqual({});
    expect(JSON.stringify(podado)).not.toContain('1036640908');
  });

  it('un array bajo una clave permitida tampoco se persiste; los escalares sí', async () => {
    const permitidos = camposConservables(
      new Map([['monto', ['valorAPagar']], ['estadoFuente', ['estado', 'pagado', 'sinDato']]]) as never,
    );

    const podado = podarPayload({
      valorAPagar: [604100, 'COP'], estado: 'Pendiente de pago', pagado: false, sinDato: null,
    }, permitidos);

    // `boolean` y `null` se conservan: no llevan PII dentro y son formas legítimas de un campo del
    // proveedor. Lo que se cae es lo que TIENE estructura, que es donde cabe un dato de persona.
    expect(podado).toEqual({ estado: 'Pendiente de pago', pagado: false, sinDato: null });
  });

  it('un `__proto__` PROPIO en el ítem no contamina el objeto podado NI llega al JSONB (RN-14)', async () => {
    // Dos capas. `defineProperty` protege a ESTE módulo; descartar la clave protege al consumidor
    // futuro —el visor de 17b, un `GET /registros`— que rehidrate la fila con `Object.assign` o un
    // spread y sí monte el gadget. Un `__proto__` no es campo legítimo de un proveedor de tránsito
    // bajo ninguna versión del mapa, así que no hay nada que perder descartándolo.
    conMapa([...MAPA_V1, fila('simit', '__proto__', 'organismo', 9)]);
    const mapa = await cargarMapaHomologacion();
    const item = JSON.parse('{"numeroComparendo":"C-1","__proto__":{"contaminado":true}}');

    const podado = podarPayload(item, camposConservables(candidatosDe(mapa, 'simit')))!;

    expect(({} as Record<string, unknown>).contaminado).toBeUndefined();
    expect(Object.getPrototypeOf(podado)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(podado, '__proto__')).toBe(false);
    expect(JSON.stringify(podado)).not.toContain('__proto__');
  });

  it('`constructor` y `prototype` tampoco se persisten aunque el mapa los liste', async () => {
    const permitidos = camposConservables(
      new Map([['organismo', ['constructor', 'prototype', 'secretariaNombre']]]) as never,
    );

    const podado = podarPayload({
      constructor: 'x', prototype: 'y', secretariaNombre: 'Secretaría de Medellín',
    }, permitidos);

    expect(podado).toEqual({ secretariaNombre: 'Secretaría de Medellín' });
  });
});

// ─────────────────────────── Lista blanca VACÍA: no borrar, no tocar ────────────────────────────
//
// El bloqueante del gate de base de datos, en su mitad de runtime. La 0151 lo tenía en su forma
// evidente —una versión del mapa que solo cubre un origen dejaba el array del otro vacío y el `CASE`
// reescribía TODOS sus payloads a `{}`—, y el gate de seguridad lo bajó a Low porque «es coherente
// con el runtime». Esa coherencia ERA el problema: si el runtime también devuelve `{}` con lista
// vacía, entonces la misma v2 de un solo origen —justo lo que el spike #11501 va a sembrar— hace que
// la SIGUIENTE corrida del sync vacíe los payloads de ese origen, sin migración de por medio.

describe('podarPayload — la lista blanca vacía NO significa «bórralo todo» (bloqueante)', () => {
  it('**con lista vacía devuelve `null`, no `{}`**', () => {
    const podado = podarPayload({ numeroComparendo: 'C-1', valorAPagar: '604100' }, new Set());

    // `{}` significa «de este ítem no se conserva nada» y PISA el payload de la fila al hacer UPSERT.
    // `null` significa «no sé qué conservar de este origen» y el sync lo trata como «esta corrida no
    // trajo payload», así que lo ya escrito se queda. Ante la duda, no borrar.
    expect(podado).toBeNull();
  });

  it('una versión del mapa que solo cubre SIMIT no vacía el payload municipal', async () => {
    // La v2 del escenario: se sube el mapa con las filas verificadas de SIMIT y las municipales
    // todavía no. El origen sin mapa deja de tener lista blanca.
    conMapa([
      ...MAPA_V1,
      fila('simit', 'numeroComparendo', 'numeroComparendo', 1, 2),
      fila('simit', 'placa', 'placa', 1, 2),
    ]);
    const mapa = await cargarMapaHomologacion();

    const municipal = camposConservables(candidatosDe(mapa, 'municipal'));

    expect(municipal.size).toBe(0);
    expect(podarPayload({ numero: 'C-1', valor: '999' }, municipal)).toBeNull();
  });

  it('el consolidado deja el payload en `null` y no en `{}` (que es lo que el UPSERT respeta)', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();
    const acumulador = new Map();

    // Se acumula por SIMIT con su mapa, pero el payload se poda con una lista vacía: es el estado en
    // que quedaría el origen cuya versión vigente no lo describe.
    acumularSimit(acumulador, [ITEM_SIMIT_CRUDO], candidatosDe(mapa, 'simit'));
    const consolidado = acumulador.get('C-0001')!;
    consolidado.payloadSimit = podarPayload(ITEM_SIMIT_CRUDO, new Set());

    // El UPDATE del sync solo pisa el payload cuando NO es `null` ni `undefined`.
    expect(consolidado.payloadSimit).toBeNull();
  });
});

// ─────────────────────────── La poda ocurre al acumular, no al escribir ─────────────────────────

describe('acumular* — el payload entra YA podado al consolidado (AC1)', () => {
  it('SIMIT: lo que viaja al INSERT no lleva los campos de persona', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();
    const acumulador = new Map();

    acumularSimit(acumulador, [ITEM_SIMIT_CRUDO], candidatosDe(mapa, 'simit'));

    // Podar al escribir dejaría el ítem íntegro vivo en el acumulador durante toda la corrida, y
    // bastaría con que alguien logueara ese objeto para publicar los datos del infractor.
    const payload = acumulador.get('C-0001')!.payloadSimit as Record<string, unknown>;
    expect(payload.numeroComparendo).toBe('C-0001');
    for (const campo of CAMPOS_DE_PERSONA) {
      expect(Object.prototype.hasOwnProperty.call(payload, campo)).toBe(false);
    }
  });

  it('municipal: mismo tratamiento y con SU lista, sin heredar la de SIMIT', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();
    const acumulador = new Map();

    acumularMunicipal(acumulador, [{
      numero: 'C-0002', placa: 'XYZ789', descripcion: 'Estacionar en sitio prohibido',
      valor: '999', propietario: 'MARIA LOPEZ', cedulaPropietario: '43567890',
    }], candidatosDe(mapa, 'municipal'), 'BELLO');

    expect(acumulador.get('C-0002')!.payloadMunicipal).toEqual({
      numero: 'C-0002', placa: 'XYZ789', descripcion: 'Estacionar en sitio prohibido', valor: '999',
    });
  });

  it('la segunda vista del mismo comparendo también entra podada', async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();
    const acumulador = new Map();

    // Primero lo ve el municipio; luego SIMIT. La rama que rellena el hueco de una fuente que
    // faltaba es la que un refactor olvida podar.
    acumularMunicipal(acumulador, [{ numero: 'C-0001' }], candidatosDe(mapa, 'municipal'), 'BELLO');
    acumularSimit(acumulador, [ITEM_SIMIT_CRUDO], candidatosDe(mapa, 'simit'));

    const payload = acumulador.get('C-0001')!.payloadSimit as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, 'documentoInfractor')).toBe(false);
    expect(payload.valorAPagar).toBe('604100');
  });
});
