# Siigo API — base de conocimiento

Documento acumulativo sobre la API de Siigo Nube, construido a partir del API Blueprint
oficial. Se va ampliando a medida que se revisan nuevas secciones.

- **Doc oficial:** https://siigoapi.docs.apiary.io
- **Blueprint crudo (útil para leer sin JS):** https://siigoapi.docs.apiary.io/api-description-document
- **Base URL:** `https://api.siigo.com`
- **Soporte:** soporteapi@siigo.com

> La página de Apiary es una SPA: un fetch normal devuelve el HTML vacío. Para leer la
> documentación de forma programática hay que descargar el blueprint desde
> `/api-description-document`.

**Secciones revisadas:** Autenticación · Convenciones generales · Clientes · Facturas de Venta · Productos · Catálogos
**Última revisión:** 2026-08-13 — se reconfirmaron contra el blueprint los campos obligatorios de
`POST /v1/invoices`, el lote asíncrono, los filtros de clientes y `GET /v1/document-types?type=FV`.
**Pendientes:** Categorías de Inventario · Cotizaciones · Notas Crédito · Facturas de compra · Documento soporte · Recibos de Caja · Recibos de pago · Comprobantes Contables · Reportes · Webhooks

---

## 1. Convenciones generales

### Autenticación

Esquema OAuth con token JWT.

```
POST /auth
{ "username": "...", "access_key": "..." }
```

- Credenciales: Siigo Nube → menú izquierdo *Alianzas* → botón **Mi Credencial API**.
- Devuelve `access_token` **válido 24 horas**; hay que renovarlo.

### Headers

| Header | Obligatorio | Notas |
|---|---|---|
| `Authorization` | sí | el `access_token` |
| `Partner-Id` | sí, en **todas** las peticiones | nombre de la app integradora, 3–100 alfanuméricos, sin espacios ni caracteres especiales. Siigo monitorea este valor y bloquea a quien envíe datos falsos. El mismo valor para todas las empresas de una misma integración |
| `Idempotency-Key` | opcional | solo en POST de comprobantes. Alfanumérico ≤30 chars, sin espacios ni especiales |

### Idempotencia

Soportada en `POST` de: `/v1/invoices`, `/v1/credit-notes`, `/v1/journals`, `/v1/vouchers`.
Si repites el mismo `Idempotency-Key` y el documento ya existe, la API devuelve el
comprobante creado previamente en vez de duplicarlo. **No** enviar el header en GET/PUT/DELETE.

### Límites y tiempos

- **100 peticiones por minuto por empresa** de Siigo Nube (excederlo → 429).
- Respuesta promedio <2 s, pero Siigo recomienda **timeout de 120 s o más** en creación de
  comprobantes (facturas, notas crédito, recibos de caja, comprobantes contables): en picos
  de uso algunas transacciones tardan más.
- **Bloqueo temporal del usuario API** si durante 7 días más del 80 % de los requests son errores.

> **Cómo se protege FLITO de esos tres límites.** Son tres fenómenos distintos y hay tres mecanismos
> separados; ninguno sustituye a otro (HU #11249 y #11341):
>
> | Riesgo | Mecanismo | Dónde |
> |---|---|---|
> | Cuota de 100/min por empresa | limitador de ventana deslizante, el excedente espera | `siigo.resiliencia.ts` |
> | Un endpoint concreto caído | cortacircuitos por endpoint | `siigo.resiliencia.ts` |
> | Bloqueo del usuario API por proporción de errores | **freno por proporción acumulada** | `siigo.freno.service.ts` |
>
> El freno se calcula sobre `siigo_operaciones` (sin contador aparte) en una ventana de **24 h** con
> umbral del **60 %** —`SIIGO_FRENO_VENTANA_HORAS`, `SIIGO_FRENO_UMBRAL`,
> `SIIGO_FRENO_MIN_OPERACIONES`—. Los números son deliberadamente más estrictos que los de Siigo:
> medir 7 días al 80 % frenaría en el instante exacto del bloqueo, que ya es tarde. Los errores
> causados por datos nuestros (`parameter_required` y compañía) **no** cuentan, ni en el numerador ni
> en el denominador: no dicen nada sobre la salud del servicio. Estado y reactivación manual en
> `GET`/`POST /api/siigo/freno`.

### Códigos HTTP

`200` OK · `201` Created · `400` Bad Request · `401` sin `access_token` válido · `403` sin permisos ·
`404` no existe · `408` timeout · `409` conflicto de estado · `415` media type no soportado ·
`429` rate limit · `500` · `503` · `504`

### Formato de error

```json
{
  "Status": 400,
  "Errors": [
    {
      "Code": "parameter_required",
      "Message": "The field code is required",
      "Params": ["code"],
      "Detail": "Check the API documentation: [url]"
    }
  ]
}
```

Códigos frecuentes: `parameter_required`, `parameter_empty`, `parameter_inactive`,
`not_found`, `already_exists`, `duplicated_document`, `invalid_amount`, `invalid_date`,
`invalid_identification`, `invalid_total_payments`, `invalid_payment`, `invalid_retentions`,
`invalid_dian_resolution`, `invalid_idempotency-key`, `invalid_partner_id`, `requests_limit`,
`unauthorized`, `update_not_allowed`, `delete_not_allowed`, `blocked_transactions`,
`company_settings`, `customer_settings`, `document_settings`, `product_settings`,
`warehouse_settings`, `disabled_functionality`.

### Paginación (endpoints de listado)

```json
{
  "pagination": { "page": 1, "page_size": 25, "total_results": 253 },
  "results": [ ... ],
  "_links": { "previous": {...}, "self": {...}, "next": {...} }
}
```

Query params `page` y `page_size`.

### Formatos de fecha

- Fecha: `yyyy-MM-dd`
- Fecha y hora UTC: `yyyy-MM-ddTHH:mm:ssZ`

### Metadata

Casi todas las entidades devuelven `metadata: { created, last_updated }`.

---

## 2. Clientes (terceros)

Clientes, proveedores u otros terceros. Grupo `/v1/customers`.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/v1/customers` | Crear tercero |
| GET | `/v1/customers/{customer_id}` | Consultar por id (UUID) |
| GET | `/v1/customers` | Listar con filtros |
| PUT | `/v1/customers/{id}` | Actualizar |

### Campos

**Obligatorios:** `person_type` (`Person` \| `Company`), `id_type`, `identification`,
`name`, `fiscal_responsibilities[].code`, `address.address`,
`address.city.{country_code, state_code, city_code}`, `phones[]`, `contacts[]`
(`contacts[].first_name` obligatorio).

**Opcionales:** `type` (`Customer` \| `Supplier` \| `Other`, default `Customer`),
`check_digit` (0–9, se calcula automáticamente), `commercial_name`, `branch_office`
(entero 0–999, default 0), `active` (default `true`), `vat_responsible` (default `false`),
`address.postal_code` (≤10), `phones[].{indicative,number,extension}` (≤10 c/u, solo numérico),
`contacts[].{last_name, email, phone}`, `comments` (≤4000), `related_users.seller_id`,
`related_users.collector_id`, `additional_fields.CUCON` (Código Único de Contrato, sector salud, 64 chars).

Detalles que importan:

- `name` es un **array**: `["Stark Industries"]` si es Company, `["Marcos","Castillo"]` si es Person.
- `identification`: ≤50 chars, sin caracteres especiales. Solo se permite repetir un número
  ya existente en Nube **si es una sucursal nueva** (`branch_office` distinto).
- `seller_id` / `collector_id` deben existir; se consultan en `GET /v1/users`.
- **`PUT` reemplaza**, no hace merge: hay que reenviar todos los campos como en la creación.
  Un campo omitido/vacío queda vacío en Nube.

### Tipos de identificación (Colombia)

| ID | Tipo | Formato de `identification` |
|---|---|---|
| 13 | Cédula de ciudadanía | numérico, 3–13 |
| 31 | NIT | numérico, 3–13 |
| 11 | Registro civil | numérico, 3–13 |
| 12 | Tarjeta de identidad | alfanumérico, ≤20 |
| 21 | Tarjeta de extranjería | alfanumérico, 1–20 |
| 22 | Cédula de extranjería | alfanumérico, 1–20 |
| 41 | Pasaporte | alfanumérico, 1–20 |
| 42 | Documento de identificación extranjero | alfanumérico, 1–20 |
| 43 | Sin identificación del exterior / uso DIAN | alfanumérico, 1–20 |
| 47 | Permiso especial de permanencia (PEP) | alfanumérico, 1–20 |
| 48 | Permiso protección temporal (PPT) | alfanumérico, 1–20 |
| 50 | NIT de otro país | alfanumérico, 1–20 |
| 89 | Salvoconducto de permanencia | alfanumérico, 1–20 |
| 91 | NUIP | alfanumérico, 1–20 |
| R-00-PN | No obligado a registrarse en el RUT PN | alfanumérico, 1–13 |

### Responsabilidades fiscales

| Código | Responsabilidad |
|---|---|
| `R-99-PN` | No aplica – Otros (valor por defecto y el más común) |
| `O-13` | Gran contribuyente |
| `O-15` | Autorretenedor |
| `O-23` | Agente de retención IVA |
| `O-47` | Régimen simple de tributación |

### Códigos de ciudad

| Ciudad | country_code | state_code | city_code |
|---|---|---|---|
| Bogotá | CO | 11 | 11001 |
| Medellín | CO | 05 | 05001 |
| Nueva York | US | 01 | 0101 |

Lista completa: https://saprodcentralassets.blob.core.windows.net/siigoapi/documentation/Lista-de-ciudades.xlsx
También consultable en Siigo Nube: *Reportes → Cartera/Proveedores → Reportes de sistema → Países-Departamentos-Ciudades*.

### Filtros de `GET /v1/customers`

`identification`, `branch_office`, `created_start`, `created_end`, `updated_start`, `updated_end`.

### Respuesta

`CustomerOut` = los mismos campos + `id` (UUID), `id_type` como objeto `{code, name}`,
`fiscal_responsibilities[].name`, `address.city.{country_name, state_name, city_name}` y `metadata`.

---

## 3. Facturas de Venta

Grupo `/v1/invoices`.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/v1/invoices` | Crear factura |
| PUT | `/v1/invoices/{id}` | Editar |
| POST | `/v1/invoices/batch` | Crear lote **asíncrono** (body ≤1 MB, notifica por webhook) |
| GET | `/v1/invoices` | Listar con filtros |
| GET | `/v1/invoices/{invoice_id}` | Consultar una |
| DELETE | `/v1/invoices/{id}` | Borrar |
| POST | `/v1/invoices/{id}/annul` | Anular |
| POST | `/v1/invoices/{id}/mail` | Enviar por correo (hasta 5 destinatarios) |
| GET | `/v1/invoices/{id}/stamp/errors` | Errores de facturas rechazadas por la DIAN |
| GET | `/v1/invoices/{id}/pdf` | PDF |
| GET | `/v1/invoices/{id}/xml` | XML |
| GET | `/v1/document-types?type=FV` | Tipos de comprobante de venta |

### Campos obligatorios de creación

```
document.id             number  → tipo de comprobante, debe existir (GET /v1/document-types)
date                    date    → yyyy-MM-dd. En electrónicas NO admite fecha anterior a hoy
customer.identification string  → el cliente debe existir y estar activo
seller                  number  → id de vendedor (GET /v1/users)
items[].code            string  → producto existente y activo
items[].quantity        number  → máx. 2 decimales
items[].price           number  → máx. 6 decimales
payments[].id           number  → medio de pago (GET /v1/payment-types)
payments[].value        number  → máx. 2 decimales
```

> **Qué envía FLITO, y qué no** (decisiones del 2026-08-13). Se manda **solo lo obligatorio**:
> `document`, `date`, `customer.identification`, `seller`, `items[]` (`code`, `quantity`, `price`) y
> `payments[]` (`id`, `value`), más `cost_center` cuando el comprobante lo exige. Se omiten a
> propósito, y cada omisión tiene una respuesta detrás:
>
> | Campo | Por qué no se envía |
> |---|---|
> | `items[].taxes` | Los impuestos los aplica Siigo desde el producto (A7) |
> | `retentions[]` | Las retenciones se configuran en el **tercero**, no por documento |
> | `currency` | Es «moneda **extranjera**»: en COP lo correcto es omitirlo, no mandar `{code:'COP'}` |
> | `number` | El consecutivo lo asigna Siigo; ni siquiera existe en `InvoiceIn` |
> | `payments[].due_date` | No se maneja plazo. Las formas de pago con vencimiento se filtran al elegir |

### Campos opcionales relevantes

- `number` — consecutivo; si se envía, no debe existir en Nube.
- `stamp.send: true` — envía a la DIAN (default `false`).
- `mail` — envía copia al cliente (default `false`).
- `observations` (≤4000), `retentions[]` (ids de ReteICA/ReteIVA/Autorretención, vía `GET /v1/taxes`).
- `advance_payment` — anticipo/copago, positivo, ≤ total de la factura.
- `cost_center`, `currency.code`, `currency.exchange_rate`.
- `customer.branch_office` (default 0).
- `items[].description`, `items[].discount` (valor o porcentaje según configuración),
  `items[].taxes[].id`, `items[].taxed_price`, `items[].warehouse`, `items[].seller`.
- `global_discounts[].{id, percentage, value}` — porcentaje entre 0.01 y 99.99.
- `additional_fields` — orden de compra y orden de entrega (prefijo y número ≤20 chars c/u).

### Trampas conocidas

- **`payments[]`**: no se admite más de una forma de pago si alguna maneja vencimiento
  (`due_date: true`); en ese caso `payments[].due_date` (`yyyy-MM-dd`) es obligatorio.
- **`items[].taxed_price`** es el precio con IVA incluido y **reemplaza** a `items[].price`.
  Ej.: `taxed_price: 10000` con IVA 19 % → base 8.403,36 + IVA 1.596,64.
- **No se permiten dos impuestos del mismo tipo** en un mismo ítem.
- Muchos campos dependen de la **configuración del comprobante o de la empresa** en Siigo Nube
  (moneda extranjera, vendedor por ítem, descuento por valor vs. porcentaje, anticipo,
  descripción larga del producto). Si no está marcado allí, el campo se rechaza.
- Existen bloques adicionales por sector: ingresos para terceros (`items.customer`),
  transporte (`transport`), salud (`healthcare_company`) y productos de obsequio.

### Crear cliente desde la factura

Se puede crear el tercero en la misma petición enviando el objeto `customer` completo.
Obligatorios: `person_type`, `id_type`, `identification`, `name[]`, `address.address`,
`address.city.{country_code, state_code, city_code}`, `contacts[].first_name`.

### Restricciones de edición / borrado / anulación

No se puede **editar, borrar ni anular** una factura que:

1. esté en proceso de envío a la DIAN o ya aceptada (tenga CUFE), o
2. tenga documentos relacionados en Siigo Nube (notas crédito, notas débito, recibos de caja,
   ajustes de cartera) — hay que eliminar primero los relacionados.

En `PUT` son **inmutables**: `document.id`, `customer.identification`, `currency.code`, y
`number` si la numeración está configurada como manual.

### Lote asíncrono

`POST /v1/invoices/batch` con `notification_url` (obligatoria, `https://`, <2048 chars) y
`invoices[]`. Cada factura del array requiere además su propio `idempotency_key`
(alfanumérico ≤30 chars). Al terminar el procesamiento, Siigo hace POST a la
`notification_url` con `{ id, status, status_at, notification_url, invoices: [...] }`,
donde cada factura trae su `status_code`, su `idempotency_key` y el detalle creado o el error.

### Filtros de `GET /v1/invoices`

`created_start`, `created_end`, `updated_start`, `updated_end`, `date_start`, `date_end`,
`name` (ej. `FV-003-457`), `customer_identification`, `customer_branch_office`, `document_id`.

> **No hay filtro por `observations`.** Importa porque FLITO escribe ahí el identificador FLIT para
> poder reconocer sus facturas, y es lo que la reconciliación de la HU #11326 necesita encontrar.
> Al no poder filtrarlo en origen, esa búsqueda filtra por `customer_identification` más el rango de
> fechas y **reconoce leyendo** las observaciones de cada resultado, paginando. De ahí que agotar el
> tope de páginas sin encontrarla no signifique que no exista.

### Respuesta

`id` (UUID), `document`, `number`, `name` (`FV-2-22`), `date`, `customer`, `cost_center`,
`currency`, `total` (calculado según el manejo de decimales configurado en la empresa),
`balance` (saldo pendiente), `seller`, `stamp`, `mail`, `observations`, `items[]`,
`payments[]`, `global_discounts[]`, `additional_fields`, `public_url` (vista pública del
documento) y `metadata`.

---

## 4. Productos

Bienes y/o servicios que la empresa adquiere para uso propio o para comercializar.
Grupo `/v1/products`.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/v1/products` | Crear producto/servicio |
| GET | `/v1/products/{product_id}` | Consultar por id (UUID) |
| GET | `/v1/products` | Listar con filtros |
| PUT | `/v1/products/{id}` | Actualizar |
| DELETE | `/v1/products/{id}` | Borrar → `{ "id": "...", "deleted": true }` |

### Campos

**Obligatorios:** `code`, `name`, `account_group`.

| Campo | Reglas |
|---|---|
| `code` | único, alfanumérico, **NO permite espacios**, ≤30 chars |
| `name` | ≤100 chars, permite espacios y especiales |
| `account_group` | id de la clasificación de inventario (`GET /v1/account-groups`); debe existir y estar activo |

**Opcionales:**

| Campo | Default | Reglas |
|---|---|---|
| `type` | `Product` | ver nota sobre valores más abajo |
| `stock_control` | `false` | control de inventario |
| `active` | `true` | |
| `tax_classification` | `Taxed` | `Taxed` \| `Exempt` \| `Excluded` |
| `tax_included` | `false` | IVA incluido en el precio |
| `tax_consumption_value` | — | impuesto al consumo, positivo, ≤2 decimales |
| `taxes[].id` | — | el impuesto debe existir en Nube |
| `taxes[].milliliters` | — | **obligatorio** si maneja impuesto de bebidas azucaradas |
| `taxes[].rate` | — | **obligatorio** en bebidas azucaradas; solo 18, 35, 28, 55, 38 o 65 |
| `prices[].currency_code` | — | debe existir en Nube |
| `prices[].price_list.position` | — | entero **1 a 12** (Siigo maneja hasta 12 listas de precio) |
| `prices[].price_list.value` | — | positivo, ≤2 decimales |
| `unit` | `94` | código de unidad de medida para factura electrónica |
| `unit_label` | — | texto que sale impreso en el PDF de la factura |
| `reference` | — | referencia/código de fábrica, alfanumérico ≤80 |
| `description` | — | ≤2500 chars |
| `barcode` | — | alfanumérico ≤50, permite espacios |
| `brand` | — | alfanumérico ≤50 |
| `tariff` | — | código arancelario, numérico ≤10 |
| `model` | — | alfanumérico ≤50 |
| `components[].code` / `.quantity` | — | solo para `type: Combo` |

En el modelo de datos, `barcode`, `brand`, `tariff` y `model` viajan agrupados dentro de
`additional_fields`.

Unidades de medida: https://saprodcentralassets.blob.core.windows.net/siigoapi/documentation/unidades%20de%20medida.xlsx
(también en Nube: `#/reports/2000/5515?TabID=1753&pTabID=1446`).

### Combos

`type: "Combo"` solo está disponible para usuarios con **Siigo Nube Premium**. Ejemplo:

```json
{
  "type": "Combo",
  "code": "1234",
  "name": "Combo de prueba",
  "account_group": 121,
  "components": [
    { "code": "product-1", "quantity": 100 },
    { "code": "product-2", "quantity": 20 }
  ]
}
```

Los `components` deben existir y estar activos. En GET y en el listado, los combos devuelven
el array `components` con `id`, `code` y `name` de cada componente.

### Trampas conocidas

- **`code` no admite espacios** y es la clave que usan las facturas (`items[].code`).
- **`account_group` es inmutable** una vez que el producto tiene movimiento en algún documento.
- **No se pueden modificar los `components` de un Combo** si el combo ya tuvo movimientos.
- **Los valores de `type` son inconsistentes en la propia doc de Siigo:** creación documenta
  `Product | Service | Combo`; actualización documenta `Product | Service | ConsumerGood`;
  y la respuesta de consulta describe `Product | service | ConsumerGood`. Hay que validarlo
  contra el ambiente de pruebas antes de fijar un enum en nuestro código.
- `PUT` exige `code`, `name` y `account_group` igual que la creación — mismo patrón de
  reemplazo que en Clientes.

### Filtros de `GET /v1/products`

`code`, `created_start`, `created_end`, `updated_start`, `updated_end`, `id`.

- Los resultados vienen **ordenados por fecha de creación, más recientes primero**.
- `updated_start` / `updated_end` reaccionan tanto a cambios de propiedades **como a cambios
  en los saldos de inventario** — útil para sincronizar stock de forma incremental.
- Se pueden pedir **hasta 20 ids a la vez** separados por coma:
  `GET /v1/products?ids={GUID},{GUID}`.

### Respuesta

`ProductOut` = los campos anteriores + `id` (UUID), `account_group` como objeto `{id, name}`,
`taxes[].{id, name, type, percentage}`, `prices[].price_list.{position, name, value}`,
`unit` como objeto `{code, name}`, y además:

- `available_quantity` — cantidad disponible; si el producto está en varias bodegas,
  devuelve el total de todas.
- `warehouses[]` — `{id, name, quantity}` por bodega.
- `metadata` — `{created, last_updated}`.

---

## 5. Catálogos

Grupo `Catálogos` del blueprint. Son listas de parametrización de la empresa en Siigo Nube:
cambian poco y se consultan mucho, así que se **cachean** en FLITO (tabla `siigo_catalogos`,
HU #11281). Todos responden un **arreglo simple**, no la forma paginada `{ pagination, results }`.

| Método | Ruta | Qué devuelve |
|---|---|---|
| GET | `/v1/document-types?type=FV` | Tipos de comprobante (`type`: `FV`, `FC`, `NC`, `RC`…) |
| GET | `/v1/users` | Usuarios; se usan como **vendedor** en la factura |
| GET | `/v1/payment-types?document_type=FV` | Formas de pago del comprobante |
| GET | `/v1/taxes` | Impuestos y retenciones |
| GET | `/v1/account-groups` | Grupos / clasificaciones de inventario |
| GET | `/v1/cost-centers` | Centros de costo |
| GET | `/v1/warehouses` | Bodegas |
| GET | `/v1/price-lists` | Listas de precio (posición 1–12) |
| GET | `/v1/fixed-assets` | Activos fijos |
| GET | `/v1/expense` | Descuentos de recibos de caja |

### Estructuras

```
Document        id, code, name, description, type, active, seller_by_item, cost_center,
                cost_center_mandatory, automatic_number, consecutive, discount_type, decimals,
                advance_payment, reteiva, reteica, self_withholding, self_withholding_limit,
                electronic_type
User            id, username, first_name, last_name, email, active, identification
PaymentTypes    id, name, type, active, due_date
Tax             id, name, type, percentage, active
AccountGroup    id, name, active
CostCenter      id, code, name, active
Warehouse       id, name, active, has_movements
PriceList       id, name, active, position
```

### Notas

- **`/v1/cost-centers` existe y está documentado** en el blueprint (`## Centros de Costo`),
  aunque no aparecía en versiones anteriores de este documento. Devuelve `CostCenter`.
  Que un comprobante **maneje** o **exija** centro de costo se lee de `Document.cost_center` y
  `Document.cost_center_mandatory`; la configuración de la empresa puede además fijar un
  `cost_center_default`.
- **`PaymentTypes.due_date`** indica si la forma de pago maneja vencimiento. Si alguna lo maneja,
  la factura **no admite más de una forma de pago** y `payments[].due_date` pasa a ser obligatorio.
- **Datos personales:** `/v1/users` devuelve `identification` y `email`. FLITO **no los persiste**
  (Ley 1581): de ese catálogo solo se guarda el nombre, que es lo único necesario para elegir
  vendedor.
- Los ids **no son constantes entre empresas**: un `13156` es IVA 19 % en una empresa y otra cosa
  en otra. Por eso la copia local es única por (tipo, código) y nunca se comparte entre ambientes
  sin resincronizar.

---

## Notas para la integración en FLITO

Puntos donde se concentra el riesgo, a resolver en el cliente HTTP:

1. **Token de 24 h** — cachear y renovar de forma proactiva, con reintento ante 401.
2. **`Partner-Id` constante** — un único valor para toda la integración; falsearlo causa bloqueo.
3. **`Idempotency-Key` por factura** — derivarlo de un id estable nuestro, no aleatorio,
   para que un reintento no genere duplicados.
4. **Rate limit de 100 rpm por empresa** — cola/throttle propio, más backoff ante 429.
5. **Timeout ≥120 s** en creación de comprobantes.
6. **Dependencia de la configuración de Siigo Nube** — los catálogos (`/document-types`,
   `/users`, `/taxes`, `/payment-types`, `/account-groups`, `/cost-centers`) deben resolverse y
   cachearse; los ids no son constantes entre empresas. Resuelto en la HU #11281
   (`apps/api/src/modules/siigo/siigo.catalogos.service.ts` + tabla `siigo_catalogos`).
7. **Sincronización incremental** — `updated_start`/`updated_end` de `/v1/products` refleja
   también los movimientos de inventario, así que sirve como fuente para actualizar stock
   sin recorrer el catálogo completo.
