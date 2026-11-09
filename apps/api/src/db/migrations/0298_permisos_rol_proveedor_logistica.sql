-- 0298_permisos_rol_proveedor_logistica.sql
-- ADR-0040 (Feature #14326, HU #14351 y #14353) — el rol `proveedor` trae el perfil «Coordinador de
-- proveedor» de logística. Supersede en parte ADR-0039 §12 («no se siembran»).
--
--   1. `logistica.traslado.anular` pasa a colgar de `accion.logistica.despachar_entregar_devolver`
--      (ADR-0040 §2). Sigue siendo opcional también de `reversar_paso` en el árbol del código
--      (`PADRES_DE_OPCIONAL`): basta que uno sea efectivo. El primero de esa lista es el
--      `padre_codigo` de la base, y desde este cambio el primero es `despachar_entregar_devolver`.
--   2. Reparto del rol `proveedor`: páginas, acciones y opcionales de logística. La rama
--      `menu.gestion` ya la tiene el rol (SOAT), así que la cadena queda completa.
--      NO se siembran: cerrar lote, reversar paso, viajes adicionales (D3), firmar llegada a FLIT
--      (N4), dejar pendiente / resolver trámite (R20), ver documento del firmante (PII) ni gestionar
--      motivos. Un mensajero de proveedor se arma por usuario: revocar `logistica.actas.operar_ajenas`.
--   Un proveedor que no presta logística recibe las filas latentes: la página no sale en su menú
--   (`paginasDePermisos`), las rutas le dan 403 (`conAlcance`) y no salen en `/me` (`funcionesDePermisos`).
-- Sin BEGIN/COMMIT. Sin DDL. Idempotente: el UPDATE solo toca la fila si el padre difiere y los
-- INSERT llevan ON CONFLICT DO NOTHING. Si el rol no existe, el JOIN no inserta nada.

UPDATE permisos_funciones
   SET padre_codigo = 'accion.logistica.despachar_entregar_devolver'
 WHERE codigo = 'logistica.traslado.anular'
   AND padre_codigo IS DISTINCT FROM 'accion.logistica.despachar_entregar_devolver';

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT r.codigo, f.codigo
  FROM permisos_roles r
  JOIN permisos_funciones f ON f.codigo IN (
    'pagina.flito_logistica',
    'pagina.flito_logistica_ruta',
    'accion.logistica.ver_consola',
    'accion.logistica.ver_actas',
    'accion.logistica.generar_actas',
    'accion.logistica.despachar_entregar_devolver',
    'accion.mi_ruta.ver',
    'accion.mi_ruta.escanear',
    'accion.mi_ruta.reportar_novedad',
    'logistica.actas.descargar',
    'logistica.actas.despachar',
    'logistica.actas.operar_ajenas',
    'logistica.recogida.confirmar',
    'logistica.traslado.registrar',
    'logistica.traslado.anular'
  )
 WHERE r.codigo = 'proveedor'
ON CONFLICT DO NOTHING;
