-- 0164_flito_comparendos_fecha_notificacion.sql
-- Feature #11492 (17a) — Monitoreo de comparendos. HU #11794 (persistir y exponer la fecha de
-- notificacion canonica, y estrenar el criterio de centinela `01/01/1900`).
-- Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con sql.begin()).
-- Idempotente: se puede re-aplicar entera. La segunda pasada no cambia ni una fila mas.
--
-- ============================================================================
-- QUE AFIRMA ESTA MIGRACION
-- ============================================================================
--
-- 1. `fecha_notificacion` es un dato del CANONICO y no un campo del payload crudo. Las DOS fuentes
--    la publican y de ella cuelga el conteo de terminos del proceso; un dato que no es columna no se
--    puede filtrar ni ordenar, y el payload viene podado a la lista blanca (RN-25).
--
-- 2. `01/01/1900` NO es una fecha: es el CENTINELA con el que las fuentes dicen «no notificado». La
--    premisa la dejo escrita la 0158 y hasta hoy servia para NO mapear el campo. Al mapearlo hay que
--    decidir que se hace con el centinela, y lo que se hace es descartarlo: `NULL`.
--
-- 3. El mismo criterio se estrena para `fecha_comparendo`, que hasta hoy NO tenia ninguno. Esto
--    CAMBIA salida ya visible: un comparendo cuyo `fechaComparendo` llegue `01/01/1900` pasa de
--    guardarse como `1900-01-01` a guardarse como `NULL`. No es efecto colateral, es la decision: un
--    centinela no cambia de significado segun la columna en la que caiga, y dejar el criterio a
--    medias significaria que la misma cadena del mismo proveedor es «no notificado» en una columna y
--    «ocurrio en 1900» en la de al lado.
--
-- ============================================================================
-- LAS TRES GRAFIAS, QUE SON DATOS MEDIDOS Y NO SUPUESTOS
-- ============================================================================
--
-- Respuestas reales del NIT 901789698 (compartidas por David, 2026-08-24):
--
--   · SIMIT (Verifik)  `DD/MM/YYYY HH:MM:SS`  ->  `14/05/2026 00:00:00`, `26/03/2026 ...`
--   · UTS Medellin     `YYYY-MM-DD`           ->  `2026-07-30` (en la raiz del item de
--                                                 informacionComparendo)
--   · UTS Bogota       `DD/MM/YYYY` SIN HORA  ->  `14/05/2026`
--
-- La tercera es la que obliga a que la hora sea OPCIONAL en la rama con barras del parser
-- (`fechaCanonica`). Si fuera obligatoria, Bogota se caeria entera a NULL y el sintoma —una columna
-- vacia en una ciudad y llena en otra— no lo ve ningun test que solo mire Medellin.
--
-- Las tres entran por el MISMO `source_path` (`fechaNotificacion`, en la raiz del item), asi que la
-- homologacion de las grafias es trabajo del parser y no del mapa: no hay tres filas, hay una por
-- origen.
--
-- CONTRASTE CRUZADO, ya hecho: el comparendo 05001000000054652201 aparece en las dos fuentes y las
-- dos dicen `30/07/2026`. En el caso medido CF-08 ni siquiera llega a arbitrar; la precedencia se
-- implementa igual (sale gratis de RN-13) y se prueba con un caso donde SI discrepan.
--
-- ============================================================================
-- POR QUE **NO** HAY BACKFILL
-- ============================================================================
--
-- Ni un `UPDATE`. Dos motivos distintos, y los dos son suficientes:
--
--   · Para `fecha_notificacion`: el dato NO ESTA EN NINGUNA PARTE de donde reconstruirlo. Los
--     payloads historicos se podaron a la lista blanca de la v3 (RN-25) y `fechaNotificacion` no
--     estaba en ella, asi que ni las columnas ni el JSONB lo tienen. `NULL` = «no se sabe», que es
--     el vocabulario que esta tabla ya usa para el historico (0160).
--
--   · Para `fecha_comparendo`: un `UPDATE ... SET fecha_comparendo = NULL WHERE fecha_comparendo =
--     '1900-01-01'` seria escribir una decision de HOY sobre filas que nadie volvio a medir. El
--     siguiente sync las corrige solo, porque el criterio vive en el merge y se aplica a cada fila
--     que se vuelve a visitar. Lo que no se vuelve a visitar son las filas `inactivo` (CF-10), y
--     ahi el `1900-01-01` sobrevive: queda declarado, no escondido.
--
-- ============================================================================
-- POR QUE LA v4 SE SIEMBRA ENTERA (RN-11)
-- ============================================================================
--
-- El merge lee la version MAXIMA del `field_map` y **no hereda de las anteriores**. Una v4 con dos
-- filas —las de `fechaNotificacion`— dejaria al modulo sin numero, sin placa, sin fecha y sin monto:
-- el apagon del historico entero que RN-12 existe para evitar. Por eso las 41 filas de la v3 se
-- re-siembran tal cual y solo cambian dos notas (las que decian que `fechaNotificacion` no se mapea,
-- que a partir de aqui es falso).
--
-- Y RN-25 se cierra por la misma via: la lista blanca de la poda se DERIVA de los `source_path` de
-- la version vigente. Sin la fila en la v4, `fechaNotificacion` la seguiria tirando la poda y toda
-- la HU quedaria inerte aunque los tipos compilaran.
--
-- NO se editan la 0158, la 0160 ni la 0163: son historial aplicado.
--
-- ============================================================================
-- SIN INDICES NUEVOS
-- ============================================================================
--
-- Nadie filtra ni ordena todavia por `fecha_notificacion`: el visor es la HU #11795 y la pantalla
-- pagina por `created_at` (RN-32). Un indice que el planner no usa solo cuesta escrituras en la
-- tabla que mas crece del modulo. Cuando el filtro exista, se mide y se decide entonces.
--
-- ============================================================================
-- PII (RN-25, Ley 1581)
-- ============================================================================
--
-- Una fecha de notificacion no identifica a nadie: es un hito procesal del comparendo, igual que
-- `fecha_comparendo`. Las dos filas nuevas del mapa nombran una hoja ESCALAR en la raiz del item, no
-- un subarbol, asi que la poda no puede arrastrar un contenedor con datos de persona dentro.

-- ============================================================================
-- 1. La columna
-- ============================================================================
--
-- Nullable y SIN default: un `DEFAULT` aqui seria afirmar algo sobre filas que nadie ha medido, y
-- ademas un `ADD COLUMN` nullable sin default es un cambio de METADATOS en PostgreSQL, sin
-- reescritura de la tabla.

ALTER TABLE flito_comparendos_registros
  ADD COLUMN IF NOT EXISTS fecha_notificacion DATE;

COMMENT ON COLUMN flito_comparendos_registros.fecha_notificacion IS
  'Cuando se NOTIFICO el comparendo, en la zona del proveedor y sin hora (la columna es date). La '
  'escribe el sync a partir del field_map v4 y NINGUN endpoint de gestion la edita: es dato de '
  'fuente inmutable (CF-09). Tres grafias medidas el 2026-08-24 sobre el NIT 901789698, las tres por '
  'el mismo source_path fechaNotificacion: DD/MM/YYYY HH:MM:SS (SIMIT), YYYY-MM-DD (UTS Medellin) y '
  'DD/MM/YYYY SIN HORA (UTS Bogota) — por eso la hora es OPCIONAL en la rama con barras de '
  'fechaCanonica. Precedencia SIMIT -> municipal -> lo ya guardado (CF-08, RN-13). NULL significa NO '
  'NOTIFICADO O NO SE SABE, y ahi cae tambien el CENTINELA 01/01/1900, que el merge descarta en vez '
  'de persistir. SIN BACKFILL: lo anterior a esta migracion se queda en NULL porque el dato no esta '
  'ni en las columnas ni en payload_* (la v3 no lo nombraba, asi que RN-25 lo podaba); lo corrige el '
  'siguiente sync de cada fila, salvo en las filas inactivo, que ya no se visitan (CF-10).';

-- ============================================================================
-- 2. El centinela, declarado tambien sobre `fecha_comparendo`
-- ============================================================================
--
-- El COMMENT de `fecha_comparendo` no decia nada del centinela porque hasta hoy no habia criterio.
-- `COMMENT ON COLUMN` es idempotente por naturaleza: reemplaza el anterior.

COMMENT ON COLUMN flito_comparendos_registros.fecha_comparendo IS
  'Fecha de imposicion del comparendo, sin hora (la columna es date). La normaliza fechaCanonica en '
  'flito-comparendos-merge.ts desde ISO, DD/MM/YYYY y DD-MM-YYYY, con hora detras o sin ella; lo que '
  'no se entienda se descarta a NULL, porque una fecha inventada es peor que ninguna. Desde la HU '
  '#11794 el CENTINELA 01/01/1900 (con hora o sin ella) tampoco se persiste: significa NO NOTIFICADO '
  'y no una fecha de 1900. Es un CAMBIO de comportamiento respecto de lo ya guardado — las filas que '
  'hoy tienen 1900-01-01 se corrigen en el siguiente sync, NO por esta migracion (ver la cabecera).';

-- ============================================================================
-- 3. El mapa v4: la v3 ENTERA mas las dos filas de la fecha de notificacion
-- ============================================================================

INSERT INTO flito_comparendos_field_map (version, origen, source_path, target_field, prioridad, provisional, notas) VALUES
  -- ── SIMIT (Verifik) ──────────────────────────────────────────────────────────────────────────
  (4, 'simit', 'numeroComparendo',                    'numeroComparendo',      1, false, 'Clave de negocio (CF-07). 20 digitos en la captura real.'),
  (4, 'simit', 'numeroMulta',                         'numeroComparendo',      2, false, 'Respaldo. `comparendo` NO se mapea: en el payload real es el booleano true y sombrearia a este candidato.'),
  (4, 'simit', 'placa',                               'placa',                 1, false, 'PII: enmascarar en logs'),
  (4, 'simit', 'infracciones.0.codigoInfraccion',     'codigoInfraccion',      1, false, 'El codigo cuelga de infracciones[0], no del item.'),
  (4, 'simit', 'codigoInfraccion',                    'codigoInfraccion',      2, false, 'Respaldo plano por si el proveedor lo sube al item.'),
  (4, 'simit', 'infracciones.0.descripcionInfraccion','descripcionInfraccion', 1, false, NULL),
  (4, 'simit', 'descripcionInfraccion',               'descripcionInfraccion', 2, false, 'Respaldo plano.'),
  (4, 'simit', 'fechaComparendo',                     'fechaComparendo',       1, false, 'Formato DD/MM/YYYY HH:MM:SS. El centinela 01/01/1900 se descarta desde la HU #11794.'),
  (4, 'simit', 'fechaImposicion',                     'fechaComparendo',       2, false, 'Respaldo: nombre que usaba la v1. No aparece en la captura; inerte mientras fechaComparendo llegue.'),
  (4, 'simit', 'fechaNotificacion',                   'fechaNotificacion',     1, false, 'HU #11794: DD/MM/YYYY HH:MM:SS. Deja de estar fuera del mapa. El centinela 01/01/1900 —que es lo que la excluia desde la 0158— lo descarta ahora fechaCanonica a NULL, en vez de obligar a no mapear el campo.'),
  (4, 'simit', 'organismoTransito',                   'organismo',             1, false, NULL),
  (4, 'simit', 'secretariaNombre',                    'organismo',             2, false, 'Respaldo: nombre que usaba la v1.'),
  (4, 'simit', 'valorPagar',                          'monto',                 1, false, 'Deuda total: incluye valorGestion. Ver la nota de decision de negocio en la cabecera de la 0158.'),
  (4, 'simit', 'valorAPagar',                         'monto',                 2, false, 'Respaldo: nombre que usaba la v1.'),
  (4, 'simit', 'valor',                               'monto',                 3, false, 'Solo capital de la infraccion, sin gestion.'),
  (4, 'simit', 'estadoComparendo',                    'estadoFuente',          1, false, 'Texto crudo del proveedor; no se normaliza.'),
  (4, 'simit', 'estadoCartera',                       'estadoFuente',          2, false, 'Llego null en la captura.'),
  (4, 'simit', 'estadoPago',                          'estadoFuente',          3, false, 'HU #11712: campo real del proveedor. Va DELANTE de `estado`, que es un alias heredado de la v1 y por doctrina de la 0158 los alias inertes son respaldo de ultima prioridad.'),
  (4, 'simit', 'estado',                              'estadoFuente',          4, false, 'Respaldo: nombre que usaba la v1. Baja de 3 a 4 al entrar estadoPago.'),
  (4, 'simit', 'numeroResolucion',                    'numeroResolucion',      1, false, 'HU #11712: null mientras es comparendo, con valor cuando ya es multa. Acto administrativo, no dato de persona (RN-25).'),
  (4, 'simit', 'idResolucion',                        'idResolucion',          1, false, 'HU #11712: identificador de SISTEMA del proveedor (115697134), no el numero legible. Columna propia justamente para que no acabe pintado como numero. No se publica en el API.'),
  -- ── Municipal (UTS) ──────────────────────────────────────────────────────────────────────────
  (4, 'municipal', 'numeroComparendo',                              'numeroComparendo',      1, false, 'Clave de negocio (CF-07). `identificador` NO se mapea: es el NIT consultado.'),
  (4, 'municipal', 'estadoCuenta.numeroComparendo',                 'numeroComparendo',      2, false, 'El mismo numero, repetido dentro de estadoCuenta.'),
  (4, 'municipal', 'numero',                                        'numeroComparendo',      3, false, 'Respaldo: nombre que usaba la v1.'),
  (4, 'municipal', 'placa',                                         'placa',                 1, false, 'PII: enmascarar en logs'),
  (4, 'municipal', 'codigoInfraccion',                              'codigoInfraccion',      1, false, NULL),
  (4, 'municipal', 'estadoCuenta.infraccion.0.codigoInfraccion',    'codigoInfraccion',      2, false, NULL),
  (4, 'municipal', 'descripcionInfraccion',                         'descripcionInfraccion', 1, false, NULL),
  (4, 'municipal', 'estadoCuenta.infraccion.0.descripcion',         'descripcionInfraccion', 2, false, NULL),
  (4, 'municipal', 'fechaComparendo',                               'fechaComparendo',       1, false, 'ISO sin hora en la captura (2026-07-19).'),
  (4, 'municipal', 'fechaNotificacion',                             'fechaNotificacion',     1, false, 'HU #11794: en la RAIZ del item de informacionComparendo. Dos grafias medidas por este mismo camino — Medellin ISO (2026-07-30) y Bogota DD/MM/YYYY SIN HORA (14/05/2026)—, asi que la homologacion la hace el parser y no una fila por grafia.'),
  (4, 'municipal', 'estadoCuenta.secretaria.nombreAutoridadTransito','organismo',            1, false, 'Unica hoja autorizada de estadoCuenta.secretaria. estadoCuenta.direccion es PII y queda fuera.'),
  (4, 'municipal', 'organismo',                                     'organismo',             2, false, 'Respaldo plano por si otro municipio lo publica asi.'),
  (4, 'municipal', 'valor',                                         'monto',                 1, false, 'Numero JSON. proyeccionMultaDTO.valorConDescuento50 NO se mapea: es proyeccion condicionada.'),
  (4, 'municipal', 'monto',                                         'monto',                 2, false, 'Respaldo.'),
  (4, 'municipal', 'descripcionEstado',                             'estadoFuente',          1, false, 'Texto crudo del proveedor («Se adeuda»); no se normaliza.'),
  (4, 'municipal', 'codigo',                                        'codigoInfraccion',      3, false, 'Respaldo: nombre de la v1, que es el que emite el mock del UTS. Sin esta fila el modo mock (el DEFECTO) homologa codigoInfraccion a NULL.'),
  (4, 'municipal', 'descripcion',                                   'descripcionInfraccion', 3, false, 'Respaldo: nombre de la v1 y del mock. Sin esta fila se cae el escenario CF-08 del mock.'),
  (4, 'municipal', 'fecha',                                         'fechaComparendo',       2, false, 'Respaldo: nombre de la v1 y del mock.'),
  (4, 'municipal', 'estado',                                        'estadoFuente',          2, false, 'Respaldo: nombre de la v1 y del mock del UTS, que es el modo por defecto. Por eso aqui NO es un alias inerte y va delante de estadoPago.'),
  (4, 'municipal', 'estadoPago',                                    'estadoFuente',          3, false, 'HU #11712: mismo campo que en SIMIT, no observado en este origen. Respaldo de ultima prioridad.'),
  (4, 'municipal', 'nroResolucion',                                 'numeroResolucion',      1, false, 'HU #11712: nombre VERIFICADO contra el proveedor real. `fechaResolucion` NO se mapea: el item real la trae con valor y nroResolucion en NULL a la vez, asi que fabricaria multas.'),
  (4, 'municipal', 'numeroResolucion',                              'numeroResolucion',      2, false, 'HU #11712: respaldo simetrico con el nombre largo de SIMIT, por si otro municipio lo publica asi. No observado.')
ON CONFLICT (version, origen, source_path) DO NOTHING;

COMMENT ON TABLE flito_comparendos_field_map IS
  'Homologacion versionable fuente -> canonico (ADR-0003). El merge lee la version MAXIMA y NO '
  'hereda de las anteriores, asi que cada version re-siembra los dos origenes enteros. La v1 (0150) '
  'era provisional; la v2 (0158) sale de payloads reales del 2026-08-20; la v3 (0160) le añadio la '
  'resolucion y estadoPago (HU #11712); la v4 (0164) le añade fechaNotificacion en los dos origenes '
  '(HU #11794) y es la vigente. Los source_path admiten rutas con punto y esta tabla ES la lista '
  'blanca de la poda RN-25: lo que no se nombre aqui no se persiste en payload_simit / '
  'payload_municipal, y por eso mapear un campo es tambien la unica forma de conservarlo crudo. '
  'tipo_registro NO es un target_field: lo deriva el merge.';
