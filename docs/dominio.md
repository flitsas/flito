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
| **Registro consolidado** | comparendo, fila del panel | Una deuda vista por una o dos fuentes y fundida en una fila (SIMIT manda, el municipio rellena huecos). Sus campos de fuente son de **solo lectura**: los escribe el sync y no hay endpoint que los edite. |
| **Sync de comparendos** | actualización, barrido | Disparo manual (endpoint/botón); sin cron en 17a. Global o por NIT(s). |
| **Estado (monitoreo)** | activo / inactivo | Lo mantiene el sync: `inactivo` = las fuentes dejaron de reportarlo **con cobertura completa**. No significa «pagado». Lo que dice la autoridad viaja aparte, en `estadoFuente` (texto del proveedor). |
| **Timeline** | historial, trazabilidad del comparendo | Llegada, desaparición y reaparición de un registro. Responde «¿desde cuándo arrastramos esto?», que el estado actual no puede contar. |
| **Causal operativa** | estado de gestión, seguimiento | Catálogo CRUD; se asigna al comparendo en gestión (Feature 17b). Distinta del `estado` activo/inactivo del sync. |

### Qué NO es «monitoreo de comparendos»

Tres cosas distintas usan la palabra *comparendo* o *monitoreo* y no se tocan entre sí:

| No confundir con | Qué es | En qué se diferencia |
|---|---|---|
| **Gate SIMIT del traspaso** | Verificación puntual de que un vehículo/persona puede traspasarse hoy | Consulta que **caduca** y bloquea un trámite concreto. El monitoreo lleva histórico y no bloquea nada. |
| **Pre-vuelo de trámites** | Comprobaciones previas a radicar | Mira una placa/trámite en curso, no una cartera por NIT. |
| **Incidente PESV `comparendo`** | Evento de seguridad vial de un conductor propio | Es del programa PESV (flota y conductores de FLIT), con sus propios enums; el monitoreo mira deuda de **terceros** por NIT y no alimenta indicadores PESV. |

### Retención de datos (24 meses)

No es una política declarada: es un borrado que ocurre. El cron `flito-comparendos-purga` elimina registros
consolidados y corridas de sync más viejos que `COMPARENDOS_RETENTION_MONTHS` (24 por defecto), y su timeline
se va por `ON DELETE CASCADE`. Detalles que importan al leer la cifra:

- **El reloj es `ultimo_visto_en`**, no la fecha del comparendo: una deuda que las fuentes siguen reportando no se borra por vieja que sea la infracción.
- **Está APAGADO por defecto**: solo corre con `COMPARENDOS_PURGA_CRON_ENABLED=1`, y admite una pasada en seco que cuenta candidatos sin borrar.
- **Se frena solo** si los candidatos superan un porcentaje de la tabla (`COMPARENDOS_PURGA_MAX_RATIO`) o si nadie ha sincronizado en `COMPARENDOS_PURGA_SYNC_MAX_DIAS`: con el sync parado, `ultimo_visto_en` deja de avanzar en toda la tabla y la purga acabaría borrando datos vigentes en silencio.
- Los payloads crudos de los proveedores se guardan **podados** a la lista blanca del mapa de homologación, y **no** salen por el API.

Cada lectura que devuelve NIT o placa queda anotada en `pii_access_log` (Ley 1581 art. 17), con los filtros enmascarados,
y sale con `Cache-Control: no-store`.

**Buscar por NIT o por placa es `POST /registros/buscar`, con esos dos valores en el cuerpo** (AGENTS.md §14). No es una
mutación: responde 200 y no crea nada. El `GET /registros` sigue existiendo para la vista por defecto y solo admite lo que
no identifica a nadie —estado, número de comparendo, paginación—; un `?nit=` en la query es un **400**, no un filtro que se
ignora. El motivo es que una URL con un NIT dentro se queda escrita en el access log del proxy, en el historial del
navegador y en el `Referer` de la petición siguiente, tres registros que no están bajo la retención de 24 meses ni bajo el
`pii_access_log`. Los identificadores opacos sí van en el path: `GET /registros/:id` es un UUID y no dice nada de nadie.

Diseño 17a: [`docs/features/flito-comparendos-ingesta-parametrizacion.md`](features/flito-comparendos-ingesta-parametrizacion.md).

## Cómo usarlo

1. En intake o al redactar Features: mapear el lenguaje del humano a la columna **Término canónico**.
2. Si un sinónimo nuevo aparece ≥2 veces, añadirlo a “También dicen…”.
3. Decisiones de negocio (no solo nombres) van a ADR o a la tabla “Decisiones tomadas” del Feature — no al glosario.
