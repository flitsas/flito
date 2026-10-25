-- HU #13941 (Feature #13696, decisión de David Chica del 2026-10-24) — El permiso «Dr. Flit» con sus cuatro
-- funciones. Escrita a mano e idempotente. NO drizzle-kit (AGENTS.md regla 6).
--
-- Dr. Flit está disponible para cualquier usuario: sin exclusión por tipo de usuario ni por enlace (se retira
-- `rechazarEnlaceCompania`). El control es el ítem `pagina.flito_dr_flit` (General) con cuatro acciones, cada
-- una con la operación que exige su ruta: «Ver los manuales» (`drflit.manuales.ver`), «Usar la IA»
-- (`drflit.ia.usar`), «Consultar la gestión» (`drflit.gestion.consultar`) y «Radicar casos de soporte»
-- (`drflit.soporte.radicar`).
--
-- 1. Catálogo: el ítem y las acciones (upsert con `IS DISTINCT FROM`). Las cuatro OPERACIONES no se siembran:
--    nacen absorbidas por su acción (como las del expediente de bolsas, 0248); sembrarlas haría fallar
--    `verificarCatalogoAlArrancar` («la base declara y el código no usa»).
-- 2. Reparto: TODOS los roles (fila a fila de `permisos_roles`, sin literales) reciben el ítem + «Ver los
--    manuales» y su elemento `menu.general` (reparto universal, P-22, como Perfil en la 0237 paso 1b); un rol
--    creado después nace con ellos (`crearRol` → `ACCIONES_UNIVERSALES`). `admin` recibe las cuatro (ADR-0022:
--    «`admin` tiene todas las acciones», que vigila `permisos-siembra-admin.test.ts`). Nadie más recibe IA,
--    consulta de gestión ni soporte: se conceden desde la pantalla de permisos.
-- Idempotencia: el upsert no reescribe lo que no cambió; el paso universal solo reparte si NINGÚN rol tiene aún
-- la acción (la segunda corrida, o un rol al que el panel se la quitó, no recibe nada); el de `admin` es
-- `ON CONFLICT DO NOTHING`. Sin escrituras a usuarios: nadie tenía estas acciones.

-- ÁRBOL GENERADO (inicio)
-- 1 ítem (nivel 2) y 4 acciones (nivel 3). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol dr-flit
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.flito_dr_flit', 'general', 'Dr. Flit', 'Entrar a la pantalla «Dr. Flit».', 'pagina', 'menu.general', '2', '20'),
  ('accion.dr_flit.ver_manuales', 'general', 'Ver los manuales', 'Consultar en Dr. Flit las fichas de ayuda de las pantallas que puede abrir.', 'accion', 'pagina.flito_dr_flit', '3', '10'),
  ('accion.dr_flit.usar_ia', 'general', 'Usar la IA', 'Preguntarle a la IA de Dr. Flit sobre los manuales de sus pantallas.', 'accion', 'pagina.flito_dr_flit', '3', '20'),
  ('accion.dr_flit.consultar_gestion', 'general', 'Consultar la gestión', 'Buscar desde Dr. Flit el estado de trámites, SOAT, impuestos y derechos que puede ver.', 'accion', 'pagina.flito_dr_flit', '3', '30'),
  ('accion.dr_flit.radicar_soporte', 'general', 'Radicar casos de soporte', 'Enviar desde Dr. Flit un caso a la mesa de soporte, con adjuntos.', 'accion', 'pagina.flito_dr_flit', '3', '40')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- Paso 1 — Reparto UNIVERSAL: la acción y su cadena (ítem y elemento) a CADA rol de permisos_roles (sin
-- literales de rol: un rol ausente = 0 filas). Solo si la acción existe y aún no la tiene ningún rol.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT r.codigo, v.fn
  FROM permisos_roles r
 CROSS JOIN (VALUES
  ('accion.dr_flit.ver_manuales', 'accion.dr_flit.ver_manuales'),
  ('accion.dr_flit.ver_manuales', 'pagina.flito_dr_flit'),
  ('accion.dr_flit.ver_manuales', 'menu.general')
 ) AS v(accion, fn)
 WHERE EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = v.accion)
   AND EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = v.fn)
   AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x WHERE x.funcion_codigo = v.accion)
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 2 — `admin` recibe TODAS las acciones y su cadena (ADR-0022). JOIN a permisos_roles: un ambiente
-- sin el rol recibe 0 filas, no una FK rota.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.dr_flit.consultar_gestion'),
  ('admin', 'accion.dr_flit.radicar_soporte'),
  ('admin', 'accion.dr_flit.usar_ia'),
  ('admin', 'accion.dr_flit.ver_manuales'),
  ('admin', 'menu.general'),
  ('admin', 'pagina.flito_dr_flit')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)
