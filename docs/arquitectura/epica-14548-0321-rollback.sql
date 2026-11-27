-- epica-14548-0321-rollback.sql — INVERSO de lo que siembra 0321_flito_ia_consumo_permisos.sql (Épica #14548, ADR-0051).
--
-- NO ES UNA MIGRACIÓN: no va en apps/api/src/db/migrations/ y ningún runner la aplica. Se corre a mano, solo si se decide
-- revertir la imagen de la API a una anterior a la 0321, y con el «sí» humano. En PDN, con el pg_dump previo de siempre.
--
-- Cuándo y en qué orden (verificado en código):
--   1. Revertir la imagen de la API a una anterior a la 0321 (commit de flit-gitops) y esperar a que termine el rollout.
--      Durante este paso, la imagen anterior registrará «CATÁLOGO DE PERMISOS INCOHERENTE» (sobran las filas de la 0321):
--      es esperado e inocuo. `verificarCatalogoAlArrancar` solo registra el error (apps/api/src/server.ts:72-77); no aborta
--      el arranque.
--   2. Correrlo en UNA sola transacción. El fichero no lleva BEGIN/COMMIT a propósito (así no choca con nada que lo envuelva):
--        psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f docs/arquitectura/epica-14548-0321-rollback.sql
--      `-1` (--single-transaction) hace que se revierta todo o nada. Es idempotente: tras un fallo, volver a correrlo es seguro.
--      Va DESPUÉS del paso 1 por la fila del ledger: si se borrara con la imagen 0321 todavía desplegada, cualquier pod
--      recreado volvería a aplicar la 0321 (el initContainer `db-apply` aplica las pendientes que hay en disco) y deshacería
--      el rollback. Con la imagen anterior, la 0321 ya no está en disco.
--   3. Roll-forward: al volver a desplegar una imagen con la 0321, el initContainer `db-apply` la vuelve a aplicar, porque
--      este script borra su fila del ledger (`_kyverum_applied_migrations`, apps/api/src/scripts/db-apply.ts:44).
--
-- Qué revierte: la página `pagina.ia_consumo` y sus tres acciones, con TODAS sus filas de reparto y de excepción de usuario,
-- también las concedidas desde el panel después de la 0321. Esas concesiones se pierden: es lo que tiene revertir un permiso
-- con datos. NO toca `permisos_auditoria` (sin FK: conserva el historial), ni `menu.administracion` (es un elemento de antes
-- de la 0321), ni ninguna operación: las operaciones nacen en el árbol y no se siembran.
--
-- Orden de borrado: primero lo que referencia la función (reparto y excepciones de usuario, FK restrict); después las
-- acciones (hijas de la página por `padre_codigo`, FK restrict); después la página. Todos los DELETE filtran por código.
--
-- Notas:
--   · Las concesiones individuales (`permisos_usuario_funcion`) se borran SIN fila en `permisos_auditoria`: el pg_dump previo
--     es el único registro de quién las tenía. El «sí» humano para ejecutarlo debe quedar en el ticket.
--   · `permisos_intentos_denegados` no tiene FK a `permisos_funciones` a propósito (ADR-0016: guarda también códigos que no
--     están en el catálogo). No se toca. Su FK a `users` tampoco se toca.

DELETE FROM permisos_rol_funcion
 WHERE funcion_codigo IN ('pagina.ia_consumo', 'accion.ia_consumo.ver', 'accion.ia_consumo.exportar', 'accion.ia_consumo.ver_contenido');

DELETE FROM permisos_usuario_funcion
 WHERE funcion_codigo IN ('pagina.ia_consumo', 'accion.ia_consumo.ver', 'accion.ia_consumo.exportar', 'accion.ia_consumo.ver_contenido');

DELETE FROM permisos_funciones
 WHERE codigo IN ('accion.ia_consumo.ver', 'accion.ia_consumo.exportar', 'accion.ia_consumo.ver_contenido');

DELETE FROM permisos_funciones
 WHERE codigo = 'pagina.ia_consumo';

-- Para que el roll-forward vuelva a aplicar la 0321 (sin esto, la fila del ledger la daría por aplicada y el permiso no volvería).
DELETE FROM _kyverum_applied_migrations
 WHERE filename = '0321_flito_ia_consumo_permisos.sql';

-- Comprobación: debe devolver 0.
SELECT count(*) AS restos FROM permisos_funciones WHERE codigo LIKE '%ia\_consumo%';
