-- 0228_permiso_logistica_operar_ajenas.sql
-- HU #13425 (Feature #13414, Épica #13411, ADR-0022) — la función `logistica.actas.operar_ajenas`,
--   que sustituye a la regla por nombre `role === 'mensajero'` de flito-logistica (CA-11): sin ella,
--   cada usuario solo entrega, devuelve y ve en su ruta las actas que tiene asignadas; con ella, las
--   de cualquiera. También decide quién es asignable como mensajero (entrega y NO opera las ajenas).
-- Autor: equipo FLITO. Antecedentes: 0220 (calco de la siembra de una operación), 0226 (admin con
--   todo marcado: toda siembra posterior marca a `admin` en el mismo archivo).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra de datos. La anterior es la 0227_ (HU #13421).
--   - Nació como 0227 y se renumeró a 0228 al apilarse sobre la HU #13421 (su 0227_permisos_pesv_por_item);
--     no se había aplicado en ningún ambiente compartido.

-- ── Paso 1 — La operación (byte a byte con catalogo-operaciones.ts) ──────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('logistica.actas.operar_ajenas', 'logistica', 'Operar actas asignadas a otro mensajero', 'Entregar, devolver y ver en la ruta las actas asignadas a otros usuarios, no solo las propias.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — `admin`, explícito (0226: admin = todo marcado; lo vigila permisos-siembra-admin.test.ts)
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.actas.operar_ajenas')
ON CONFLICT DO NOTHING;

-- ── Paso 3 — Equivalencia (AC7): todo rol que HOY pasa la regla. Hasta esta HU la restricción solo
--   alcanzaba al código de rol `mensajero`; cualquier otro rol con acceso a mi ruta, entregar o
--   devolver operaba las actas ajenas. Ese mismo conjunto, leído de la base (incluye roles creados
--   desde el panel), recibe la función. El código de rol aquí es DATO de la siembra, no regla.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT DISTINCT rf.rol_codigo, 'logistica.actas.operar_ajenas'
FROM permisos_rol_funcion rf
WHERE rf.funcion_codigo IN ('logistica.ruta.ver', 'logistica.actas.entregar', 'logistica.actas.devolver')
  AND rf.rol_codigo <> 'mensajero'
ON CONFLICT DO NOTHING;

-- ── Paso 4 — Equivalencia por USUARIO: quien recibió una de esas funciones como excepción propia y
--   no es del rol `mensajero` también pasaba la regla; conserva el comportamiento con una excepción
--   `conceder` (solo si su rol no la trae ya del Paso 3).
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT DISTINCT uf.user_id, 'logistica.actas.operar_ajenas', 'conceder'
FROM permisos_usuario_funcion uf
JOIN users u ON u.id = uf.user_id
WHERE uf.funcion_codigo IN ('logistica.ruta.ver', 'logistica.actas.entregar', 'logistica.actas.devolver')
  AND uf.efecto = 'conceder'
  AND u.role <> 'mensajero'
  AND NOT EXISTS (
    SELECT 1 FROM permisos_rol_funcion r
    WHERE r.rol_codigo = u.role AND r.funcion_codigo = 'logistica.actas.operar_ajenas'
  )
ON CONFLICT DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0228$
DECLARE n_ops int; n_reparto int; n_admin int; n_mensajero int;
BEGIN
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo = 'logistica.actas.operar_ajenas';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE funcion_codigo = 'logistica.actas.operar_ajenas';
  SELECT count(*) INTO n_admin FROM permisos_rol_funcion WHERE funcion_codigo = 'logistica.actas.operar_ajenas' AND rol_codigo = 'admin';
  SELECT count(*) INTO n_mensajero FROM permisos_rol_funcion WHERE funcion_codigo = 'logistica.actas.operar_ajenas' AND rol_codigo = 'mensajero';
  IF n_ops <> 1 OR n_admin <> 1 OR n_mensajero <> 0 THEN
    RAISE EXCEPTION '0228: siembra de logistica.actas.operar_ajenas inconsistente (ops=%, admin=%, mensajero=%)', n_ops, n_admin, n_mensajero;
  END IF;
  RAISE NOTICE '0228: función logistica.actas.operar_ajenas sembrada (% roles)', n_reparto;
END $resumen0228$;
