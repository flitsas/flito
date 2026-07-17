-- Sprint 1 Ola A · P0-DBA-5
-- Agrega FK + índice de soporte en parts_movements.wo_id y maintenance_schedule.wo_id.
-- Antes ambos eran integer sin .references() → orphans silenciosos posibles, reportes
-- de costo por WO inconsistentes, Postgres no protege al borrar work_orders.
--
-- Estrategia: NOT VALID + VALIDATE en pasos separados para minimizar lock window.
--   1. Limpiar orphans previos (SET NULL — preferimos preservar el movimiento histórico
--      que romper la migración; un movimiento con wo_id huérfano queda "sin OT".)
--   2. Crear FK NOT VALID (lock corto: solo metadata).
--   3. VALIDATE CONSTRAINT (lock SHARE — no bloquea reads/writes).
--   4. Índices CONCURRENTLY (sin bloqueo).

-- ============================================================================
-- 1. Limpiar orphans previos
-- ============================================================================

UPDATE parts_movements
   SET wo_id = NULL
 WHERE wo_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = parts_movements.wo_id);

UPDATE maintenance_schedule
   SET wo_id = NULL
 WHERE wo_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = maintenance_schedule.wo_id);

-- ============================================================================
-- 2. parts_movements.wo_id: ON DELETE RESTRICT
--    (un movimiento de inventario referencia una OT real; borrar la OT debe ser
--     imposible mientras existan movimientos contables asociados.)
-- ============================================================================

ALTER TABLE parts_movements
  ADD CONSTRAINT fk_parts_movements_wo
  FOREIGN KEY (wo_id) REFERENCES work_orders(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE parts_movements VALIDATE CONSTRAINT fk_parts_movements_wo;

-- ============================================================================
-- 3. maintenance_schedule.wo_id: ON DELETE SET NULL
--    (la programación es un evento futuro; si la OT se anula, la programación
--     queda viva pero desvinculada.)
-- ============================================================================

ALTER TABLE maintenance_schedule
  ADD CONSTRAINT fk_maintenance_schedule_wo
  FOREIGN KEY (wo_id) REFERENCES work_orders(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE maintenance_schedule VALIDATE CONSTRAINT fk_maintenance_schedule_wo;

-- ============================================================================
-- 4. Índices parciales (solo filas con wo_id no nulo)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_parts_movements_wo
  ON parts_movements(wo_id) WHERE wo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_maintenance_schedule_wo
  ON maintenance_schedule(wo_id) WHERE wo_id IS NOT NULL;
