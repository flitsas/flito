# Registro de terceros destinatarios de datos personales — FLITO

**Naturaleza del documento:** registro de cumplimiento (Ley 1581 de 2012 — Habeas Data, Colombia).
**No es un ADR.** No propone ni decide arquitectura, no tiene estado `Propuesto`/`Aceptado` y no vive
en `docs/adr/`. Es el papel que responde a una sola pregunta de auditoría: *¿a quién le remite FLITO
datos de un titular, qué dato exactamente, con qué finalidad y con qué base?*

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Fecha | 2026-08-18 |
| Autor | `architecture-agent` (documento), a partir de la auditoría de `security-agent` |
| Motivo | Cambio de contrato de las fuentes de `flito-comparendos` (commit `b9071bd`, rama `fix/flito-contratos-simit-municipal`). El NIT monitoreado pasa a viajar en la **query de un GET** hacia Verifik/SIMIT y ya viajaba como parámetro hacia el UTS municipal. `security-agent` verificó que **no existía en el repositorio ningún registro de esos dos terceros como destinatarios de un documento de identidad**. |
| Cobertura | **Parcial y declarada** — ver §5. Documenta a fondo Verifik y UTS municipal; enumera el resto de salidas del monorepo como *pendientes de documentar*. |
| Revisión jurídica | **PENDIENTE** — ver §6. Ningún autor de este documento es abogado. |

---

## 0. Advertencia de precisión: qué es dato personal aquí y qué no

Esta distinción condiciona todo el documento y se hace explícita porque el error contrario
—tratar todo identificador como PII— produce registros inflados que un auditor descarta:

- **El NIT de una persona jurídica NO es dato personal.** La Ley 1581 protege datos de **personas
  naturales** (su ámbito son los datos «registrados en cualquier base de datos susceptibles de
  tratamiento por entidades de naturaleza pública o privada» referidos a personas naturales). La
  doctrina de la SIC ha sostenido de forma constante que la información de personas jurídicas queda
  fuera. Un NIT `900.xxx.xxx-x` de una sociedad, por sí solo, no activa la 1581.
- **El NIT de una persona natural SÍ lo es.** En Colombia el NIT de una persona natural es su
  cédula (con dígito de verificación). El catálogo de NITs monitoreados de `flito-comparendos`
  **no impide** registrar un NIT de persona natural: admite cualquier documento que pase el Zod de
  alfabeto. El propio esquema lo dice —`COMMENT ON COLUMN flito_comparendos_registros.nit_monitoreado`,
  migración `0150`: *«PII (Ley 1581) cuando el NIT es de persona natural»*.
- **La placa es cuasi-PII.** No identifica directamente a una persona, pero permite identificarla
  indirectamente vía RUNT. El repositorio ya la trata así (`COMMENT ON COLUMN … .placa`, migración
  `0150`). Las placas **no** se remiten a las fuentes: solo llegan **desde** ellas.
- **Los payloads crudos de las fuentes sí traen datos personales.** Es la parte más sensible y no
  es hipotética: `COMMENT ON COLUMN … payload_simit` / `payload_municipal` (migración `0150`)
  declara *«DATOS PERSONALES DE TERCEROS (Ley 1581): el proveedor suele devolver nombre y documento
  del infractor, que el canónico NO mapea»*. Esos datos **entran**, no salen; pero su recepción y
  conservación son tratamiento y por eso figuran en cada ficha.

**Consecuencia operativa:** el dato que FLITO remite a Verifik y al UTS es un identificador cuya
naturaleza jurídica **depende de cada fila del catálogo de NITs**. Por tanto el registro se lleva
como si fuera dato personal (peor caso), y se deja como control pendiente el poder distinguir en el
catálogo persona natural de persona jurídica (§6, punto 5).

---

## 1. Identificación del Responsable del Tratamiento

| Campo | Valor | Estado |
|---|---|---|
| Razón social | FLIT S.A.S. (dominio corporativo `flitsas.com`; el producto se publica en `operaciones.flitsas.com`) | **A confirmar** razón social exacta y NIT con el área legal |
| Rol frente a estos datos | Responsable del Tratamiento | A confirmar por abogado |
| Relación con «Kyverum» | El código usa `kyverum.com` en infraestructura y pasarelas (`s3.kyverum.com`, `runt.kyverum.com`, `cea.kyverum.com`) y `User-Agent: Kyverum-Operaciones/1.0`. **No está documentado en el repositorio si Kyverum es la misma entidad jurídica, una marca o un tercero.** | **PENDIENTE — bloqueante para §5**: si Kyverum es otra persona jurídica, esas tres salidas son transmisiones a un tercero y necesitan ficha propia |
| Oficial de Protección de Datos / contacto de habeas data | No consta en el repositorio | **PENDIENTE** |
| Registro Nacional de Bases de Datos (RNBD) | No consta en el repositorio si las bases de FLITO están inscritas | **PENDIENTE** (aplica según activos totales del responsable; a validar con legal) |

---

## 2. Cómo leer cada ficha

Cada ficha declara, en este orden: **quién** recibe, **qué dato** exacto, **por dónde** viaja
(verbo, ruta, ubicación del dato en la petición), **para qué** (finalidad), **con qué base**,
**qué rol jurídico** tiene el receptor, **si cruza la frontera**, **qué se recibe de vuelta**,
**cuánto se conserva** y **qué mitigaciones técnicas están verificadas**.

Las afirmaciones técnicas llevan ancla a archivo. Las afirmaciones jurídicas que no puedo sustentar
van marcadas como **[VALIDAR]** y se listan agrupadas en §6.

---

## 3. Ficha 1 — Verifik (consulta SIMIT)

### 3.1 Identificación del destinatario

| Campo | Valor |
|---|---|
| Nombre comercial | Verifik — servicio de consulta SIMIT |
| Endpoint | `GET {VERIFIK_SIMIT_BASE_URL}/v2/co/simit/consultar` |
| Host | **Provisionado por Ops en `VERIFIK_SIMIT_BASE_URL`; no hay valor por defecto en el código** (decisión de ADR-0002 §6). El repositorio no contiene el host, así que **este registro no puede afirmar dónde está alojado**: hay que leerlo del `.env` de cada ambiente y anotarlo aquí (§6, punto 4). |
| Autenticación | `Authorization: Bearer <token SIMIT>`, cifrado en reposo AES-256-GCM (ADR-0002) |
| Módulo que lo invoca | `apps/api/src/modules/flito-comparendos/clients/verifik-simit.client.ts` |
| Estado operativo | **Ejercitable solo si `COMPARENDOS_SIMIT_MODE=real`.** El valor por defecto es `mock` (`apps/api/src/config/env.ts`), y en `mock` el adapter **no toca la red y no pide el token**. Es decir: en un ambiente sin esa variable puesta a `real`, **hoy no sale ningún NIT hacia Verifik**. |

### 3.2 Dato remitido

| Parámetro | Contenido | Naturaleza |
|---|---|---|
| `documentType` | Constante `NIT` | No es dato personal |
| `documentNumber` | NIT monitoreado del catálogo `flito_comparendos_nits` | **Dato personal si es NIT de persona natural** (§0). Peor caso asumido. |

**Ubicación exacta del dato:** query string de un `GET`, construida con `URLSearchParams` (no por
interpolación). Antes del commit `b9071bd` el contrato estaba documentado como `POST` con el NIT en
el cuerpo; era una descripción equivocada del contrato del proveedor, no una regresión. **El verbo
y la ubicación del dato los impone el proveedor, no FLITO.**

**Consecuencia que hay que decir en voz alta:** un identificador en una query string queda escrito
en el log de acceso de **cualquier proxy del lado del proveedor** por el que pase la petición. Eso
está fuera del control técnico de FLITO y es la razón por la que este registro existe.

**Precisión sobre la regla interna:** `AGENTS.md` §14 gobierna **nuestras** superficies (rutas y
query de `apps/web`, nuestros access logs, los filtros de nuestra API autenticada) y ahí su default
—PII en body de un `POST …/buscar`— se sigue cumpliendo: la búsqueda de comparendos de nuestra API
es `POST /registros/buscar`. Una llamada **saliente** a un tercero no la regula §14; lo que aplica
es la Ley 1581 por remisión del dato. Esta distinción se corrigió expresamente en `b9071bd`.

### 3.3 Finalidad

Consultar los comparendos vigentes asociados al NIT monitoreado, para construir el inventario
operativo de deudas de tránsito de la flota (Feature #11492, módulo `flito-comparendos`). La
finalidad es **operativa y determinada**; no hay perfilamiento, no hay cesión comercial y no hay
uso secundario del dato remitido.

### 3.4 Base del tratamiento — **[VALIDAR]**

Candidatas, en orden de solidez esperada:

1. **Interés legítimo del empleador/operador de flota en conocer sus propias obligaciones**, cuando
   el NIT es de una empresa del grupo (en cuyo caso, además, no hay dato personal en juego).
2. **Autorización del titular**, cuando el NIT es de persona natural (conductor propietario,
   tercero vinculado). **El repositorio no contiene ningún mecanismo que capture o verifique esa
   autorización antes de dar de alta un NIT en el catálogo.** Es el hallazgo de cumplimiento más
   importante de esta ficha.
3. **Cumplimiento de un deber legal / PESV**, si la consulta se enmarca en obligaciones del Plan
   Estratégico de Seguridad Vial. **[VALIDAR]** — no me consta que exista una norma que obligue a
   consultar comparendos por NIT, así que no la invoco.

> **Marcado como pendiente:** la Ley 1581 exige autorización previa, expresa e informada salvo las
> excepciones de su art. 10. No afirmo aquí cuál de las excepciones aplicaría porque no puedo
> sustentarlo. **Debe decidirlo el área jurídica.**

### 3.5 Rol jurídico del receptor — **[VALIDAR]**

Dos lecturas posibles, y **cambian el instrumento contractual exigible**:

- **Verifik como Encargado del Tratamiento:** procesa el identificador *por cuenta de* FLITO para
  devolver un resultado. Bajo esta lectura, la comunicación es una **transmisión** y exige contrato
  de transmisión con las cláusulas del régimen reglamentario (Decreto 1377 de 2013, compilado en el
  Decreto 1074 de 2015, Libro 2 Parte 2 Título 2 Capítulo 25) — **no cito el artículo exacto porque
  no puedo sustentar su numeración en el decreto compilado**.
- **Verifik como Responsable receptor:** opera sus propias fuentes y bases; bajo esta lectura la
  comunicación es una **transferencia** y la base de legitimación es distinta.

La diferencia entre *transmisión* y *transferencia* es la que determina qué papel hay que firmar.
**No la resuelvo yo.**

### 3.6 Transferencia/transmisión internacional

**No determinable desde el repositorio.** El host va por variable de entorno y no está en el código
(ADR-0002 §6, `.env.example`). Verifik es un proveedor con presencia en Colombia, pero **eso no
dice dónde está alojado el endpoint concreto**. Acción: leer `VERIFIK_SIMIT_BASE_URL` en cada
ambiente, resolver el host y anotar el resultado en esta casilla (§6, punto 4).

Si resultara alojado fuera de Colombia, aplica el régimen de transferencia internacional del
**art. 26 de la Ley 1581** (prohibición de transferencia a países sin nivel adecuado de protección,
con las excepciones que el propio artículo enumera). La lista de países con nivel adecuado la fija
la SIC por circular (**Circular Externa 005 de 2017 — verificar vigencia y contenido actual con
legal**; no afirmo aquí qué países la integran).

### 3.7 Datos recibidos de vuelta

La respuesta cruda se persiste en `flito_comparendos_registros.payload_simit`. Según el `COMMENT`
de la migración `0150`, **suele incluir nombre y documento del infractor**, que el modelo canónico
no mapea. Desde la HU #11511 el payload se poda a la lista blanca del `field_map`. Prohibido
exponerlo crudo por API o por log (lo declara el propio `COMMENT`).

### 3.8 Conservación

`COMPARENDOS_RETENTION_MONTHS`, por defecto **24 meses** (decisión humana del 2026-08-13), aplicada
por `flito-comparendos-purga.cron.ts`. El reloj es `ultimo_visto_en` y no `created_at` (RN-26): se
purga lo que ninguna fuente ha vuelto a reportar dentro de la ventana. El cron tiene puerta positiva
(`COMPARENDOS_PURGA_CRON_ENABLED`) y frenos de ratio: **si la puerta está cerrada en un ambiente,
la retención declarada no se está ejecutando allí** — verificar por ambiente.

---

## 4. Ficha 2 — UTS municipal (organismos de tránsito)

### 4.1 Identificación del destinatario

| Campo | Valor |
|---|---|
| Nombre | UTS municipal — servicio de consulta de infracciones de los organismos de tránsito municipales |
| Endpoint | `GET {UTS_MUNICIPAL_BASE_URL}/infraction/api/Infraccion/ConsultarInfraccionFuente` |
| Host | EC2 de **AWS en la región `us-east-1`** (host bajo `compute-1.amazonaws.com`), según lo verificado por el Líder Técnico. **El valor concreto no está en el repositorio**: va en `UTS_MUNICIPAL_BASE_URL`, sin default, y solo el origen (la ruta la pone el adapter). |
| Autenticación | **Ninguna.** El UTS no pide autorización; el token de Verifik no viaja aquí, deliberadamente. |
| Módulo que lo invoca | `apps/api/src/modules/flito-comparendos/clients/uts-municipal.client.ts` |
| Estado operativo | **OPERATIVO desde el 2026-08-20** (antes no lo era: el adapter rechazaba la base `http://`). Confirmado que el proveedor **solo publica `http://`** y que el endpoint está en **AWS `us-east-1`**; David decidió ese día abrir la excepción, acotada a esta fuente (`permitirTextoPlano` en `baseUrlExigida` y en `httpsGetJson`). Verifik sigue siendo https-only porque lleva el Bearer. |
| **Cifrado de transporte** | **NINGUNO.** La transferencia del NIT monitoreado al UTS va **en claro, sobre HTTP**, en la query de un GET: es legible para cualquier intermediario de la ruta hasta `us-east-1`. Es una consecuencia asumida y no un descuido — sin ella la fuente no es consultable—. El adapter emite un `log.warn` por corrida («el NIT viaja sin cifrar»), sin URL ni NIT en claro. Mitigación pendiente: que el proveedor exponga HTTPS. |

### 4.2 Dato remitido

| Parámetro | Contenido | Naturaleza |
|---|---|---|
| `nit` | NIT monitoreado del catálogo | **Dato personal si es de persona natural** (§0) |
| `fuente` | Código del municipio (`BELLO`, `ITAGUI`, `MEDELLIN`…) | No es dato personal |

**Ubicación exacta:** query string de un `GET`, construida con `URLSearchParams`. Mismo comentario
que en §3.2 sobre logs de acceso del lado del receptor, **agravado**: al no haber `Authorization`,
la restricción de la RFC 9111 al almacenamiento en cachés compartidas de respuestas autenticadas no
aplica, y el único control que le quita a un proxy intermedio la discreción de almacenar la
respuesta es el `Cache-Control: no-store` que el adapter envía explícitamente.

### 4.3 Finalidad

Complementar la consulta SIMIT con los comparendos que solo figuran en el sistema del municipio.
El merge da prioridad a SIMIT y el municipal solo rellena campos ausentes (ADR-0003).

### 4.4 Base del tratamiento — **[VALIDAR]**

Mismas candidatas que §3.4, con un matiz propio: el receptor es (o actúa por cuenta de) una
**entidad pública** —el organismo de tránsito municipal—, y la consulta de infracciones de tránsito
es en principio información de acceso público a través de los portales oficiales. **No afirmo que
eso constituya por sí solo una excepción del art. 10 de la Ley 1581**: el hecho de que un dato sea
consultable públicamente no convierte automáticamente en lícita su recolección masiva y su
conservación en una base de datos propia, que es exactamente lo que hace este módulo. **Debe
validarlo el área jurídica.**

### 4.5 Rol jurídico del receptor — **[VALIDAR]**

Probablemente **Responsable receptor** (la entidad de tránsito es responsable de su propia base) y
no encargado. Bajo esa lectura la comunicación sería una **transferencia**. Igual que en §3.5, la
calificación no la hago yo.

**Complicación adicional:** el endpoint está en un EC2 de AWS, no en infraestructura `.gov.co`. Es
decir, el receptor técnico inmediato **no es el municipio** sino el operador que expone el UTS.
Quién opera ese servicio y bajo qué contrato con el municipio **no consta en el repositorio** — es
un tercero más en la cadena, sin identificar.

### 4.6 Transferencia internacional — **SÍ, y hay que decirlo**

El host es un EC2 de AWS en `us-east-1` (**Estados Unidos**). Por tanto:

- Aunque el titular del dato sea colombiano y el organismo de tránsito sea colombiano, **el dato
  cruza la frontera** al viajar hacia ese endpoint. Es transferencia/transmisión internacional a
  todos los efectos de la Ley 1581.
- Aplica el **art. 26 de la Ley 1581** (prohibición de transferencia a países que no proporcionen
  niveles adecuados de protección, con las excepciones enumeradas en el propio artículo).
- Si Estados Unidos figura o no en la lista de países con nivel adecuado de la SIC, y bajo qué
  condiciones, **es exactamente el tipo de dato que no debo afirmar de memoria**: hay que
  verificarlo contra la circular vigente de la SIC (Circular Externa 005 de 2017 y sus
  modificaciones). **[VALIDAR]**
- Si no hubiera nivel adecuado declarado, las vías típicas son la **autorización expresa e
  inequívoca del titular** para la transferencia, o un **contrato de transmisión** con las cláusulas
  del régimen reglamentario. **[VALIDAR]** cuál procede.

> **Nota de honestidad:** desde el 2026-08-20 este canal **sí está operativo** (§4.1) y además va
> **sin cifrado de transporte**. Lo que antes era una obligación futura es una obligación actual:
> en cuanto se provisione `UTS_MUNICIPAL_BASE_URL` en un ambiente y `COMPARENDOS_SIMIT_MODE=real`,
> la transferencia internacional ocurre en cada corrida del sync, en claro. Este registro debía
> estar cerrado antes; cerrarlo es ahora el pendiente #3 de §6.

### 4.7 Datos recibidos, conservación

Idénticos a §3.7 y §3.8, sobre la columna `payload_municipal`.

---

## 4.bis Mitigaciones técnicas verificadas (comunes a las dos fichas)

Verificadas de forma independiente por `security-agent` sobre el commit `b9071bd`. Se citan, no se
reescriben:

| # | Mitigación | Punto que la sostiene |
|---|---|---|
| M1 | **La URL saliente con el NIT dentro no llega a ningún log, respuesta HTTP ni fila de BD.** Un `Error` de red de Node trae la URL completa en su `message`; `comoErrorDeFuente` **descarta el objeto de error entero** y conserva únicamente `e.code`. | `clients/fuente-http.ts` → `comoErrorDeFuente` (lleva un aviso explícito en el propio archivo para quien lo edite) |
| M2 | Los `log.debug` / `log.warn` de ambos adapters registran `nit: maskDocument(nit)` y nunca la URL. Además, en producción el nivel de log es `info`, así que los `debug` ni siquiera se emiten. | `clients/verifik-simit.client.ts`, `clients/uts-municipal.client.ts`, `shared/logger.ts` |
| M3 | No hay APM, ni interceptores globales, ni handler de `unhandledRejection` por donde la URL pueda escapar. Verificado: ninguna dependencia de APM en `apps/api/package.json`, ningún `process.on('unhandledRejection')` en el código de producción, ningún envío de logs a un agregador externo configurado en `docker-compose*.yml` ni en `ecosystem.config.cjs`. | Inventario propio, coincide con `security-agent` |
| M4 | El `Authorization` de Verifik se desenvuelve (`token.unwrap()`) en una sola expresión, dentro del objeto de cabeceras, y ese objeto no se registra nunca. Token cifrado AES-256-GCM en reposo con llave dedicada (ADR-0002). | `clients/verifik-simit.client.ts`, `flito-comparendos.token.service.ts` |
| M5 | Las **lecturas** del módulo registran en `pii_access_log` (`shared/pii-audit.ts`) con los filtros enmascarados: `GET /sync/runs`, `GET /sync/runs/:id`, y las cuatro rutas de registros vía `registrarAccesoComparendos`. | `flito-comparendos.pii.ts`, `flito-comparendos.routes.ts` |
| M6 | Solo `https`: `baseUrlExigida` rechaza esquema distinto, base no parseable, y base con query o fragmento (esto último impide que el despliegue inyecte parámetros en la query que lleva el NIT). | `clients/fuente-http.ts` → `baseUrlExigida` |
| M7 | `Cache-Control: no-store` en ambas peticiones salientes. En el UTS es la única protección frente a cachés intermedias, porque la petición no lleva `Authorization`. | ambos adapters |
| M8 | La query se construye con `URLSearchParams`, nunca por interpolación: protege también frente a valores que entren por seed, migración o script y no por el Zod del API. | ambos adapters |
| M9 | Acceso restringido: todo el router exige `authMiddleware` + `requireRole('admin')`, con rate limit propio en alta de NIT, sync y lectura de registros. | `flito-comparendos.routes.ts` |
| M10 | Retención efectiva declarada y ejecutada (24 meses por defecto), con frenos que abortan la pasada ante un borrado anómalo. | `flito-comparendos-purga.cron.ts` (RN-26 a RN-30) |

### Hueco conocido y **NO resuelto** — se registra como tal

> **`POST /api/flito/comparendos/sync` —que es *la* operación que remite el NIT al tercero— escribe
> `audit()` pero NO `logPiiAccess`.**
>
> - Verificado en `apps/api/src/modules/flito-comparendos/flito-comparendos.routes.ts`, handler de
>   `POST /sync`: el `audit()` que hay registra alcance y contadores (`resource: 'flito_comparendos_sync'`),
>   que responde «quién disparó una corrida», **no** «de quién se remitieron datos y a quién».
> - Por qué importa: bajo el **art. 17 de la Ley 1581** (deberes del Responsable), la comunicación de
>   los datos de un titular a un tercero es justamente uno de los hechos sobre los que el titular
>   puede preguntar. Hoy, ante la pregunta *«¿ustedes le remitieron mi documento a alguien, cuándo y
>   a quién?»*, la respuesta del sistema es incompleta. **No cito literal del art. 17 porque no
>   puedo sustentar cuál corresponde exactamente.**
> - Asimetría que lo hace evidente: las **lecturas** de datos dejan `pii_access_log`, pero la
>   **remisión** —que es el evento más sensible de los dos— no.
> - Estado: **pendiente de corrección en otro PR.** Este registro **no lo da por resuelto** y debe
>   actualizarse cuando se cierre.

---

## 5. Declaración de cobertura

**Este registro cubre a fondo dos destinatarios: Verifik y el UTS municipal.** El monorepo tiene
más salidas hacia terceros. Enumerarlas —aunque sea en una línea— es lo que impide que este
documento sea engañoso para su único lector, que es un auditor.

Inventario obtenido por búsqueda directa sobre `apps/api/src` (hosts en código y variables de
entorno), no de memoria. **Ninguna de las siguientes tiene ficha; todas están PENDIENTES DE
DOCUMENTAR.**

### 5.1 Salidas que SÍ remiten datos personales o cuasi-PII

| Destinatario | Qué es | Qué remite | Ancla |
|---|---|---|---|
| **Siigo** (`api.siigo.com`, `documentview.siigo.com`) | ERP contable / facturación electrónica | **Sí**: crea y actualiza terceros con `identification`, `person_type: 'Person'`, nombre, y datos de contacto de personas naturales | `modules/siigo/siigo.terceros.service.ts` |
| **Pasarela RUNT de Kyverum** (`runt.kyverum.com`) | Consulta de vehículos y personas ante el RUNT | **Sí**: `documento` + `tipoDocumento` de la persona en el cuerpo del POST | `modules/runt/runt.service.ts` |
| **RUNT directo** (`runtproapi.runt.gov.co`, `portalpublico.runt.gov.co`) | Consulta directa al RUNT (Ministerio de Transporte) | **Sí**: documento del ciudadano / placa | `modules/runt/runt-direct.service.ts` |
| **SIMIT FCM** (`consultasimit.fcm.org.co`, `qxcaptcha.fcm.org.co`) | SIMIT de la Federación Colombiana de Municipios — **distinto** del Verifik de la Ficha 1; sirve al pre-vuelo de trámites, no a `flito-comparendos` | **Sí**: documento y/o placa | `modules/integraciones/simit.direct.ts` |
| **Proxy CEA** (`cea.kyverum.com`) | Proxy legacy a SIMIT / Fasecolda / MercadoLibre / tránsitos; marcado en el código como «se elimina en Fase 3 del desacople» | **Sí** (consulta SIMIT y trámites de tránsito) | `modules/integraciones/cea-proxy.ts`, `modules/tramites/tramites.service.ts` |
| **Anthropic** (`api.anthropic.com`) | Motor de OCR y extracción documental | **Sí, y del tipo más sensible**: imágenes de documentos (cédula, licencias, tarjetas de propiedad). **Transferencia internacional** (EE. UU.) | `modules/tramites/anthropic.ts`, `modules/vehicles/ocr.pipeline.ts`, `modules/runt/runt.routes.ts`, `modules/drive/procesador.service.ts`, `modules/flito-ocr/flito-ocr.service.ts` |
| **Meta — WhatsApp Cloud API** (`graph.facebook.com`) | Notificaciones a partes de un trámite | **Sí**: número de teléfono del destinatario y el texto del mensaje (nombre, placa, enlace de verificación). **Transferencia internacional** | `modules/tramites/notificaciones.ts` |
| **SMTP saliente** (Office 365, host en `SMTP_HOST`) | Correo transaccional | **Sí**: correo, nombre, placa y enlaces de verificación de identidad en el cuerpo | `services/email.ts`, `modules/tramites/identidad.routes.ts` |
| **RNDC / Ministerio de Transporte** (SOAP, `plc.mintransporte.gov.co` en sandbox) | Reporte legal de manifiestos y remesas | **Sí**: documentos de conductores, propietarios, tenedores, destinatarios. Hoy el repositorio solo tiene cliente **mock** (`RNDC_MODE` por defecto `mock`); el cliente SOAP real está anotado como Fase 4.3 | `modules/rndc/client/`, `modules/rndc/envio.service.ts` |
| **Rentas de Caldas** (`rentas.caldas.gov.co`) | Liquidación de impuesto vehicular | **Cuasi-PII**: placa del vehículo | `modules/integraciones/impuesto-vehicular.direct.ts` |
| **MinIO / S3** (`s3.kyverum.com` por defecto) | Almacenamiento de archivos (fotos, documentos) | **Sí**, si el host es operado por un tercero. **Depende de si Kyverum es la misma entidad jurídica que el Responsable** (§1) | `services/storage.ts`, `config/env.ts` |

### 5.2 Salidas que NO remiten datos personales (verificado)

| Destino | Qué es | Por qué no |
|---|---|---|
| **Fasecolda** (`guiadevalores.fasecolda.com`) | Guía de valores de vehículos | Se consultan códigos y características del vehículo, no personas |
| **MercadoLibre** (`api.mercadolibre.com`) | Referencia de precios de vehículos | Búsqueda por texto de modelo; sin datos de persona |
| **OFAC / ONU / UE** (`www.treasury.gov`, `scsanctions.un.org`, `webgate.ec.europa.eu`) | Listas restrictivas para el módulo LAFT | **Solo descarga**: se bajan las listas completas y el cotejo de nombres ocurre **en local**. No sale ningún nombre nuestro | `modules/laft/lists/`, `modules/laft/sync/` |
| **Google Drive** (`www.googleapis.com`) | Origen de documentos a procesar | Scope `drive.readonly`; se listan carpetas por `folderId` y se descargan archivos. **Recibe** PII en los documentos, **no remite** | `services/googleDrive.ts` |
| **FLIT** (`…execute-api.us-east-1.amazonaws.com/pdn`) | Reporte público de trámites que alimenta `flito-sync` | **Es fuente, no destinatario**: se consulta por rango de fechas y tipo de reporte, y **recibe** de vuelta `cedulanit`, `nombres`, `celular`, `correoelectronico`, `direccion`. Como receptor de datos no aplica; **como remitente hacia nosotros, la relación jurídica con FLIT sí debe documentarse aparte** | `modules/flito-sync/flit-http.adapter.ts` |
| **SuperTransporte / UIAF-SIREL** (`www.supertransporte.gov.co`, `reportes.uiaf.gov.co`) | Portales de cargue PESV y reporte ROS | El sistema **genera el paquete**; el cargue al portal lo hace un humano manualmente. No hay llamada saliente automatizada | `modules/pesv/export.routes.ts`, `modules/laft/ros.routes.ts` |
| **`maps.google.com`** | Enlace de ubicación en un texto de notificación | Se construye una URL con lat/lng para que la abra un humano; no hay petición saliente desde el servidor | `modules/drivers/incidents.routes.ts` |

### 5.3 Observación de infraestructura

No hay **ningún** envío de logs a un agregador externo configurado en el repositorio
(`docker-compose.yml`, `docker-compose.prod.yml`, `ecosystem.config.cjs`, `scripts/`). El comentario
de `shared/logger.ts` menciona fluent-bit/vector/datadog como destino previsto: **si Ops habilita
uno, ese agregador pasa a ser un destinatario adicional** y este registro debe recogerlo.

---

## 6. Puntos que requieren validación jurídica

Dirigidos al Líder Técnico para que los escale a quien corresponda. **El LT es líder técnico, no
abogado; ninguno de estos puntos debería cerrarse dentro del equipo de ingeniería.**

| # | Punto | Quién debe resolverlo |
|---|---|---|
| 1 | **Calificación de Verifik y del UTS: ¿encargados (transmisión) o responsables receptores (transferencia)?** Determina si hace falta contrato de transmisión con las cláusulas del régimen reglamentario. | Abogado / oficial de protección de datos |
| 2 | **Base de legitimación para remitir un NIT de persona natural** a las dos fuentes. Hoy **no existe en el sistema ningún mecanismo que capture o verifique autorización del titular antes de dar de alta un NIT en el catálogo.** | Abogado + producto |
| 3 | **Transferencia internacional al UTS (AWS `us-east-1`, EE. UU.)**: si aplica alguna excepción del art. 26 de la Ley 1581, si EE. UU. figura en la lista de países con nivel adecuado de la SIC vigente, y qué instrumento hace falta si no. | Abogado |
| 4 | **Localización real de los endpoints**: leer `VERIFIK_SIMIT_BASE_URL` y `UTS_MUNICIPAL_BASE_URL` en cada ambiente, resolver los hosts y anotar el resultado en §3.1 y §4.1. Sin esto, la casilla de transferencia internacional de la Ficha 1 queda vacía. | Ops + LT (técnico, no jurídico) |
| 5 | **Distinguir persona natural de persona jurídica en el catálogo de NITs.** Hoy el módulo no lo modela, así que todo NIT se trata como peor caso. Un campo de tipo de persona permitiría aplicar el régimen solo donde corresponde — y detectar altas de cédulas que quizá no deberían estar ahí. | LT + producto (con criterio jurídico sobre el efecto) |
| 6 | **Identidad de «Kyverum»** frente al Responsable (§1). Si es otra persona jurídica, `s3.kyverum.com`, `runt.kyverum.com` y `cea.kyverum.com` son transmisiones a un tercero y necesitan ficha propia. | Legal + LT |
| 7 | **Alcance del aviso de privacidad y de las autorizaciones ya recogidas**: ¿cubren la remisión a estos destinatarios y la conservación de payloads con nombre y documento del infractor? | Abogado |
| 8 | **Inscripción en el RNBD** de las bases del módulo, y si el registro de terceros destinatarios debe reflejarse allí. | Abogado |
| 9 | **Aplicabilidad de este registro al resto de salidas de §5.1** y prioridad de documentación. Mi recomendación técnica de orden: Anthropic (imágenes de cédula al exterior) → RUNT/SIMIT-FCM → Siigo → Meta/WhatsApp → SMTP → RNDC. | LT, con validación jurídica |

**Citas legales usadas en este documento y su nivel de confianza:**

- Ley 1581 de 2012, **art. 26** (transferencia a países sin nivel adecuado, y sus excepciones) — citado por artículo, sin literal. Confianza alta en la materia del artículo.
- Ley 1581 de 2012, **art. 17** (deberes del Responsable) — citado por artículo, **sin literal, deliberadamente**: no puedo sustentar cuál literal corresponde a la comunicación de datos a un tercero.
- Ley 1581 de 2012, **art. 10** (casos en que no se requiere autorización) — mencionado como el lugar donde vive la excepción, **sin afirmar que alguna aplique**.
- Decreto 1377 de 2013, compilado en el **Decreto 1074 de 2015** (Libro 2, Parte 2, Título 2, Capítulo 25) — citado **sin numeración de artículo en el decreto compilado**, porque no puedo sustentarla.
- SIC, **Circular Externa 005 de 2017** (países con nivel adecuado de protección) — citada **con la instrucción explícita de verificar vigencia y contenido**. No enumero países.
- **No se cita la Ley 1266 de 2008** (dato financiero y crediticio): no es el régimen aplicable a este tratamiento.

---

## 7. Mantenimiento de este registro

Se actualiza —y no se archiva— cuando ocurra cualquiera de estas cosas:

1. Se añade una llamada saliente a un tercero que remita un dato de persona natural.
2. Cambia el contrato de una salida existente: verbo, ubicación del dato, host o proveedor.
3. Se cierra el hueco del `POST /sync` sin `logPiiAccess` (§4.bis) → actualizar esa entrada.
4. ~~El proveedor del UTS expone HTTPS~~ → **ocurrido de otra forma el 2026-08-20**: se abrió el
   canal sobre `http://` sin esperar al HTTPS (§4.1), así que la transferencia internacional de
   §4.6 ya es real **y sin cifrado de transporte** en cuanto se provisione
   `UTS_MUNICIPAL_BASE_URL`. Vuelve a actualizarse el día que el proveedor sí exponga HTTPS.
5. Se documenta a fondo cualquiera de las salidas de §5.1 → sale de «pendiente» y gana ficha.
6. Ops habilita envío de logs a un agregador externo (§5.3).

---

## Anexo A — Dónde debería vivir este documento en el repositorio

**Recomendación: `docs/privacy/registro-terceros-destinatarios.md`** (carpeta nueva).

Razones, en orden:

1. **No es un ADR y no debe estar en `docs/adr/`.** Los cinco ADR existentes deciden arquitectura y
   tienen estado y campo `Supersedes`. Este documento no decide nada: constata. Meterlo allí
   obligaría a darle un estado que no tiene sentido para un papel de cumplimiento, y contaminaría
   la numeración `ADR-000N` con algo que un auditor —no un ingeniero— viene a buscar.
2. **No es `docs/features/`** (documentos de diseño por Feature, con ciclo de vida ligado a un WI de
   ADO), **ni `docs/integraciones/`** (documentación *técnica* de cómo hablar con un proveedor, como
   `siigo-api.md`), **ni `docs/ux/`**. Este registro cruza varios Features y varias integraciones a
   la vez, y su vigencia no termina cuando el Feature se cierra.
3. **`docs/privacy/` empareja con el módulo `apps/api/src/modules/privacy/`**, que es donde ya viven
   los derechos del titular (`privacy.routes.ts`), la consulta de accesos a PII
   (`pii-access.routes.ts`) y el cron de retención (`retention.cron.ts`). La correspondencia
   documento↔código es la misma convención que el repositorio ya usa en `docs/integraciones/`.
4. **La carpeta va a tener más de un inquilino**, y eso es un argumento a favor de crearla en vez de
   dejar el archivo suelto: la política de retención por dominio, el inventario de bases para el
   RNBD y las fichas del resto de destinatarios de §5.1 son documentos hermanos de este.
5. **Alternativa razonable si se prefiere no crear carpeta:** `docs/privacy-registro-terceros.md` en
   la raíz de `docs/`. Funciona, pero envejece peor en cuanto aparezca el segundo documento de
   cumplimiento — que aparecerá.

Sugerencia adicional: enlazarlo desde `AGENTS.md` §14 y §16, que son los puntos donde un agente o
una persona buscando la regla de PII acabaría mirando primero.
