-- 0165_flito_comparendos_municipio_comparendo.sql
-- Feature #11495 (17b) — Visor de comparendos. HU #11878 (resolver el municipio del comparendo y
-- filtrar por el).
-- Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con sql.begin()).
-- Idempotente: se puede re-aplicar entera. La segunda pasada no cambia ni una fila mas —los dos
-- UPDATE llevan `municipio_comparendo IS NULL` en el WHERE, asi que la primera los agota.
--
-- ============================================================================
-- EL DEFECTO QUE CIERRA
-- ============================================================================
--
-- El filtro `municipio` del listado comparaba por igualdad contra `municipio_fuente`, que es «a que
-- municipio se le PREGUNTO». Esa columna viene NULL en toda fila que solo vio el SIMIT, asi que
-- **filtrar por Medellin escondia comparendos de Medellin** — y el `organismo` de esas mismas filas
-- («STRIA DE TTOyTTE MEDELLIN») decia exactamente de donde eran, pero nadie lo usaba para filtrar.
--
-- La correccion NO es reinterpretar `municipio_fuente`: es una columna nueva con la OTRA pregunta.
--
-- ============================================================================
-- LAS DOS COLUMNAS, Y POR QUE SON DOS
-- ============================================================================
--
--   · `municipio_fuente`     — a quien se le PREGUNTO. Trazabilidad de la corrida. NO se toca en
--                              esta migracion: ni su valor, ni su significado, ni su tipo. Sigue
--                              siendo NULL en lo que solo vio el SIMIT, porque a nadie se le
--                              pregunto por ello, y sigue siendo lo que usa el barrido de
--                              inactivacion para saber que fuentes cubrio la corrida (RN-23).
--   · `municipio_comparendo` — de donde ES el comparendo. Es lo que un operador quiere decir cuando
--                              elige «Medellin» en el filtro.
--
-- Fundirlas en una habria hecho lo contrario de lo que pide la HU: escribir una deduccion encima de
-- un hecho, y perder para siempre la trazabilidad de que fuente devolvio cada fila.
--
-- ============================================================================
-- SIN FK CONTRA `flito_comparendos_municipios`
-- ============================================================================
--
-- Simetria deliberada con `municipio_fuente`, que tampoco la tiene. Una FK convertiria un renombre
-- de `codigo_fuente` en la parametrizacion (una pantalla de catalogo, sin conciencia de historico)
-- en un error de escritura sobre `flito_comparendos_registros`, o —con ON UPDATE CASCADE— en una
-- reescritura masiva del historico disparada desde un CRUD. El valor es una FOTO del codigo con el
-- que se reconocio el municipio, no un puntero vivo a la fila del catalogo.
--
-- ============================================================================
-- EL CRITERIO, QUE EXISTE DOS VECES (TS Y SQL)
-- ============================================================================
--
-- El mismo que implementa `municipioDelComparendo` en `flito-comparendos-merge.ts`, en dos
-- escalones:
--
--   1. `municipio_fuente IS NOT NULL` -> ese, y FIN. Ni se mira el organismo: si a Medellin se le
--      pregunto y Medellin respondio, no hay nada que deducir. El hecho vence a la heuristica.
--   2. Si no, se busca en el ORGANISMO cada `codigo_fuente` del catalogo con LIMITE DE PALABRA:
--        '(^|[^A-Z0-9])' || codigo_fuente || '([^A-Z0-9]|$)'
--      `\y` / `\b` NO sirven, y no es preferencia de estilo: los codigos admiten espacio
--      (`SANTA FE DE ANTIOQUIA`), y un limite de palabra alrededor de un termino con espacios
--      delimita cada trozo, no el termino. `LIKE '%'||codigo_fuente||'%'` tampoco: sin limite,
--      cualquier codigo que sea subcadena de otro (o de una palabra cualquiera) casaria de mas.
--
--   **Exactamente UN codigo distinto casa -> ese. Cero, o dos o mas -> NULL.** De ahi el
--   `count(*) OVER (PARTITION BY r.id) = 1`. Sin desempate por longitud ni «gana el primero»: los
--   dos serian una decision inventada sobre texto libre del proveedor, y el precio de equivocarse es
--   enseñarle a un operador un comparendo de otro municipio. NULL es el lado seguro y ya significa
--   «no se sabe» en esta tabla.
--
-- Que las dos escrituras del criterio digan lo mismo NO se deja a la buena voluntad: lo vigila
-- `apps/api/__tests__/services/flito-comparendos-migracion-0165-paridad.test.ts`, que extrae de ESTE
-- archivo los literales del limite de palabra y la tabla de plegado de acentos, y los contrasta con
-- `municipioDelComparendo` sobre un corpus. Cambiar el `~` por un LIKE, quitar el `= 1` o borrar el
-- `translate` pone ese test en rojo.
--
-- El catalogo entra COMPLETO, sin `WHERE activo`. Desactivar una fuente deja de consultarla; no
-- borra de donde eran los comparendos que ya trajo. Es el mismo argumento con el que el filtro del
-- listado no valida su municipio contra el catalogo.
--
-- No se escapan metacaracteres en `codigo_fuente` porque la ruta del catalogo lo valida contra
-- `^[A-Z0-9 _-]+$`. **Si esa validacion se relaja, esto se rompe en silencio** (un codigo con `.`
-- casaria de mas y nadie veria un error, solo municipios mal atribuidos). Queda declarado aqui y en
-- el JSDoc de `municipioDelComparendo`.
--
-- ============================================================================
-- POR QUE EL SQL PLIEGA ACENTOS Y `upper()` SOLO NO BASTA
-- ============================================================================
--
-- El criterio en TS normaliza con `normalizarCodigoFuente`: NFD, borrar diacriticos, trim, upper.
-- `upper()` de PostgreSQL **no borra diacriticos**, asi que con `upper(organismo)` a secas el
-- organismo real 'Secretaría de Movilidad de Medellín' NO casa con el codigo 'MEDELLIN' y el
-- backfill lo dejaria en NULL mientras el siguiente sync lo pondria en MEDELLIN: las dos mitades del
-- mismo criterio diciendo cosas distintas sobre la misma fila.
--
-- MEDIDO, no supuesto: sobre la base de demo (125 filas, 5 sin `municipio_fuente`) el escalon 2 con
-- `upper()` a secas casa 0 filas; con el plegado casa 4.
--
-- Se pliega con `translate()` y no con `unaccent()` a proposito: `unaccent` es una EXTENSION, y
-- crearla exige superusuario y añade una dependencia de despliegue a una migracion que solo necesita
-- comparar texto. La tabla cubre las vocales acentuadas del castellano y del portugues, la diereses,
-- la eñe y la cedilla; `Ñ -> N` coincide con lo que hace el NFD del lado de TS (Ñ se descompone en
-- N + tilde combinante, y la tilde se borra).
--
-- ============================================================================
-- EL BACKFILL: QUE TOCA Y QUE NO
-- ============================================================================
--
-- **No escribe ni una vez sobre `municipio_fuente` ni sobre `organismo`.** Los dos se LEEN. Lo unico
-- que esta migracion escribe en `flito_comparendos_registros` es la columna que acaba de crear.
--
-- Las filas `inactivo` SI entran, al contrario que en la 0164. No es incoherencia, es la misma
-- premisa aplicada: aquella no podia reconstruir el dato de ninguna parte, y esta si —el organismo
-- esta en la propia fila—. Y como el sync ya no visita las `inactivo` (CF-10), esta migracion es la
-- UNICA oportunidad que tienen de llenarse. No hacerlo dejaria el histórico apagado sin municipio
-- para siempre.
--
-- FILAS QUE ESPERA TOCAR (medido en la base de demo el 2026-08-25, 125 filas en la tabla):
--   · Escalon 1 -> 120 filas (todas las que tienen `municipio_fuente`).
--   · Escalon 2 ->   4 filas (organismos de Medellin vistos solo por SIMIT).
--   · Sin tocar ->   1 fila  (organismo 'Secretaria de Movilidad QA 0': no reconoce ningun codigo).
-- En un ambiente con mas historico la proporcion cambia; lo que no cambia es que la suma de los dos
-- escalones nunca puede superar el total de filas, porque el segundo solo mira lo que el primero
-- dejo en NULL.
--
-- ============================================================================
-- EL INDICE NUEVO SUSTITUYE AL VIEJO, NO CONVIVE CON EL
-- ============================================================================
--
-- `idx_flito_comparendos_municipio_creado` (0153) servia al filtro del listado por
-- `municipio_fuente`. Ese filtro se acaba de mudar de columna, asi que el indice se queda sin su
-- unico consumidor y se BORRA. Dejarlo seria pagar escrituras en la tabla que mas crece del modulo
-- por un plan que nadie va a pedir.
--
-- Comprobado antes de borrarlo: `municipio_fuente` solo aparece en un WHERE en dos sitios. Uno es
-- `condicionesDeFiltro`, que es el que se muda. El otro es `condicionAusente` (el barrido de
-- inactivacion), donde el predicado que guia es `ultimo_sync_run_id IS DISTINCT FROM $1` y el
-- municipio entra como `municipio_fuente IS NULL OR municipio_fuente IN (...)` — nunca como columna
-- guia por igualdad, asi que ese indice no le servia de nada.
--
-- SIN `CONCURRENTLY`, por lo mismo que la 0152 y la 0153: no puede correr dentro de una transaccion
-- y el runner envuelve cada archivo en una (ADR-DB-001); el intento moriria con un `25001` y dejaria
-- la cadena parada.
--
-- ============================================================================
-- COSTE Y VENTANA DE BLOQUEO  (leer ANTES de aplicarla fuera de local)
-- ============================================================================
--
-- Lo caro de este archivo NO es la regex. Conviene decirlo porque el instinto apunta al reves:
--
--   · El ESCALON 2 —el del `~` por fila y por municipio— solo mira lo que el escalon 1 dejo en
--     NULL, es decir las filas sin `municipio_fuente`. Medido: 4 de 125 (3 %). Despreciable.
--   · El ESCALON 1 es el que pesa: reescribe ~el 96 % de la tabla (120 de 125). En MVCC eso es una
--     version de tupla NUEVA por fila, y cada update no-HOT escribe ademas en los indices de la
--     tabla. La tabla puede casi duplicar su tamano en disco hasta el siguiente VACUUM.
--     Recomendado despues de aplicarla: `VACUUM (ANALYZE) flito_comparendos_registros;`
--
-- VENTANA DE BLOQUEO. El runner envuelve el archivo entero en UNA transaccion (ADR-DB-001), asi que
-- la ventana es todo el archivo, no cada sentencia:
--
--   · `UPDATE`      -> ROW EXCLUSIVE: los lectores no se enteran, pero deja row locks hasta el commit.
--   · `CREATE INDEX`-> SHARE (sin CONCURRENTLY): **bloquea escrituras** mientras dura.
--   · `DROP INDEX`  -> ACCESS EXCLUSIVE, breve.
--
-- El runner NO fija `lock_timeout` ni `statement_timeout` (`db-apply.ts`), asi que si se bloquea
-- espera indefinidamente y encola detras.
--
-- NO APLICAR CON UNA CORRIDA DE SYNC EN VUELO. El sync reescribe estas mismas filas bajo su lock de
-- aplicacion (RN-15), que esta migracion no toma: bloqueo garantizado y deadlock posible.
--
-- El orden de las sentencias NO es indiferente y esta elegido: el backfill va ANTES del
-- `CREATE INDEX`, para no poblar el indice y batirlo acto seguido.
--
-- Los numeros de arriba salen de una base con 125 filas. **El volumen en QA y en PDN es desconocido
-- desde aqui**; con `pg_dump` previo, que es la convencion 6 del README de migraciones.

-- ============================================================================
-- PII (Ley 1581)
-- ============================================================================
--
-- Un codigo de municipio no identifica a nadie: describe al comparendo, igual que el organismo del
-- que se deduce. Por eso el filtro `municipio` puede viajar en la query (RN-36) y por eso esta
-- columna sale al API y al Excel. El backfill no lee ni una columna de persona.

-- ============================================================================
-- 1. La columna
-- ============================================================================
--
-- Nullable y SIN default: NULL significa «no se sabe de donde es», y una cadena vacia seria un
-- tercer valor para lo mismo. `varchar(40)` en simetria exacta con `municipio_fuente` y con
-- `flito_comparendos_municipios.codigo_fuente`, que es de donde sale el valor.
-- Un ADD COLUMN nullable y sin default es un cambio de METADATOS en PostgreSQL: no reescribe la
-- tabla.

ALTER TABLE flito_comparendos_registros
  ADD COLUMN IF NOT EXISTS municipio_comparendo VARCHAR(40);

COMMENT ON COLUMN flito_comparendos_registros.municipio_comparendo IS
  'De donde ES el comparendo (HU #11878), que NO es lo mismo que municipio_fuente: aquella dice a '
  'que municipio se le PREGUNTO. Lo deriva el sync (municipioDelComparendo, en '
  'flito-comparendos-merge.ts) en dos escalones: el municipio consultado si lo hay; si no, el UNICO '
  'codigo_fuente del catalogo que aparezca dentro del organismo con limite de palabra. Cero '
  'coincidencias o DOS dejan NULL: la ambiguedad no se desempata, se declara. NULL significa NO SE '
  'SABE DE DONDE ES, nunca cadena vacia. Se RE-DERIVA entera en cada corrida (como tipo_registro), '
  'asi que añadir un municipio al catalogo corrige solo las filas que el sync vuelva a visitar; el '
  'historico ya guardado lo corrigio el backfill de la 0165. Es la columna por la que filtra el '
  'listado y la que sale en la columna Municipio del Excel. Sin FK contra '
  'flito_comparendos_municipios, igual que municipio_fuente: un renombre en la parametrizacion no '
  'puede convertirse en un error de escritura sobre el historico.';

COMMENT ON COLUMN flito_comparendos_registros.municipio_fuente IS
  'A que municipio se le PREGUNTO: el codigo_fuente de la fuente municipal que devolvio esta fila, o '
  'NULL si solo la reporto el SIMIT (a nadie se le pregunto por ella). Es trazabilidad de la corrida '
  'y la usa el barrido de inactivacion para saber que fuentes cubrio (RN-23). NO dice de donde es el '
  'comparendo — para eso esta municipio_comparendo (HU #11878). Hasta esa HU el filtro del listado '
  'comparaba contra ESTA columna, y por eso filtrar por Medellin escondia los comparendos de '
  'Medellin que solo habia visto el SIMIT. Su valor y su significado no cambiaron; cambio que '
  'pregunta responde cada columna.';

-- ============================================================================
-- 2. Backfill, escalon 1: el municipio consultado manda
-- ============================================================================
--
-- Solo copia. `municipio_comparendo IS NULL` en el WHERE es lo que hace idempotente la re-aplicacion
-- Y lo que impide que una segunda pasada pise algo que el sync ya haya derivado despues.

UPDATE flito_comparendos_registros
   SET municipio_comparendo = municipio_fuente
 WHERE municipio_comparendo IS NULL
   AND municipio_fuente IS NOT NULL;

-- ============================================================================
-- 3. Backfill, escalon 2: deducir del organismo
-- ============================================================================
--
-- Un CTE por fila candidata con su codigo casado y CUANTOS codigos distintos casaron; solo se
-- escriben las de exactamente uno. El `count(*) OVER (PARTITION BY r.id)` es la regla de ambiguedad,
-- y quitarlo convertiria «este texto nombra dos municipios» en «gana el que devuelva el JOIN
-- primero», que no es una decision de nadie.
--
-- El catalogo entra entero (sin `WHERE m.activo`), y el JOIN es contra el organismo YA PLEGADO a la
-- misma forma que produce normalizarCodigoFuente en TS.

WITH candidatos AS (
  SELECT r.id,
         m.codigo_fuente,
         count(*) OVER (PARTITION BY r.id) AS codigos_casados
    FROM flito_comparendos_registros r
    JOIN flito_comparendos_municipios m
      ON upper(translate(r.organismo,
                         'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛäëïöÄËÏÖãõÃÕçÇ',
                         'aeiouunAEIOUUNaeiouAEIOUaeiouAEIOUaeioAEIOaoAOcC'))
         ~ ('(^|[^A-Z0-9])' || m.codigo_fuente || '([^A-Z0-9]|$)')
   WHERE r.municipio_comparendo IS NULL
     AND r.organismo IS NOT NULL
)
UPDATE flito_comparendos_registros r
   SET municipio_comparendo = c.codigo_fuente
  FROM candidatos c
 WHERE c.id = r.id
   AND c.codigos_casados = 1;

-- ============================================================================
-- 4. El indice del filtro se muda de columna
-- ============================================================================
--
-- Misma forma que el que sustituye (0153): la IGUALDAD delante y (created_at DESC, id DESC) detras,
-- que son las columnas del cursor y en el mismo orden (RN-32), para que el indice entregue la pagina
-- ya ordenada y el plan pierda el nodo de Sort.

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_municipio_comparendo_creado
    ON flito_comparendos_registros (municipio_comparendo, created_at DESC, id DESC);

COMMENT ON INDEX idx_flito_comparendos_municipio_comparendo_creado IS
  'Filtro por municipio del listado (HU #11878) servido en el orden del cursor (RN-32): la igualdad '
  'delante y (created_at DESC, id DESC) detras entregan la pagina ya ordenada, sin nodo de Sort. '
  'SUSTITUYE a idx_flito_comparendos_municipio_creado, que indexaba la columna por la que el filtro '
  'ya no pregunta.';

DROP INDEX IF EXISTS idx_flito_comparendos_municipio_creado;
