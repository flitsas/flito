-- 0211_permisos_soat_incompletas.sql
-- HU #12997 (Feature #12841, diseño §11.1 opción A) — las DOS funciones de lectura de las solicitudes
--   SOAT del canal Cliente que quedaron guardadas porque el RUNT no respondió: `soat.incompletas.buscar`
--   (POST /api/flito/soat/cliente/incompletas/buscar) y `soat.incompleta.ver` (GET …/incompletas/:id).
--   Son códigos PROPIOS porque el catálogo es «una función por ruta»; se reparten a TODO rol que hoy
--   tenga `soat.cola.ver` / `soat.solicitud.ver`, así quien ve la cola ve también sus incompletas.
-- Autor: equipo FLITO. Antecedentes: 0203/0208 (siembra de operación, reparto en VALUES explícitos),
--   0185 (reparto a roles de fábrica distintos de admin), ADR-DB-001 (sin control de transacción).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra. La anterior es la 0210_ (HU #12996, tabla de incompletas).

-- ── Paso 1 — Las dos operaciones (byte a byte con catalogo-operaciones.ts) ────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('soat.incompletas.buscar', 'soat', 'Ver las solicitudes de SOAT por validar y descartadas', 'Recorrer las solicitudes que quedaron guardadas porque el RUNT no respondió, y las que se descartaron.', 'operacion'),
  ('soat.incompleta.ver',     'soat', 'Ver una solicitud de SOAT por validar o descartada', 'Abrir el detalle de una solicitud guardada sin validar con el RUNT: propietario, factura y motivo del descarte.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto de PARTIDA en VALUES explícitos (forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts para la paridad de la 0179): los cuatro roles de fábrica
--   que tienen de partida `soat.cola.ver` y `soat.solicitud.ver` (GUARDAS_MEDIDAS de `GET /` y `GET /:id`).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin',     'soat.incompletas.buscar'),
  ('admin',     'soat.incompleta.ver'),
  ('auditor',   'soat.incompletas.buscar'),
  ('auditor',   'soat.incompleta.ver'),
  ('cliente',   'soat.incompletas.buscar'),
  ('cliente',   'soat.incompleta.ver'),
  ('proveedor', 'soat.incompletas.buscar'),
  ('proveedor', 'soat.incompleta.ver')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 3 — Y a todo rol creado en el panel que HOY ya tenga la función de la cola / del detalle.
--   (Forma SELECT a propósito: el reparto de partida lo lleva el paso 2; esto cubre lo que el
--   administrador repartió después, que no está en ningún archivo.)
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, 'soat.incompletas.buscar' FROM permisos_rol_funcion rf WHERE rf.funcion_codigo = 'soat.cola.ver'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, 'soat.incompleta.ver' FROM permisos_rol_funcion rf WHERE rf.funcion_codigo = 'soat.solicitud.ver'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0211$
DECLARE n_ops int; n_sin_buscar int; n_sin_ver int; n_buscar int; n_ver int;
BEGIN
  -- Por código exacto y NO por prefijo: `soat.*` tiene decenas de filas previas.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN
    ('soat.incompletas.buscar', 'soat.incompleta.ver');
  -- Quien ve la cola y no puede buscar incompletas (o ve el detalle y no la incompleta) es un hueco.
  SELECT count(*) INTO n_sin_buscar FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo = 'soat.cola.ver' AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x
     WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = 'soat.incompletas.buscar');
  SELECT count(*) INTO n_sin_ver FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo = 'soat.solicitud.ver' AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x
     WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = 'soat.incompleta.ver');
  SELECT count(*) INTO n_buscar FROM permisos_rol_funcion WHERE funcion_codigo = 'soat.incompletas.buscar';
  SELECT count(*) INTO n_ver FROM permisos_rol_funcion WHERE funcion_codigo = 'soat.incompleta.ver';
  IF n_ops <> 2 OR n_sin_buscar <> 0 OR n_sin_ver <> 0 OR n_buscar < 4 OR n_ver < 4 THEN
    RAISE EXCEPTION '0211: funciones de incompletas SOAT inconsistentes (ops=%, sin_buscar=%, sin_ver=%, buscar=%, ver=%)',
      n_ops, n_sin_buscar, n_sin_ver, n_buscar, n_ver;
  END IF;
  RAISE NOTICE '0211: 2 funciones de incompletas SOAT sembradas (buscar en % roles, ver en % roles)', n_buscar, n_ver;
END $resumen0211$;
