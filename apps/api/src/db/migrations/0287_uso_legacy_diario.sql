-- 0287_uso_legacy_diario.sql
-- HU #13989 (Feature #13980, Épica #14272, ADR-0033) — conteo de uso de las rutas de los módulos
-- legacy `soat`, `tramites` y `liquidacion`, en agregados por día.
--
-- No guarda PII: `ruta` es el prefijo declarado + el patrón de Express (nunca la URL real), y
-- `consumidor` es el código del rol o 'publico' (nunca id, correo ni IP).
-- Sin FK a `permisos_roles`, a propósito: borrar un rol no debe borrar ni bloquear el histórico, y una
-- FK podría tumbar el lote entero del flush. Sin índices extra: la PK empieza por `dia`.
--
-- Política de retención (AGENTS.md, regla 16): se conserva hasta aceptar el ADR de la HU #13990, con un
-- MÁXIMO de 6 meses desde el primer despliegue en PDN. Al retirar la instrumentación, una migración
-- nueva hace DROP TABLE; no hay cron de purga.
--
-- Sin BEGIN/COMMIT. Idempotente.

CREATE TABLE IF NOT EXISTS uso_legacy_diario (
  dia date NOT NULL,
  modulo varchar(20) NOT NULL,
  ruta varchar(240) NOT NULL,
  metodo varchar(10) NOT NULL,
  consumidor varchar(40) NOT NULL,
  total bigint NOT NULL,
  CONSTRAINT uso_legacy_diario_pkey PRIMARY KEY (dia, modulo, ruta, metodo, consumidor),
  CONSTRAINT uso_legacy_diario_modulo_check CHECK (modulo IN ('soat', 'tramites', 'liquidacion')),
  CONSTRAINT uso_legacy_diario_total_check CHECK (total > 0)
);
