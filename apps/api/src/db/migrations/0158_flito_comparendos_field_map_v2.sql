-- ============================================================================
-- 0158 — FLITO comparendos: mapa de homologación v2, VERIFICADO
-- ============================================================================
--
-- Feature #11492 (17a). Cierra lo que la 0150 dejó abierto: su v1 nació con `provisional=true`
-- porque estaba deducida de nombres de campo plausibles, sin haber visto nunca una respuesta de
-- los proveedores. El 2026-08-20 se capturaron payloads REALES de las dos fuentes —Verifik SIMIT y
-- el UTS municipal (Medellín)— y esta v2 es lo que dicen esos payloads, no lo que se esperaba.
-- Por eso entra con `provisional=false`.
--
-- La 0150 NO se toca: ya está aplicada, y además la v1 es el historial de lo que se creyó. El merge
-- lee la versión MÁXIMA de `flito_comparendos_field_map` (RN-11), así que basta con insertar la v2
-- para que la homologación pase a usarla.
--
-- ── Qué se aprendió del payload real, y qué corrige cada cosa ───────────────────────────────────
--
-- SIMIT (Verifik). La raíz es `{ data, signature, id }` y los comparendos vivos llegan en
-- `data.multas` (`data.comparendos` vino VACÍO en la misma respuesta). Cada ítem trae:
--
--   · `comparendo` NO es el número: es el BOOLEANO `true`. La v1 lo tenía como candidato de
--     prioridad 2 para `numeroComparendo` y aquí NO está, y es deliberado: `primerValor` devuelve
--     el primer candidato NO nulo, así que un `true` habría SOMBREADO a los candidatos siguientes
--     y el ítem entero se habría descartado por «número irreconocible». Un booleano en la posición
--     del número no es un respaldo, es un apagón.
--   · El código y la descripción de la infracción cuelgan de `infracciones[0]`, no del ítem. De ahí
--     los `source_path` con punto: el merge los resuelve desde el 2026-08-20.
--   · `fechaNotificacion` NO se mapea. En la captura trae centinelas `01/01/1900` para comparendos
--     no notificados, y una fecha centinela homologada es peor que un `NULL`: se ve como un dato.
--     Solo `fechaComparendo` (que llega como `11/05/2026 14:20:00`, con hora).
--   · `infractor.*` (nombre y documento del infractor) NO se mapea y no puede mapearse: es dato de
--     persona (Ley 1581) y la lista blanca de la poda RN-25 se DERIVA de esta tabla — lo que se
--     nombre aquí es exactamente lo que se persiste en `payload_simit`.
--   · `fechaImposicion` SÍ se conserva, en prioridad 2. No aparece en la captura, pero `types.ts`
--     lo declara y la v1 lo tenía: soltarlo habría sido dejar sin fecha a una variante del
--     proveedor que hoy nadie ha observado, a cambio de nada.
--
-- Regla general de esta v2, para que no haya que deducirla fila a fila: **todo nombre de la v1 que
-- no se contradiga con el payload real se conserva como respaldo de última prioridad**. Un respaldo
-- inerte no cuesta nada (`primerValor` solo lo mira si los de delante faltan); soltarlo, en cambio,
-- rompe en silencio a quien emitía ese nombre. La ÚNICA excepción es `comparendo` en SIMIT, y es
-- por lo dicho arriba: no está ausente, está ocupado por un booleano que sombrea a los demás.
--
-- UTS municipal. La raíz es el eco de la consulta y lo bueno está en
-- `consultaMultaOComparendoOutDTO.informacionComparendo`. Cada ítem trae:
--
--   · El organismo NO está en el ítem: está en `estadoCuenta.secretaria.nombreAutoridadTransito`.
--     La v1 apuntaba a `organismo` y a `secretaria`, que en el payload real es un OBJETO — se
--     conserva `organismo` como respaldo de prioridad 2 por si otro municipio sí lo publica plano.
--   · `estadoCuenta` lleva dentro `direccion` (dirección del hecho, dato de persona) y no se mapea
--     ninguna ruta que la incluya. La poda reconstruye SOLO la hoja autorizada, nunca el subárbol.
--   · `identificador` es el NIT consultado, no un número de comparendo: fuera del mapa.
--   · `nombres`, `apellidos` y `contraventores` son del infractor: fuera del mapa.
--   · La fecha viene ISO sin hora (`2026-07-19`) y el valor como número JSON (`633232.0`).
--
-- ── Decisión de negocio PENDIENTE de confirmar (no la resuelve esta migración) ──────────────────
--
-- `monto` en SIMIT se mapea a `valorPagar` (prioridad 1), que en la captura vale 1 308 422 e
-- INCLUYE el `valorGestion` de 42 200 que cobra el operador del SIMIT; `valor` (1 266 222) es solo
-- el capital de la infracción y queda de prioridad 3. Se elige `valorPagar` porque el módulo es de
-- monitoreo de DEUDA y lo que hay que pagar para extinguirla es esa cifra. Si Cartera decide que el
-- inventario debe llevar el capital, se cambia el orden de estas dos filas en una v3 —una fila, sin
-- despliegue, que es justo para lo que ADR-0003 versiona esta tabla—.
--
-- Ojo también con `proyeccionMultaDTO.valorConDescuento50` del UTS: es una proyección condicionada
-- a pagar dentro del plazo, no la deuda. No se mapea a `monto` a propósito.

-- ── Cómo se REVIERTE esto ──────────────────────────────────────────────────────────────────────
--
-- No borrando la v2: `operaciones_app` tiene `SELECT, INSERT, UPDATE` sobre esta tabla y NO tiene
-- `DELETE` (0150), y el proyecto no lleva scripts `down`. La reversa es **sembrar una v3 que copie
-- las filas de la v1**, que sigue íntegra en la tabla —el merge lee la versión MÁXIMA, así que la
-- v3 pasa a mandar sin tocar nada de lo anterior—:
--
--   INSERT INTO flito_comparendos_field_map (version, origen, source_path, target_field, prioridad,
--                                            provisional, notas)
--   SELECT 3, origen, source_path, target_field, prioridad, provisional, 'Reversa de la v2 a la v1'
--     FROM flito_comparendos_field_map WHERE version = 1
--   ON CONFLICT (version, origen, source_path) DO NOTHING;
--
-- No hay pérdida de datos en ningún sentido: las versiones conviven y el histórico es el registro
-- de lo que se creyó en cada momento.

INSERT INTO flito_comparendos_field_map (version, origen, source_path, target_field, prioridad, provisional, notas) VALUES
  -- ── SIMIT (Verifik) — payload real de data.multas[] del 2026-08-20 ────────────────────────────
  (2, 'simit', 'numeroComparendo',                    'numeroComparendo',      1, false, 'Clave de negocio (CF-07). 20 digitos en la captura real.'),
  (2, 'simit', 'numeroMulta',                         'numeroComparendo',      2, false, 'Respaldo. `comparendo` NO se mapea: en el payload real es el booleano true y sombrearia a este candidato.'),
  (2, 'simit', 'placa',                               'placa',                 1, false, 'PII: enmascarar en logs'),
  (2, 'simit', 'infracciones.0.codigoInfraccion',     'codigoInfraccion',      1, false, 'El codigo cuelga de infracciones[0], no del item.'),
  (2, 'simit', 'codigoInfraccion',                    'codigoInfraccion',      2, false, 'Respaldo plano por si el proveedor lo sube al item.'),
  (2, 'simit', 'infracciones.0.descripcionInfraccion','descripcionInfraccion', 1, false, NULL),
  (2, 'simit', 'descripcionInfraccion',               'descripcionInfraccion', 2, false, 'Respaldo plano.'),
  (2, 'simit', 'fechaComparendo',                     'fechaComparendo',       1, false, 'Formato DD/MM/YYYY HH:MM:SS. fechaNotificacion NO se mapea: trae centinelas 01/01/1900.'),
  (2, 'simit', 'fechaImposicion',                     'fechaComparendo',       2, false, 'Respaldo: nombre que usaba la v1. No aparece en la captura; inerte mientras fechaComparendo llegue.'),
  (2, 'simit', 'organismoTransito',                   'organismo',             1, false, NULL),
  (2, 'simit', 'secretariaNombre',                    'organismo',             2, false, 'Respaldo: nombre que usaba la v1.'),
  (2, 'simit', 'valorPagar',                          'monto',                 1, false, 'Deuda total: incluye valorGestion. Ver la nota de decision de negocio en la cabecera.'),
  (2, 'simit', 'valorAPagar',                         'monto',                 2, false, 'Respaldo: nombre que usaba la v1.'),
  (2, 'simit', 'valor',                               'monto',                 3, false, 'Solo capital de la infraccion, sin gestion.'),
  (2, 'simit', 'estadoComparendo',                    'estadoFuente',          1, false, 'Texto crudo del proveedor; no se normaliza.'),
  (2, 'simit', 'estadoCartera',                       'estadoFuente',          2, false, 'Llego null en la captura.'),
  (2, 'simit', 'estado',                              'estadoFuente',          3, false, 'Respaldo: nombre que usaba la v1.'),
  -- ── Municipal (UTS) — payload real de informacionComparendo[] del 2026-08-20 ──────────────────
  (2, 'municipal', 'numeroComparendo',                              'numeroComparendo',      1, false, 'Clave de negocio (CF-07). `identificador` NO se mapea: es el NIT consultado.'),
  (2, 'municipal', 'estadoCuenta.numeroComparendo',                 'numeroComparendo',      2, false, 'El mismo numero, repetido dentro de estadoCuenta.'),
  (2, 'municipal', 'numero',                                        'numeroComparendo',      3, false, 'Respaldo: nombre que usaba la v1.'),
  (2, 'municipal', 'placa',                                         'placa',                 1, false, 'PII: enmascarar en logs'),
  (2, 'municipal', 'codigoInfraccion',                              'codigoInfraccion',      1, false, NULL),
  (2, 'municipal', 'estadoCuenta.infraccion.0.codigoInfraccion',    'codigoInfraccion',      2, false, NULL),
  (2, 'municipal', 'descripcionInfraccion',                         'descripcionInfraccion', 1, false, NULL),
  (2, 'municipal', 'estadoCuenta.infraccion.0.descripcion',         'descripcionInfraccion', 2, false, NULL),
  (2, 'municipal', 'fechaComparendo',                               'fechaComparendo',       1, false, 'ISO sin hora en la captura (2026-07-19).'),
  (2, 'municipal', 'estadoCuenta.secretaria.nombreAutoridadTransito','organismo',            1, false, 'Unica hoja autorizada de estadoCuenta.secretaria. estadoCuenta.direccion es PII y queda fuera.'),
  (2, 'municipal', 'organismo',                                     'organismo',             2, false, 'Respaldo plano por si otro municipio lo publica asi.'),
  (2, 'municipal', 'valor',                                         'monto',                 1, false, 'Numero JSON. proyeccionMultaDTO.valorConDescuento50 NO se mapea: es proyeccion condicionada.'),
  (2, 'municipal', 'monto',                                         'monto',                 2, false, 'Respaldo.'),
  (2, 'municipal', 'descripcionEstado',                             'estadoFuente',          1, false, 'Texto crudo del proveedor («Se adeuda»); no se normaliza.'),
  (2, 'municipal', 'codigo',                                        'codigoInfraccion',      3, false, 'Respaldo: nombre de la v1, que es el que emite el mock del UTS. Sin esta fila el modo mock (el DEFECTO) homologa codigoInfraccion a NULL.'),
  (2, 'municipal', 'descripcion',                                   'descripcionInfraccion', 3, false, 'Respaldo: nombre de la v1 y del mock. Sin esta fila se cae el escenario CF-08 del mock.'),
  (2, 'municipal', 'fecha',                                         'fechaComparendo',       2, false, 'Respaldo: nombre de la v1 y del mock.'),
  (2, 'municipal', 'estado',                                        'estadoFuente',          2, false, 'Respaldo: nombre que usaba la v1.')
ON CONFLICT (version, origen, source_path) DO NOTHING;

COMMENT ON TABLE flito_comparendos_field_map IS
  'Homologacion versionable fuente -> canonico (ADR-0003). El merge lee la version MAXIMA. La v1 '
  '(migracion 0150) era provisional y se conserva como historial; la v2 (migracion 0158) sale de '
  'payloads reales capturados el 2026-08-20 y es la vigente. Los source_path admiten rutas con '
  'punto (infracciones.0.codigoInfraccion) y esta tabla ES la lista blanca de la poda RN-25: lo '
  'que no se nombre aqui no se persiste en payload_simit / payload_municipal.';
