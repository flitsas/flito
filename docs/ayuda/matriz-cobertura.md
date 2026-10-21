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
| Corredor SOAT | `soat`, `flito_tramites`, `flito_revisiones`, `flito_bitacora`, `flito_comparendos`, `clients`, `flito_tablero` | — | — |
| Corredor Impuestos | `flito_impuestos`, `flito_derechos` | `flito_tramites`, `flito_revisiones`, `flito_tablero` | — |
| Mensajero y Logística | `flito_logistica`, `flito_logistica_ruta` | — | Tablero general |
| Facturación | `siigo_parametrizacion`, `siigo_operacion`, `flito_comprobantes`, `flito_conciliacion`, `flito_bolsas`, `flito_tarifas`, `flito_servicios_adicionales`, `finanzas_reporte_costos`, `finanzas_gastos_diarios` | `clients` | — |
| Super Admin | `roles_permisos`, `siigo_credenciales` | — | Usuarios, Privacidad y datos, Log de accesos PII, Google Drive, Organismos de tránsito, Tablero general |

Las cinco áreas listan al menos una ficha publicada.

## Capturas

Las capturas de cada ficha se generan sobre datos demo (sin PII real) con:

```bash
npm run capturas:ayuda -w apps/web -- --grep <clave>
```

Escriben `apps/web/public/ayuda/<clave>/NN-<paso>.png` (1280 px, tema claro, ≤ 200 KB). Detalle en
`apps/web/e2e/tests/ayuda-capturas.capturas.spec.ts` y en la skill `flit-ayuda-flito`.

| Ficha | Capturas |
|---|---|
| `flito_logistica_ruta` | 5 (piloto, HU #13769) |
