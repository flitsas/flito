-- Hardening: el rol default de 'admin' en la tabla users escala privilegios accidentalmente
-- si un INSERT directo en BD omite la columna. Lo quitamos para forzar especificación explícita.

ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
