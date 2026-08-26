# ADR-0001 — Módulo `flito-comparendos`: sync bajo demanda y modelo de ingesta

## Estado

**Aceptado** — Feature [#11492](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11492) (17a).  
Aprobado por Líder Técnico (2026-08-13): Opción 1; hosts por env; sync **síncrono** en v1; retención PII/timeline 24 meses **parametrizable**.

## Contexto

Se necesita monitoreo operativo de comparendos multi-NIT y multi-municipio (SIMIT Verifik + UTS municipal), con unicidad por número de comparendo, merge SIMIT>municipal, inactivación automática y timeline. El repo ya tiene consultas SIMIT FCM/CEA en `integraciones/` y gates de traspaso/PESV que **no** deben absorber este dominio.

## Decisión

1. Crear módulo nuevo `apps/api/src/modules/flito-comparendos/` montado en `/api/flito/comparendos`.
2. Sync **solo** por `POST /sync` (sin cron en 17a), global o filtrado por NIT(s). Respuesta **síncrona** en v1.
3. Persistencia propia (`flito_comparendos_*`): catálogos (NITs, municipios, causales), registros canónicos + JSONB crudo, sync_runs/steps, eventos.
4. Clientes Verifik/UTS **dentro del módulo**; reutilizar únicamente helpers HTTP de `integraciones/http.js`. No invocar `consultarSimit` / `simit.direct` / CEA como fuente de este módulo.
5. Inactivación conservadora: solo cuando el NIT tuvo SIMIT ok y todos los municipios activos ok en ese run.
6. Campos de gestión (`causal_id`, `observacion`) en el mismo registro, escritos solo en Feature 17b.
7. **Paralelismo acotado (mitigación timeout):** las llamadas municipales de un NIT se ejecutan con concurrencia limitada (p. ej. 4–6) y timeout por llamada acotado (~8s). Motivo: `proxy_read_timeout` del nginx web ≈ 120s; matriz NIT × municipios secuencial supera ese techo con facilidad. SIMIT por NIT puede seguir en serie; el endpoint permanece síncrono (no 202/polling en 17a). Si la matriz crece (p. ej. decenas de NITs), un ADR sucesor puede pasar a cola asíncrona.

Diseño detallado: `docs/features/flito-comparendos-ingesta-parametrizacion.md`.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Extender `integraciones/` + tablas de traspaso | Acopla dominios; viola decisión de producto |
| Solo JSONB sin columnas canónicas | Encarece 17b (filtros/export) |
| Cron + cola desde el día 1 | Fuera de alcance 17a; sync manual basta |

## Consecuencias

- **Positivas:** Separación clara vs traspaso/PESV; contratos listos para 17b; fallos parciales observables.
- **Negativas:** Más tablas; sync síncrono sigue acotado por proxy (~120s) aunque se paralelicen municipales; con muchos NITs hará falta async.
- **Migración:** SQL plana `0150_flito_comparendos_ingesta.sql` (no `drizzle-kit generate`). El número **0149** quedó tomado por `0149_siigo_corte_historico_sembrado.sql` en la rama Siigo.
- **Supersedes:** ninguno (primer ADR del repo en `docs/adr/`).
- **Corrección (2026-08-13):** migración renumerada 0149→0150; decisión de paralelismo acotado añadida tras review de implementación.
- **Enmienda (2026-08-19):** el techo de extracción del módulo deja de ser únicamente el de la lectura paginada (50 filas × 60 peticiones/minuto, que vive en `COMPARENDOS_REGISTROS_LIMIT_MAX` y en el comentario de `registrosLimiter`, no en este ADR): el export a Excel de 17b (HU #11558) tiene su propia cota y su propia cuota. Ver ADR-0004, que **complementa** a este —no lo enmienda en sus siete decisiones ni lo supersede—.
