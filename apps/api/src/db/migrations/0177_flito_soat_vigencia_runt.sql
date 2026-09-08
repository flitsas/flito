-- 0177_flito_soat_vigencia_runt.sql
-- Feature #12075 — Verificacion diaria del SOAT contra el RUNT a las 00:10 de Colombia.
-- HU #12096 (el recorrido: que vehiculos, como se consultan y que se escribe).
-- Autor: equipo FLITO. Antecedentes: HU #12095 (el cron y su estado en `system_kv`), migracion 0174
-- (la regla de «cero backfill» que aqui se repite) y 0167:139 (por que un CHECK se pone con
-- DROP + ADD y no con `ADD CONSTRAINT IF NOT EXISTS`, que PostgreSQL no admite).
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`,
-- `src/scripts/db-apply.ts`).
--
-- Ningun comentario de este archivo escribe el par de dolares que abre un bloque (leccion de la
-- 0156, repetida en la 0167 y en la 0176): el guarda `scanForTxControl` tapa los bloques citados con
-- dolares ANTES de quitar los comentarios.
--
-- ============================================================================
-- QUE TRAE
-- ============================================================================
--
--   1. Cuatro columnas de vigencia en `flito_soat`, con su CHECK.
--   2. `flito_soat_verificacion_corridas`: UNA FILA POR CORRIDA (dia + intento).
--   3. El indice que el recorrido necesita (`flito_soportes` por soat+tipo). `verificada_en`
--      NO se indexa: el porque, medido, esta abajo en su propio bloque.
--   4. Retira la clave de `system_kv` que la HU #12095 uso como estado provisional, dejando en el
--      log del CD lo que habia dentro.
--
-- ============================================================================
-- LOS DOS NOMBRES QUE NO SON LOS DEL AC1, Y POR QUE
-- ============================================================================
--
-- El AC1 nombra las columnas `estado` y `poliza`. Las dos chocan con columnas que YA existen en
-- `flito_soat`, y el choque no es de estilo: es de tipo y de significado.
--
--   · `estado` -> **`estado_vigencia`**. `flito_soat.estado` existe desde el modelo original y es el
--     ENUM `flito_soat_estado` con los estados de la SOLICITUD (pendiente, solicitado, con_novedad,
--     pagado). Escrito literal, el `ADD COLUMN IF NOT EXISTS estado` de abajo seria un **no-op
--     silencioso** —la columna existe— y el primer UPDATE del recorrido moriria con
--     `22P02 invalid input value for enum "flito_soat_estado": "vigente"`. Los dos estados son
--     ortogonales y tienen que convivir: un SOAT `pagado` que el RUNT no reporta es exactamente el
--     hallazgo que este Feature persigue.
--   · `poliza` -> **`poliza_runt`**. `numero_poliza` existe desde la 0157 y es la llave con la que
--     una boleta de pago externo cruza contra el SOAT (Feature #11623); la escribe el OCR de la
--     factura de FLITO. La del RUNT es otro dato, de otra fuente. Que las dos diverjan es senal util
--     —una poliza reexpedida— y no ruido; pisar la del OCR con la del registro borraria la llave de
--     conciliacion sin que nada se pusiera rojo.
--
-- `verificada_en` y `vence_el` conservan el nombre literal del AC: no chocan con nada.
--
-- ============================================================================
-- VARCHAR + CHECK, NUNCA UN ENUM
-- ============================================================================
--
-- Misma decision, y por el mismo motivo, que `flito_soat.origen` (0167) deja escrito: ampliar un
-- varchar con CHECK es un DROP/ADD CONSTRAINT barato, mientras que un enum arrastra a cada migracion
-- futura la trampa del 55P04 (`ALTER TYPE ... ADD VALUE` no puede correr dentro de una transaccion, y
-- el runner envuelve cada archivo en una) que este dominio ya pago dos veces. Los CHECK se declaran
-- ADEMAS en `schema.ts`: la leccion de la 0157 es que un CHECK que solo vive en la base convence a
-- quien lee el esquema de que anadir un valor no necesita migracion, y el primer INSERT muere con
-- 23514.
--
-- **Tres valores y ni uno mas.** `vencido` NO se persiste: se deriva comparando `vence_el` contra el
-- dia de Bogota. Guardarlo como estado obligaria a reescribir filas cada medianoche para que la
-- columna dejara de mentir.
--
-- ============================================================================
-- SIN BACKFILL (deliberado, las cuatro columnas)
-- ============================================================================
--
-- Ni un UPDATE de datos en este archivo. De las filas existentes no consta ninguna consulta al RUNT,
-- y `estado_vigencia = 'no_verificado'` es exactamente eso. Rellenar `vigente` porque estan `pagado`
-- seria escribir como hecho lo que este Feature existe para comprobar — la misma regla que la 0174
-- dejo escrita para `runt_consultado_en`. **La segunda pasada no cambia ni una fila.**
--
-- El `NOT NULL DEFAULT` no reescribe la tabla: desde PostgreSQL 11 el default constante se guarda en
-- el catalogo y se materializa al actualizar cada fila (mismo razonamiento que la 0174 para
-- `flito_compradores.procedencia`).
--
-- ============================================================================
-- SEGUNDA PASADA (P6)
-- ============================================================================
--
-- `ADD COLUMN IF NOT EXISTS` (x4), `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` (x2),
-- `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (x2) y un `DELETE` por clave primaria que la segunda
-- vez no encuentra nada. `COMMENT ON` es idempotente por definicion. Ni una fila cambia.

-- ── 1. flito_soat: las cuatro columnas de vigencia ──────────────────────────

ALTER TABLE flito_soat
  ADD COLUMN IF NOT EXISTS estado_vigencia varchar(15) NOT NULL DEFAULT 'no_verificado',
  ADD COLUMN IF NOT EXISTS verificada_en   timestamptz,
  ADD COLUMN IF NOT EXISTS vence_el        date,
  ADD COLUMN IF NOT EXISTS poliza_runt     varchar(60);

-- DROP + ADD y no un bloque DO: PostgreSQL no admite `ADD CONSTRAINT IF NOT EXISTS` (0167:139), y
-- esta forma ademas reescribe la definicion si alguien la cambio a mano.
ALTER TABLE flito_soat DROP CONSTRAINT IF EXISTS flito_soat_estado_vigencia_chk;
ALTER TABLE flito_soat ADD CONSTRAINT flito_soat_estado_vigencia_chk
  CHECK (estado_vigencia IN ('vigente', 'sin_registro', 'no_verificado'));

COMMENT ON COLUMN flito_soat.estado_vigencia IS
  'HU #12096: que dijo el RUNT la ultima vez que respondio sobre la vigencia de ESTE SOAT. '
  'vigente | sin_registro | no_verificado. NO es flito_soat.estado, que es el enum de la SOLICITUD '
  '(pendiente/solicitado/con_novedad/pagado) y es ortogonal a este: un SOAT pagado y sin_registro es '
  'el hallazgo que el Feature #12075 persigue. vencido NO se persiste: se deriva de vence_el contra '
  'el dia de Bogota. Lo escribe SOLO la corrida de las 00:10; ninguna accion humana lo toca.';

COMMENT ON COLUMN flito_soat.verificada_en IS
  'HU #12096: cuando RESPONDIO el RUNT, no cuando se intento. La corrida NO la toca si el RUNT se '
  'cayo o el circuito estaba abierto (AC5): moverla con los intentos fallidos dejaria toda la cola '
  'con fecha de anoche tras un mes de pasarela caida, y la antiguedad —que es la senal que este '
  'Feature mide— diria lo contrario de lo que pasa. NULL = de este SOAT no consta ninguna respuesta.';

COMMENT ON COLUMN flito_soat.vence_el IS
  'HU #12096: hasta cuando dice el RUNT que la poliza esta vigente. NULL = el registro respondio por '
  'estado y sin fecha, que es frecuente y legitimo. Se conserva intacto cuando el desenlace es '
  'sin_registro o no_verificado.';

COMMENT ON COLUMN flito_soat.poliza_runt IS
  'HU #12096: numero de poliza que reporta el RUNT, normalizado igual que numero_poliza. Es OTRA '
  'columna a proposito: numero_poliza es la que el OCR saco de la factura de FLITO y con la que se '
  'concilia una boleta de pago externo (Feature #11623). Que diverjan es senal util (poliza '
  'reexpedida), no ruido. Cuasi-PII: no se proyecta hacia la cola ni viaja en query (AGENTS.md 14).';

-- ── 2. La tabla de corridas: UNA FILA POR CORRIDA, no una por dia vivo ──────
--
-- La llave es el PAR (dia, intento) y eso es lo caro de esta tabla. Con la llave solo en `dia`, el
-- upsert del intento 2 borraria lo que midio el intento 1 —y `verificados` dejaria de poder sumarse
-- sobre el dia—; y un `onConflictDoUpdate` cuyo target fuera solo `dia` se llevaria por delante la
-- corrida del dia anterior, que es literalmente la deuda que esta tabla viene a cerrar.
--
-- `proximo_intento_en` NO es una columna: se deriva de `iniciada_en + 1 hora` mientras la corrida
-- siga `en_curso` y queden reintentos (CF-06, la cadencia se mide desde el ARRANQUE del intento).
-- Persistir una resta es garantizar que un dia deje de cuadrar con sus sumandos.
--
-- Ningun identificador de vehiculo entra aqui, ni en las columnas ni dentro de `motivos`: son
-- conteos. Un mapa vehiculo -> causa convertiria esta tabla en una lista de VIN con su incidencia.
CREATE TABLE IF NOT EXISTS flito_soat_verificacion_corridas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dia          date        NOT NULL,
  intento      smallint    NOT NULL,
  iniciada_en  timestamptz NOT NULL DEFAULT now(),
  cerrada_en   timestamptz,
  estado       varchar(10) NOT NULL DEFAULT 'en_curso',
  total        integer     NOT NULL DEFAULT 0,
  verificados  integer     NOT NULL DEFAULT 0,
  cambiaron    integer     NOT NULL DEFAULT 0,
  fallidos     integer     NOT NULL DEFAULT 0,
  motivos      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE flito_soat_verificacion_corridas
  DROP CONSTRAINT IF EXISTS flito_soat_verif_corrida_estado_chk;
ALTER TABLE flito_soat_verificacion_corridas
  ADD CONSTRAINT flito_soat_verif_corrida_estado_chk
  CHECK (estado IN ('en_curso', 'completa', 'parcial'));

-- El unico indice de esta tabla. Sirve las dos lecturas del cron —el agregado del dia
-- (`WHERE dia = $1`, por prefijo izquierdo) y la fila del ultimo intento (`WHERE dia = $1 AND
-- intento = $2`, por la llave entera)— y ES la restriccion de unicidad que hace posible el upsert.
-- Un indice extra sobre (dia) seria redundante.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_verif_corrida_dia_intento
  ON flito_soat_verificacion_corridas (dia, intento);

COMMENT ON TABLE flito_soat_verificacion_corridas IS
  'Feature #12075 (HU #12096): una fila por CORRIDA de la verificacion diaria de vigencia del SOAT, '
  'con llave (dia, intento). Sustituye a la clave system_kv[flito-soat.vigencia.corrida-dia] de la '
  'HU #12095, que el dia siguiente sobrescribia: con una sola clave la constancia del AC5 era '
  'efimera y no se podia responder «que dias quedaron a medias este mes». estado usa el MISMO '
  'vocabulario que el EstadoCorrida del cron. proximo_intento_en no es columna: se deriva de '
  'iniciada_en + 1 hora. Sin identificadores de vehiculo, aqui ni en motivos.';

COMMENT ON COLUMN flito_soat_verificacion_corridas.fallidos IS
  'Vehiculos que quedaron sin verificar por indisponibilidad de la fuente. Mayor que cero es lo '
  'UNICO que reprograma el reintento horario, asi que contar aqui un fallido como verificado apaga '
  'el reintento en silencio y para siempre.';

COMMENT ON COLUMN flito_soat_verificacion_corridas.motivos IS
  'Vocabulario CERRADO (timeout | red | circuito | otro) con su conteo, mas `reintentos` (total de '
  'consultas repetidas de la corrida). Nunca un err.message como clave: el mensaje de un tercero '
  'puede traer dentro la placa o el VIN con los que se consulto, y logger no redacta lo que no '
  'reconoce.';

-- ── 3. El indice que el recorrido necesita ─────────────────────────────────
--
-- El censo del AC2 pregunta, por cada SOAT candidato, si existe un soporte VIVO de tipo
-- `factura_soat` colgando de el. Hasta hoy `flito_soportes` no tenia NINGUN indice por `soat_id`
-- solo: los tres que hay son parciales sobre otras FK (`siigo_factura_id`, `conciliacion_boleta_id`)
-- o sobre otro tipo (`factura_venta`), asi que ese EXISTS recorria la tabla entera.
--
-- **NO es unico**, al reves que su vecino `idx_flito_soportes_soat_factura_venta`: `factura_soat`
-- SI puede repetirse por SOAT. Por eso mismo el censo usa EXISTS y no un JOIN — un join duplicaria
-- la fila del SOAT una vez por comprobante e inflaria el total de la corrida.
CREATE INDEX IF NOT EXISTS idx_flito_soportes_soat_tipo
  ON flito_soportes (soat_id, tipo)
  WHERE soat_id IS NOT NULL AND descartado = false;

-- ── `verificada_en` NO se indexa, y esto es lo que hay que leer antes de anadirlo ──────────
--
-- Este archivo llego a traer un `CREATE INDEX ... ON flito_soat (verificada_en)`. Se RETIRO en el
-- gate de esquema por INERTE, y las dos razones estan medidas:
--
--   1. **El orden no encaja.** Un btree se declara `ASC NULLS LAST` por defecto, y solo puede suplir
--      ese mismo orden hacia adelante o `DESC NULLS FIRST` hacia atras. El censo pide
--      `ASC NULLS FIRST` —lo nunca verificado primero—, que no es ninguno de los dos. Medido con
--      EXPLAIN sobre un indice analogo de la BD local y con `enable_seqscan = off`: sale
--      `Sort (NULLS FIRST) -> Seq Scan` aunque se penalice el seqscan a 1e10.
--   2. **El predicado tampoco lo usaria.** El censo filtra
--      `verificada_en IS NULL OR verificada_en < corte`: un OR de baja selectividad y SIN `LIMIT`,
--      donde seq scan + sort gana siempre. Y el unico otro lector de la columna —el filtro de
--      vigencia de la cola— discrimina por `estado_vigencia` y `vence_el`, no por esta.
--
-- Declararlo `NULLS FIRST` tampoco servia: con el censo actual el planificador seguiria prefiriendo
-- seq scan + sort hasta que el volumen crezca, y quedaria un indice sin usar con un comentario
-- prometiendo de mas.
--
-- **Cuando SI habra que indexarla:** el dia que exista una consulta de antiguedad con `LIMIT` —un
-- «los N mas viejos» para un tablero, que es lo que el Feature #12075 acabara pidiendo—. Entonces se
-- crea con la MISMA clausula de orden que use esa consulta y se comprueba con EXPLAIN que entra.
-- Anadirlo sin esa consulta y sin esa medicion es reintroducir esto.

-- ── 4. La clave de system_kv se retira, con constancia en el log del CD ─────
--
-- El NOTICE va inmediatamente ANTES del DELETE y no al principio del archivo: si algo de arriba
-- aborta, no se borra nada y el aviso habria sido falso. Es el mismo patron que la 0176 usa antes de
-- suprimir `observacion_rechazo`.
--
-- Lo que se dice al log es el DIA, el ESTADO y los INTENTOS de la ultima corrida que el KV guardaba
-- —nada de PII: ahi dentro nunca hubo mas que conteos—, para que quede constancia de que se retiro
-- un estado vivo y de cual era. **Cero backfill hacia la tabla nueva** (regla de la 0174): de las
-- corridas anteriores no consta NADA por corrida —el KV guardaba solo la ultima, machacada cada
-- dia— y fabricar una fila con el dia que quedara ahi seria inventar un intento que nadie observo.
--
-- La consulta vive dentro de un IF EXISTS sobre `system_kv` porque plpgsql no resuelve las
-- referencias hasta que la sentencia se EJECUTA: en un entorno sin esa tabla la rama no se toma y no
-- es un 42P01.
DO $kv$
DECLARE
  v_estado jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'system_kv'
  ) THEN
    SELECT v INTO v_estado FROM system_kv WHERE k = 'flito-soat.vigencia.corrida-dia';

    IF v_estado IS NULL THEN
      RAISE NOTICE 'HU #12096: no habia estado de corrida en system_kv; nada que retirar.';
    ELSE
      RAISE NOTICE 'HU #12096: se retira el estado provisional de system_kv (dia %, estado %, intentos %, verificados %, pendientes %). Pasa a flito_soat_verificacion_corridas, que guarda una fila por corrida. Sin backfill: de las corridas anteriores solo constaba la ultima.',
        v_estado->>'dia', v_estado->>'estado', v_estado->>'intentos',
        v_estado->>'verificados', v_estado->>'pendientes';

      DELETE FROM system_kv WHERE k = 'flito-soat.vigencia.corrida-dia';
    END IF;
  END IF;
END
$kv$;
