-- 0296_flito_logistica_dueno_proveedor.sql
-- Autor: David Chica
-- HU #14346 y #14348 (Feature #14326, ADR-0039 §6.3 y §8.6). Dueño de la LT y del firmante, y el índice de búsqueda por licencia.
--
-- Solo aditiva: columnas NULL e índices, y NULL significa «solo Operaciones». La imagen anterior las ignora.
-- Sin BEGIN/COMMIT (ADR-DB-001): lo pone el runner. Idempotente: se puede aplicar dos veces.
--
-- Costo con `strategy: Recreate` en PDN (la API está caída mientras corre): una pasada sobre las LT con compañía y
-- sin dueño. Las dos comprobaciones de acta abierta entran por `idx_flito_log_doc_acta` y por el `documento_id` de
-- las líneas. Sin un límite, un lock ajeno dejaría esperando la migración sin ningún error en el log: así falla a
-- los 30 s y queda visible en el initContainer.
SET LOCAL lock_timeout = '30s';

-- ── Columnas. El FK sobre columnas recién creadas en NULL no recorre datos. ─────────────────────────────
ALTER TABLE flito_logistica_documentos
  ADD COLUMN IF NOT EXISTS proveedor_logistica_id uuid REFERENCES flito_proveedores_logistica (id) ON DELETE RESTRICT;
ALTER TABLE flito_logistica_recogida_firmantes
  ADD COLUMN IF NOT EXISTS proveedor_logistica_id uuid REFERENCES flito_proveedores_logistica (id) ON DELETE RESTRICT;

-- ── Índices ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_flito_log_doc_proveedor ON flito_logistica_documentos (proveedor_logistica_id);
CREATE INDEX IF NOT EXISTS idx_flito_log_recogida_firmantes_proveedor ON flito_logistica_recogida_firmantes (proveedor_logistica_id);
-- No único a propósito (§8.6): datos viejos con números repetidos convertirían la migración en una parada de rollout.
CREATE INDEX IF NOT EXISTS idx_flito_log_doc_numero_licencia ON flito_logistica_documentos (numero_licencia);

-- ── Licencias existentes (#14346 AC9) ───────────────────────────────────────────────────────────────────
-- No entregadas y sin acta abierta: al proveedor actual de su compañía. El resto queda sin dueño, incluidas las que
-- tienen un acta abierta: al cerrarse, `pasarAlProveedorVigente` las lleva al proveedor vigente.
-- Acta abierta por las dos vías que usa el módulo: `documentos.acta_id` (actas sin viaje) y las líneas del acta.
-- `proveedor_logistica_id IS NULL` hace que la segunda aplicación no toque nada.
UPDATE flito_logistica_documentos d
   SET proveedor_logistica_id = c.flito_proveedor_logistica_id
  FROM clients c
 WHERE c.id = d.compania_id
   AND c.flito_proveedor_logistica_id IS NOT NULL
   AND d.proveedor_logistica_id IS NULL
   AND d.tipo = 'licencia_transito'
   AND d.estado <> 'entregado'
   AND NOT EXISTS (
     SELECT 1 FROM flito_logistica_actas a
      WHERE a.id = d.acta_id AND a.estado IN ('generada', 'despachada')
   )
   AND NOT EXISTS (
     SELECT 1 FROM flito_logistica_acta_lineas l
       JOIN flito_logistica_actas a ON a.id = l.acta_id
      WHERE l.documento_id = d.id AND a.estado IN ('generada', 'despachada')
   );
