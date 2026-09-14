-- 0191_servicios_adicionales_tipos.sql
-- Feature #12540 — HU #12541: catálogo de tipos de servicio adicional con baja lógica y permisos.
--   · DDL: tabla `flito_servicios_adicionales_tipos` + índice único parcial sobre el nombre PLEGADO
--     (minúsculas, sin tilde) de los tipos ACTIVOS: dar de baja libera el nombre; dos activos no lo
--     comparten aunque difieran en mayúsculas o tildes.
--   · Semilla del catálogo inicial (3 tipos, valor 0, sin autor: el admin nace después que la migración).
--   · Semilla de las 4 funciones `parametrizacion.servicios_adicionales.*` + reparto a `admin` y
--     `financiera` (el mismo reparto que las tarifas: es la parte comercial, la negocia Finanzas).
-- Autor: equipo FLITO. Antecedentes: 0182 (índice parcial con expresión, translate() y no unaccent()),
--   0190 (baja lógica + FK RESTRICT + estilo de siembra), ADR-0005 (FK en pareja con marca de tiempo).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en su propia transaccion.
--   - Idempotente: CREATE TABLE/INDEX IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING.
--   - Dollar-quoting ETIQUETADO en el bloque DO; la etiqueta no se nombra en ningun comentario.
--   - Ninguna linea del archivo empieza por «(» + comilla salvo las tuplas de siembra de permisos: el
--     test de la 0179 compara esas lineas con lo que produce generar-seed-permisos.ts. Las tuplas del
--     catálogo van en UNA sola línea por eso mismo.
--   - translate() y no unaccent(): DEV no tiene la extensión (memoria: la 0182 abortó el CD por eso).

-- ── Paso 1 — La tabla ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_servicios_adicionales_tipos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre varchar(120) NOT NULL,
  descripcion text,
  valor numeric(14,2) NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  dado_de_baja_en timestamptz,
  dado_de_baja_por_id integer REFERENCES users(id) ON DELETE RESTRICT,
  creado_por_id integer REFERENCES users(id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_por_id integer REFERENCES users(id) ON DELETE RESTRICT,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_serv_adic_tipos_valor_chk CHECK (valor >= 0),
  CONSTRAINT flito_serv_adic_tipos_nombre_chk CHECK (btrim(nombre) <> ''),
  CONSTRAINT flito_serv_adic_tipos_baja_chk CHECK (activo = (dado_de_baja_en IS NULL))
);

COMMENT ON TABLE flito_servicios_adicionales_tipos IS 'HU #12541 catálogo de tipos de servicio adicional. Baja LÓGICA (activo=false + dado_de_baja_en); nunca DELETE ni reactivación. El nombre plegado es único entre los activos.';
COMMENT ON COLUMN flito_servicios_adicionales_tipos.dado_de_baja_por_id IS 'Actor de la baja; FK RESTRICT (nunca hard-delete de users). Acompaña a dado_de_baja_en; el CHECK baja_chk ata activo con la fecha, no con el actor.';
COMMENT ON COLUMN flito_servicios_adicionales_tipos.creado_por_id IS 'Actor del alta; FK RESTRICT. NULL en las filas sembradas por esta migración (sin actor).';
COMMENT ON COLUMN flito_servicios_adicionales_tipos.actualizado_por_id IS 'Último actor que editó nombre, descripción o valor; FK RESTRICT.';

-- ── Paso 2 — Un nombre plegado por tipo ACTIVO ──────────────────────────────────────────────────
-- La MISMA expresión vive en `nombrePlegado()` del servicio; si cambia aquí, cambia allí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_serv_adic_tipos_nombre_activo
  ON flito_servicios_adicionales_tipos (lower(translate(nombre, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')))
  WHERE activo;

-- ── Paso 3 — Catálogo inicial (valor 0: lo fija Finanzas desde la pantalla) ─────────────────────
INSERT INTO flito_servicios_adicionales_tipos (nombre, valor) VALUES ('Paz y salvo de impuestos', 0), ('Diagnóstico', 0), ('Derecho de petición', 0)
ON CONFLICT (lower(translate(nombre, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))) WHERE activo DO NOTHING;

-- ── Paso 4 — Funciones nuevas (admin + financiera) ──────────────────────────────────────────────
-- Formato del generador (generar-seed-permisos.ts): una tupla por linea. Textos de negocio fijados
-- con el diseño slim HU #12541; deben ser byte a byte los de catalogo-operaciones.ts.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('parametrizacion.servicios_adicionales.crear', 'parametrizacion', 'Crear un tipo de servicio adicional', 'Dar de alta un tipo de servicio adicional con su nombre, descripción y valor.', 'operacion'),
  ('parametrizacion.servicios_adicionales.dar_de_baja', 'parametrizacion', 'Dar de baja un tipo de servicio adicional', 'Retirar un tipo del catálogo sin borrarlo. No se reactiva y su nombre queda libre.', 'operacion'),
  ('parametrizacion.servicios_adicionales.editar', 'parametrizacion', 'Editar un tipo de servicio adicional', 'Cambiar el nombre, la descripción o el valor de un tipo activo.', 'operacion'),
  ('parametrizacion.servicios_adicionales.listar', 'parametrizacion', 'Ver los tipos de servicio adicional', 'Consultar el catálogo de tipos de servicio adicional y su valor.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'parametrizacion.servicios_adicionales.crear'),
  ('admin', 'parametrizacion.servicios_adicionales.dar_de_baja'),
  ('admin', 'parametrizacion.servicios_adicionales.editar'),
  ('admin', 'parametrizacion.servicios_adicionales.listar'),
  ('financiera', 'parametrizacion.servicios_adicionales.crear'),
  ('financiera', 'parametrizacion.servicios_adicionales.dar_de_baja'),
  ('financiera', 'parametrizacion.servicios_adicionales.editar'),
  ('financiera', 'parametrizacion.servicios_adicionales.listar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 5 — La cuenta, en el log del CD ────────────────────────────────────────────────────────
DO $resumen0191$
DECLARE n_tipos int; n_funciones int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_tipos FROM flito_servicios_adicionales_tipos WHERE activo;
  SELECT count(*) INTO n_funciones FROM permisos_funciones
   WHERE codigo LIKE 'parametrizacion.servicios_adicionales.%';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo IN ('admin', 'financiera')
     AND funcion_codigo LIKE 'parametrizacion.servicios_adicionales.%';
  RAISE NOTICE '0191: tipos de servicio adicional activos = % (esperados >= 3); funciones = % (esperadas 4); reparto admin+financiera = % (esperados 8)',
    n_tipos, n_funciones, n_reparto;
END $resumen0191$;
