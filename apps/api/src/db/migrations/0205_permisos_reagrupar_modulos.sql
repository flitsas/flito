-- 0205_permisos_reagrupar_modulos.sql
-- Feature #12072 / HU #12716: cada pantalla FLITO se agrupa en la pantalla de permisos con las
--   acciones de su modulo, y el modulo `parametrizacion` se reparte entre los modulos que de verdad
--   usan sus operaciones. Hasta aqui `modulo` era el grupo de PAGE_GROUPS para las paginas
--   (`flito_soat_e_impuestos` para 14 pantallas) y el nombre del fichero para las operaciones, asi
--   que la pantalla de SOAT y sus acciones salian en dos grupos distintos.
-- Autor: equipo FLITO. Antecedentes: 0179 (catalogo y reparto; NO se modifica), 0182/0188/0193
--   (DML sobre permisos_*), ADR-DB-001 (sin control de transaccion propio).
--
-- Que hace: SOLO DML sobre `permisos_funciones.modulo` (varchar 40). No toca codigos, ni
--   `permisos_rol_funcion`, ni `permisos_usuario_funcion`: ningun rol gana ni pierde nada. Los
--   modulos `flito_soat_e_impuestos`, `parametrizacion` y `sync` desaparecen; nacen `clientes`,
--   `tarifas`, `servicios_adicionales` y `catalogos_compartidos` (claves de agrupacion, no roles ni
--   slugs). Sin bump de sesion: los permisos no viajan en el JWT (HU #12082) y `modulo` no decide
--   acceso, solo agrupacion y el texto del 403.
--
-- Idempotente: `IS DISTINCT FROM` deja la segunda pasada en UPDATE 0. La fuente de las tuplas es
--   `apps/api/src/modules/permisos/catalogo-agrupacion.ts`; el bloque se genera con
--   `npm run permisos:seed -w apps/api -- --reagrupar` y `__tests__/db/migracion-0205.test.ts`
--   comprueba que sea byte a byte el mismo. `verificarCatalogoAlArrancar()` exige esta migracion:
--   sin aplicarla el API arranca con ArranquePermisosError nombrando las filas que difieren.

-- REAGRUPACIÓN GENERADA (inicio)
-- 47 pares código → módulo de agrupación (HU #12716). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --reagrupar
UPDATE permisos_funciones AS f
   SET modulo = v.modulo
  FROM (VALUES
    ('finanzas.servicios_adicionales.asignar', 'servicios_adicionales'),
    ('finanzas.servicios_adicionales.quitar', 'servicios_adicionales'),
    ('finanzas.servicios_adicionales.ver', 'servicios_adicionales'),
    ('pagina.clients', 'clientes'),
    ('pagina.drive', 'derechos'),
    ('pagina.finanzas_reporte_costos', 'liquidacion'),
    ('pagina.flito_bitacora', 'bitacora'),
    ('pagina.flito_bolsas', 'bolsas'),
    ('pagina.flito_comparendos', 'comparendos'),
    ('pagina.flito_comprobantes', 'comprobantes'),
    ('pagina.flito_compuerta', 'compuerta'),
    ('pagina.flito_conciliacion', 'conciliacion'),
    ('pagina.flito_derechos', 'derechos'),
    ('pagina.flito_impuestos', 'impuestos'),
    ('pagina.flito_logistica', 'logistica'),
    ('pagina.flito_logistica_ruta', 'logistica'),
    ('pagina.flito_revisiones', 'revisiones'),
    ('pagina.flito_servicios_adicionales', 'servicios_adicionales'),
    ('pagina.flito_soat', 'soat'),
    ('pagina.flito_tablero', 'tablero'),
    ('pagina.flito_tarifas', 'tarifas'),
    ('pagina.flito_tramites', 'tramites'),
    ('pagina.roles_permisos', 'permisos'),
    ('pagina.tramite', 'tramite'),
    ('pagina.transito', 'transito'),
    ('pagina.transito_organismos', 'transito'),
    ('pagina.users', 'usuarios'),
    ('parametrizacion.companias.editar', 'clientes'),
    ('parametrizacion.companias.listar', 'catalogos_compartidos'),
    ('parametrizacion.organismos.editar', 'transito'),
    ('parametrizacion.organismos.fijar_modalidad', 'transito'),
    ('parametrizacion.organismos.listar', 'catalogos_compartidos'),
    ('parametrizacion.organismos.ver_vigencias', 'transito'),
    ('parametrizacion.proveedores.crear', 'clientes'),
    ('parametrizacion.proveedores.editar', 'clientes'),
    ('parametrizacion.proveedores.listar', 'catalogos_compartidos'),
    ('parametrizacion.servicios_adicionales.crear', 'servicios_adicionales'),
    ('parametrizacion.servicios_adicionales.dar_de_baja', 'servicios_adicionales'),
    ('parametrizacion.servicios_adicionales.editar', 'servicios_adicionales'),
    ('parametrizacion.servicios_adicionales.listar', 'servicios_adicionales'),
    ('parametrizacion.tarifas.crear', 'tarifas'),
    ('parametrizacion.tarifas.editar', 'tarifas'),
    ('parametrizacion.tarifas.historial', 'tarifas'),
    ('parametrizacion.tarifas.listar', 'tarifas'),
    ('parametrizacion.tarifas.ver_por_cliente', 'tarifas'),
    ('sync.sync.lanzar', 'tramites'),
    ('sync.sync.ver_estado', 'tramites')
  ) AS v(codigo, modulo)
 WHERE f.codigo = v.codigo
   AND f.modulo IS DISTINCT FROM v.modulo;
-- REAGRUPACIÓN GENERADA (fin)
