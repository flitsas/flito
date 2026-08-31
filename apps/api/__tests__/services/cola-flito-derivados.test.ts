// FLITO — lo que el Excel de las colas DERIVA, probado SIN generar un archivo (HU #11934).
//
// ── Por qué existe este archivo y no basta con las dos suites de export ──────────────────────────
//
// `__tests__/helpers/keyed-db.ts` **no evalúa la proyección**: `resolve(reg, name)` (línea 49)
// devuelve las filas que el escenario registró, tal cual, sin mirar qué columnas pidió el `select`.
// La consecuencia es exacta y hay que decirla: una expresión `sql\`… ->> 'clase'\`` **no se ejecuta
// nunca** en `flito-soat-export.test.ts` ni en `flito-impuestos-export.test.ts`, así que esas dos
// suites NO pueden demostrar que la extracción del jsonb funcione. Pueden demostrar que el valor
// llega a su celda —lo hacen—, pero el tramo «clave de FLIT → campo» es invisible para ellas: un
// mapeo cruzado (`Modelo ← modelo` en vez de `Modelo ← modeloAno`) las deja las dos en verde.
//
// El hueco se cierra por las dos puntas y las dos están aquí:
//
//   1. **Las funciones puras**, llamadas directamente con los valores MEDIDOS que llegan de verdad:
//      `" "`, `"  "`, la clave ausente, la fila sin `flit_raw`, el número JSON.
//   2. **El SQL RENDERIZADO** de las ocho expresiones, con `PgDialect().sqlToQuery()`: qué clave del
//      payload quedó ligada a qué campo. Es el único aserto del repo que ve el cruce.
//
// Lo que este archivo NO prueba: que las filas lleguen a la hoja, que el 422 salga a tiempo o que la
// cuota se comparta. Eso es de las suites de export, y aquí no se duplica.

import { describe, it, expect } from 'vitest';
import { flitoTramites } from '../../src/db/schema.js';
import { renderizar } from '../helpers/sql-ligado.js';
import {
  bloqueTitular, celdaDesdeJson, ciudadDeOrganismo, clavePar, CLASE_ID, CLASE_INTERLOCUTOR,
  CLAVES_FLIT_RAW, expresionesFlitRaw, parDeClave, TITULAR_VACIO,
} from '../../src/shared/export/cola-flito-derivados.js';

// ─────────────────────────── Las ocho expresiones `->>` ──────────────────────────────────────────

describe('las claves de `flit_raw`: qué clave alimenta qué campo', () => {
  const exprs = expresionesFlitRaw(flitoTramites.flitRaw);

  /** La clave del payload que quedó LIGADA a esta expresión, leída del SQL renderizado. */
  const claveDe = (campo: keyof typeof exprs): unknown => {
    const q = renderizar(exprs[campo]);
    // La forma tiene que ser la del operador de texto y con la clave como PARÁMETRO. Si alguien la
    // concatenara en el texto del SQL, `params` vendría vacío y este aserto lo diría.
    expect(q.sql, `${campo} no extrae de flit_raw con ->>`)
      .toContain('"flito_tramites"."flit_raw" ->> ');
    // DOS parámetros y no uno: la clave se liga dos veces —una en el `jsonb_typeof(… -> clave)` que
    // descarta lo no escalar y otra en el `->>` que extrae—. Que sean IGUALES es parte del contrato:
    // comprobar la forma de una clave y extraer otra sería un descarte que no descarta nada.
    expect(q.params, `${campo} tiene que ligar su clave como parámetro`).toHaveLength(2);
    expect(q.params[0], `${campo} comprueba y extrae claves distintas`).toBe(q.params[1]);
    return q.params[0];
  };

  it('**`Linea` sale de `modelo` y `Modelo` de `modeloAno`** — el par cruzado es el defecto obvio', () => {
    // El mutante nombrado de esta HU: intercambiar estas dos líneas en `CLAVES_FLIT_RAW`. Lo que FLIT
    // llama `modelo` es la LÍNEA comercial (`ONIX`, `STONIC`, `Y`), y todo el repo usa «modelo =
    // año», así que `Modelo ← modelo` es el mapeo que sale gratis: mete líneas comerciales en una
    // columna de años, el `.xlsx` se abre sin quejarse y **pasa cualquier aserto de cabeceras**.
    // Ningún otro test del repo ve este cruce.
    expect(claveDe('linea')).toBe('modelo');
    expect(claveDe('modelo')).toBe('modeloAno');
  });

  it('las otras seis van a su clave, y ninguna es `codigoSecretaria`', () => {
    expect(claveDe('marca')).toBe('marca');
    expect(claveDe('clase')).toBe('clase');
    expect(claveDe('capacidad')).toBe('capacidad');
    expect(claveDe('departamento')).toBe('departamentoTransito');
    expect(claveDe('nombres')).toBe('nombres');
    expect(claveDe('apellidos')).toBe('apellidos');

    // `codigoSecretaria` llega SIN el cero de relleno en 3 650 de 7 052 filas (`5001` frente a
    // `05001`), y el catálogo se indexa por la cadena de cinco. Leer la ciudad por ahí dejaría el
    // 51,8 % de las celdas vacías sin que nada fallara: no puede estar ligado a ninguna expresión.
    const todas = Object.keys(exprs).map((c) => claveDe(c as keyof typeof exprs));
    expect(todas).not.toContain('codigoSecretaria');
    expect(todas).toHaveLength(8);
  });

  it('`clase` YA está mapeada aunque FLIT todavía no la mande', () => {
    // Es el motivo por el que la decisión de diseño lee de `flit_raw` en vez de hacer crecer el sync:
    // `->>` sobre una clave ausente da NULL, y el día que FLIT empiece a mandarla la columna se llena
    // sola, sin migración y sin despliegue. Si alguien «limpiara» esta expresión por no tener datos,
    // esa propiedad se perdería en silencio.
    expect(CLAVES_FLIT_RAW.clase).toBe('clase');
    expect(claveDe('clase')).toBe('clase');
  });
});

// ─────────────────────────── El valor que sale de un jsonb ───────────────────────────────────────

describe('`celdaDesdeJson` — lo que puede llegar de un `jsonb` ajeno', () => {
  it('**un número no tumba el export**: `2021` se escribe `"2021"`', () => {
    // `modeloAno` es el campo que un proveedor manda como número JSON. El tipo `string | null` de la
    // expresión es una promesa de TypeScript que nadie comprueba en ejecución, así que un `.trim()`
    // sobre ese valor sería un TypeError DENTRO del `map` de las filas: **el export entero
    // respondería 500 por UNA fila** y las otras 1 999 legítimas se perderían con ella.
    expect(celdaDesdeJson(2021)).toBe('2021');
    expect(celdaDesdeJson(0)).toBe('0');
    expect(celdaDesdeJson(false)).toBe('false');
  });

  it('el espacio es ausencia, igual que en `celdaTexto` — no hay una segunda definición de vacío', () => {
    for (const blanco of ['', ' ', '  ', '\t', '\n']) expect(celdaDesdeJson(blanco)).toBeNull();
    expect(celdaDesdeJson('  ONIX  ')).toBe('ONIX');
  });

  it('la clave ausente y el null dan celda vacía', () => {
    expect(celdaDesdeJson(undefined)).toBeNull();
    expect(celdaDesdeJson(null)).toBeNull();
    expect(celdaDesdeJson(Number.NaN)).toBeNull();
  });

  it('**el blob serializado que `->>` produce DE VERDAD se descarta**, no un objeto JS', () => {
    // Corrección del gate de seguridad (Medium sobre `dcd57ea`). Este caso decía antes
    // `expect(celdaDesdeJson({ a: 1 })).toBeNull()` y certificaba en verde una garantía INEXISTENTE:
    // `celdaDesdeJson` no recibe nunca un objeto JS. Medido contra el Postgres 16 local:
    //
    //   select '{"n":{"a":1,"b":"ANA"}}'::jsonb ->> 'n';   →  {"a": 1, "b": "ANA"}  (pg_typeof = text)
    //   select '{"ap":["PEREZ","GOMEZ"]}'::jsonb ->> 'ap'; →  ["PEREZ", "GOMEZ"]
    //
    // `->>` YA serializa el objeto a texto, así que lo que llega aquí es una CADENA y la rama
    // `typeof valor === 'string'` se la tragaba entera hasta la celda. La forma correcta del caso es
    // la cadena que Postgres produce.
    expect(celdaDesdeJson('{"a": 1, "b": "ANA"}')).toBeNull();
    expect(celdaDesdeJson('["PEREZ", "GOMEZ"]')).toBeNull();
    expect(celdaDesdeJson('  {"a": 1}  ')).toBeNull();
  });

  it('la guarda es EXACTA: un texto que solo PARECE JSON se respeta', () => {
    // La guarda de JS es defensa en profundidad —el descarte de verdad ocurre en SQL— y por eso no
    // puede ser una heurística de «empieza por llave»: borraría datos legítimos en silencio, que es
    // el mismo pecado que viene a corregir. Solo descarta lo que REALMENTE parsea como objeto o array.
    expect(celdaDesdeJson('TRANSPORTES [ABC] SAS')).toBe('TRANSPORTES [ABC] SAS');
    expect(celdaDesdeJson('{PEREZ GOMEZ}')).toBe('{PEREZ GOMEZ}');
    expect(celdaDesdeJson('[SIN CARROCERIA')).toBe('[SIN CARROCERIA');
    // Escalares serializados: siguen siendo celdas válidas.
    expect(celdaDesdeJson('2021')).toBe('2021');
    expect(celdaDesdeJson('null')).toBe('null');
  });
});

// ─────────────────────────── El descarte de verdad ocurre en SQL ─────────────────────────────────

describe('lo no escalar se descarta en la EXTRACCIÓN, no al escribir la celda', () => {
  const exprs = expresionesFlitRaw(flitoTramites.flitRaw);

  it('**cada expresión envuelve el `->>` en un `case jsonb_typeof`**', () => {
    // El mutante nombrado: quitar el `case` y dejar `${columna} ->> ${clave}` a secas. Es lo que
    // había en `dcd57ea` y lo que el gate de seguridad tumbó — con él, un objeto anidado bajo
    // cualquiera de las 8 claves llega a la celda SERIALIZADO (`{"a": 1, "b": "ANA"}`), se publica en
    // un archivo que cruza el perímetro, `pii_access_log` no lo declara, y `bloqueTitular` clasifica
    // esa fila como PJUR/NIT metiendo el blob en `RazonSocial`.
    //
    // Este aserto es el ÚNICO sitio del repo donde esa garantía se comprueba de verdad: `keyed-db` no
    // evalúa la proyección, así que ninguna suite de export ejecuta este SQL. Lo que ellas prueban es
    // la guarda de JS, que es la segunda línea de defensa.
    //
    // Medido contra Postgres 16: el `case` descarta objeto y array y CONSERVA el escalar (`ANA`), el
    // número (`2021` → `'2021'`), la clave ausente (NULL) y la columna NULL (NULL) — o sea que no
    // rompe el auto-llenado de `Clase`, que es lo que sostiene la decisión de diseño.
    for (const campo of Object.keys(exprs) as (keyof typeof exprs)[]) {
      const { sql } = renderizar(exprs[campo]);
      expect(sql, `${campo} no descarta lo no escalar en SQL`).toContain('jsonb_typeof(');
      expect(sql, `${campo} no descarta objetos`).toContain("when 'object' then null");
      expect(sql, `${campo} no descarta arrays`).toContain("when 'array' then null");
      // Y sigue extrayendo con `->>` (texto) y no con `->` (jsonb), que devolvería las cadenas
      // entrecomilladas (`"ONIX"`).
      expect(sql, `${campo} tiene que extraer con ->>`).toContain('->> ');
    }
  });
});

// ─────────────────────────── El bloque del titular: TRES estados ─────────────────────────────────

describe('`bloqueTitular` — la regla tiene TRES estados, no dos', () => {
  const CINCO = ['claseDeInterlocutor', 'nombrePila', 'apellidos', 'razonSocial', 'claseId'] as const;

  it('**sin par (canal Cliente, sin `flit_raw`) → las CINCO columnas vacías**', () => {
    // El mutante que esto mata es el que la HU nombra: `if (!apellidos) → PJUR/NIT`. Con él, cada
    // fila del canal Cliente —`vehiculo_id` sí, trámite no, payload ninguno— saldría marcada
    // PERSONA JURÍDICA con `NIT` y la razón social VACÍA. El archivo se abre, las 25 cabeceras
    // están, y lo que se publica es una afirmación falsa sobre la naturaleza jurídica de un titular.
    for (const sinPar of [null, undefined]) {
      const b = bloqueTitular(sinPar);
      expect(b).toEqual(TITULAR_VACIO);
      for (const c of CINCO) expect(b[c], `${c} tenía que ir vacía`).toBeNull();
    }
  });

  it('con `flit_raw` pero sin ninguno de los dos campos → también las cinco vacías', () => {
    // La otra cara del mismo estado, y la que distingue este caso de «persona jurídica anónima»: hay
    // payload, pero no trae el bloque. Decir `PJUR`/`NIT` a partir de esa ausencia sería inventarse
    // el dato más comprometido de la hoja.
    expect(bloqueTitular({ nombres: null, apellidos: undefined })).toEqual(TITULAR_VACIO);
    expect(bloqueTitular({ nombres: ' ', apellidos: ' ' })).toEqual(TITULAR_VACIO);
  });

  it('natural: con apellidos → `PNAT`, `CC`, y `RazonSocial` VACÍA', () => {
    const b = bloqueTitular({ nombres: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ' });
    expect(b.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.natural);
    expect(b.claseId).toBe(CLASE_ID.natural);
    expect(b.nombrePila).toBe('JUANA MARIA');
    expect(b.apellidos).toBe('PEREZ GOMEZ');
    // Las dos formas son EXCLUYENTES: una fila natural con razón social sería un registro que dice
    // dos cosas a la vez, y el sistema del cliente lo carga como si las dos fueran ciertas.
    expect(b.razonSocial).toBeNull();
  });

  it('jurídica: sin apellidos → `PJUR`, `NIT`, `RazonSocial` = `nombres`, y los dos nombres VACÍOS', () => {
    const b = bloqueTitular({ nombres: 'TRANSPORTES DEL VALLE SAS', apellidos: null });
    expect(b.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.juridica);
    expect(b.claseId).toBe(CLASE_ID.juridica);
    expect(b.razonSocial).toBe('TRANSPORTES DEL VALLE SAS');
    expect(b.nombrePila).toBeNull();
    expect(b.apellidos).toBeNull();
  });

  it('**el ESPACIO es el caso propio**: `" "`, `"  "`, `"\\t"` cuentan como sin apellidos', () => {
    // Medido: `apellidos` llega como «solo espacios» en 3 510 de 7 052 filas, con CERO vacías y CERO
    // nulas. Los dos casos de arriba —natural con apellido, jurídica con `null`— quedan verdes con
    // el mutante «no recortar el apellido» (`if (apellidos)` sobre la cadena cruda): con él, la
    // MITAD del parque se clasificaría como persona natural con un apellido de un espacio. Solo este
    // caso lo mata.
    for (const blanco of [' ', '  ', '\t', '  ', '']) {
      const b = bloqueTitular({ nombres: 'INVERSIONES ABC SAS', apellidos: blanco });
      expect(b.claseDeInterlocutor, `«${JSON.stringify(blanco)}» tenía que ser jurídica`)
        .toBe(CLASE_INTERLOCUTOR.juridica);
      expect(b.claseId).toBe(CLASE_ID.juridica);
      expect(b.razonSocial).toBe('INVERSIONES ABC SAS');
      expect(b.apellidos).toBeNull();
    }
  });

  it('un `nombres` numérico se clasifica igual y no revienta', () => {
    expect(bloqueTitular({ nombres: 12345, apellidos: ' ' }).razonSocial).toBe('12345');
  });
});

// ─────────────────────────── La tupla se reconcilia junta (SOAT) ─────────────────────────────────

describe('`clavePar` / `parDeClave` — el par se reconcilia COMO TUPLA', () => {
  it('dos trámites que coinciden en el par dan la MISMA clave', () => {
    expect(clavePar('JUANA', 'PEREZ')).toBe(clavePar('  JUANA ', 'PEREZ  '));
  });

  it('**coincidir en `nombres` y diferir en `apellidos` da claves DISTINTAS**', () => {
    // Es lo que hace que `comun()` devuelva vacío y no una mezcla. Con dos `comun()` independientes
    // —uno por campo— este par produciría `nombres: 'JUANA'` + `apellidos: null`, y esa fila se
    // clasificaría como JURÍDICA metiendo el nombre de pila de una persona en `RazonSocial`, con su
    // `ClaseId` diciendo `NIT`. No lanza, no avisa, y ningún aserto de columnas lo ve.
    expect(clavePar('JUANA', 'PEREZ')).not.toBe(clavePar('JUANA', 'GOMEZ'));
  });

  it('sin ninguno de los dos, la clave es `null` y vuelve como «sin par»', () => {
    expect(clavePar(' ', null)).toBeNull();
    expect(parDeClave(null)).toBeNull();
    expect(bloqueTitular(parDeClave(null))).toEqual(TITULAR_VACIO);
  });

  it('la ida y la vuelta conservan la clasificación', () => {
    const clave = clavePar('INVERSIONES ABC SAS', ' ');
    expect(bloqueTitular(parDeClave(clave))).toEqual(bloqueTitular({
      nombres: 'INVERSIONES ABC SAS', apellidos: ' ',
    }));
  });
});

// ─────────────────────────── La ciudad del organismo ─────────────────────────────────────────────

describe('`ciudadDeOrganismo` — del CATÁLOGO, por el código normalizado', () => {
  it('un código del catálogo da su ciudad', () => {
    expect(ciudadDeOrganismo('76520')).toBe('Palmira');
    expect(ciudadDeOrganismo('25286')).toBe('Funza');
  });

  it('**el código SIN el cero de relleno no resuelve** — por eso no se lee de `flit_raw`', () => {
    // `flit_raw->>'codigoSecretaria'` manda `5001` donde el catálogo tiene `05001`, en 3 650 de las
    // 7 052 filas. Este aserto fija que el atajo NO funcionaría: si alguien cambiara el origen a esa
    // clave, el 51,8 % de las celdas saldría vacío sin un solo error. La celda buena sale de
    // `flito_{soat,impuestos}.organismo_codigo`, que el sync ya normalizó.
    expect(ciudadDeOrganismo('5001')).toBeNull();
    expect(ciudadDeOrganismo('05001')).toBe('Medellín');
  });

  it('un código fuera del catálogo deja la celda vacía y NO lanza', () => {
    // Un organismo nuevo en la base llega antes que su entrada en el catálogo compilado. Un export
    // de 2 000 filas no puede caerse entero —500 para todas— por una fila así.
    expect(() => ciudadDeOrganismo('99999')).not.toThrow();
    expect(ciudadDeOrganismo('99999')).toBeNull();
    expect(ciudadDeOrganismo(null)).toBeNull();
    expect(ciudadDeOrganismo(' ')).toBeNull();
  });
});
