-- 0147_siigo_emision_por_envio.sql
-- Feature #11242 — A2: la configuración de emisión se ELIGE al enviar y se recuerda por cliente.
-- Autor: equipo FLITO. Motivo: el vendedor y la forma de pago cambian según a quién se le factura.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ LA CONFIGURACIÓN GLOBAL NO ALCANZA
-- ============================================================================
--
-- `siigo_config_emision` guarda UNA configuración vigente por ambiente. Con eso, cambiar el vendedor
-- para una empresa lo cambia para todas, y enviar ochenta trámites de cuatro empresas obliga a
-- enviar cuatro veces reconfigurando en medio. El comprobante, el vendedor, la forma de pago y el
-- centro de costo salen de catálogos de Siigo y son una ELECCIÓN de quien factura.
--
-- Dos tablas y ninguna pantalla de parametrización nueva:
--
--   1. **El lote guarda lo que se eligió** (columnas de abajo). Igual que con los conceptos: el
--      envío solo encola y la emisión ocurre después, en el cron. Sin el snapshot, entre el clic y
--      la emisión alguien cambia la configuración global y sale una factura con otro vendedor.
--
--   2. **`siigo_emision_cliente` recuerda lo último usado** por cliente, y solo para precargar el
--      próximo envío. NO es una parametrización que alguien mantenga: se escribe sola al enviar. Si
--      un cliente no tiene fila, el diálogo precarga la configuración global, que pasa a ser una
--      semilla y no la fuente.
--
-- **NULL significa «usar la configuración global»**, no «vacío». Es lo que permite que los lotes
-- creados antes de A2 —y los envíos que no elijan nada— sigan emitiendo exactamente como hasta hoy.

-- ── Lo que se eligió para ESTE lote ──────────────────────────────────────────

ALTER TABLE siigo_lotes_facturacion
  ADD COLUMN IF NOT EXISTS documento_tipo_codigo varchar(60),
  ADD COLUMN IF NOT EXISTS vendedor_codigo       varchar(60),
  ADD COLUMN IF NOT EXISTS forma_pago_codigo     varchar(60),
  ADD COLUMN IF NOT EXISTS centro_costo_codigo   varchar(60);

COMMENT ON COLUMN siigo_lotes_facturacion.vendedor_codigo IS
  'Snapshot de lo elegido al enviar (A2). NULL = usar la configuracion global vigente, que es lo '
  'que hacian los lotes anteriores a A2. Entra en la huella: cambiar el vendedor cambia la factura.';

-- ── Lo último que se usó con cada cliente ────────────────────────────────────
--
-- Por (cliente, ambiente): `pruebas` y `produccion` son empresas distintas de Siigo, así que un
-- vendedor de pruebas no significa nada en producción. Sin el ambiente en la llave, precargar el
-- diálogo de producción con un código de pruebas produciría un rechazo que nadie entendería.

CREATE TABLE IF NOT EXISTS siigo_emision_cliente (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ambiente              varchar(12) NOT NULL,

  documento_tipo_codigo varchar(60),
  vendedor_codigo       varchar(60),
  forma_pago_codigo     varchar(60),
  centro_costo_codigo   varchar(60),

  -- Quién y cuándo, para poder explicar por qué una factura salió con ese vendedor. No es
  -- auditoría formal —eso vive en `siigo_operaciones`— sino el dato que la pantalla enseña.
  actualizado_por       integer REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_emision_cliente_ambiente_chk CHECK (ambiente IN ('pruebas', 'produccion'))
);

-- Una sola memoria por cliente y ambiente: esto RECUERDA, no versiona. El historial de con qué
-- parametrizacion salio cada factura vive en el lote, que es inmutable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_emision_cliente
    ON siigo_emision_cliente (client_id, ambiente);

COMMENT ON TABLE siigo_emision_cliente IS
  'Ultimo valor de emision usado con cada cliente (A2). Se escribe SOLA al enviar y solo sirve para '
  'precargar el proximo envio: no es una parametrizacion que alguien mantenga.';
