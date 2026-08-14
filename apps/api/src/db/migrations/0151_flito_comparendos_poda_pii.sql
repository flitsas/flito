-- 0151_flito_comparendos_poda_pii.sql
-- Feature #11492 (17a) — Monitoreo de comparendos. HU #11511 (poda de PII, retención y acceso).
-- Autor: equipo FLITO. Motivo: cerrar el hallazgo del gate de seguridad de la HU #11500 — los
-- `payload_simit` / `payload_municipal` empezaron a poblarse con esa HU y guardaban la respuesta
-- ÍNTEGRA del proveedor. En SIMIT eso arrastra normalmente el NOMBRE y el DOCUMENTO del infractor,
-- que es una PERSONA NATURAL y no la empresa monitoreada: datos personales de un tercero (Ley 1581)
-- guardados en claro, sin registro de acceso y sin purga.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente: se puede
-- re-aplicar entera sin efecto adicional.
--
-- Diseño: docs/features/flito-comparendos-ingesta-parametrizacion.md
-- Decisiones: ADR-0003 (homologación); decisión humana del 2026-08-13 (podar, no cifrar).
--
-- ============================================================================
-- QUÉ HACE ESTE ARCHIVO Y QUÉ **NO**
-- ============================================================================
--
-- Hace tres cosas, y ninguna cambia la FORMA de ninguna tabla:
--
--   1. GRANT DELETE sobre los dos padres, que es lo que la purga necesita para poder borrar.
--   2. La poda ONE-SHOT de los payloads YA escritos (lo que el código nuevo evita de aquí en
--      adelante, esto lo arregla hacia atrás).
--   3. Actualiza los COMMENT de las dos columnas para que digan la política vigente.
--
-- **No** añade columnas, no crea la lista blanca como catálogo y no toca `flito_comparendos_field_map`.
-- La lista blanca se DERIVA en tiempo de ejecución de los `source_path` de la versión vigente del
-- `field_map` (ver `flito-comparendos-merge.ts`, RN-25). Esto es deliberado y es el punto del
-- diseño: añadir un campo a la lista blanca es INSERTAR UNA FILA en el `field_map`, sin migración,
-- sin despliegue y sin dos fuentes de verdad que se desincronicen.

-- ── 1. Permisos: el DELETE que la 0150 dejó pendiente a propósito ───────────
--
-- La 0150 concedió SELECT/INSERT/UPDATE y ningún DELETE, y lo dejó escrito: «sin DELETE, la purga
-- que exige esa política NO podrá borrar nada bajo operaciones_app. La HU que la implemente
-- necesitará su propia migración». Esta es esa migración.
--
-- Basta con los DOS PADRES:
--
--   · `flito_comparendos_eventos` cae por el ON DELETE CASCADE de su FK a `registros`.
--   · `flito_comparendos_sync_steps` cae por el ON DELETE CASCADE de su FK a `sync_runs`.
--
-- Y eso no es un descuido de permisos: PostgreSQL ejecuta las acciones referenciales (el CASCADE)
-- con los privilegios del DUEÑO de la tabla, no con los del rol que dispara el DELETE. Conceder
-- DELETE también sobre los hijos solo abriría la puerta a borrarlos SUELTOS —sin su padre—, que es
-- justo lo que la 0150 quiso impedir: los eventos y los pasos son el rastro de lo que pasó, y
-- borrarlos por separado es borrar la prueba dejando el registro que la contradice.
--
-- Lo que este GRANT habilita sigue siendo estrecho: `flito-comparendos-purga.cron.ts` borra por
-- ANTIGÜEDAD (`ultimo_visto_en` / `iniciado_en` por debajo del corte de COMPARENDOS_RETENTION_MONTHS)
-- y no hay ni habrá endpoint que borre un comparendo — un comparendo que desaparece de la fuente se
-- INACTIVA (CF-10), no se borra.
--
-- El guard por `pg_roles` es el mismo de la 0150: en docker-compose el POSTGRES_USER es
-- `operaciones_app` y en otras instalaciones no existe; sin él la cadena moriría con
-- `role ... does not exist`.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT DELETE ON flito_comparendos_registros TO operaciones_app;
    GRANT DELETE ON flito_comparendos_sync_runs TO operaciones_app;
  END IF;
END $$;

-- ── 2. Poda one-shot de lo ya escrito ───────────────────────────────────────
--
-- El código nuevo poda ANTES de persistir, así que a partir de este despliegue no entra un campo de
-- persona más. Esto es lo otro: las filas que la HU #11500 ya escribió con la respuesta íntegra.
--
-- Va en la migración y no en un script suelto a propósito. Un «procedimiento documentado» que hay
-- que acordarse de ejecutar en cada ambiente es un procedimiento que en algún ambiente no se
-- ejecuta, y el ambiente olvidado se queda con los datos del infractor en claro. La cadena de
-- migraciones ya corre en todos.
--
-- Cómo funciona: se lee la lista blanca del `field_map` VIGENTE (la versión máxima, igual que el
-- merge en tiempo de ejecución) y se reescribe cada payload quedándose solo con esas claves. La
-- misma lista, la misma versión y el mismo criterio que aplicará el sync en su próxima corrida.
--
-- Propiedades:
--
--   · **Idempotente.** La segunda pasada no encuentra nada que cambiar (`IS DISTINCT FROM`), así que
--     no reescribe filas ni infla la tabla con versiones muertas.
--   · **No toca `updated_at`.** Esto es una corrección de protección de datos, no un cambio de
--     negocio: hacer que 17b lea «este comparendo cambió hoy» sería mentir en la pantalla.
--   · **La lista blanca vacía NO poda: protege.** El criterio, y es POR ORIGEN y no global (gate de
--     db-review): un origen cuya lista blanca sale vacía se deja EXACTAMENTE COMO ESTÁ y se dice en
--     un `RAISE NOTICE`; el otro se poda igual si su lista sí tiene contenido. Sin esto bastaba con
--     que la versión vigente del mapa cubriera un solo origen —una v2 solo-SIMIT, que es justo lo
--     que el spike #11501 va a sembrar— para que el `coalesce(…, '{}')` dejara el array del otro
--     vacío y el `CASE` reescribiera TODOS sus payloads a `{}`, irreversiblemente. El guard global
--     por `v_version IS NULL` no cubría ese caso porque el mapa no estaba vacío: estaba incompleto.
--     Podar un origen con la lista del otro nunca fue una opción, así que podar solo el que tiene
--     lista es lo máximo que se puede hacer con seguridad, y no hacer nada en el otro es exactamente
--     lo que el runtime hace ahora (`podarPayload` devuelve `null` con lista vacía).
--   · **Solo se conservan valores ESCALARES.** La lista blanca filtra por clave; esto filtra por
--     forma. Un `source_path` permitido cuyo valor sea un subárbol —`"valorAPagar": { "total": …,
--     "titular": { "nombre": …, "documento": … } }`— guardaría la PII bajo una clave autorizada, y
--     además `homologar` no sabe leer un objeto: es dato que no sirve para re-mergear y sí para
--     filtrarse. Mismo criterio que `esEscalarPersistible` en el merge.
--   · **`__proto__`, `constructor` y `prototype` no se persisten** aunque el mapa los liste. En el
--     JSONB no contaminan nada por sí solos, pero dejan la fila cargada para el primer consumidor
--     que la rehidrate con `Object.assign` (RN-14). No son campos legítimos de un proveedor.
--
-- Para re-ejecutarla a mano (por ejemplo tras subir el mapa a v2, si se quiere volver a estrechar):
-- copiar este bloque DO tal cual y correrlo con psql. Es el mismo SQL y no depende de nada más.
--
-- Y la contrapartida, que se asume a conciencia (decisión humana del 2026-08-13): esto es
-- IRREVERSIBLE. Si el spike #11501 descubre que hacía falta un campo que se podó, no se puede
-- re-mergear desde el JSONB — hay que volver a consultar al proveedor. Se cambia una pérdida de
-- datos recuperable por una fuga de datos personales que no lo es.

DO $$
DECLARE
  v_version    integer;
  v_simit      text[];
  v_municipal  text[];
  v_filas      bigint;
BEGIN
  SELECT max(version) INTO v_version FROM flito_comparendos_field_map;

  IF v_version IS NULL THEN
    RAISE NOTICE '0151: field_map vacio -> sin lista blanca, no se poda ningun payload';
    RETURN;
  END IF;

  -- El filtro por `target_field` es el MISMO que aplica el runtime al cargar el mapa
  -- (`CAMPOS_CANONICOS` en `flito-comparendos-merge.ts`): `target_field` es una columna de texto
  -- libre y el merge ignora las filas que no apuntan a un campo canónico, así que sus `source_path`
  -- NO están en la lista blanca de la aplicación. Sin este filtro las dos listas podían separarse —
  -- la de la migración más ancha que la del runtime— y el `source_path` de una fila con
  -- `target_field` inventado sobrevivía INTACTO en los payloads ya escritos, que son precisamente
  -- las filas que llevan la PII. Y el escenario no es hipotético: el spike #11501 va a insertar
  -- filas exploratorias sin pasar por revisión de código, que es el punto de que el mapa sea tabla.
  -- Si esta lista y `CAMPOS_CANONICOS` divergen algún día, esta migración poda de MENOS (deja algún
  -- campo que el runtime ya no lee) y nunca de más: el error cae del lado que no borra datos.
  SELECT
    coalesce(array_agg(DISTINCT source_path) FILTER (WHERE origen = 'simit'), '{}')::text[],
    coalesce(array_agg(DISTINCT source_path) FILTER (WHERE origen = 'municipal'), '{}')::text[]
  INTO v_simit, v_municipal
  FROM flito_comparendos_field_map
  WHERE version = v_version
    AND target_field IN (
      'numeroComparendo', 'placa', 'codigoInfraccion', 'descripcionInfraccion',
      'fechaComparendo', 'organismo', 'monto', 'estadoFuente'
    )
    AND source_path NOT IN ('__proto__', 'constructor', 'prototype');

  -- Lista vacía = «este origen no lo describe el mapa vigente», NO «de este origen no se conserva
  -- nada». Se avisa y se deja el payload intacto; el otro origen se poda igual si su lista sí tiene
  -- contenido. Los dos vacíos = no hay nada que hacer y se sale sin tocar una fila.
  IF cardinality(v_simit) = 0 THEN
    RAISE NOTICE '0151: field_map v% no mapea NINGUN campo canonico del origen simit -> payload_simit se deja INTACTO (no se poda)', v_version;
  END IF;
  IF cardinality(v_municipal) = 0 THEN
    RAISE NOTICE '0151: field_map v% no mapea NINGUN campo canonico del origen municipal -> payload_municipal se deja INTACTO (no se poda)', v_version;
  END IF;
  IF cardinality(v_simit) = 0 AND cardinality(v_municipal) = 0 THEN
    RAISE NOTICE '0151: ningun origen tiene lista blanca utilizable en la v% -> no se poda nada', v_version;
    RETURN;
  END IF;

  WITH podado AS (
    SELECT
      r.id,
      -- `jsonb_typeof(...) = 'object'` porque `jsonb_each` revienta sobre un array o un escalar: un
      -- payload que no sea un objeto no es podable y se deja como está (no debería existir, pero la
      -- columna es JSONB libre y una migración no es sitio para un ERROR evitable).
      CASE WHEN cardinality(v_simit) > 0 AND jsonb_typeof(r.payload_simit) = 'object'
        THEN coalesce((
          SELECT jsonb_object_agg(e.key, e.value)
          FROM jsonb_each(r.payload_simit) e
          WHERE e.key = ANY (v_simit)
            AND jsonb_typeof(e.value) IN ('string', 'number', 'boolean', 'null')
        ), '{}'::jsonb)
        ELSE r.payload_simit
      END AS nuevo_simit,
      CASE WHEN cardinality(v_municipal) > 0 AND jsonb_typeof(r.payload_municipal) = 'object'
        THEN coalesce((
          SELECT jsonb_object_agg(e.key, e.value)
          FROM jsonb_each(r.payload_municipal) e
          WHERE e.key = ANY (v_municipal)
            AND jsonb_typeof(e.value) IN ('string', 'number', 'boolean', 'null')
        ), '{}'::jsonb)
        ELSE r.payload_municipal
      END AS nuevo_municipal
    FROM flito_comparendos_registros r
    WHERE r.payload_simit IS NOT NULL OR r.payload_municipal IS NOT NULL
  )
  UPDATE flito_comparendos_registros r
  SET payload_simit = p.nuevo_simit,
      payload_municipal = p.nuevo_municipal
  FROM podado p
  WHERE p.id = r.id
    AND (r.payload_simit IS DISTINCT FROM p.nuevo_simit
      OR r.payload_municipal IS DISTINCT FROM p.nuevo_municipal);

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  RAISE NOTICE '0151: payloads podados a la lista blanca del field_map v% (simit: % campo(s), municipal: % campo(s)) en % fila(s)',
    v_version, cardinality(v_simit), cardinality(v_municipal), v_filas;
END $$;

-- ── 3. Los COMMENT dicen la política vigente ────────────────────────────────
--
-- La 0150 los dejó describiendo la política ANTERIOR («el proveedor suele devolver nombre y
-- documento del infractor, que el canónico NO mapea»). Quien abra la tabla con un cliente SQL tiene
-- que leer lo que hay HOY en la columna, no lo que hubo entre dos HUs.

COMMENT ON COLUMN flito_comparendos_registros.payload_simit IS
  'Respuesta de la fuente PODADA a lista blanca (HU #11511): solo los source_path del field_map '
  'vigente, que es lo unico que permite re-homologar sin re-consultar (ADR-0003). Los campos de '
  'PERSONA del infractor -nombre, documento y similares- NO se persisten: se descartan antes del '
  'INSERT. Retencion: COMPARENDOS_RETENTION_MONTHS (purga en flito-comparendos-purga.cron.ts). '
  'Prohibido exponerla cruda por API o log; toda lectura pasa por registrarAccesoComparendos.';

COMMENT ON COLUMN flito_comparendos_registros.payload_municipal IS
  'Respuesta del municipio (UTS) PODADA a lista blanca. Mismo tratamiento que payload_simit: solo '
  'source_path del field_map vigente, sin campos de persona, retencion '
  'COMPARENDOS_RETENTION_MONTHS, prohibido exponerla cruda por API o log.';
