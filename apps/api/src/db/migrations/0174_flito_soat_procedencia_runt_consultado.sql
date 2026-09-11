-- 0174_flito_soat_procedencia_runt_consultado.sql
-- Feature #12073 — SOAT canal Cliente con factura leida. HU #12093 (procedencia de cada dato del
-- propietario y fecha de la consulta al RUNT).
-- Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente en el sentido fuerte: la segunda pasada NO CAMBIA NI UNA FILA.
--
-- ============================================================================
-- QUE TRAE (dos columnas, dos tablas, una HU)
-- ============================================================================
--
-- 1. `flito_soat_solicitud.runt_consultado_en timestamptz` — el instante en que el RUNT RESPONDIO
--    dentro del alta. Desde ADR-0010 la consulta ocurre dentro de la peticion y es compuerta: si no
--    respondio, no hay fila. Sin esta columna, la unica fecha que la ficha podia enseñar era
--    `solicitado_en`, que es cuando se guardo la solicitud y no cuando se midio el vehiculo — dos
--    instantes que hoy distan milisegundos y que dejarian de coincidir en cuanto el alta se parta.
--
-- 2. `flito_compradores.procedencia jsonb NOT NULL DEFAULT '{}'` — mapa campo -> 'factura' | 'runt'
--    | 'manual' para los NUEVE campos del comprador (`CAMPOS_COMPRADOR_FACTURA`). Desde la HU
--    #12092 el formulario ya no se teclea entero, asi que quien revisa necesita saber si el nombre
--    lo puso el concesionario en la factura o lo escribio el cliente.
--
-- ============================================================================
-- POR QUE `runt_consultado_en` ES NULLABLE
-- ============================================================================
--
-- Las solicitudes radicadas antes de esta HU no tienen ese dato y no se puede inventar: bajo la
-- #11935 el RUNT se consultaba DESPUES del COMMIT (o no se consultaba), y `solicitado_en` es otra
-- cosa. Un NOT NULL con `DEFAULT now()` habria escrito en la base la fecha de la MIGRACION como si
-- fuera la de una consulta al registro nacional — la clase de mentira que la 0172 ya rechazo por
-- escrito para `puertas`. NULL significa «de esta solicitud no consta cuando se consulto», que es la
-- verdad. Y CERO backfill, por lo mismo.
--
-- ============================================================================
-- POR QUE `procedencia` SI ES NOT NULL, y por que eso no contradice la regla 4 del README
-- ============================================================================
--
-- El README pide añadir nullable + backfill + constraint en la migracion siguiente para columnas
-- NOT NULL sobre tablas existentes. Esa regla protege del `ADD COLUMN NOT NULL` SIN DEFAULT, que
-- aborta con 23502 en cuanto la tabla tiene una fila. Con DEFAULT constante no hay tal problema:
-- desde PostgreSQL 11 el `ADD COLUMN ... NOT NULL DEFAULT '{}'` no reescribe la tabla (el default se
-- guarda en el catalogo y se materializa al actualizar cada fila), asi que las ~7 052 filas de
-- `flito_compradores` quedan con el mapa vacio sin un solo UPDATE.
--
-- Y el NOT NULL vale la pena: `{}` y NULL significarian lo mismo —«de esta fila no se sabe la
-- procedencia»— con dos formas distintas, y todo lector tendria que acordarse de las dos. Con NOT
-- NULL hay un solo caso vacio, y `procedencia->>'nombres'` nunca es una comparacion contra NULL.
--
-- El mapa vacio NO es un valor de relleno: es lo que corresponde a una fila del sync de tramites,
-- que nunca paso por el formulario del canal, y a una radicada antes de que existiera este dato.
-- Distinguirlo del mapa completo que escribe el alta es trivial y no hace falta un CHECK: el
-- vocabulario lo impone Zod en la UNICA ruta que escribe esta columna, igual que la mitad positiva
-- del titular (0172). Un CHECK sobre jsonb aqui obligaria a enumerar en SQL los nueve campos y los
-- tres valores, y esa lista quedaria en la base sin forma de crecer con el enum de shared-types —
-- que es el defecto que la 0172 documenta al no añadir el reciproco de `flito_compradores_titular_chk`.
--
-- ============================================================================
-- SIN BACKFILL (deliberado, las dos columnas)
-- ============================================================================
--
-- Ni un UPDATE en este archivo. De las solicitudes ya radicadas no consta ni cuando respondio el
-- RUNT ni de donde salio cada dato del propietario, y rellenarlo con una suposicion —«todo manual»,
-- «consultado al migrar»— seria escribir como hecho lo que nadie observo. La segunda pasada no
-- cambia ni una fila porque la primera tampoco cambio ninguna.
--
-- Idempotencia: `ADD COLUMN IF NOT EXISTS` (x2). `COMMENT ON COLUMN` es idempotente por definicion.

-- ── 1. flito_soat_solicitud: cuando respondio el RUNT ───────────────────────

ALTER TABLE flito_soat_solicitud
  ADD COLUMN IF NOT EXISTS runt_consultado_en timestamptz;

COMMENT ON COLUMN flito_soat_solicitud.runt_consultado_en IS
  'HU #12093: instante en que el RUNT RESPONDIO durante el alta (ADR-0010, la consulta es compuerta '
  'y ocurre dentro de la peticion). No es solicitado_en, que es cuando se guardo la fila. NULL en '
  'las solicitudes anteriores a esta HU: de ellas no consta, y no se rellena.';

-- ── 2. flito_compradores: de donde salio cada dato del propietario ──────────

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS procedencia jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN flito_compradores.procedencia IS
  'HU #12093: mapa campo -> factura | runt | manual para los nueve campos del comprador '
  '(CAMPOS_COMPRADOR_FACTURA), siempre completo. Lo escriben las DOS rutas del canal Cliente: el '
  'alta con lo que declare el formulario, y la subsanacion con los nueve en manual, porque ahi los '
  'valores llegan de un formulario que una persona acaba de enviar. El defecto de un campo no '
  'declarado es manual. {} = fila del sync de tramites o anterior a esta HU: no se sabe, y no se '
  'rellena. El vocabulario lo impone Zod en las rutas que la escriben.';
