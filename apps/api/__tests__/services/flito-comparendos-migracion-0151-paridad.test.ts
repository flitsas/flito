// FLITO comparendos — paridad entre la lista blanca del SQL y la del runtime (TC #11523).
//
// La migración `0151_flito_comparendos_poda_pii.sql` poda los payloads YA ESCRITOS a la lista blanca
// del `field_map`, y para eso repite —hardcodeada, porque una migración no puede importar
// TypeScript— la lista de campos canónicos que el runtime tiene en `CAMPOS_CANONICOS`
// (`flito-comparendos-merge.ts`). Son dos copias del mismo hecho en dos lenguajes distintos y hasta
// ahora nada vigilaba que siguieran diciendo lo mismo.
//
// Qué pasa si divergen. La 0151 ya está APLICADA: no se reescribe, así que la divergencia no se
// corrige editándola sino con una migración nueva. El error cae del lado seguro —si el runtime gana
// un campo canónico, la 0151 podó de MENOS y dejó vivo un `source_path` que ya nadie lee; nunca de
// más— pero «de menos» en una poda de PII significa datos personales que se creían borrados y
// siguen en la base. Por eso esto es una red de seguridad y no la corrección de un fallo.
//
// ── Por qué la comparación es DIRECCIONAL desde la HU #11712 ────────────────────────────────────
//
// Hasta la v2 del mapa las dos listas eran idénticas y el test las comparaba como tales. La HU
// #11712 añade dos canónicos (`numeroResolucion`, `idResolucion`) y la 0151 no puede crecer con
// ellos: está aplicada. Comparar «idénticas» dejaría este archivo en rojo permanente, y la salida
// fácil —copiar su bloque de poda a la migración nueva— sería peor que el problema: la 0151 agrega
// por claves de PRIMER NIVEL (`jsonb_object_agg`) y es anterior a los `source_path` con punto, así
// que repetirla hoy BORRARÍA `estadoCuenta.secretaria.*` e `infracciones.0.*`, que la v2 persiste
// legítimamente. Destrucción de datos a cambio de cero ganancia de PII.
//
// Así que se conserva la dirección que protege de PII —**lo que está en el SQL tiene que seguir
// siendo canónico**— como fallo duro y sin excepción posible, y el excedente del runtime se declara
// campo a campo, con su porqué, en `CANONICOS_POSTERIORES_A_0151`. Un excedente no declarado sigue
// siendo un fallo.
//
// El test lee el `.sql` de disco a propósito. Copiar la lista aquí crearía una TERCERA copia y el
// problema volvería una casilla más allá.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `flito-comparendos-merge.ts` importa el cliente de base al cargarse. Aquí no se consulta nada —solo
// se lee una constante—, así que se corta el pool en el import en vez de abrirlo para nada.
vi.mock('../../src/db/client.js', () => ({
  db: {},
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { CAMPOS_CANONICOS } = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

const RUTA_MIGRACION = fileURLToPath(
  new URL('../../src/db/migrations/0151_flito_comparendos_poda_pii.sql', import.meta.url),
);

/**
 * Los campos del `WHERE target_field IN (...)` de la migración.
 *
 * Se quitan antes los comentarios de línea porque la cabecera de la 0151 habla de `target_field` en
 * prosa; sin eso, un comentario podría alimentar la comparación. Y se exige UNA sola lista: si
 * mañana aparecen dos filtros por `target_field`, comparar solo el primero sería justamente el tipo
 * de vigilancia a medias que este test viene a evitar, así que se prefiere fallar y que alguien mire.
 */
function camposDelSql(sql: string): string[] {
  const sinComentarios = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const listas = [...sinComentarios.matchAll(/target_field\s+IN\s*\(([^)]*)\)/gi)];

  expect(
    listas.length,
    'se esperaba exactamente un `target_field IN (...)` en la 0151; si la migración cambió de forma, '
    + 'este extractor hay que actualizarlo (no la migración, que ya está aplicada)',
  ).toBe(1);

  return [...listas[0][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Los canónicos que NACIERON DESPUÉS de la 0151 y que por tanto no pueden estar en su lista.
 *
 * No es una excepción para poner el test verde: es el hecho que el test tiene que conocer para
 * seguir vigilando algo. La 0151 está APLICADA y no se reescribe, así que cada canónico nuevo la
 * deja «podando de menos» por definición, y comparar las dos listas como IDÉNTICAS convertiría este
 * archivo en un impuesto que se paga borrando aserciones.
 *
 * Lo que sí se conserva entero es la dirección con riesgo de PII —`sqlCampos ⊆ CAMPOS_CANONICOS`,
 * ver abajo—, y lo que cada entrada de aquí tiene que responder es: **¿qué quedó sin podar del
 * histórico, y por qué se puede vivir con ello?**
 *
 *   · `numeroResolucion` / `idResolucion` (HU #11712, migración 0160). La poda de la 0151 no los
 *     conocía, así que en los payloads ya escritos no hay ninguna ruta suya viva **que la 0151
 *     hubiera tenido que borrar**: al revés, esos `source_path` NO estaban en ninguna versión del
 *     mapa anterior a la v3, de modo que la 0151 ya los borró como borra todo lo que el mapa no
 *     nombra. El desajuste es solo de listas, no de datos.
 *
 *   · `fechaNotificacion` (HU #11794, migración 0164). Mismo caso y con una vuelta de tuerca que
 *     conviene leer, porque es lo que hace imposible el backfill de esa HU: `fechaNotificacion` SÍ
 *     venía en los payloads crudos del proveedor —la 0158 la nombra explícitamente al explicar por
 *     qué NO la mapeaba—, y precisamente por no estar en ninguna versión del mapa anterior a la v4,
 *     la poda la BORRÓ de todo lo ya escrito, aquí y en cada corrida posterior (RN-25). Así que la
 *     0151 no podó de menos: podó de más, en el sentido bueno. El precio es que el dato histórico no
 *     está en ninguna parte de donde reconstruirlo, y por eso la 0164 no lleva `UPDATE` y las filas
 *     viejas se quedan en `null` hasta que un sync las vuelva a visitar.
 *
 * Y NO se resuelve copiando el bloque de la 0151 a una migración nueva que vuelva a podar: la 0151
 * agrega por claves de PRIMER NIVEL (`jsonb_object_agg`) y es anterior a los `source_path` con
 * punto, así que repetirla hoy BORRARÍA `estadoCuenta.secretaria.*` e `infracciones.0.*`, que la v2
 * persiste legítimamente. Sería destrucción de datos a cambio de cero ganancia de PII.
 */
const CANONICOS_POSTERIORES_A_0151 = ['numeroResolucion', 'idResolucion', 'fechaNotificacion'] as const;

/**
 * Las divergencias entre las dos listas, ya clasificadas por dirección.
 *
 * Está extraída como función pura —y no escrita dentro del `it`— para poder dispararla contra
 * listas de mentira y demostrar que la dirección peligrosa sigue fallando (ver el último bloque).
 * Un guardarraíl que solo se ejecuta sobre datos que ya están bien no demuestra que mire.
 */
export function divergencias(sqlCampos: string[], runtimeCampos: string[]): string[] {
  const enSql = new Set(sqlCampos);
  const enRuntime = new Set(runtimeCampos);
  const posteriores = new Set<string>(CANONICOS_POSTERIORES_A_0151);

  // Un array de frases y no dos `toEqual` de sets: lo que un fallo tiene que decir es QUÉ campo y
  // en CUÁL de los dos lados, no «esperaba Set(8) y recibí Set(9)».
  return [
    // Dirección TOLERADA, y solo para lo declarado arriba: el runtime homologa un campo que la
    // 0151 no podó. Un canónico nuevo que NO esté declarado sigue siendo fallo: obliga a escribir
    // por qué se puede vivir con él antes de añadirlo.
    ...runtimeCampos.filter((c) => !enSql.has(c) && !posteriores.has(c)).map((c) => (
      `'${c}': está en CAMPOS_CANONICOS (runtime, flito-comparendos-merge.ts), FALTA en la lista `
      + 'del SQL (0151_flito_comparendos_poda_pii.sql) y NO está declarado en '
      + 'CANONICOS_POSTERIORES_A_0151 → o es un canónico nuevo (declararlo ahí, con el porqué), o '
      + 'la poda histórica lo ignora y sus source_path siguen vivos en los payloads ya escritos'
    )),
    // Dirección PELIGROSA, fallo duro y sin excepciones posibles: la 0151 conserva un campo que el
    // runtime ya no homologa. Eso es exactamente «datos que sobrevivieron a la poda y que nadie
    // vuelve a mirar», que es el escenario de PII de RN-25.
    ...sqlCampos.filter((c) => !enRuntime.has(c)).map((c) => (
      `'${c}': está en la lista del SQL (0151_flito_comparendos_poda_pii.sql) y SOBRA respecto de `
      + 'CAMPOS_CANONICOS (runtime, flito-comparendos-merge.ts) → el runtime ya no lo homologa; '
      + 'quitarlo del runtime sin más deja la 0151 podando por un campo muerto'
    )),
  ];
}

describe('migración 0151 — la lista blanca del SQL y CAMPOS_CANONICOS no pueden divergir (TC #11523)', () => {
  const sqlCampos = camposDelSql(readFileSync(RUTA_MIGRACION, 'utf8'));
  const runtimeCampos = [...CAMPOS_CANONICOS] as string[];

  it('extrae una lista no vacía del .sql (si esto falla, el resto del test no vigila nada)', () => {
    expect(sqlCampos.length).toBeGreaterThan(0);
    expect(new Set(sqlCampos).size).toBe(sqlCampos.length); // sin duplicados
  });

  it('**la 0151 no conserva ni un campo que el runtime ya no homologue** (dirección con PII)', () => {
    expect(divergencias(sqlCampos, runtimeCampos)).toEqual([]);
  });

  it('**cada canónico posterior a la 0151 está declarado, y sigue siendo canónico**', () => {
    // La lista de excepciones no puede envejecer en silencio: si alguien borra `idResolucion` del
    // runtime, esta entrada se queda tapando una divergencia que ya no existe.
    for (const campo of CANONICOS_POSTERIORES_A_0151) {
      expect(runtimeCampos, `\`${campo}\` ya no es canónico: sobra en CANONICOS_POSTERIORES_A_0151`)
        .toContain(campo);
      expect(sqlCampos, `\`${campo}\` SÍ está en la 0151: no es posterior a ella`).not.toContain(campo);
    }
  });
});

// ─────────────────────── El guardarraíl, disparado contra listas de mentira ─────────────────────
//
// La comparación de arriba corre sobre datos que hoy están bien, así que por sí sola no distingue
// «vigila y no encuentra nada» de «dejó de vigilar». Estas son las mutaciones, con la respuesta que
// tienen que provocar.

describe('la dirección peligrosa sigue en rojo (mutación del propio guardarraíl)', () => {
  it('un campo en el SQL que el runtime ya no homologa FALLA, y ninguna excepción lo salva', () => {
    const errores = divergencias(['placa', 'nombreInfractor'], ['placa']);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('nombreInfractor');
    expect(errores[0]).toContain('SOBRA');
  });

  it('ni siquiera si alguien lo mete en la lista de posteriores: esa lista no cubre esta dirección', () => {
    // `numeroResolucion` está declarado como posterior a la 0151. Si APARECIERA en el SQL sin estar
    // en el runtime, seguiría siendo un fallo: la excepción es unidireccional.
    const errores = divergencias(['placa', 'numeroResolucion'], ['placa']);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('numeroResolucion');
  });

  it('un canónico nuevo SIN declarar también falla: la excepción hay que escribirla, no se supone', () => {
    const errores = divergencias(['placa'], ['placa', 'campoInventado']);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('campoInventado');
    expect(errores[0]).toContain('CANONICOS_POSTERIORES_A_0151');
  });

  it('y el caso declarado NO falla: es la única puerta que se abre', () => {
    expect(divergencias(['placa'], ['placa', 'numeroResolucion', 'idResolucion'])).toEqual([]);
  });
});
