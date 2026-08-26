-- 0160_flito_comparendos_tipo_registro.sql
-- Feature #11492 (17a) — Monitoreo de comparendos. HU #11712 (distinguir comparendo de multa por el
-- numero de resolucion, y sumar `estadoPago` a la cadena del estado de la fuente).
-- Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con sql.begin()).
-- Idempotente: se puede re-aplicar entera sin efecto adicional y sin cambiar una sola fila.
--
-- Decision de negocio (David, 2026-08-21) y enmienda de docs/adr/ADR-0003-flito-comparendos-homologacion.md.
--
-- ============================================================================
-- QUE AFIRMA ESTA MIGRACION
-- ============================================================================
--
-- Los dos endpoints devuelven comparendos Y multas en la misma lista. Un comparendo se convierte en
-- multa con el tiempo, y lo que los distingue es la resolucion: mientras es comparendo, el proveedor
-- manda los campos de resolucion en null; cuando ya es multa, con valor. Eso se PERSISTE en tres
-- columnas nuevas y no se deriva en vuelo, porque un dato que no es columna no se puede filtrar ni
-- indexar y el payload crudo ya viene podado a la lista blanca de RN-25.
--
--   · `tipo_registro`     enum ('comparendo','multa'). Lo DERIVA el merge, no el mapa (ver abajo).
--   · `numero_resolucion` varchar(60). El numero legible del acto administrativo.
--   · `id_resolucion`     varchar(60). Identificador de SISTEMA del proveedor («115697134»), que NO
--                         es el numero legible y por eso es columna propia y no un respaldo de la
--                         anterior: como candidato del numero acabaria pintado en la columna
--                         «N.º resolucion» de la pantalla. Los dos vienen nulos mientras es
--                         comparendo y con valor cuando ya es multa, asi que los dos son señal
--                         valida del TIPO, y de ahi la disyuncion del CHECK.
--
-- ============================================================================
-- POR QUE **NO** HAY NI UN `UPDATE`: EL HISTORICO SE QUEDA EN NULL
-- ============================================================================
--
-- Las tres columnas nacen NULLABLE y **SIN DEFAULT**, y esta migracion no reescribe una sola fila.
-- `NULL` significa aqui «no se sabe», que es exactamente lo que sabemos del historico: sus payloads
-- ya fueron podados y ninguna version anterior del mapa nombraba la resolucion, asi que el dato no
-- esta ni en las columnas ni en el JSONB.
--
-- Un `DEFAULT 'comparendo'` seria comodo y seria mentira. Y no una mentira transitoria: las filas
-- `inactivo` ya no las visita ningun sync (CF-10), asi que nadie va a volver a pasar por ellas para
-- corregir la afirmacion — se quedaria en pantalla para siempre, y el visor de la HU #11713 la
-- pintaria como dato verificado. `NULL` = «no se sabe» es ademas el vocabulario que esta tabla ya
-- usa para el historico (`gestion_actualizada_en` / `gestion_actualizada_por`, HU #11556).
--
-- Bonus operativo: tres `ADD COLUMN` nullable y sin default son un cambio de METADATOS en PostgreSQL
-- (desde la 11 incluso con default constante), sin reescritura de la tabla que mas crece del modulo.
--
-- ============================================================================
-- POR QUE `tipo_registro` NO ES UN `target_field` DEL MAPA
-- ============================================================================
--
-- `flito_comparendos_field_map` alimenta lo que el proveedor DICE; el tipo no lo dice nadie, se
-- deduce. Si fuera `target_field`, una fila de una tabla de TEXTO decidiria el valor de una columna
-- `enum`: basta con apuntarle un campo cualquiera del proveedor para que el INSERT reviente con un
-- 22P02 a mitad de corrida y se lleve por delante el NIT entero. Es la misma clase de fallo que el
-- sombreado del `comparendo: true` que documenta la 0158, con consecuencia peor.
--
-- Lo deriva `resolverCampos` (`flito-comparendos-merge.ts`) DESPUES de resolver los dos campos de
-- resolucion, igual que ya deriva `origen_merge`. Asi el invariante del CHECK se cumple por
-- construccion en vez de vigilarse: no hay forma de escribir un `tipo_registro` que no venga del
-- valor que se acaba de escribir en las otras dos columnas.
--
-- Y la promocion a multa es MONOTONA: cualquier fuente que presente resolucion promueve la fila, que
-- es lo que RN-13 (`simit ?? municipal ?? previo`) ya hace sin regla nueva. Que una fuente calle no
-- es la afirmacion «no hay resolucion», es indistinguible de que no publique el campo. El tercer
-- escalon (`previo`) da la otra mitad gratis: una fila que ya fue multa no regresa a comparendo
-- porque el proveedor deje de mandar el campo. **No hay regresion automatica multa -> comparendo**:
-- exigiria una señal POSITIVA del proveedor y hoy ninguna de las dos fuentes la publica. Riesgo
-- abierto y declarado, no deuda escondida.
--
-- ============================================================================
-- SIN INDICES NUEVOS
-- ============================================================================
--
-- `tipo_registro` son dos valores sobre toda la tabla y el planner no lo usaria: es el mismo
-- razonamiento que ya esta escrito en `schema.ts` para `origen_merge`. `numero_resolucion` no es
-- llave de nada —nadie hace join ni unicidad por ella— y por eso tampoco lleva unico.
--
-- ============================================================================
-- PII (RN-25, Ley 1581)
-- ============================================================================
--
-- La lista blanca de la poda se DERIVA de esta tabla, asi que las filas que siembra este archivo
-- cambian lo que sobrevive en `payload_simit` / `payload_municipal`. Un numero de resolucion
-- identifica un ACTO ADMINISTRATIVO sobre una infraccion, no a una persona: esta en el mismo plano
-- que `numero_comparendo`, que ya es la llave de la fila, asi que no añade vinculabilidad. No es
-- dato sensible (art. 5, Ley 1581) y entra con finalidad declarada. Las rutas nuevas son escalares
-- de PRIMER NIVEL: no abren ningun contenedor, asi que `injertarHoja` no gana superficie.
--
-- Si algun municipio emitiera la resolucion como OBJETO, hay dos mecanismos distintos y conviene no
-- confundirlos, porque estan en dos sitios del flujo y protegen de cosas distintas:
--
--   · No se PERSISTE: `esEscalarPersistible` lo descarta dentro de `injertarHoja`, que es la poda
--     del payload (RN-25). Es lo que impide que un subarbol con datos de persona entre por una
--     clave autorizada.
--   · No se HOMOLOGA: `primerValor` lo salta (`esValorHomologable`) y sigue al candidato siguiente;
--     si no hay ninguno, el campo queda NULL y la fila se queda en comparendo. Ojo: **si hay un
--     candidato de prioridad 2 con valor bueno, la fila SI se promueve**, que es lo correcto.
--
-- Las dos funciones se parecen y NO son la misma: `esEscalarPersistible` admite `boolean` y `null`
-- (son valores legitimos que guardar), `esValorHomologable` no (de un `true` no sale un canonico).
--
-- Siguen FUERA del mapa y la v3 no puede nombrarlos: `infractor.*`, `nombres`, `apellidos`,
-- `contraventores`, `estadoCuenta.direccion`, `identificador`, `informacionMoroso` e
-- `informacionMorosoCobro`.
--
-- ============================================================================
-- EL MAPA v3: RE-SIEMBRA COMPLETA DE LOS DOS ORIGENES
-- ============================================================================
--
-- El merge lee la version MAXIMA (RN-11), asi que una v3 parcial dejaria fuera todo lo que la v2
-- cubria: no se heredan versiones. Por eso la v3 repite las 35 filas de la v2 y añade 6.
-- La v2 NO se toca: es historial y `operaciones_app` no tiene DELETE sobre la tabla (0150).
--
-- Lo que la v3 añade, y lo que deliberadamente deja fuera:
--
--   · simit `numeroResolucion` -> numeroResolucion, y simit `idResolucion` -> idResolucion. El valor
--     real del proveedor para el segundo es «115697134».
--   · municipal `nroResolucion` -> numeroResolucion (nombre VERIFICADO contra el proveedor real), con
--     `numeroResolucion` de respaldo simetrico por si otro municipio lo publica con el nombre largo.
--   · **`fechaResolucion` NO se mapea a nada.** El item real de Medellin la trae con valor
--     («2026-09-22») y `nroResolucion` en NULL a la vez: usarla como señal fabricaria multas.
--   · **`idEstadoComparendo` NO se mapea.** Es un `int` y pondria «3» como estado en pantalla.
--   · `estadoPago` entra en la cadena de `estadoFuente` de CADA origen por separado. En SIMIT va
--     delante de `estado` —doctrina de la 0158: los alias heredados de la v1 son respaldo de ULTIMA
--     prioridad, y un campo real del proveedor no puede ir detras de un nombre inerte—. En municipal
--     va detras de `estado`, y la asimetria es deliberada: alli `estado` no es un nombre inerte sino
--     el que emite el mock del UTS, que es el modo POR DEFECTO, mientras que `estadoPago` no se ha
--     observado en ese origen.
--
-- ── Como se REVIERTE esto ──────────────────────────────────────────────────────────────────────
--
-- El mapa, sembrando una v4 que copie la v2 (el proyecto no lleva scripts `down` y `operaciones_app`
-- no tiene DELETE sobre la tabla):
--
--   INSERT INTO flito_comparendos_field_map (version, origen, source_path, target_field, prioridad,
--                                            provisional, notas)
--   SELECT 4, origen, source_path, target_field, prioridad, provisional, 'Reversa de la v3 a la v2'
--     FROM flito_comparendos_field_map WHERE version = 2
--   ON CONFLICT (version, origen, source_path) DO NOTHING;
--
-- Esa reversa es segura para las columnas: sin candidatos de resolucion, `elegir` cae al tercer
-- escalon (el valor ya guardado), asi que las filas que ya son multa siguen siendo multa. Lo unico
-- que se pierde es la capacidad de promover filas NUEVAS, que pasarian a nacer `comparendo`.
--
-- Las columnas no se revierten: un `DROP COLUMN` destruiria el dato ya verificado. Si hubiera que
-- dejar de usarlas, se dejan de leer.

-- ── 1. El tipo ──────────────────────────────────────────────────────────────────────────────────
-- PostgreSQL no admite `CREATE TYPE IF NOT EXISTS`, y la idempotencia no es opcional: la cadena se
-- re-aplica en cualquier ambiente que vaya por detras y una segunda pasada que abortara con 42710
-- dejaria parado el `db:apply`. Mismo patron que la 0156 con `pg_constraint`.
DO $ma$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'flito_comparendos_tipo_registro') THEN
    CREATE TYPE flito_comparendos_tipo_registro AS ENUM ('comparendo', 'multa');
  END IF;
END $ma$;

-- ── 2. Las tres columnas ────────────────────────────────────────────────────────────────────────
-- Nullable y sin DEFAULT, por lo dicho arriba. `varchar(60)` como `numero_comparendo`.
ALTER TABLE flito_comparendos_registros
  ADD COLUMN IF NOT EXISTS tipo_registro flito_comparendos_tipo_registro,
  ADD COLUMN IF NOT EXISTS numero_resolucion varchar(60),
  ADD COLUMN IF NOT EXISTS id_resolucion varchar(60);

-- ── 3. El CHECK que impide que la fila mienta ───────────────────────────────────────────────────
--
-- Las dos piezas que parecen adorno hacen dos trabajos DISTINTOS, y conviene no confundirlas
-- (verificado contra PostgreSQL 16, no deducido):
--
--   · **La PRIMERA rama esta para ADMITIR el historico**, no para cerrar ningun hueco. Al llegar
--     aqui las tres columnas acaban de nacer, asi que TODA fila existente es (NULL, NULL, NULL).
--     Sin esa rama, `tipo_registro IS NOT NULL` da FALSE y el CHECK RECHAZA el historico entero: el
--     `ADD CONSTRAINT` de abajo moriria en el acto con «check constraint ... is violated by some
--     row», y la migracion no pasaria de aqui en ningun ambiente con datos.
--
--   · **Lo que cierra el hueco de la evaluacion a NULL es la guarda `tipo_registro IS NOT NULL AND`
--     de la SEGUNDA rama.** La comparacion desnuda `(NULL = 'multa') = (...)` evalua a NULL y un
--     CHECK que evalua a NULL PASA, asi que sin esa guarda se colaria justo la fila peor: sin tipo
--     y CON numero de resolucion. Con la guarda, `FALSE AND NULL` es FALSE y la fila se rechaza.
--
-- Juntas dicen lo que se queria decir: «sin tipo» solo es legal si tampoco hay resolucion —que es
-- el historico—, y con tipo, `multa` equivale exactamente a tener alguna de las dos resoluciones.
DO $ma$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flito_comparendos_tipo_resolucion_chk'
  ) THEN
    ALTER TABLE flito_comparendos_registros
      ADD CONSTRAINT flito_comparendos_tipo_resolucion_chk
      CHECK (
        (tipo_registro IS NULL AND numero_resolucion IS NULL AND id_resolucion IS NULL)
        OR (tipo_registro IS NOT NULL
            AND (tipo_registro = 'multa') = (numero_resolucion IS NOT NULL OR id_resolucion IS NOT NULL))
      );
  END IF;
END $ma$;

COMMENT ON COLUMN flito_comparendos_registros.tipo_registro IS
  'Comparendo o multa. Lo DERIVA el merge del numero/id de resolucion ya resuelto (HU #11712), no '
  'el field_map: si fuera target_field, una fila de texto decidiria el valor de un enum y el INSERT '
  'reventaria con 22P02. NULL significa NO SE SABE: no significa comparendo y no se pinta como tal. '
  'La 0160 no rellena nada, asi que al aplicarla TODA la tabla queda en NULL; a partir de ahi el '
  'sync escribe el tipo de cada fila que vuelve a visitar, de modo que el NULL solo sobrevive en lo '
  'que ya no se sincroniza (las filas inactivo, CF-10), y ahi si es definitivo: sus payloads estan '
  'podados y ninguna version anterior del mapa nombraba la resolucion, asi que no hay de donde '
  'reconstruirlo.';

COMMENT ON COLUMN flito_comparendos_registros.numero_resolucion IS
  'Numero legible de la resolucion que convirtio el comparendo en multa. NO se guarda tal cual: se '
  'normaliza como los demas codigos del canonico (trim, colapso de espacios, MAYUSCULAS) y se '
  'RECORTA a los 60 caracteres de la columna. Recortar es seguro justo porque no es llave: no hay '
  'unico ni indice ni join por ella, asi que en el peor caso se degrada un dato de pantalla; '
  'numero_comparendo, en cambio, no se recorta nunca, porque recortar la llave fundiria dos deudas. '
  'NULL mientras sigue siendo comparendo, o si la fila es anterior a la 0160.';

COMMENT ON COLUMN flito_comparendos_registros.id_resolucion IS
  'Identificador de SISTEMA de la resolucion en el proveedor (por ejemplo 115697134). No se publica '
  'en el API: no es legible para nadie fuera del proveedor. Se guarda porque, igual que el numero, '
  'viene nulo mientras es comparendo y con valor cuando ya es multa, y por tanto es la otra mitad '
  'de la señal del tipo (ver el CHECK, que acepta cualquiera de los dos).';

-- ── 4. El mapa v3 ───────────────────────────────────────────────────────────────────────────────
INSERT INTO flito_comparendos_field_map (version, origen, source_path, target_field, prioridad, provisional, notas) VALUES
  -- ── SIMIT (Verifik) ──────────────────────────────────────────────────────────────────────────
  (3, 'simit', 'numeroComparendo',                    'numeroComparendo',      1, false, 'Clave de negocio (CF-07). 20 digitos en la captura real.'),
  (3, 'simit', 'numeroMulta',                         'numeroComparendo',      2, false, 'Respaldo. `comparendo` NO se mapea: en el payload real es el booleano true y sombrearia a este candidato.'),
  (3, 'simit', 'placa',                               'placa',                 1, false, 'PII: enmascarar en logs'),
  (3, 'simit', 'infracciones.0.codigoInfraccion',     'codigoInfraccion',      1, false, 'El codigo cuelga de infracciones[0], no del item.'),
  (3, 'simit', 'codigoInfraccion',                    'codigoInfraccion',      2, false, 'Respaldo plano por si el proveedor lo sube al item.'),
  (3, 'simit', 'infracciones.0.descripcionInfraccion','descripcionInfraccion', 1, false, NULL),
  (3, 'simit', 'descripcionInfraccion',               'descripcionInfraccion', 2, false, 'Respaldo plano.'),
  (3, 'simit', 'fechaComparendo',                     'fechaComparendo',       1, false, 'Formato DD/MM/YYYY HH:MM:SS. fechaNotificacion NO se mapea: trae centinelas 01/01/1900.'),
  (3, 'simit', 'fechaImposicion',                     'fechaComparendo',       2, false, 'Respaldo: nombre que usaba la v1. No aparece en la captura; inerte mientras fechaComparendo llegue.'),
  (3, 'simit', 'organismoTransito',                   'organismo',             1, false, NULL),
  (3, 'simit', 'secretariaNombre',                    'organismo',             2, false, 'Respaldo: nombre que usaba la v1.'),
  (3, 'simit', 'valorPagar',                          'monto',                 1, false, 'Deuda total: incluye valorGestion. Ver la nota de decision de negocio en la cabecera de la 0158.'),
  (3, 'simit', 'valorAPagar',                         'monto',                 2, false, 'Respaldo: nombre que usaba la v1.'),
  (3, 'simit', 'valor',                               'monto',                 3, false, 'Solo capital de la infraccion, sin gestion.'),
  (3, 'simit', 'estadoComparendo',                    'estadoFuente',          1, false, 'Texto crudo del proveedor; no se normaliza.'),
  (3, 'simit', 'estadoCartera',                       'estadoFuente',          2, false, 'Llego null en la captura.'),
  (3, 'simit', 'estadoPago',                          'estadoFuente',          3, false, 'HU #11712: campo real del proveedor. Va DELANTE de `estado`, que es un alias heredado de la v1 y por doctrina de la 0158 los alias inertes son respaldo de ultima prioridad.'),
  (3, 'simit', 'estado',                              'estadoFuente',          4, false, 'Respaldo: nombre que usaba la v1. Baja de 3 a 4 al entrar estadoPago.'),
  (3, 'simit', 'numeroResolucion',                    'numeroResolucion',      1, false, 'HU #11712: null mientras es comparendo, con valor cuando ya es multa. Acto administrativo, no dato de persona (RN-25).'),
  (3, 'simit', 'idResolucion',                        'idResolucion',          1, false, 'HU #11712: identificador de SISTEMA del proveedor (115697134), no el numero legible. Columna propia justamente para que no acabe pintado como numero. No se publica en el API.'),
  -- ── Municipal (UTS) ──────────────────────────────────────────────────────────────────────────
  (3, 'municipal', 'numeroComparendo',                              'numeroComparendo',      1, false, 'Clave de negocio (CF-07). `identificador` NO se mapea: es el NIT consultado.'),
  (3, 'municipal', 'estadoCuenta.numeroComparendo',                 'numeroComparendo',      2, false, 'El mismo numero, repetido dentro de estadoCuenta.'),
  (3, 'municipal', 'numero',                                        'numeroComparendo',      3, false, 'Respaldo: nombre que usaba la v1.'),
  (3, 'municipal', 'placa',                                         'placa',                 1, false, 'PII: enmascarar en logs'),
  (3, 'municipal', 'codigoInfraccion',                              'codigoInfraccion',      1, false, NULL),
  (3, 'municipal', 'estadoCuenta.infraccion.0.codigoInfraccion',    'codigoInfraccion',      2, false, NULL),
  (3, 'municipal', 'descripcionInfraccion',                         'descripcionInfraccion', 1, false, NULL),
  (3, 'municipal', 'estadoCuenta.infraccion.0.descripcion',         'descripcionInfraccion', 2, false, NULL),
  (3, 'municipal', 'fechaComparendo',                               'fechaComparendo',       1, false, 'ISO sin hora en la captura (2026-07-19).'),
  (3, 'municipal', 'estadoCuenta.secretaria.nombreAutoridadTransito','organismo',            1, false, 'Unica hoja autorizada de estadoCuenta.secretaria. estadoCuenta.direccion es PII y queda fuera.'),
  (3, 'municipal', 'organismo',                                     'organismo',             2, false, 'Respaldo plano por si otro municipio lo publica asi.'),
  (3, 'municipal', 'valor',                                         'monto',                 1, false, 'Numero JSON. proyeccionMultaDTO.valorConDescuento50 NO se mapea: es proyeccion condicionada.'),
  (3, 'municipal', 'monto',                                         'monto',                 2, false, 'Respaldo.'),
  (3, 'municipal', 'descripcionEstado',                             'estadoFuente',          1, false, 'Texto crudo del proveedor («Se adeuda»); no se normaliza.'),
  (3, 'municipal', 'codigo',                                        'codigoInfraccion',      3, false, 'Respaldo: nombre de la v1, que es el que emite el mock del UTS. Sin esta fila el modo mock (el DEFECTO) homologa codigoInfraccion a NULL.'),
  (3, 'municipal', 'descripcion',                                   'descripcionInfraccion', 3, false, 'Respaldo: nombre de la v1 y del mock. Sin esta fila se cae el escenario CF-08 del mock.'),
  (3, 'municipal', 'fecha',                                         'fechaComparendo',       2, false, 'Respaldo: nombre de la v1 y del mock.'),
  (3, 'municipal', 'estado',                                        'estadoFuente',          2, false, 'Respaldo: nombre de la v1 y del mock del UTS, que es el modo por defecto. Por eso aqui NO es un alias inerte y va delante de estadoPago.'),
  (3, 'municipal', 'estadoPago',                                    'estadoFuente',          3, false, 'HU #11712: mismo campo que en SIMIT, no observado en este origen. Respaldo de ultima prioridad.'),
  (3, 'municipal', 'nroResolucion',                                 'numeroResolucion',      1, false, 'HU #11712: nombre VERIFICADO contra el proveedor real. `fechaResolucion` NO se mapea: el item real la trae con valor y nroResolucion en NULL a la vez, asi que fabricaria multas.'),
  (3, 'municipal', 'numeroResolucion',                              'numeroResolucion',      2, false, 'HU #11712: respaldo simetrico con el nombre largo de SIMIT, por si otro municipio lo publica asi. No observado.')
ON CONFLICT (version, origen, source_path) DO NOTHING;

COMMENT ON TABLE flito_comparendos_field_map IS
  'Homologacion versionable fuente -> canonico (ADR-0003). El merge lee la version MAXIMA y NO '
  'hereda de las anteriores, asi que cada version re-siembra los dos origenes enteros. La v1 (0150) '
  'era provisional; la v2 (0158) sale de payloads reales del 2026-08-20; la v3 (0160) le añade la '
  'resolucion y estadoPago (HU #11712) y es la vigente. Los source_path admiten rutas con punto y '
  'esta tabla ES la lista blanca de la poda RN-25: lo que no se nombre aqui no se persiste en '
  'payload_simit / payload_municipal. tipo_registro NO es un target_field: lo deriva el merge.';
