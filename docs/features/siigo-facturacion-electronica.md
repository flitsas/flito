# Facturación electrónica de trámites vía Siigo API — Features (borrador local)

> **Estado:** Features creadas en Azure DevOps (serie 10-15, IDs 11239-11244). Este documento
> sigue siendo la fuente de diseño detallado que citan.
> Base técnica: [`docs/integraciones/siigo-api.md`](../integraciones/siigo-api.md).
> Implementación de referencia: [`docs/uso-siigo/`](../uso-siigo/README.md) — cliente portable con
> las formas exactas de los payloads (`EJEMPLO_CLIENTE`, `EJEMPLO_FACTURA`), el patrón de reserva
> idempotente (restricción `UNIQUE` + `INSERT ... ON CONFLICT DO NOTHING` **antes** de llamar a
> Siigo), el saneamiento de `name` y la normalización de la respuesta (`cufe`, `pdf_url`,
> `stamp_status`, `public_url`). Insumo directo de F3, F4 y F5.

## 1. Objetivo

Emitir la factura electrónica de venta de un trámite ante la DIAN a través de Siigo API,
disparada desde el módulo **Reporte de costos**, y entregarla por correo al solicitante.

## 1.1 Decisiones tomadas

| # | Decisión | Estado |
|---|---|---|
| D-1 | **Granularidad de la factura** | **Diferida.** Se implementa *una factura por trámite*, pero el modelo de datos nace preparado para consolidar (ver §7). |
| D-2 | **Tratamiento tributario de los conceptos** | **Diferida.** No se asume nada: la clasificación tributaria y los impuestos son configurables por concepto, y la emisión en producción se bloquea hasta confirmarlos (ver §7). |
| D-3 | **Destinatario del correo** | `clients.email` — el correo de la compañía que ya existe en FLITO. No se agrega modelo nuevo. |
| D-4 | **Relación con «Facturar»** | La emisión electrónica es un **paso posterior**: «Facturar» sigue congelando la liquidación como hoy, y la emisión actúa sobre trámites ya marcados como facturados. |

D-4 tiene una consecuencia útil: como la emisión no toca el flujo contable actual, se puede emitir
el histórico ya facturado sin modificar nada de lo que hoy funciona.

## 2. Traducción de conceptos

| Siigo | FLITO | Dónde vive hoy |
|---|---|---|
| Producto | Concepto de costo de un trámite: SOAT, impuesto, derecho de tránsito, trámite digital, logística, GMF | `flito_tarifas_compania.concepto`, columnas de `flito_liquidaciones` |
| Cliente (tercero) | Compañía gestora del trámite | `clients` |
| Factura de venta | Factura de un trámite con el detalle de cada concepto | `flito_liquidaciones` (liquidación sellada) + `finanzas.service.ts` |
| Ítem de la factura | Una línea por concepto con valor ≠ NULL | `EXPR_SOAT`, `EXPR_IMPUESTO`, `EXPR_DERECHO`, `EXPR_DIGITAL`, `EXPR_LOGISTICA`, `EXPR_GMF` |

El flujo actual ya tiene el punto de enganche natural: `POST /flito/liquidacion/:tramiteId/facturar`
marca la liquidación como `facturado` y la congela definitivamente. La emisión electrónica se
acopla ahí.

## 3. Lo que ya existe y se reutiliza

- **Reporte de costos** (`apps/web/src/pages/FinanzasReporteCostos.tsx`) ya tiene selección
  múltiple, filtros (incluido `facturado=si|no` y `documentacionCompleta`) y acciones por fila.
- **Liquidación sellada** (`flito_liquidaciones`) ya congela los valores por concepto y distingue
  `NULL` = «no aplica» de cero. Es exactamente la fuente que necesita la factura.
- **Patrón de integración externa ya probado en RNDC** — reutilizable casi tal cual:
  - credenciales cifradas AES-256-GCM con AAD por fila (`rndc_credenciales`),
  - log WORM append-only de operaciones (`rndc_operaciones`),
  - idempotencia persistida (`rndc_idempotency_keys`),
  - outbox con estados `pendiente | enviado | error | fallido_definitivo`,
  - `MODE = mock | real` + `AMBIENTE = sandbox | produccion` en `env.ts`.
- **Circuit breaker** (`services/circuitBreaker.ts`) y **email** (`services/email.ts`).
- **Storage S3** (`services/storage.ts`) y `clients.flitoCarpetaStorage` para archivar PDF/XML.

## 4. Brechas detectadas en el modelo actual

Esto es lo que **no** existe hoy y condiciona el alcance:

1. **`clients` no tiene datos fiscales suficientes para Siigo.** Tiene `name`, `document`,
   `documentType` (varchar 5, default `'NIT'`), `email`, `phone`, `address`, `city` (texto libre).
   Siigo exige además: `person_type`, `id_type` como código numérico (13/31/…),
   `fiscal_responsibilities[].code`, y `address.city.{country_code, state_code, city_code}`
   (códigos, no texto). **`city` en texto libre no es convertible a código de forma confiable.**
2. **No hay forma de pago ni vencimiento por trámite.** Siigo exige `payments[]` con `id` y `value`.
3. **No hay IVA en ningún lado.** El reporte de costos no tiene columna de impuestos sobre venta.
   Si FLIT factura IVA sobre honorarios, el total de FLITO ≠ el total de la factura Siigo.
4. **No hay tabla de mapeo** concepto→producto Siigo ni cliente FLITO→tercero Siigo.
5. **No hay cola/worker genérico.** RNDC usa outbox + cron; hay que replicar el patrón.
6. **Aún no hay acceso a Siigo** — el desarrollo debe poder completarse contra un mock.

---

# Features propuestas

## F1 — Cimientos de integración con Siigo API

**Objetivo:** dejar operativo el canal técnico con Siigo antes de emitir nada.

**Alcance**
- Tabla `siigo_credenciales` con `username` y `access_key` cifrados AES-256-GCM (mismo esquema que
  `rndc_credenciales`: cipher + iv + auth_tag + `aad_nonce` + `key_version`), `ambiente`
  (`pruebas|produccion`) y `activo`.
- Cliente HTTP `siigo.client.ts`: `POST /auth`, caché del `access_token` (24 h) con renovación
  proactiva y reintento único ante 401, header `Partner-Id` fijo, `Idempotency-Key` por comprobante.
- **Throttle a 100 req/min** por empresa + backoff exponencial ante 429, `timeout` de 120 s en
  creación de comprobantes, y circuit breaker reutilizando `withCircuitBreaker`.
- Traducción de la estructura de error de Siigo (`{Status, Errors[{Code, Message, Params, Detail}]}`)
  a un error tipado del dominio, con el `Code` preservado para decidir si un fallo es reintentable.
- **Modo `mock | real`** (`SIIGO_MODE`) para desarrollar y probar sin acceso al ambiente real.
- Log WORM `siigo_operaciones` (request/response, duración, resultado, código) — sin volcar
  credenciales ni el token.
- Endpoint de diagnóstico «probar conexión» para admin.

**Fuera de alcance:** cualquier emisión de comprobantes.

**Riesgos:** el bloqueo de usuario de Siigo si >80 % de requests fallan durante 7 días hace que un
bug en bucle de reintentos sea costoso; el backoff y el `fallido_definitivo` son obligatorios, no
opcionales.

---

## F2 — Parametrización: catálogos y mapeo de conceptos a productos

**Objetivo:** que un concepto de costo de FLITO sepa qué producto es en Siigo, y que la factura
sepa con qué comprobante, vendedor y forma de pago nacer.

**Alcance**
- Sincronización y caché de catálogos de Siigo: `/v1/document-types?type=FV`, `/v1/users`,
  `/v1/payment-types`, `/v1/taxes`, `/v1/account-groups`, centros de costo.
- Tabla `siigo_mapeo_conceptos`: `concepto` (`soat`, `impuesto`, `derecho_tramite`,
  `tramite_digital`, `logistica`, `gmf`) → `product_code` de Siigo + `tax_classification`
  (`Taxed | Exempt | Excluded`) + `taxes[]` aplicables + unidad de medida +
  `es_ingreso_terceros` (bool) + `confirmado_por_contabilidad` (bool).
- **El tratamiento tributario es dato, no código (D-2).** Ningún concepto lleva su clasificación
  quemada en el armado del payload: se lee de esta tabla. Cuando contabilidad defina si hay IVA
  sobre honorarios o si SOAT/impuesto/derecho van como ingresos para terceros, es un cambio de
  configuración, no de desarrollo.
- **Gate de producción:** la emisión contra el ambiente real se rechaza mientras algún concepto
  aplicable tenga `confirmado_por_contabilidad = false`. En mock/pruebas no aplica el gate, para no
  frenar el desarrollo.
- Configuración global de emisión: `document.id` (tipo de comprobante FV), `seller` por defecto,
  `payment.id` por defecto, `cost_center` opcional.
- Pantalla de administración dentro de parametrización FLITO, con validación en vivo contra los
  catálogos (si el `product_code` no existe o está inactivo en Siigo, no se guarda).
- Opción de **crear los productos faltantes en Siigo** desde FLITO (`POST /v1/products`), respetando
  que `code` no admite espacios y ≤30 chars.

**Decisión abierta:** ver preguntas 1 y 2 — la granularidad del producto y el tratamiento tributario
determinan si esto son 6 productos o N (tipo de trámite × concepto).

---

## F3 — Sincronización de clientes FLITO → terceros Siigo

**Objetivo:** garantizar que el tercero existe en Siigo antes de enviarle un trámite.

**Alcance**
- **Completar el modelo fiscal de `clients`**: `person_type`, `id_type` (código Siigo),
  `check_digit`, `fiscal_responsibilities`, `country_code`/`state_code`/`city_code`,
  `commercial_name`, `branch_office`, y datos de contacto separados (`first_name`, `last_name`,
  `email`, indicativo/número). Migración + UI en la pantalla de Clientes.
- Catálogo local de ciudades DANE (país/departamento/ciudad) a partir del XLSX oficial de Siigo,
  para poder mapear el `city` en texto libre que hay hoy.
- Tabla `siigo_terceros`: `client_id` → `siigo_customer_id` (UUID) + `identification` +
  `branch_office` + `sincronizado_en` + `hash` de los datos enviados.
- Servicio `asegurarTercero(clientId)`: busca por `GET /v1/customers?identification=…`; si existe,
  vincula; si no, lo crea con `POST /v1/customers`. Si existe y los datos cambiaron, `PUT` completo
  (Siigo **reemplaza**, no hace merge: hay que reenviar todo el objeto).
- **Validador previo**: pantalla/informe de «clientes no facturables» que lista qué campo fiscal le
  falta a cada cliente antes de intentar emitir.
- **Saneamiento de `name` según el tipo de persona**: es siempre un array, pero su forma depende
  de `person_type` — `[nombres, apellidos]` para persona natural y `[razón social]` de un solo
  elemento para compañía. La limpieza también depende del tipo: para persona natural se eliminan
  dígitos y signos (Siigo los rechaza), pero la razón social **conserva dígitos y siglas** —
  «TRANSPORTES 3M S.A.S.» no debe convertirse en «TRANSPORTES M S.A.S.». `limpiarNombre()` de la
  referencia aplica solo al caso Person. El validador previo detecta nombres rechazables según el
  tipo de persona. Ver [`docs/uso-siigo/`](../uso-siigo/README.md).
  **Quien decide la forma es el `person_type` nuevo, no una suposición sobre la cartera**: hoy la
  mayoría de los clientes son compañías (`clients.document_type` tiene default `NIT`), pero el
  modelo no lo restringe — no hay enum en el esquema y `clients.routes.ts` acepta cualquier cadena
  de hasta 5 caracteres. **Se implementan y se prueban las dos ramas**, Person y Company; la
  migración deriva `person_type` del `document_type` existente (`NIT` → Company; `CC`/`CE`/`TI` →
  Person) y deja explícito qué hacer con las filas sin dato, que quedan como no facturables hasta
  que un humano las clasifique.

**Regla de negocio:** un cliente sin datos fiscales completos **bloquea** la emisión de sus trámites
con un mensaje accionable, no con un error genérico de Siigo.

---

## F4 — Emisión de la factura electrónica desde Reporte de costos

**Objetivo:** el disparador funcional del requerimiento.

**Alcance**
- Acción **«Enviar a facturación electrónica»** en Reporte de costos, por fila y en lote sobre la
  selección existente. Habilitada solo para trámites que cumplan las precondiciones: liquidación
  **sellada y ya marcada como facturada** (D-4), cliente sincronizado, conceptos mapeados y
  documentación completa.
- Armado del `InvoiceIn` desde la liquidación sellada:
  - `document.id`, `date`, `customer.identification`, `seller` de la parametrización;
  - un `item` por cada concepto con valor **no NULO** (respetando que `NULL` = no aplica);
  - `payments[]` según parametrización;
  - `observations` con el `idFlit`, la placa y el tipo de trámite para trazabilidad;
  - `stamp.send = true` (DIAN) y envío al correo de la compañía (D-3);
  - `Idempotency-Key` derivado del `id` del **lote de facturación** (ver §7) — **estable, no
    aleatorio**, para que un reintento nunca genere una factura duplicada;
  - la forma exacta del payload (`items`, `payments`, `stamp.send`, `send_email`) sigue
    `EJEMPLO_FACTURA` de [`docs/uso-siigo/siigo-uso.js`](../uso-siigo/siigo-uso.js);
  - validación de sanidad en servidor al armar: total > 0, ítems con código de producto e importes
    no negativos (`validarItems()` de la referencia), aunque los valores salgan de la liquidación
    sellada.
- Tabla `siigo_facturas`: `id`, `siigo_invoice_id`, `number`, `name` (`FV-2-22`), `cufe`,
  `public_url`, `estado`, `total_siigo`, `enviado_en`, `error_code`, `error_detalle`, `intentos`,
  `idempotency_key` — con restricción **`UNIQUE`**: la base de datos es el árbitro anti-duplicado.
  El worker reserva la clave (`INSERT ... ON CONFLICT DO NOTHING`) **antes** de llamar a Siigo, y
  el conflicto se resuelve **según el estado de la fila reservada**: `emitida` devuelve la factura
  ya emitida; `en_proceso` señala otra emisión en curso (la petición no emite en paralelo);
  `fallida` permite que un reintento legítimo tome la clave y vuelva a intentar — sin esta
  distinción, un timeout dejaría la clave reservada para siempre y ningún reintento volvería a
  emitir. Si el POST a Siigo tuvo éxito pero el UPDATE local falló, la reconciliación (consulta a
  Siigo por el identificador FLIT en `observations`) recupera esa factura DIAN real en vez de
  dejarla marcada como fallida. «Consultar y luego emitir» es una carrera que produce dos facturas
  DIAN reales; patrón base de [`docs/uso-siigo/siigo-uso.js`](../uso-siigo/siigo-uso.js), que aquí
  se corrige en el manejo de `en_proceso`/`fallida`.
  - **La toma de una clave `fallida` es atómica.** El reintento no lee el estado y luego emite:
    reclama la fila con un `UPDATE` condicional y **solo emite quien recibe fila**.
    `UPDATE siigo_facturas SET estado='en_proceso', intentos=intentos+1 WHERE idempotency_key=$1
    AND estado='fallida' RETURNING id`. `ON CONFLICT DO NOTHING` devuelve cero filas siempre, así
    que sin esta condición dos reintentos simultáneos sobre la misma fila `fallida` emiten **dos
    facturas DIAN** — justo la carrera que la restricción `UNIQUE` viene a evitar.
  - **`en_proceso` tiene arrendamiento, no es un estado terminal.** Una fila en `en_proceso` con
    más de N minutos (parámetro de operación, sugerido 15) se considera huérfana —worker caído
    entre la reserva y el `UPDATE`— y entra a la reconciliación descrita arriba, que la resuelve a
    `emitida` si Siigo tiene la factura o a `fallida` si no. Sin esta regla, `en_proceso` bloquea
    la clave indefinidamente: el mismo problema que se corrigió para `fallida`, mudado de estado.
- Tabla puente `siigo_factura_tramites`: `factura_id` → `tramite_id` + `liquidacion_id`.
  **Es una relación N:1 desde el inicio** aunque hoy siempre tenga una sola fila por factura; es
  lo que permite habilitar la consolidación después sin migrar la tabla principal (D-1, §7).
- **Outbox + worker** (patrón RNDC): la acción encola; el worker emite respetando el rate limit.
  Estados `pendiente | enviado | error | fallido_definitivo`.
- **Conciliación de totales**: si el `total` que devuelve Siigo difiere del total de la liquidación
  FLITO, la fila se marca para revisión en vez de darse por buena en silencio (Siigo calcula según
  el manejo de decimales configurado en la empresa, que puede no coincidir con el nuestro).
- Nuevo estado visible en el reporte y filtro por estado de facturación electrónica.

**Diseño para D-1:** el armado se organiza en dos pasos separados — *agrupar* (qué trámites van en
qué factura) y *armar* (construir el `InvoiceIn` de un grupo). Hoy solo existe el agrupador
`unoPorTramite`. Añadir `consolidadoPorCliente` después es una función nueva, no un rediseño.

---

## F5 — Seguimiento DIAN, entrega al solicitante y archivo

**Objetivo:** cerrar el ciclo: que la factura quede aceptada, entregada y archivada.

**Alcance**
- Reconciliador periódico del estado DIAN: `GET /v1/invoices/{id}` para leer el CUFE y
  `GET /v1/invoices/{id}/stamp/errors` para las rechazadas. (Evaluar antes el grupo **Webhooks** de
  Siigo, aún sin revisar: si notifica el estado, se evita el polling.)
- Envío por correo al solicitante: `POST /v1/invoices/{id}/mail` (hasta 5 direcciones) o `mail` en
  la creación. Pregunta 3 define el destinatario.
- Descarga y archivo de **PDF y XML** (`/pdf`, `/xml`) en S3 bajo `clients.flitoCarpetaStorage`,
  enlazados al trámite para que queden junto a los demás soportes.
- La respuesta de emisión se normaliza a `cufe`, `pdf_url`, `stamp_status` y `public_url` como en
  `emitirFactura()` de [`docs/uso-siigo/siigo-client.js`](../uso-siigo/siigo-client.js), de modo
  que el reconciliador y el archivo lean siempre los mismos campos.
- Panel de estado: emitidas, aceptadas por DIAN, rechazadas con su motivo, pendientes de envío.
- Reenvío manual de correo y reintento manual de las rechazadas, desde el reporte.

---

## F6 — Auditoría, errores y reversa

**Objetivo:** que el proceso sea operable cuando algo falle, y auditable siempre.

**Alcance**
- Bitácora por trámite de todo el ciclo (encolado, emitido, aceptado, rechazado, correo enviado),
  colgando de `flito_liquidacion_eventos` o de una bitácora propia.
- Bandeja de fallidos con el `Code` de Siigo traducido a lenguaje operativo y acción sugerida
  (`parameter_required` → falta un dato; `invalid_dian_resolution` → resolución vencida; etc.).
- Reintento masivo controlado y marcado manual de `fallido_definitivo`.
- **Reversa:** hoy `reversar` está prohibido después de `facturado`. Con factura electrónica emitida
  y aceptada por la DIAN, la corrección solo puede ser una **nota crédito** (`/v1/credit-notes`);
  la **anulación electrónica** (`DELETE /v1/invoices/{id}`, estado `anulada`) aplica en ventanas y
  estados DIAN distintos. Pregunta 8 define si entran en este alcance o en una feature posterior.
- Permisos: qué rol puede emitir (hoy `financiera`, `admin`, `auditor` leen el reporte; liquidar y
  facturar exigen escritura).

---

## 5. Secuencia sugerida

```
F1 (cimientos) ──┬── F2 (catálogos y mapeo) ──┐
                 └── F3 (clientes)  ───────────┴── F4 (emisión) ── F5 (DIAN + entrega) ── F6 (operación)
```

F2 y F3 son paralelizables una vez exista F1. F4 depende de ambas.

---

## 6. Preguntas abiertas

Las cuatro bloqueantes originales ya se resolvieron (§1.1): dos con decisión (D-3, D-4) y dos
diferidas con una estrategia de diseño que impide que bloqueen el desarrollo (D-1, D-2 → §7).

### Importantes (se pueden asumir, pero conviene confirmar)

5. **GMF (4x1000).** ¿Se factura como una línea más (un producto «GMF»), o se absorbe dentro del
   valor de otro concepto? Facturar un gravamen bancario como producto tiene lectura tributaria.
6. **Forma de pago.** No existe en FLITO. ¿Una forma de pago fija parametrizada (p. ej. «Crédito»
   con vencimiento a N días), o se captura por cliente? Si maneja vencimiento, Siigo exige
   `due_date` y **no admite más de una forma de pago** en la factura.
7. **Retenciones.** ¿Aplican ReteICA/ReteIVA/autorretención en las facturas de FLIT? Siigo lo
   soporta con `retentions[]`, pero hay que saber cuáles y cuándo.
8. **Notas crédito y anulación.** Si un trámite facturado hay que corregirlo o anularlo, ¿entran
   la nota crédito y la anulación electrónica en este alcance o se manejan manualmente en Siigo por
   ahora? Son operaciones distintas: la anulación aplica en ventanas y estados DIAN que la nota
   crédito no cubre.
9. **Empresa emisora.** ¿FLIT factura desde un único NIT / una sola empresa de Siigo Nube, o hay
   varias? El rate limit y las credenciales son **por empresa**.
10. **Ambiente de pruebas.** ¿Ya se solicitaron las credenciales de pruebas a Siigo? Hasta tenerlas
    el desarrollo va contra mock, y la certificación real quedaría fuera de la definición de hecho.
11. **Universo facturable.** ¿Solo trámites con liquidación **sellada** y documentación completa, o
    también estimados? (Recomendación: solo sellados; un estimado puede cambiar mañana y una factura
    electrónica aceptada por la DIAN no.)
12. **Numeración.** ¿Se deja que Siigo asigne el consecutivo (recomendado), o FLITO debe enviar
    `number`? Y ¿la resolución DIAN vigente ya está cargada en Siigo?
13. **Histórico.** ¿Se van a facturar electrónicamente trámites ya marcados como facturados en
    FLITO, o solo los nuevos desde la puesta en marcha?
14. **Sucursales (`branch_office`).** ¿Un cliente FLITO puede tener varias sucursales en Siigo? La
    clave real del tercero en Siigo es `identification + branch_office`.
15. **Moneda.** ¿Siempre COP? (Se asume que sí.)
16. **Rol autorizado.** ¿Quién puede disparar la emisión: `financiera`, `admin`, ambos?

---

## 7. Estrategia para las decisiones diferidas

D-1 y D-2 son decisiones de negocio que todavía no están tomadas. En vez de esperarlas o de
asumirlas en silencio, el diseño las aísla para que llegar a cualquiera de las respuestas posibles
sea configuración o una extensión acotada, nunca un rediseño.

### D-1 — Granularidad (una factura por trámite vs. consolidada)

| Riesgo si se asume mal | Cómo lo neutraliza el diseño |
|---|---|
| Modelar `siigo_facturas.tramite_id` como único obliga a migrar la tabla y su historial el día que se quiera consolidar | La relación factura↔trámite vive en la tabla puente `siigo_factura_tramites` desde el primer día, N:1. Consolidar solo agrega filas, no cambia el esquema |
| La idempotencia atada al trámite deja de servir cuando una factura cubre varios | La `Idempotency-Key` se deriva del **lote de facturación**, no del trámite. Con un trámite por factura el lote tiene un elemento; con varios, la misma key sigue siendo estable y única |
| El armado del payload se llena de condicionales | Se separan *agrupar* y *armar*. Cambiar la granularidad es cambiar de agrupador |

Se implementa **una factura por trámite** porque es la única que puede construirse sin más
definición de negocio, y porque una factura rechazada por la DIAN no arrastra a las demás.

### D-2 — Tratamiento tributario

| Riesgo si se asume mal | Cómo lo neutraliza el diseño |
|---|---|
| Emitir facturas con IVA incorrecto ante la DIAN — un error caro y difícil de deshacer (solo con nota crédito) | La clasificación tributaria y los impuestos de cada concepto son **datos configurables**, y la emisión en producción está bloqueada hasta que contabilidad marque cada concepto como confirmado |
| Descubrir tarde que el total de FLITO no coincide con el de Siigo | La conciliación de totales compara el `total` devuelto por Siigo contra la liquidación y marca la diferencia para revisión en lugar de aceptarla |
| Que «ingresos para terceros» resulte necesario y no esté contemplado | El flag `es_ingreso_terceros` existe en el mapeo desde el inicio; lo pendiente sería poblar el tercero beneficiario, acotado a SOAT/impuesto/derecho |

**Lo que sí hace falta decidir antes de producción, no antes de desarrollar:** si hay IVA sobre
honorarios. Si lo hay, FLITO necesita una columna de IVA en el reporte de costos y en la
liquidación — y eso sí es alcance adicional, porque hoy no existe en ninguna parte del modelo.
Queda señalado como **riesgo de alcance** de F2, no como bloqueo de F1/F3.

---

## 8. Deuda técnica y notas de gestión (registradas 2026-08-05)

- **DT-1 — Caché de token Siigo multi-instancia.** El caché de `siigo.token.ts` vive en memoria
  del proceso. Si PM2 llega a correr más de una instancia del API, cada una autentica por su lado:
  Siigo lo tolera, pero se pierde el mutex y se gastan logins extra. La referencia
  (`docs/uso-siigo/siigo-client.js`) ya admite caché inyectable. Acción cuando se escale a 2+
  instancias: mover el caché a Redis (`src/shared/redis.ts`) sin tocar el resto del cliente.
  **No urgente** mientras haya una sola instancia.
- **NG-1 — Cierre de la Feature 10 (ADO 11239).** Su alcance está implementado y probado al 100 %
  (credenciales AES-256-GCM, cliente HTTP, token, throttle, backoff, circuit breaker, errores
  tipados, mock, bitácora WORM, diagnóstico; suites `siigo-*` en `apps/api/__tests__/services/`).
  Sugerencia al Product Owner: evaluar su cierre. Cerrar un Feature es exclusivo del PO.
