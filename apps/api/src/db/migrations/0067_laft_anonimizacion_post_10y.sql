-- LAFT/SARLAFT v2 — F5: Política de retención + anonimización post 10 años.
--
-- Ley 1121 de 2006 + Circular UIAF: las entidades vigiladas deben conservar
-- la documentación de transacciones SARLAFT por MÍNIMO 5 años. PO definió:
-- conservación 10 años, después anonimizar (no borrar) — preserva trazabilidad
-- estadística sin exponer PII.
--
-- ROS borradores se "archivan" (no se anonimizan) porque pueden ser requeridos
-- por la UIAF aun después del plazo si hay investigación abierta.
--
-- pesv_retencion_politicas ya tiene enum pesv_retencion_accion con valor
-- 'anonimizar' (mig 0060). Reusamos esa tabla para LAFT también — el cron
-- diario consulta tipo_documento y aplica la lógica correspondiente.

BEGIN;

INSERT INTO pesv_retencion_politicas (
  tipo_documento, retencion_anios, base_legal, accion, habilitado, notas_md, created_by
)
SELECT * FROM (VALUES
  ('laft_counterparty'::varchar(60), 10::smallint,
   'Ley 1121/2006 + Circular UIAF — SARLAFT'::varchar(200),
   'anonimizar'::pesv_retencion_accion, true,
   'Anonimiza PII (nombre, doc, email, phone) preservando id+riesgo+timestamps para reportería histórica.'::text,
   1::integer),
  ('laft_cash_txn'::varchar(60), 10::smallint,
   'Circular UIAF + Decreto 1497/2002 — SARLAFT'::varchar(200),
   'anonimizar'::pesv_retencion_accion, true,
   'Anonimiza datos del titular en transacciones en efectivo. Mantiene monto/fecha para indicadores agregados.'::text,
   1::integer),
  ('laft_ros_draft'::varchar(60), 10::smallint,
   'Resolución UIAF 122/2021 — Archivo SIREL'::varchar(200),
   'archivar_offline'::pesv_retencion_accion, true,
   'Borrador ROS no se anonimiza — se archiva offline. Investigación UIAF puede requerir consulta posterior.'::text,
   1::integer)
) AS v(tipo_documento, retencion_anios, base_legal, accion, habilitado, notas_md, created_by)
ON CONFLICT (tipo_documento) DO NOTHING;

COMMIT;
