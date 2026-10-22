-- HU #13424 (Feature #13414, Épica #13411) · ADR-0022 §D2 — `admin` con todo el catálogo marcado (salvo tres).
--
-- Numerada 0226: la 0224 y la 0225 son de la Épica 13201 (HU #13409 y #13410) y no siembran permisos.
--
-- Decisión del PO: `admin` es un rol con todos los permisos marcados y EDITABLE como cualquier otro.
-- Esta migración le marca lo que hoy le falta, incluida `impuestos.recibos.reemplazar` (la 0220 la
-- sembró sin reparto; decisión P-1 del PO del 2026-10-07: ganancia aprobada).
--
-- EXCEPCIÓN (decisión del PO del 2026-10-07, bloqueante del backend-agent sobre ADR-0022 §D2): NO se
-- le marcan las tres funciones del canal SOAT sin trámite —`soat.solicitud.crear`,
-- `soat.runt.preconsultar` y `soat.factura.leer`—. Sus rutas (`flito-soat-cliente.routes.ts`:
-- `POST /cliente`, `/cliente/preconsulta`, `/cliente/factura/lectura`) no tienen otra guarda que la
-- función: marcarlas le daría a `admin` acceso real a radicar, a la preconsulta RUNT (coste externo y
-- PII del propietario) y al OCR de la factura. Se le podrán marcar cuando la HU #12874 permita radicar
-- escogiendo la compañía. La lista la fija `__tests__/services/permisos-siembra-admin.test.ts`.
--
-- Después de esta migración `admin` se edita desde el panel como cualquier rol; el arranque del API
-- ya no exige nada de él. Toda siembra posterior que inserte en `permisos_funciones` debe marcar a
-- `admin` en el mismo archivo: lo vigila `__tests__/services/permisos-siembra-admin.test.ts` en CI.
--
-- Solo datos. Idempotente: PK (rol_codigo, funcion_codigo) + ON CONFLICT DO NOTHING. No toca
-- `permisos_usuario_funcion` (las excepciones por usuario se conservan).
--
-- Rollback del CÓDIGO (no de esta migración): si se revierte el código de la HU #13424 vuelve el
-- check de arranque viejo (que tolera la ausencia de estas tres); antes de revertir, re-ejecutar este
-- mismo INSERT (idempotente) por si alguien desmarcó a `admin` otra función desde el panel.

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT 'admin', f.codigo FROM permisos_funciones f
WHERE f.codigo NOT IN ('soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear')
ON CONFLICT DO NOTHING;
