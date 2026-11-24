# Integraciones de salida de FLITO

Qué consume `apps/api` de otros sistemas, leído del código el 06/11/2026. Es un inventario, **no** el contrato de esos
terceros: cada proveedor es dueño del suyo y aquí no se redacta ninguno. Las operaciones de entrada están en
`contracts/openapi/flito-api.v1.yaml`, y lo que se lee de FLIT 2, en `contracts/openapi/flit2-integracion.v1.yaml`.

Los hosts de cada ambiente van por variables de entorno; los valores reales no se escriben aquí (el repo es público).

## Con contrato o documentación en este repo

| Sistema | Qué consume FLITO | Dónde en el código | Configuración | Referencia del contrato |
|---|---|---|---|---|
| **FLIT 2** | `POST /api/v1/external/auth/token`, `GET /api/v1/external/tramites/sync` | `modules/flito-sync/flit2-pase.service.ts`, `flit2-sync-http.adapter.ts` | `FLIT2_BASE_URL` | `contracts/openapi/flit2-integracion.v1.yaml` (vista del consumidor) y `external-api.v1.json` del repo `flit` (el del proveedor) |
| **FLIT 2, adjuntos** | `GET /api/v1/external/tramites/{id}/adjuntos/{adjuntoId}/url`, `POST /api/v1/external/tramites/{id}/adjuntos` (multipart) | `modules/flito-sync/flit2-sync-http.adapter.ts`, `flit2-adjuntos.ts` | `FLIT2_BASE_URL`, `FLIT2_ADJUNTOS_HOSTS` | `external-api.v1.json` del repo `flit`; no entran en la vista del consumidor porque esta cubre token y feed |
| **Siigo Nube** | `/auth`; `/v1/invoices` (crear, consultar, documento, `stamp/errors`, `mail`); `/v1/customers`; `/v1/products`; catálogos `/v1/users`, `/v1/taxes`, `/v1/payment-types`, `/v1/document-types`, `/v1/cost-centers`, `/v1/account-groups` | `modules/siigo/siigo.client.ts`, `siigo.token.ts` y los servicios del módulo | `SIIGO_BASE_URL`, `SIIGO_AMBIENTE` | [siigo-api.md](siigo-api.md), resumen del blueprint oficial del proveedor |

## Sin contrato en este repo

Para estos, el código es lo único que hay aquí. **[por verificar]** contra la documentación de cada proveedor antes de
tratar cualquier detalle de este cuadro como un acuerdo.

| Sistema | Para qué | Dónde en el código | Configuración |
|---|---|---|---|
| FLIT 1 (reporte de trámites y archivos) | Lectura automática de trámites y adjuntos | `modules/flito-sync/flit-http.adapter.ts`, `flit1-adjuntos.http.ts` | `FLIT_BASE_URL`, `FLIT1_TRAMITES_BASE_URL`, `FLIT1_ARCHIVOS_BASE_URL` |
| RUNT (portal público y pasarela) | Consulta de vehículos y personas | `modules/runt/runt-direct.service.ts`, `runt.service.ts` | Por módulo |
| SIMIT, Fasecolda, Mercado Libre, impuesto vehicular | Consultas de trámite, directas o por proxy | `modules/integraciones/*` | `INTEGRACIONES_MODE`, `VERIFIK_SIMIT_BASE_URL` |
| UTS municipal | Comparendos | `modules/flito-comparendos/clients/uts-municipal.client.ts` | `UTS_MUNICIPAL_BASE_URL` |
| RNDC | Manifiestos y remesas | `modules/rndc/*` | `RNDC_MODE`, credenciales cifradas en base de datos |
| Anthropic | OCR e IA (Dr. Flit, documentos) | `modules/tramites/anthropic.ts`, `modules/flito-dr-flit/dr-flit-ia.client.ts`, `modules/ai/*` | Variables de cada módulo |
| Azure DevOps | Casos de soporte desde Dr. Flit | `modules/flito-dr-flit/dr-flit-ado.client.ts` | `DRFLIT_ADO_ORG_URL` |
| Listas restrictivas (OFAC, ONU, UE) | Descarga para LAFT | `modules/laft/sync/*`, `modules/laft/lists/*` | URL públicas en el código |
| Google Drive | Procesador de cuentas | `services/googleDrive.ts`, `modules/drive/*` | Variables de Google |
| Almacenamiento S3 y correo SMTP | Archivos y notificaciones | `services/storage.ts`, `services/email.ts` | `S3_ENDPOINT`, `SMTP_HOST` |

## Lo que llega de vuelta

Dos entradas responden a estos sistemas y están en el contrato de FLITO, con el cuerpo `[por verificar]` porque se leen
crudas para validar el HMAC: `POST /api/flito/sync/flit2/avisos` (avisos firmados de FLIT 2) y
`POST /api/webhooks/firma/{proveedor}` (firma digital).
