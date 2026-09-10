-- 0182_tarifas_vigencias.sql
-- Feature #12365 — Tarifas como vigencias con historial. HU #12373 (eslabon 1 de 2): la tarifa de
--   una compania deja de ser una fila que se sobreescribe (0110) y pasa a ser una secuencia de
--   VIGENCIAS [vigente_desde, vigente_hasta) por (compania, concepto, tipo). La abierta se cobra;
--   cambiar un valor cierra la abierta y abre otra; dejar de cobrar cierra sin abrir. Nunca se borra.
-- Autor: equipo FLITO. Antecedentes: 0110 (flito_tarifas_compania), 0179/0181 (catalogo y reparto
--   de permisos), ADR-DB-001 (sin control de transaccion propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado
--     y ninguna etiqueta se cita con sus dolares en un comentario (el escaner corre antes de quitarlos).
--   - Idempotente en sentido fuerte: la 2a pasada no toca una fila. La marca de «primera pasada» es
--     que exista la tabla vieja: el desdoble corre solo si to_regclass la encuentra, y la deja caida.
--   - Aborta (RAISE EXCEPTION) y no adivina cuando el dato viejo no cabe en el modelo nuevo: tipo
--     fuera del catalogo, o dos logisticas ACTIVAS con valor distinto en la misma compania.
--   - Los DELETE/INSERT de permisos van en forma parseable por __tests__/helpers/permisos-seed-sql.ts.
--     Es el PRIMER retiro de funcion que ve el motor: `parametrizacion.tarifas.borrar` desaparece.
--   - Requiere btree_gist (contrib). Antes del merge, contra la base del ambiente:
--       SELECT installed_version, default_version FROM pg_available_extensions WHERE name='btree_gist';
--     Si default_version es NULL, instalar postgresql-16-contrib en el host; el paso 0 lo dice.

-- ── Paso 0 — La extension que hace posible EXCLUDE sobre (int, text, tstzrange) ─────────────────
DO $ext0182$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist') THEN
    RAISE EXCEPTION '0182: btree_gist no esta disponible en este servidor (falta el paquete contrib). Sin ella no hay constraint de no-solape; instalela y relance el despliegue.';
  END IF;
  CREATE EXTENSION IF NOT EXISTS btree_gist;
END $ext0182$;

-- ── Paso 1 — La tabla de vigencias ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_tarifas_vigencias (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id    integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  concepto       varchar(30) NOT NULL,
  -- 'MATRICULA' | 'TRASPASO' | 'OTROS' para tramite_digital; NULL siempre para logistica.
  tipo_tramite   varchar(20),
  valor          numeric(14,2) NOT NULL,
  vigente_desde  timestamptz NOT NULL DEFAULT now(),
  -- NULL = abierta (es la que se cobra). Rango semiabierto [desde, hasta).
  vigente_hasta  timestamptz,
  fijado_por_id  integer REFERENCES users(id),
  fijado_en      timestamptz NOT NULL DEFAULT now(),
  cerrado_por_id integer REFERENCES users(id),
  cerrado_en     timestamptz,
  CONSTRAINT flito_tarifas_vigencias_concepto_chk CHECK (concepto IN ('tramite_digital', 'logistica')),
  -- El IS NOT NULL no sobra: `NULL IN (...)` es NULL y un CHECK con resultado NULL deja pasar la fila.
  CONSTRAINT flito_tarifas_vigencias_tipo_chk CHECK (
    (concepto = 'tramite_digital' AND tipo_tramite IS NOT NULL AND tipo_tramite IN ('MATRICULA', 'TRASPASO', 'OTROS'))
    OR (concepto = 'logistica' AND tipo_tramite IS NULL)),
  CONSTRAINT flito_tarifas_vigencias_valor_chk  CHECK (valor >= 0),
  -- >= y no >: una tarifa creada inactiva y nunca activada es el rango vacio [t, t), que no solapa.
  CONSTRAINT flito_tarifas_vigencias_rango_chk  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
  CONSTRAINT flito_tarifas_vigencias_cierre_chk CHECK ((vigente_hasta IS NULL) = (cerrado_en IS NULL)),
  -- Sin solapes dentro de una llave. Dos abiertas [a,inf) y [b,inf) siempre solapan, asi que esta
  -- constraint tambien garantiza «una sola abierta»; el indice parcial de abajo es redundante a
  -- proposito: es el que el servicio atrapa como 23505 y convierte en 409 (esta da 23P01).
  CONSTRAINT flito_tarifas_vigencias_sin_solape EXCLUDE USING gist (
    compania_id WITH =,
    concepto WITH =,
    (COALESCE(tipo_tramite, '')::text) WITH =,
    (tstzrange(vigente_desde, vigente_hasta, '[)')) WITH &&)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_tarifas_vigencias_abierta
  ON flito_tarifas_vigencias (compania_id, concepto, COALESCE(tipo_tramite, ''))
  WHERE vigente_hasta IS NULL;

-- Resolver la tarifa de un tramite y listar el historial es siempre «esta compania, este concepto».
CREATE INDEX IF NOT EXISTS idx_flito_tarifas_vigencias_compania_concepto
  ON flito_tarifas_vigencias (compania_id, concepto);

COMMENT ON TABLE flito_tarifas_vigencias IS
  'Vigencias de tarifa negociada por compania (HU #12373). Una llave (compania, concepto, tipo) es una '
  'secuencia de rangos [vigente_desde, vigente_hasta) sin solapes; la abierta (hasta NULL) se cobra. '
  'No se borra ni se sobreescribe: cambiar = cerrar y abrir en una transaccion.';
COMMENT ON COLUMN flito_tarifas_vigencias.tipo_tramite IS
  'MATRICULA | TRASPASO | OTROS para tramite_digital (catalogo cerrado, shared-types TIPOS_TRAMITE_TARIFA); NULL para logistica.';
COMMENT ON COLUMN flito_tarifas_vigencias.vigente_hasta IS
  'NULL = vigencia abierta. Rango semiabierto: el instante de cierre ya pertenece a la vigencia siguiente.';

-- ── Paso 2 — Desdoble de flito_tarifas_compania (solo la primera pasada) ─────────────────────────
-- Una vigencia por llave, elegida por prioridad: especifica activa > generica activa > especifica
-- inactiva > generica inactiva. Es la misma regla con la que tarifaDe() resolvia ayer (la especifica
-- manda, la inactiva no cuenta), asi que lo que se cobra hoy es lo que se cobraba ayer. Las filas que
-- pierden la prioridad se descartan con NOTICE: quedan en el pg_dump previo y en audit_logs.
-- La generica de tramite_digital (tipo NULL) se desdobla en las tres vigencias explicitas con el
-- mismo valor, vigente_desde = created_at y fijado_por = actualizado_por_id.
-- Una tarifa inactiva migra CERRADA con vigente_hasta = cerrado_en = updated_at: PATCH activo=false
-- bumpeaba updated_at, asi que es la mejor evidencia disponible de cuando dejo de cobrarse.
DO $desdoble0182$
DECLARE
  n int; lista text; n_td int; n_lg int; n_cand int;
BEGIN
  IF to_regclass('public.flito_tarifas_compania') IS NULL THEN
    RAISE NOTICE '0182: flito_tarifas_compania ya no existe — el desdoble corrio en una pasada anterior';
    RETURN;
  END IF;

  -- 2a. Abortos: lo que el modelo nuevo no puede representar lo decide una persona, no esta migracion.
  SELECT count(*), string_agg(format('compania %s tipo %L', compania_id, tipo_tramite), ', ')
    INTO n, lista
    FROM flito_tarifas_compania
   WHERE concepto = 'tramite_digital' AND tipo_tramite IS NOT NULL
     AND upper(unaccent(trim(tipo_tramite))) NOT IN ('MATRICULA', 'TRASPASO', 'OTROS');
  IF n > 0 THEN
    RAISE EXCEPTION '0182: % tarifa(s) de tramite_digital con tipo fuera del catalogo (Matricula, Traspaso, Otros): %. Corrija o retire esas filas y relance.', n, lista;
  END IF;

  SELECT count(*), string_agg(format('compania %s (valores %s)', compania_id, valores), ', ') INTO n, lista
    FROM (SELECT compania_id, string_agg(DISTINCT valor::text, ' y ') AS valores
            FROM flito_tarifas_compania
           WHERE concepto = 'logistica' AND activo
           GROUP BY compania_id HAVING count(DISTINCT valor) > 1) c;
  IF n > 0 THEN
    RAISE EXCEPTION '0182: % compania(s) con dos logisticas ACTIVAS de valor distinto: %. Deje una sola por compania y relance.', n, lista;
  END IF;

  -- 2b. Tramite digital: candidatas = especificas (tal cual) + genericas (x3 tipos), una elegida por llave.
  WITH candidatas AS (
    SELECT compania_id, upper(unaccent(trim(tipo_tramite))) AS tipo, valor, activo,
           created_at, updated_at, actualizado_por_id,
           CASE WHEN activo THEN 1 ELSE 3 END AS prioridad
      FROM flito_tarifas_compania
     WHERE concepto = 'tramite_digital' AND tipo_tramite IS NOT NULL
    UNION ALL
    SELECT t.compania_id, x.tipo, t.valor, t.activo,
           t.created_at, t.updated_at, t.actualizado_por_id,
           CASE WHEN t.activo THEN 2 ELSE 4 END
      FROM flito_tarifas_compania t
      CROSS JOIN (VALUES ('MATRICULA'), ('TRASPASO'), ('OTROS')) AS x(tipo)
     WHERE t.concepto = 'tramite_digital' AND t.tipo_tramite IS NULL
  ), elegidas AS (
    SELECT DISTINCT ON (compania_id, tipo) *
      FROM candidatas
     ORDER BY compania_id, tipo, prioridad, created_at DESC
  ), insertadas AS (
    INSERT INTO flito_tarifas_vigencias
      (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta,
       fijado_por_id, fijado_en, cerrado_por_id, cerrado_en)
    SELECT compania_id, 'tramite_digital', tipo, valor, created_at,
           CASE WHEN activo THEN NULL ELSE GREATEST(updated_at, created_at) END,
           actualizado_por_id, created_at,
           CASE WHEN activo THEN NULL ELSE actualizado_por_id END,
           CASE WHEN activo THEN NULL ELSE GREATEST(updated_at, created_at) END
      FROM elegidas
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM insertadas), (SELECT count(*) FROM candidatas) INTO n_td, n_cand;
  RAISE NOTICE '0182: tramite_digital — % vigencias creadas de % candidatas (% descartadas por prioridad)', n_td, n_cand, n_cand - n_td;

  -- 2c. Logistica: una por compania. Con activas (todas del mismo valor, 2a lo garantiza) gana la MAS
  --     ANTIGUA para que vigente_desde sea el inicio real del cobro; sin activas, la inactiva mas
  --     reciente cierra la historia. El tipo, si alguna lo traia, se ignora: logistica va sin tipo.
  WITH candidatas AS (
    SELECT compania_id, valor, activo, created_at, updated_at, actualizado_por_id,
           CASE WHEN activo THEN 1 ELSE 2 END AS prioridad
      FROM flito_tarifas_compania WHERE concepto = 'logistica'
  ), elegidas AS (
    SELECT DISTINCT ON (compania_id) *
      FROM candidatas
     ORDER BY compania_id, prioridad, CASE WHEN activo THEN created_at END ASC, updated_at DESC
  ), insertadas AS (
    INSERT INTO flito_tarifas_vigencias
      (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta,
       fijado_por_id, fijado_en, cerrado_por_id, cerrado_en)
    SELECT compania_id, 'logistica', NULL, valor, created_at,
           CASE WHEN activo THEN NULL ELSE GREATEST(updated_at, created_at) END,
           actualizado_por_id, created_at,
           CASE WHEN activo THEN NULL ELSE actualizado_por_id END,
           CASE WHEN activo THEN NULL ELSE GREATEST(updated_at, created_at) END
      FROM elegidas
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM insertadas), (SELECT count(*) FROM candidatas) INTO n_lg, n_cand;
  RAISE NOTICE '0182: logistica — % vigencias creadas de % filas (% colapsadas)', n_lg, n_cand, n_cand - n_lg;

  -- 2d. La tabla vieja cae aqui, dentro de la misma transaccion del runner: si algo de arriba fallo,
  --     no llegamos; si llegamos, el modelo viejo no puede seguir siendo escrito por un binario viejo.
  DROP TABLE flito_tarifas_compania;
  RAISE NOTICE '0182: flito_tarifas_compania retirada';
END $desdoble0182$;

-- ── Paso 3 — Permisos: dos funciones nuevas, un retiro, y el auditor fuera de las tarifas ─────────
-- Las dos lineas de INSERT en permisos_funciones son SALIDA de `npm run permisos:seed -w apps/api`
-- sobre la foto ampliada (inventario.generado.ts) y recortadas a estas dos: el test estatico de la
-- 0179 las compara con lo que el generador produce hoy.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('parametrizacion.tarifas.historial', 'parametrizacion', 'Ver el historial de tarifas de una compañía', 'Consultar las vigencias pasadas y presentes de cada concepto, con quién las fijó y quién las cerró.', 'operacion'),
  ('parametrizacion.tarifas.ver_por_cliente', 'parametrizacion', 'Ver las tarifas de una compañía', 'Consultar el valor vigente de cada concepto de una compañía y quién lo fijó.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'parametrizacion.tarifas.historial'),
  ('admin', 'parametrizacion.tarifas.ver_por_cliente'),
  ('financiera', 'parametrizacion.tarifas.historial'),
  ('financiera', 'parametrizacion.tarifas.ver_por_cliente')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Retiros. Orden obligado por el RESTRICT de la 0179: primero el reparto, luego la funcion.
-- `borrar` desaparece porque una vigencia no se borra (se cierra). El auditor deja de ver el cuadro de
-- tarifas por decision de producto de esta HU (AC16): es la primera lectura que se le retira y la
-- excepcion la lleva permisos.auditor-observa.test.ts con nombre. Un DELETE sin filas que casen no
-- toca nada: la 2a pasada sigue siendo de cero filas.
DELETE FROM permisos_rol_funcion WHERE (rol_codigo, funcion_codigo) IN (
  ('admin', 'parametrizacion.tarifas.borrar'),
  ('auditor', 'parametrizacion.tarifas.listar'),
  ('financiera', 'parametrizacion.tarifas.borrar')
);
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN ('parametrizacion.tarifas.borrar');
DELETE FROM permisos_funciones WHERE codigo IN ('parametrizacion.tarifas.borrar');

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0182$
DECLARE n_abiertas int; n_cerradas int; n_borrar int; n_nuevas int; n_auditor int;
BEGIN
  SELECT count(*) FILTER (WHERE vigente_hasta IS NULL), count(*) FILTER (WHERE vigente_hasta IS NOT NULL)
    INTO n_abiertas, n_cerradas FROM flito_tarifas_vigencias;
  SELECT count(*) INTO n_borrar  FROM permisos_funciones WHERE codigo = 'parametrizacion.tarifas.borrar';
  SELECT count(*) INTO n_nuevas  FROM permisos_funciones WHERE codigo IN ('parametrizacion.tarifas.historial', 'parametrizacion.tarifas.ver_por_cliente');
  SELECT count(*) INTO n_auditor FROM permisos_rol_funcion WHERE rol_codigo = 'auditor' AND funcion_codigo LIKE 'parametrizacion.tarifas.%';
  IF n_borrar > 0 OR n_nuevas <> 2 OR n_auditor > 0 THEN
    RAISE EXCEPTION '0182: permisos inconsistentes — borrar=% (esperado 0), nuevas=% (esperado 2), auditor en tarifas=% (esperado 0)', n_borrar, n_nuevas, n_auditor;
  END IF;
  RAISE NOTICE '0182: % vigencias abiertas, % cerradas; catalogo: borrar retirada, 2 funciones nuevas, auditor sin tarifas', n_abiertas, n_cerradas;
END $resumen0182$;
