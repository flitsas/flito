# ADR-0030 — SOAT sin trámite: la Renovación consulta el RUNT por placa + documento (sin tipo) y las incompletas pasan a ser multimodalidad

## Estado

**Propuesto** — 2026-10-26 por architecture-agent. Pendiente de aprobación del Líder Técnico. Feature [#14012](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/14012) «SOAT sin trámite: tipo Inicial / Renovación en la solicitud individual» (Épica #13760). Módulo `flito-soat`, **canal Cliente** (no el SOAT legacy `soat/`).

**Depende de** ADR-0031 (modelo de varios SOAT por vehículo). **Amplía** (no sustituye) [ADR-0010](./ADR-0010-flito-soat-runt-compuerta-alta.md) y [ADR-0019](./ADR-0019-flito-soat-solicitud-incompleta-runt-caido.md). Revierte, **solo para el tipo Renovación**, la decisión de la HU #12090 de que el canal no mande el documento del propietario al RUNT.

Diseño: [`docs/diseno-feature-14012-soat-tipo-inicial-renovacion.md`](../diseno-feature-14012-soat-tipo-inicial-renovacion.md).

## Contexto (medido en `develop` c93dbf36)

- Desde la HU #12090 el canal consulta **solo por VIN** (`consultarRuntCrudo(vin)` → `consultarVehiculoRunt(undefined, vin, '', '')`). Un VIN no sirve para la Renovación, donde el cliente conoce la placa y al propietario, no el VIN.
- La consulta por placa exige el documento del propietario (`runt.service.ts:133`). La pasarela Kyverum recibe `{ placa, documento }` sin `tipoDocumento` si no se le da (`runt.service.ts:107-111`); la vía directa barre 8 tipos con captcha (`runt-direct.service.ts:116`). **Si Kyverum resuelve el tipo no consta en el repo**: lo usan ya la certificación de impuestos y el refresco legacy (`certificacion.service.ts:230`, `soat/refresh.service.ts:73`), pero nada mide el caso NIT.
- `flito_soat_incompletas` (ADR-0019) asume VIN y factura obligatorios y un único motivo implícito (RUNT caído). F2/F3 de la Épica necesitan además «Falta factura de venta» y «Faltan datos del propietario».

## Alternativas

**Consulta de la Renovación**
1. **Placa + documento, sin tipo** (pedido del Feature). Pros: formulario corto; misma función que ya usa impuestos. Contras: depende de que Kyverum resuelva el tipo; en modo `direct` cuesta hasta 8 captchas. Esfuerzo S. Riesgo: NIT/CE rechazados si Kyverum asume CC.
2. Placa + documento + tipo pedido al usuario. Pros: determinista. Contras: reabre un AC cerrado. S.
3. Placa + documento; si hay negativa 200, reintento servidor con `NIT` y `CE` (≤3 llamadas). Pros: no toca el formulario. Contras: más llamadas al RUNT por intento fallido. S/M.

**Incompletas de la Renovación**
A. **Ampliar `flito_soat_incompletas`** (`tipo_soat`, `modalidad_consulta`, `placa`, `vin`/factura nullable, `motivo_pendiente` con los 3 valores de la Épica). Pros: una sola bandeja «Por validar», un solo reintento, la decisión de fondo de ADR-0019 intacta. Contras: más CHECKs combinados. M.
B. Tabla aparte para renovaciones. Contras: duplica bandeja, alcance, retención y reintento. L.

## Decisión

- **1**, condicionada a un **spike** con vehículos reales (propietario CC, **NIT**, sin SOAT anterior, documento equivocado) **antes** de construir la renovación (diseño §0.4). Si el NIT falla, se vuelve a decidir entre 2 y 3; no se construye a ciegas.
- **A.** La modalidad de consulta es explícita (no se deriva del tipo); el documento de consulta **es** el del propietario en `flito_compradores` (sin columna nueva de PII); «no tiene SOAT anterior» solo se afirma con `soat: []` — ausente o nulo es **indeterminado** y se trata como `caido` (defecto seguro de ADR-0010).
- El tipo vive en `flito_soat_solicitud.tipo_soat` (satélite exclusivo del canal), con `NOT NULL DEFAULT 'inicial'` como backfill.

## Consecuencias

- El canal vuelve a enviar a un tercero (RUNT/Kyverum) el documento del propietario, **solo** en Renovación: se declara en `logPiiAccess` y nunca entra a logs; se quita la placa del log de `runt-direct.service.ts:142`.
- Nueva clase de desenlace `sin_soat_anterior` en `DesenlaceRunt` y motivo de descarte `sin_soat_anterior`.
- F2/F3 reutilizan `modalidad_consulta`, `tipo_soat` y `motivo_pendiente` sin otra migración de vocabulario.
- RN-01 (`UNIQUE (vin)`) ya **no** impide renovar un SOAT emitido por FLITO: lo resuelve [ADR-0031](./ADR-0031-flito-soat-varios-soat-por-vehiculo-uno-abierto.md) (Propuesto, 2026-10-27), que va **antes** de este Feature y desplazó las migraciones de este ADR a 0268 y 0269.

## Relación con otros ADR

- ADR-0008: sin cambio (`origen` sigue siendo la marca del canal).
- ADR-0010: compuerta única y orden de clasificación conservados; se añade el paso 5-bis y la comparación por placa en el paso 3.
- ADR-0012: los tokens HMAC del acceso PII cubren la placa tecleada.
- ADR-0019: la incompleta sigue fuera de `flito_soat`; se generaliza su forma.
