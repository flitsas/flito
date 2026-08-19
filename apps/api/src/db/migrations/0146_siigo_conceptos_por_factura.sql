-- 0146_siigo_conceptos_por_factura.sql
-- Feature #11242 — A1: qué conceptos van en la factura se ELIGE al enviar. Cierra D-5 y C3.
-- Autor: equipo FLITO. Motivo: el modelo tiene que guardar la selección, no deducirla.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CAMBIA Y QUÉ ROMPERÍA NO CAMBIARLO
-- ============================================================================
--
-- Hasta ahora la factura llevaba TODOS los conceptos con valor no nulo en la liquidación. Eso no es
-- lo que hace el negocio: a una empresa se le gestiona el trámite entero —SOAT, impuesto, derecho,
-- logística, trámite digital— pero solo se le factura electrónicamente el trámite digital; el resto
-- se recupera por reintegro. Qué se factura es una DECISIÓN de quien envía, no una consecuencia de
-- lo que el trámite tenga liquidado.
--
-- Tres consecuencias en el modelo, y las tres tienen que entrar juntas:
--
--   1. **El lote guarda los conceptos** (`conceptos`). El envío solo encola; la emisión ocurre
--      después, en el cron. Sin guardarlos, entre el clic y la emisión el armado volvería a deducir
--      la lista y saldría una factura que nadie pidió.
--
--   2. **La huella los cubre.** Era `sha256(ids de trámite ordenados)` y la clave de idempotencia se
--      deriva de ella. Con la selección explícita eso deja de identificar al lote: los MISMOS
--      trámites con conceptos distintos daban la MISMA huella, así que el segundo envío recuperaba
--      el lote del primero y no emitía nada — informando «ya en cola», sin error y sin rastro. La
--      huella nueva la calcula `huellaDeLote()` sobre trámites + conceptos.
--
--      Las huellas viejas y las nuevas conviven sin chocar: son el mismo formato y el índice único
--      solo exige unicidad. Un lote antiguo nunca vuelve a calcularse.
--
--   3. **El puente factura↔trámite pasa a ser por CONCEPTO** (D-5). Ver abajo.
--
-- ── D-5: un trámite puede tener más de una factura, una por concepto ────────
--
-- `idx_siigo_factura_tramites_vivo` era UNIQUE (tramite_id) WHERE activo. Con conceptos fijos era
-- una salvaguarda anti-duplicado y nada más. Con conceptos elegibles se convertía en una regla de
-- negocio que nadie tomó: facturar el trámite digital dejaría ese trámite inhabilitado para
-- cualquier otro concepto PARA SIEMPRE.
--
-- Se amplía a (tramite_id, concepto). Lo que sigue impidiendo es lo que de verdad importaba: emitir
-- DOS VECES el mismo concepto del mismo trámite, que son dos documentos ante la DIAN y no se
-- deshacen. Lo que deja de impedir es facturar mañana la logística de un trámite cuyo trámite
-- digital se facturó ayer.
--
-- El `COALESCE` del índice no es decoración. `concepto` es NULL en las filas anteriores a esta
-- migración —cubrían «toda la liquidación» y no hay forma fiable de repartirlas— y en PostgreSQL
-- los NULL son DISTINTOS entre sí dentro de un índice único: sin el COALESCE, dos facturas vivas
-- del mismo trámite histórico dejarían de chocar y la protección se caería justo para los datos que
-- ya existen.

-- ── El lote guarda qué se factura ───────────────────────────────────────────

ALTER TABLE siigo_lotes_facturacion
  ADD COLUMN IF NOT EXISTS conceptos text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN siigo_lotes_facturacion.conceptos IS
  'Conceptos elegidos al enviar, ORDENADOS. Vacio = lote anterior a A1, que cubria todos los '
  'aplicables de la liquidacion. Entra en la huella: la seleccion es parte de la identidad del lote.';

COMMENT ON COLUMN siigo_lotes_facturacion.huella IS
  'sha256 hex de los ids de tramite Y los conceptos, ambos ORDENADOS. Ni el orden de seleccion en '
  'la pantalla ni el de los conceptos pueden producir lotes distintos con el mismo contenido.';

-- ── El puente, por concepto ─────────────────────────────────────────────────

ALTER TABLE siigo_factura_tramites
  ADD COLUMN IF NOT EXISTS concepto varchar(30);

COMMENT ON COLUMN siigo_factura_tramites.concepto IS
  'Que concepto de este tramite cubre esta factura. NULL = factura anterior a A1, que cubria todos '
  'los aplicables. Una fila por concepto facturado, no una por tramite.';

-- El índice viejo se retira DESPUÉS de crear el nuevo no: primero el nuevo no puede crearse mientras
-- el viejo siga siendo más restrictivo y bloquee filas legítimas. Se cambia en el orden seguro:
-- quitar el antiguo y poner el ampliado, ambos idempotentes.
DROP INDEX IF EXISTS idx_siigo_factura_tramites_vivo;

CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_factura_tramites_vivo
    ON siigo_factura_tramites (tramite_id, COALESCE(concepto, '*')) WHERE activo;

COMMENT ON INDEX idx_siigo_factura_tramites_vivo IS
  'D-5: un tramite no puede estar en dos facturas VIVAS por el MISMO concepto. El COALESCE cubre '
  'las filas historicas con concepto NULL, que en un unique index serian todas distintas entre si.';
