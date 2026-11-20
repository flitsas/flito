# Ayuda FLITO — matriz de cobertura por área

Épica #12756 · Feature #13692 · HU #13769 (AC6). Fecha: 2026-10-21.

Qué ficha de Ayuda FLITO (`apps/web/src/content/ayuda/<clave>.md`) cubre a cada una de las cinco
áreas de la Épica. Una ficha puede servir a varias áreas; la columna «También» lista las que el
área usa pero «pertenecen» a otra. «Nueva (pendiente)» = la ficha aún no existe y la escribe una HU
de contenido de este Feature (#13770–#13775).

## Equivalencia área ↔ rol

| Área de la Épica | Rol (`USER_ROLES`) |
|---|---|
| Super Admin | `admin` |
| Corredor SOAT | `proveedor` |
| Corredor Impuestos | `gestor_impuestos` |
| Mensajero y Logística | `mensajero` |
| Facturación | `financiera` |

## Matriz

| Área | Fichas | También | Nuevas (pendientes) |
|---|---|---|---|
| Corredor SOAT | `soat`, `flito_tramites`, `flito_revisiones`, `flito_bitacora`, `flito_comparendos`, `clients`, `flito_tablero` | `dashboard` | — |
| Corredor Impuestos | `flito_impuestos`, `flito_derechos` | `flito_tramites`, `flito_revisiones`, `flito_tablero`, `dashboard` | — |
| Mensajero y Logística | `flito_logistica`, `flito_logistica_ruta`, `dashboard` | — | — |
| Facturación | `siigo_parametrizacion`, `siigo_operacion`, `flito_comprobantes`, `flito_conciliacion`, `flito_bolsas`, `flito_tarifas`, `flito_servicios_adicionales`, `finanzas_reporte_costos`, `finanzas_gastos_diarios` | `clients`, `dashboard` | — |
| Super Admin | `privacy_log_pii`, `users`, `roles_permisos`, `drive`, `privacy`, `siigo_credenciales`, `dashboard`, `transito_organismos` | — | — |

Las cinco áreas listan al menos una ficha publicada. `dashboard` (Tablero de control, HU #13775) lo tienen de partida todos los roles del sistema salvo `cliente`.

## Capturas

Las capturas de cada ficha se generan sobre datos demo (sin PII real) con:

```bash
npm run capturas:ayuda -w apps/web -- --grep <clave>
```

Escriben `apps/web/public/ayuda/<clave>/NN-<paso>.png` (1280 px, tema claro, ≤ 200 KB). Detalle en
`apps/web/e2e/tests/ayuda-capturas.capturas.spec.ts` y en la skill `flit-ayuda-flito`.

| Ficha | Capturas |
|---|---|
| `flito_logistica` | 6 (HU #13773) |
| `flito_logistica_ruta` | 5 (piloto, HU #13769; texto revisado y diagrama en la HU #13773) |
| `siigo_parametrizacion` | 5 (HU #13770) |
| `siigo_operacion` | 3 (HU #13770) |
| `flito_comprobantes` | 3 (HU #13770) |
| `flito_conciliacion` | 5 (HU #13770) |
| `flito_bolsas` | 3 (HU #13770) |
| `flito_tarifas` | 3 (HU #13770) |
| `flito_servicios_adicionales` | 4 (HU #13770) |
| `finanzas_reporte_costos` | 4 (HU #13770) |
| `finanzas_gastos_diarios` | 2 (HU #13770) |
| `soat` | 4 (HU #13771) |
| `flito_tramites` | 4 (HU #13771) |
| `flito_revisiones` | 3 (HU #13771) |
| `flito_bitacora` | 1 (HU #13771) |
| `flito_comparendos` | 4 (HU #13771) |
| `clients` | 3 (HU #13771) |
| `flito_tablero` | 2 (HU #13771) |
| `flito_impuestos` | 5 (HU #13772) |
| `flito_derechos` | 3 (HU #13772) |
| `privacy_log_pii` | 2 (HU #13774) |
| `users` | 3 (HU #13774) |
| `roles_permisos` | 4 (HU #13774) |
| `drive` | 3 (HU #13774) |
| `privacy` | 2 (HU #13774; solo el estado previo a anonimizar, AC4) |
| `siigo_credenciales` | 4 (HU #13774) |
| `dashboard` | 2 (HU #13775) |
| `transito_organismos` | 4 (HU #13775) |
