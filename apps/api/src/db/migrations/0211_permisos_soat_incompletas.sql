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

-- ── Paso 2 — Reparto de PARTIDA, CONDICIONADO a la función de origen (security, HU #12997): cada
--   rol de fábrica recibe `soat.incompletas.buscar` SOLO si hoy tiene `soat.cola.ver`, y
--   `soat.incompleta.ver` SOLO si hoy tiene `soat.solicitud.ver`. Un rol al que el panel le quitó la
--   cola (p. ej. el auditor, de alcance `todo`) no gana por aquí el propietario de todas las compañías.
--   La tercera columna del VALUES nombra la función de origen. Es la forma canónica que parsea
--   __tests__/helpers/permisos-seed-sql.ts (`bloquesInsertCondicionado`) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin',     'soat.incompletas.buscar', 'soat.cola.ver'),
  ('admin',     'soat.incompleta.ver',     'soat.solicitud.ver'),
  ('auditor',   'soat.incompletas.buscar', 'soat.cola.ver'),
  ('auditor',   'soat.incompleta.ver',     'soat.solicitud.ver'),
  ('cliente',   'soat.incompletas.buscar', 'soat.cola.ver'),
  ('cliente',   'soat.incompleta.ver',     'soat.solicitud.ver'),
  ('proveedor', 'soat.incompletas.buscar', 'soat.cola.ver'),
  ('proveedor', 'soat.incompleta.ver',     'soat.solicitud.ver')
) AS v(rol, fn, origen)
WHERE EXISTS (SELECT 1 FROM permisos_rol_funcion o WHERE o.rol_codigo = v.rol AND o.funcion_codigo = v.origen)
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 3 — Y a todo rol creado en el panel que HOY ya tenga la función de la cola / del detalle.
--   (El paso 2 declara la partida; esto cubre lo que el administrador repartió después.)
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, 'soat.incompletas.buscar' FROM permisos_rol_funcion rf WHERE rf.funcion_codigo = 'soat.cola.ver'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, 'soat.incompleta.ver' FROM permisos_rol_funcion rf WHERE rf.funcion_codigo = 'soat.solicitud.ver'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0211$
DECLARE n_ops int; n_sin_buscar int; n_sin_ver int; n_buscar_sin_cola int; n_ver_sin_detalle int;
BEGIN
  -- Por código exacto y NO por prefijo: `soat.*` tiene decenas de filas previas.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN
    ('soat.incompletas.buscar', 'soat.incompleta.ver');
  -- Las dos direcciones de la equivalencia, rol por rol:
  --   quien ve la cola (o el detalle) y se queda sin la incompleta → hueco;
  --   quien gana la incompleta sin tener la cola (o el detalle) → ensanchamiento (security).
  SELECT count(*) INTO n_sin_buscar FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo = 'soat.cola.ver' AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x
     WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = 'soat.incompletas.buscar');
  SELECT count(*) INTO n_sin_ver FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo = 'soat.solicitud.ver' AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x
     WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = 'soat.incompleta.ver');
  SELECT count(*) INTO n_buscar_sin_cola FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo = 'soat.incompletas.buscar' AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x
     WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = 'soat.cola.ver');
  SELECT count(*) INTO n_ver_sin_detalle FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo = 'soat.incompleta.ver' AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x
     WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = 'soat.solicitud.ver');
  IF n_ops <> 2 OR n_sin_buscar <> 0 OR n_sin_ver <> 0 OR n_buscar_sin_cola <> 0 OR n_ver_sin_detalle <> 0 THEN
    RAISE EXCEPTION '0211: funciones de incompletas SOAT inconsistentes (ops=%, sin_buscar=%, sin_ver=%, buscar_sin_cola=%, ver_sin_detalle=%)',
      n_ops, n_sin_buscar, n_sin_ver, n_buscar_sin_cola, n_ver_sin_detalle;
  END IF;
  RAISE NOTICE '0211: 2 funciones de incompletas SOAT sembradas, cada una exactamente en los roles de su función de origen';
END $resumen0211$;
