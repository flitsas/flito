# Glosario de dominio — FLITO

Vocabulario canónico del producto. Cualquier requerimiento (prosa, bullets, chat) se **traduce** a estos términos antes de Features/HUs. Ampliar cuando aparezca un término ambiguo recurrente; no duplicar docs de integración.

Para Siigo (detalle técnico): [`docs/integraciones/siigo-api.md`](integraciones/siigo-api.md) y [`docs/features/siigo-facturacion-electronica.md`](features/siigo-facturacion-electronica.md).

## Actores y entidades

| Término canónico | También dicen… | Qué es en FLITO |
|---|---|---|
| **Compañía** / **cliente FLITO** | cliente, empresa, tercero, gestora | Fila de `clients`. Quien gestiona trámites en la plataforma. |
| **Solicitante** | dueño, conductor (según flujo) | Persona/rol que pide el trámite; el correo de factura electrónica usa `clients.email` (compañía). |
| **Trámite** | gestión, caso, placa+proceso | Unidad de trabajo operativa que acumula costos y puede liquidarse/facturarse. |
| **Concepto de costo** | rubro, ítem, servicio, “producto” (coloquial) | SOAT, impuestos, derecho de tránsito, trámite digital, logística, GMF, etc. |
| **Liquidación** | total a cobrar, cálculo | Valores por concepto congelables; base del reporte de costos. |
| **Facturar** (FLITO) | sellar, cerrar liquidación | Acción que marca la liquidación como `facturado` y la congela. **No** es emitir ante la DIAN. |
| **Emisión electrónica** | factura DIAN, factura Siigo, FE | Paso **posterior** a Facturar: envío a Siigo → DIAN + PDF/correo. |
| **Autogestión** | “ellos lo pagan”, “no lo gestiona Flito” | Parametrización por compañía: qué conceptos gestiona FLITO vs la compañía. Afecta “listo para liquidar”. |

## Siigo ↔ FLITO (traducción fija)

| Siigo | FLITO |
|---|---|
| Producto | Concepto de costo (mapeado a un producto Siigo) |
| Cliente (tercero) | Compañía (`clients`) |
| Factura de venta | Factura electrónica de un trámite ya facturado en FLITO |
| Ítem de factura | Línea por concepto con valor aplicable (≠ “no aplica”) |
| Ambiente `sandbox` / `producción` | `AMBIENTE` de la integración (mock/real es ortogonal: `MODE`) |

## Ambientes y modos de integración

| Término | Significado |
|---|---|
| **MODE** `mock` \| `real` | ¿Se llama al proveedor o a un stub local? |
| **AMBIENTE** `sandbox` \| `produccion` | A qué ambiente del proveedor apuntan las credenciales/config |
| **Configuración de emisión** | Document type, seller, payments, etc. vigentes por ambiente (HU config-emisión) |
| **Mapeo de conceptos** | Concepto FLITO → producto Siigo (por ambiente) |
| **Catálogos Siigo** | Copia/caché de tipos de documento, formas de pago, impuestos, etc. |

## Módulos de producto (no mezclar)

| Prefijo / ruta | Nota |
|---|---|
| `flito-*` bajo `/api/flito/...` | Módulos del producto FLITO actual |
| Módulos legacy (`soat`, `tramites`, `liquidacion`, …) | Coexisten; no unificar sin instrucción explícita |
| Reporte de costos | UI de finanzas donde se dispara selección/envío a emisión |

## Monitoreo de comparendos (FLITO)

| Término canónico | También dicen… | Qué es en FLITO |
|---|---|---|
| **Monitoreo de comparendos** | “SIMIT operativo”, multas multi-empresa, panel de comparendos | Módulo `flito-comparendos` (`/api/flito/comparendos`): ingesta SIMIT Verifik + municipales UTS, catálogos y sync bajo demanda. **No** es el gate SIMIT de traspaso, ni el pre-vuelo, ni el incidente PESV `comparendo`. |
| **NIT monitoreado** | empresa, cliente a consultar | NIT parametrizado que alimenta SIMIT (`documentNumber`) y UTS (`nit`). Puede coincidir con una compañía `clients`, pero el catálogo es propio del módulo. |
| **Municipio fuente** | secretaría, ciudad UTS | Código enviado como `fuente` a ConsultarInfraccion; lista parametrizable (seed: BELLO, ITAGUI, …). |
| **Número de comparendo** | comparendo, multa, consecutivo | Clave de unicidad del registro consolidado. La **placa** es dato/filtro, no unicidad. |
| **Sync de comparendos** | actualización, barrido | Disparo manual (endpoint/botón); sin cron en 17a. Global o por NIT(s). |
| **Causal operativa** | estado de gestión, seguimiento | Catálogo CRUD; se asigna al comparendo en gestión (Feature 17b). Distinta del `estado` activo/inactivo del sync. |

Diseño 17a: [`docs/features/flito-comparendos-ingesta-parametrizacion.md`](features/flito-comparendos-ingesta-parametrizacion.md).

## Cómo usarlo

1. En intake o al redactar Features: mapear el lenguaje del humano a la columna **Término canónico**.
2. Si un sinónimo nuevo aparece ≥2 veces, añadirlo a “También dicen…”.
3. Decisiones de negocio (no solo nombres) van a ADR o a la tabla “Decisiones tomadas” del Feature — no al glosario.
