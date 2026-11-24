-- 0264 — HU #13971 (Feature #13940 «Proveedores SOAT»): índices de users y clients por su proveedor SOAT.
--
-- Motivo: deuda que señaló db-review en #13958 (desactivar) y #13960 (eliminar), y que la 0261 dejó escrita.
-- El impacto/desactivación/eliminación de un proveedor (`flito-proveedores-estado.service.ts`,
-- `flito-proveedores-eliminar.service.ts`) filtra `users.flito_proveedor_soat_id = $1` y
-- `clients.flito_proveedor_soat_sin_tramite_id = $1`; sin índice, cada operación escanea ambas tablas enteras.
--
-- Índice COMPLETO, no parcial (`WHERE deleted_at IS NULL`):
--   · `cambiarEstadoProveedorSoat` desvincula a los usuarios con `WHERE flito_proveedor_soat_id = $1` SIN filtrar
--     `deleted_at`; un índice parcial no serviría a esa consulta (el planner no puede usarlo sin el predicado).
--   · Los clientes se filtran con `clienteVigente()`, cuyo predicado es del módulo `clients` y puede evolucionar;
--     atar el índice a él crearía drift silencioso entre el predicado del índice y el de la consulta.
--   · Las bajas son pocas frente a las filas vivas: el ahorro de tamaño de un parcial no compensa.
--
-- Idempotente (AC3): `CREATE INDEX IF NOT EXISTS`; aplicarla dos veces no falla ni cambia nada.
-- Sin cambio de comportamiento (AC4): solo índices; ninguna consulta ni dato cambia.
--
-- Nota operativa: fuera de local se aplica a mano tras el deploy (`node dist/scripts/db-apply.js`, ver README).
-- El runner envuelve cada archivo en una transacción, así que aquí NO se usa `CONCURRENTLY`. En PDN, si las tablas
-- son grandes, valorar crear antes los mismos índices a mano con `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`
-- (fuera de transacción, mismo nombre): esta migración los encontrará y será un no-op.

CREATE INDEX IF NOT EXISTS idx_users_flito_proveedor_soat
  ON users (flito_proveedor_soat_id);

CREATE INDEX IF NOT EXISTS idx_clients_flito_proveedor_soat_sin_tramite
  ON clients (flito_proveedor_soat_sin_tramite_id);
