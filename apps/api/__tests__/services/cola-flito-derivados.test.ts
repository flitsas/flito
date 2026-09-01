// FLITO — lo que el Excel de las colas DERIVA, probado SIN generar un archivo (HU #11934, #11947).
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
//   2. **El SQL RENDERIZADO** de las NUEVE expresiones, con `PgDialect().sqlToQuery()`: qué clave
//      del payload quedó ligada a qué campo. Es el único aserto del repo que ve el cruce.
//
// Lo que este archivo NO prueba: que las filas lleguen a la hoja, que el 422 salga a tiempo o que la
// cuota se comparta. Eso es de las suites de export, y aquí no se duplica.

import { describe, it, expect } from 'vitest';
import { flitoTramites } from '../../src/db/schema.js';
import { renderizar } from '../helpers/sql-ligado.js';
import {
  bloqueTitular, celdaDesdeJson, ciudadDeOrganismo, clasificacionDeTipoFlit, claveTitular, CLASE_ID,
  CLASE_INTERLOCUTOR, CLAVES_FLIT_RAW, expresionesFlitRaw, titularDeClave, TITULAR_VACIO,
} from '../../src/shared/export/cola-flito-derivados.js';

// ─────────────────────────── Las nueve expresiones `->>` ─────────────────────────────────────────

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

  it('las otras siete van a su clave, y ninguna es `codigoSecretaria`', () => {
    expect(claveDe('marca')).toBe('marca');
    expect(claveDe('clase')).toBe('clase');
    expect(claveDe('capacidad')).toBe('capacidad');
    expect(claveDe('departamento')).toBe('departamentoTransito');
    expect(claveDe('nombres')).toBe('nombres');
    expect(claveDe('apellidos')).toBe('apellidos');
    // La NOVENA (HU #11947), y la más cara de ligar mal: es la que decide las cinco columnas del
    // titular. Ligada a otra clave —`tipoTramite`, por ejemplo, que también existe en el payload—
    // el bloque entero saldría vacío en las 7 052 filas y ningún aserto de cabeceras se enteraría.
    expect(claveDe('tipo')).toBe('tipo');

    // `codigoSecretaria` llega SIN el cero de relleno en 3 650 de 7 052 filas (`5001` frente a
    // `05001`), y el catálogo se indexa por la cadena de cinco. Leer la ciudad por ahí dejaría el
    // 51,8 % de las celdas vacías sin que nada fallara: no puede estar ligado a ninguna expresión.
    const todas = Object.keys(exprs).map((c) => claveDe(c as keyof typeof exprs));
    expect(todas).not.toContain('codigoSecretaria');
    expect(todas).toHaveLength(9);
  });

  it('**`tipo` es una clave del payload, no la columna `flito_compradores.tipo_documento`**', () => {
    // Las dos parecen el mismo dato y no lo son. Medido: `flit_raw->>'tipo'` está en 7 052 de 7 052
    // filas; `flito_compradores.tipo_documento` está a 0 de 7 052 para las filas del sync —solo lo
    // escribe el canal Cliente—. Quien «corrija» el origen a la columna dejaría el tipo vacío en el
    // 100 % de lo que la pantalla enseña, y lleno justo en las filas que no tienen nada más.
    expect(CLAVES_FLIT_RAW.tipo).toBe('tipo');
    expect(claveDe('tipo')).toBe('tipo');
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
    // cualquiera de las 9 claves llega a la celda SERIALIZADO (`{"a": 1, "b": "ANA"}`), se publica en
    // un archivo que cruza el perímetro, `pii_access_log` no lo declara, y `bloqueTitular` clasifica
    // esa fila como PJUR/NIT metiendo el blob en `RazonSocial`.
    //
    // El bucle recorre TODAS las expresiones y no una lista escrita a mano: `tipo` (HU #11947) entró
    // en la garantía sin tocar este caso, y la décima clave que alguien añada entrará igual.
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

// ─────────────────────────── LA tabla: `tipo` → clase + documento ────────────────────────────────

describe('`clasificacionDeTipoFlit` — LA tabla del AC2, y la única copia del repo', () => {
  it('las cuatro entradas con documento, cada una con su PAR completo', () => {
    // Los asertos van por PAR (`claseDeInterlocutor` + `claseId` juntos) y no columna a columna: son
    // una decisión única, y un test que solo mirase el documento no vería un `PP` colgado de un
    // `PJUR`, que es un registro que dice dos cosas a la vez.
    expect(clasificacionDeTipoFlit('n')).toEqual({ claseDeInterlocutor: 'PJUR', claseId: 'NIT' });
    expect(clasificacionDeTipoFlit('cc')).toEqual({ claseDeInterlocutor: 'PNAT', claseId: 'CC' });
    expect(clasificacionDeTipoFlit('ps')).toEqual({ claseDeInterlocutor: 'PNAT', claseId: 'PP' });
    expect(clasificacionDeTipoFlit('ce')).toEqual({ claseDeInterlocutor: 'PNAT', claseId: 'CE' });
  });

  it('**`ps` es `PP` y NUNCA `PAS`** — este NO es el catálogo del RUNT', () => {
    // `TIPOS_DOCUMENTO_RUNT` (`packages/shared-types/src/flito-estados.ts`) usa `PAS` y es OTRO
    // vocabulario: el del canal Cliente y el de la certificación, que el AC8 deja intacto. Este es
    // el de la plantilla del CLIENTE. El mutante es una «unificación» bienintencionada: cambiar `PP`
    // por `PAS` aquí no rompe nada en el repo y deja de cargar el archivo del cliente.
    expect(CLASE_ID.pasaporte).toBe('PP');
    expect(clasificacionDeTipoFlit('ps')?.claseId).toBe('PP');
    expect(clasificacionDeTipoFlit('ps')?.claseId).not.toBe('PAS');
  });

  it('**`otro` clasifica la CLASE y deja el documento vacío** — no es lo mismo que no saber', () => {
    // Contra AC5, que es todo vacío. Un test que solo mirase `claseId` daría verde en los dos casos
    // y no distinguiría nada: la diferencia está en que aquí SÍ hay `claseDeInterlocutor`.
    const otro = clasificacionDeTipoFlit('otro');
    expect(otro).not.toBeNull();
    expect(otro?.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.natural);
    expect(otro?.claseId).toBeNull();
    // Y el desconocido no devuelve `{PNAT, null}`: devuelve `null`, que es otra cosa.
    expect(clasificacionDeTipoFlit('xx')).toBeNull();
  });

  it('**`c` a secas NO clasifica**: la lectura es estricta contra el origen medido', () => {
    // Decisión de David (2026-09-01). De las 7 052 filas locales, `cc` aparece en 2 393 y `c` no
    // aparece NUNCA. Aceptar `c` «por si acaso» sería meter en la tabla un token que nadie ha visto
    // y que, si llegara, significaría algo que no sabemos. (El TC #11949 se escribió con `c` antes
    // de esa decisión; lo correcto es `cc`.)
    expect(clasificacionDeTipoFlit('c')).toBeNull();
    expect(clasificacionDeTipoFlit('cc')).not.toBeNull();
  });

  it('normaliza el FORMATO (`" CC "`) pero no inventa vocabulario', () => {
    // `.trim().toLowerCase()` acepta la MISMA cadena escrita de otra forma. No convierte un token
    // distinto en uno conocido: `c` sigue sin estar, y `" C "` tampoco.
    expect(clasificacionDeTipoFlit(' CC ')).toEqual(clasificacionDeTipoFlit('cc'));
    expect(clasificacionDeTipoFlit('N')).toEqual(clasificacionDeTipoFlit('n'));
    expect(clasificacionDeTipoFlit(' Ps')).toEqual(clasificacionDeTipoFlit('ps'));
    expect(clasificacionDeTipoFlit(' C ')).toBeNull();
  });

  it('ausente, vacío, blanco y desconocido → `null` (AC5)', () => {
    for (const nada of [undefined, null, '', ' ', '  ', '\t', 'xx', 'nit', 'cedula', 'CC1']) {
      expect(clasificacionDeTipoFlit(nada), `«${JSON.stringify(nada)}» no puede clasificar`).toBeNull();
    }
  });

  it('**un `tipo` no escalar no clasifica**, ni como objeto JS ni ya serializado', () => {
    // El `case jsonb_typeof` de la proyección lo descarta en SQL; esto es la segunda línea. La forma
    // que llegaría de verdad es la CADENA que `->>` produce si alguien quitara el `case`.
    expect(clasificacionDeTipoFlit({ tipo: 'cc' })).toBeNull();
    expect(clasificacionDeTipoFlit(['cc'])).toBeNull();
    expect(clasificacionDeTipoFlit('{"tipo": "cc"}')).toBeNull();
    expect(clasificacionDeTipoFlit('["cc"]')).toBeNull();
  });

  it('**la tabla no hereda de `Object.prototype`**: `constructor` no es un tipo válido', () => {
    // El lookup lo alimenta un `jsonb` de un TERCERO. Con un objeto literal indexado,
    // `TABLA['constructor']` devuelve algo que no es `undefined` y la rama por defecto —que es la
    // que protege al canal Cliente— dejaría de significar «no lo sé» para tres cadenas concretas.
    for (const veneno of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(clasificacionDeTipoFlit(veneno), `«${veneno}» no es un tipo de documento`).toBeNull();
    }
  });
});

// ─────────────────────────── El bloque del titular ───────────────────────────────────────────────

describe('`bloqueTitular` — la clase la AFIRMA el `tipo`, no se deduce del apellido', () => {
  const CINCO = ['claseDeInterlocutor', 'nombrePila', 'apellidos', 'razonSocial', 'claseId'] as const;

  it('**sin titular (canal Cliente, sin `flit_raw`) → las CINCO columnas vacías**', () => {
    // El canal Cliente sale vacío por la RAMA POR DEFECTO y sin un `if` propio: no tiene trámite,
    // luego no tiene `flit_raw`, luego no tiene `tipo`. Es la invariante que este caso fija.
    for (const sinTitular of [null, undefined]) {
      const b = bloqueTitular(sinTitular);
      expect(b).toEqual(TITULAR_VACIO);
      for (const c of CINCO) expect(b[c], `${c} tenía que ir vacía`).toBeNull();
    }
  });

  it('**`n` con apellido CON TEXTO → `PJUR` + `NIT`**: la heurística vieja decía lo contrario', () => {
    // El caso que distingue esta HU de la #11934, y hay que leerlo con cuidado: con el apellido
    // VACÍO la regla vieja también habría dicho `PJUR`/`NIT`, así que un test escrito así pasaría
    // sin el cambio. Con el apellido LLENO, la regla vieja decía `PNAT`/`CC`.
    const b = bloqueTitular({ tipo: 'n', nombres: 'TRANSPORTES DEL VALLE SAS', apellidos: 'PEREZ GOMEZ' });
    expect(b.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.juridica);
    expect(b.claseId).toBe(CLASE_ID.nit);
    expect(b.razonSocial).toBe('TRANSPORTES DEL VALLE SAS');
    // Las dos formas son EXCLUYENTES: una fila jurídica con nombre de pila diría dos cosas a la vez.
    expect(b.nombrePila).toBeNull();
    expect(b.apellidos).toBeNull();
  });

  it('**`cc` con `apellidos = " "` sigue siendo `PNAT` + `CC`** — la regresión que mata la heurística', () => {
    // Medido: `apellidos` llega como «solo espacios» en 3 510 de 7 052 filas. Con la regla de la
    // #11934 —«sin apellido = empresa»— estas filas salían `PJUR` + `NIT` con el NOMBRE DE UNA
    // PERSONA en `RazonSocial`. Aquí el origen dice `cc` y eso es lo que manda; lo que falta es el
    // apellido, no la clase.
    for (const blanco of [' ', '  ', '\t', '  ', '', null, undefined]) {
      const b = bloqueTitular({ tipo: 'cc', nombres: 'JUANA MARIA', apellidos: blanco });
      expect(b.claseDeInterlocutor, `«${JSON.stringify(blanco)}» tenía que seguir siendo natural`)
        .toBe(CLASE_INTERLOCUTOR.natural);
      expect(b.claseId).toBe(CLASE_ID.cedula);
      expect(b.nombrePila).toBe('JUANA MARIA');
      expect(b.apellidos).toBeNull();
      expect(b.razonSocial).toBeNull();
    }
  });

  it('`cc` con apellido: `PNAT`, `CC`, nombre y apellido en su sitio, `RazonSocial` vacía', () => {
    expect(bloqueTitular({ tipo: 'cc', nombres: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ' })).toEqual({
      claseDeInterlocutor: 'PNAT', nombrePila: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ',
      razonSocial: null, claseId: 'CC',
    });
  });

  it('`ps` → `PP` y `ce` → `CE`, con el nombre repartido como en `cc`', () => {
    // 3 filas `ps` y 22 `ce` medidas. Los asertos van por PAR: `PNAT` con el documento que toca.
    expect(bloqueTitular({ tipo: 'ps', nombres: 'JOHN', apellidos: 'SMITH' })).toEqual({
      claseDeInterlocutor: 'PNAT', nombrePila: 'JOHN', apellidos: 'SMITH',
      razonSocial: null, claseId: 'PP',
    });
    expect(bloqueTitular({ tipo: 'ce', nombres: 'MARIA', apellidos: 'ROSSI' })).toEqual({
      claseDeInterlocutor: 'PNAT', nombrePila: 'MARIA', apellidos: 'ROSSI',
      razonSocial: null, claseId: 'CE',
    });
  });

  it('**`otro` → `PNAT` CON nombres y `ClaseId` VACÍO**, que no es el bloque vacío del AC5', () => {
    // Contra AC5. Un test que solo mirase `claseId` daría verde en los dos —los dos lo tienen a
    // `null`— y no distinguiría nada. Lo que separa los casos son las otras cuatro columnas.
    expect(bloqueTitular({ tipo: 'otro', nombres: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ' })).toEqual({
      claseDeInterlocutor: 'PNAT', nombrePila: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ',
      razonSocial: null, claseId: null,
    });
    // Y el desconocido, con EXACTAMENTE los mismos nombres, sale vacío entero.
    expect(bloqueTitular({ tipo: 'xx', nombres: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ' }))
      .toEqual(TITULAR_VACIO);
  });

  it('**`c`, `""`, `"xx"`, ausente y no escalar → el bloque ENTERO vacío** (AC5)', () => {
    // La rama por defecto de `clasificacionDeTipoFlit`. Es el mutante que la HU nombra el primero:
    // devolver `{PNAT, CC}` en vez de `null` marcaría con cédula cada fila del canal Cliente y cada
    // trámite sin payload, en un archivo que sale del perímetro.
    for (const tipo of ['c', '', ' ', 'xx', 'CC1', undefined, null, { a: 1 }, ['cc'], '{"a": 1}']) {
      const b = bloqueTitular({ tipo, nombres: 'JUANA MARIA', apellidos: 'PEREZ GOMEZ' });
      expect(b, `«${JSON.stringify(tipo)}» no puede clasificar`).toEqual(TITULAR_VACIO);
      // Y el nombre no se publica por ninguna de las dos vías: ni como persona ni como empresa.
      for (const c of CINCO) expect(b[c]).toBeNull();
    }
  });

  it('**`tipo` explícito SIN nombre sigue clasificando** — son 7 filas medidas y es deliberado', () => {
    // Decisión 2 de David (2026-09-01), AC1 literal. Hay 7 filas de 7 052 con `tipo` y sin nombres
    // ni apellidos (1 `n`, 6 `cc`). La guarda de la #11934
    // —`if (nombres === null && apellidos === null) return TITULAR_VACIO`— las dejaba sin clasificar
    // y **ya no está**: aquí la clase la AFIRMA el origen, no se deduce de una ausencia, que era
    // justo el defecto que la #11934 corrigió (allí no había `tipo` NINGUNO que consultar).
    const juridica = bloqueTitular({ tipo: 'n', nombres: ' ', apellidos: ' ' });
    expect(juridica.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.juridica);
    expect(juridica.claseId).toBe(CLASE_ID.nit);
    expect(juridica.razonSocial).toBeNull();   // sin razón social, y aun así PJUR + NIT

    const natural = bloqueTitular({ tipo: 'cc', nombres: null, apellidos: undefined });
    expect(natural.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.natural);
    expect(natural.claseId).toBe(CLASE_ID.cedula);
    expect(natural.nombrePila).toBeNull();
    expect(natural.apellidos).toBeNull();
  });

  it('un `nombres` numérico se clasifica igual y no revienta', () => {
    expect(bloqueTitular({ tipo: 'n', nombres: 12345, apellidos: ' ' }).razonSocial).toBe('12345');
  });

  it('un `nombres` ANIDADO no llega a la celda, y la clase la sigue diciendo el `tipo`', () => {
    // Lo que `->>` produciría de verdad si alguien quitara el `case jsonb_typeof`. El blob no se
    // publica —ni en `RazonSocial` ni en `NombrePila`—, pero `tipo` sigue siendo escalar y la fila
    // sigue clasificada: son dos decisiones independientes y esto lo fija.
    const b = bloqueTitular({ tipo: 'n', nombres: '{"primer": "ANA", "cedula": "99887766554"}', apellidos: ' ' });
    expect(b.claseDeInterlocutor).toBe(CLASE_INTERLOCUTOR.juridica);
    expect(b.claseId).toBe(CLASE_ID.nit);
    expect(b.razonSocial).toBeNull();
  });
});

// ─────────────────────────── La TRIPLA se reconcilia junta (SOAT) ────────────────────────────────

describe('`claveTitular` / `titularDeClave` — se reconcilia la TRIPLA, no campo a campo', () => {
  it('dos trámites que coinciden en los tres campos dan la MISMA clave', () => {
    expect(claveTitular('cc', 'JUANA', 'PEREZ')).toBe(claveTitular('cc', '  JUANA ', 'PEREZ  '));
  });

  it('**coincidir en el nombre y diferir en el `tipo` da claves DISTINTAS**', () => {
    // El tercer mutante nombrado de la HU: reconciliar `tipo` con un `comun()` aparte. Dos trámites
    // del mismo VIN (RN-01) que coinciden en el nombre y discrepan en el tipo —uno `n`, otro `cc`—
    // publicarían un nombre reconciliado con una clase que NINGÚN trámite afirma. Con la tripla,
    // `comun()` devuelve `null` y el bloque sale vacío, que es la respuesta honesta.
    expect(claveTitular('n', 'JUANA', 'PEREZ')).not.toBe(claveTitular('cc', 'JUANA', 'PEREZ'));
    expect(claveTitular('cc', 'JUANA', 'PEREZ')).not.toBe(claveTitular('ce', 'JUANA', 'PEREZ'));
  });

  it('coincidir en `nombres` y diferir en `apellidos` sigue dando claves DISTINTAS', () => {
    // Lo que ya fijaba la HU #11934: con un `comun()` por campo, este par produciría `JUANA` con el
    // apellido en blanco. Sigue valiendo, ahora dentro de la tripla.
    expect(claveTitular('cc', 'JUANA', 'PEREZ')).not.toBe(claveTitular('cc', 'JUANA', 'GOMEZ'));
  });

  it('el `tipo` viaja normalizado: `cc` y `" CC "` reconcilian', () => {
    // Si no, dos trámites que dicen lo mismo con otro formato dejarían la fila sin titular. Es la
    // misma normalización que usa el lookup, y por eso vive en una sola función.
    expect(claveTitular(' CC ', 'JUANA', 'PEREZ')).toBe(claveTitular('cc', 'JUANA', 'PEREZ'));
  });

  it('sin ninguno de los TRES, la clave es `null` y vuelve como «sin titular»', () => {
    expect(claveTitular(null, ' ', null)).toBeNull();
    expect(titularDeClave(null)).toBeNull();
    expect(bloqueTitular(titularDeClave(null))).toEqual(TITULAR_VACIO);
  });

  it('con `tipo` y SIN nombres la clave EXISTE: son las 7 filas medidas', () => {
    // Si `claveTitular` exigiera nombre para devolver clave, esas 7 filas perderían en SOAT la
    // clasificación que sí tienen en Impuestos, y las dos colas dirían cosas distintas del mismo
    // trámite sin que nada fallara.
    const clave = claveTitular('n', ' ', ' ');
    expect(clave).not.toBeNull();
    expect(bloqueTitular(titularDeClave(clave)).claseId).toBe(CLASE_ID.nit);
  });

  it('la ida y la vuelta conservan la clasificación', () => {
    const clave = claveTitular('n', 'INVERSIONES ABC SAS', ' ');
    expect(bloqueTitular(titularDeClave(clave))).toEqual(bloqueTitular({
      tipo: 'n', nombres: 'INVERSIONES ABC SAS', apellidos: ' ',
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
