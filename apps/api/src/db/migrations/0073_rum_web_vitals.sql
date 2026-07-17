-- 0073 — RUM Web Vitals (FIONA PR2).
--
-- Tabla append-only de métricas de campo (LCP/INP/CLS/FCP/TTFB) reportadas por
-- la librería `web-vitals` desde el navegador a `POST /api/rum`. Permite calcular
-- p75 por ruta y dispositivo sobre tráfico real (la única verdad para priorizar
-- performance; el lab/Lighthouse solo sirve para debug/regresión).
--
-- El endpoint es PÚBLICO (las vitals se reportan también pre-login, p.ej. /login),
-- con rate-limit + validación estricta + muestreo en cliente. Sin PII.
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

CREATE TABLE IF NOT EXISTS rum_web_vitals (
  id          BIGSERIAL PRIMARY KEY,
  metric      VARCHAR(8)  NOT NULL,        -- LCP | INP | CLS | FCP | TTFB
  value       DOUBLE PRECISION NOT NULL,   -- ms (CLS adimensional)
  rating      VARCHAR(20),                 -- good | needs-improvement | poor
  route       VARCHAR(200),                -- location.pathname
  nav_type    VARCHAR(24),                 -- navigate | reload | back-forward | restore | prerender
  device      VARCHAR(12),                 -- mobile | desktop
  conn        VARCHAR(12),                 -- effectiveType (4g/3g/slow-2g…)
  session_id  VARCHAR(40),
  ip_origen   VARCHAR(45),
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consultas p75 por métrica/ruta en ventanas temporales.
CREATE INDEX IF NOT EXISTS idx_rum_metric_route_created ON rum_web_vitals (metric, route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rum_created ON rum_web_vitals (created_at DESC);
