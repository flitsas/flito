-- Sprint PESV-S2 fix · Reseed catálogo de 30 estándares (incorrecto) a 24 pasos PHVA oficiales
-- según Resolución 40595 de 2022 (Min Transporte). Confirmado vs PDF oficial Cancillería:
-- https://www.cancilleria.gov.co/sites/default/files/Normograma/docs/pdf/resolucion_mintransporte_40595_2022.pdf
--
-- Estructura PHVA: Planear (6) / Hacer (12) / Verificar (4) / Actuar (2) = 24 pasos.
-- Algunos referentes ARL distribuyen 6/10/4/4 ubicando Paso 7 en Planear; aquí seguimos
-- el texto literal de la Res. 40595 que clasifica Paso 7 como transición pero queda en
-- Hacer en la Tabla del manual. La fase PHVA es lo importante para el reporte SISI/PESV.
--
-- BD prod: no hay diagnósticos creados desde el deploy de Fase 1, así que TRUNCATE seguro.

BEGIN;

-- 1. Limpiar dependencias (CASCADE para evitar errores si hubo datos de prueba)
TRUNCATE TABLE pesv_diagnostico_items CASCADE;
TRUNCATE TABLE pesv_diagnosticos CASCADE;
TRUNCATE TABLE pesv_estandares_catalogo CASCADE;

-- 2. Agregar fase PHVA + ajustar constraints
CREATE TYPE pesv_fase_phva AS ENUM ('planear', 'hacer', 'verificar', 'actuar');
ALTER TABLE pesv_estandares_catalogo ADD COLUMN fase pesv_fase_phva;
ALTER TABLE pesv_estandares_catalogo DROP CONSTRAINT IF EXISTS pesv_estandares_catalogo_paso_check;
ALTER TABLE pesv_estandares_catalogo DROP CONSTRAINT IF EXISTS uq_estandar_orden;
ALTER TABLE pesv_estandares_catalogo ADD CONSTRAINT pesv_estandares_paso_check CHECK (paso BETWEEN 1 AND 24);
ALTER TABLE pesv_estandares_catalogo ADD CONSTRAINT uq_estandar_paso UNIQUE (paso);

-- 3. Reset secuencia (catálogo limpio, ids desde 1)
SELECT setval(pg_get_serial_sequence('pesv_estandares_catalogo', 'id'), 1, false);

-- 4. Seed los 24 pasos oficiales (Res. 40595/2022)
-- PLANEAR (6 pasos)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, fase, nombre, descripcion, peso) VALUES
  ('1', 1, 1, 'planear', 'Líder del diseño e implementación del PESV', 'Designar formalmente al responsable del PESV con perfil y funciones documentadas.', 1.0),
  ('2', 2, 2, 'planear', 'Comité de Seguridad Vial', 'Conformar comité con acta, periodicidad de reuniones y funciones definidas.', 1.0),
  ('3', 3, 3, 'planear', 'Política de Seguridad Vial', 'Documentar, firmar por alta dirección y divulgar política con principios y compromisos.', 1.5),
  ('4', 4, 4, 'planear', 'Liderazgo y compromiso de la alta dirección', 'Evidenciar participación activa, asignación de recursos y rendición de cuentas.', 1.0),
  ('5', 5, 5, 'planear', 'Diagnóstico y caracterización organizacional', 'Diagnóstico inicial: rutas, vehículos, conductores, siniestralidad histórica.', 1.5),
  ('6', 6, 6, 'planear', 'Caracterización, evaluación y control de riesgos viales', 'Matriz de riesgos viales con evaluación y controles asociados.', 1.5);

-- HACER (12 pasos: incluye Paso 7 transición)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, fase, nombre, descripcion, peso) VALUES
  ('7', 7, 7, 'hacer', 'Objetivos, metas e indicadores del PESV', 'Definir objetivos SMART con metas e indicadores medibles.', 1.0),
  ('8', 8, 8, 'hacer', 'Programas de gestión de riesgos críticos', 'Programas para riesgos críticos y factores humano/vehículo/vía/entorno.', 1.5),
  ('9', 9, 9, 'hacer', 'Plan anual de trabajo', 'Cronograma anual con actividades, responsables, recursos y plazos.', 1.0),
  ('10', 10, 10, 'hacer', 'Competencia y plan anual de formación', 'Plan de capacitación y evaluación de competencias en seguridad vial.', 1.5),
  ('11', 11, 11, 'hacer', 'Responsabilidad y comportamiento seguro', 'Reglas de comportamiento, código del conductor, sanciones y reconocimientos.', 1.0),
  ('12', 12, 12, 'hacer', 'Plan de preparación y respuesta ante emergencias viales', 'Protocolos de emergencia vial, simulacros y kit de respuesta.', 1.5),
  ('13', 13, 13, 'hacer', 'Investigación interna de siniestros viales', 'Procedimiento de investigación, lecciones aprendidas y acciones.', 1.5),
  ('14', 14, 14, 'hacer', 'Vías seguras administradas por la organización', 'Inventario, evaluación y mejora de vías internas y parqueaderos.', 1.0),
  ('15', 15, 15, 'hacer', 'Planificación de desplazamientos laborales', 'Reglas de jornada, velocidad, paradas, controles de ruta.', 1.5),
  ('16', 16, 16, 'hacer', 'Inspección de vehículos y equipos', 'Listas de chequeo pre-operacionales y registro auditable.', 1.5),
  ('17', 17, 17, 'hacer', 'Mantenimiento y control de vehículos seguros', 'Programa de mantenimiento preventivo/correctivo con hojas de vida.', 1.5),
  ('18', 18, 18, 'hacer', 'Gestión del cambio y gestión de contratistas', 'Evaluar impactos viales de cambios y exigir PESV/SG-SST a contratistas.', 1.0);

-- VERIFICAR (4 pasos)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, fase, nombre, descripcion, peso) VALUES
  ('19', 19, 19, 'verificar', 'Archivo y retención documental', 'Conservar evidencias del PESV con tiempos y trazabilidad.', 1.0),
  ('20', 20, 20, 'verificar', 'Indicadores y reporte de autogestión PESV', 'Cargar indicadores y reportes a SuperTransporte (PI-PESV).', 1.5),
  ('21', 21, 21, 'verificar', 'Registro y análisis estadístico de siniestros', 'Clasificar y analizar estadísticamente la siniestralidad.', 1.5),
  ('22', 22, 22, 'verificar', 'Auditoría anual al PESV', 'Mínimo una auditoría interna anual con programa documentado.', 1.5);

-- ACTUAR (2 pasos)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, fase, nombre, descripcion, peso) VALUES
  ('23', 23, 23, 'actuar', 'Mejora continua, acciones preventivas y correctivas', 'Ciclo de AC/AP a partir de auditorías, siniestros y no conformidades.', 1.5),
  ('24', 24, 24, 'actuar', 'Mecanismos de comunicación y participación', 'Canales formales de comunicación con trabajadores y partes interesadas.', 1.0);

-- 5. Marcar fase NOT NULL ahora que tiene datos
ALTER TABLE pesv_estandares_catalogo ALTER COLUMN fase SET NOT NULL;

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT count(*) FROM pesv_estandares_catalogo;  -- debe ser 24
--   SELECT fase, count(*) FROM pesv_estandares_catalogo GROUP BY 1 ORDER BY 1;
--     planear|6, hacer|12, verificar|4, actuar|2
--   SELECT codigo, paso, fase, nombre FROM pesv_estandares_catalogo ORDER BY paso;
-- ============================================================================
