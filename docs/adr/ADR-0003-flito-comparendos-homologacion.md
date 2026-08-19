# ADR-0003 — Homologación SIMIT Verifik ↔ municipal UTS (mapa versionable)

## Estado

**Aceptado** — Feature [#11492](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11492) (17a).  
Aprobado por Líder Técnico (2026-08-13): canónico + JSONB + `field_map` versionable; spike de payloads en HU corta.

## Contexto

El merge exige que SIMIT prevalezca y municipal aporte solo campos ausentes. Aún no hay payloads reales Verifik/UTS en el repo (solo normalización FCM en `simit.direct.ts`, transporte distinto). El Feature pide mapa de campos en diseño técnico previo y señala homologación incompleta como riesgo Medio.

## Decisión

1. Mantener **columnas canónicas** tipadas en `flito_comparendos_registros` más `payload_simit` / `payload_municipal` JSONB (auditoría y re-homologación).
2. Tabla `flito_comparendos_field_map` versionada: `(version, origen, source_path) → target_field`, con flag `provisional`.
3. **v1 provisional** se siembra en la migración `0150_flito_comparendos_ingesta.sql` usando candidatos alineados a `SimitComparendo` / `normalizeComparendos` y alias municipales comunes (detalle en el diseño del Feature).
4. **Spike** (HU BACKEND corta): capturar respuestas reales redactadas → fixtures de test → validar/ajustar mapa → insertar `version=2` con `provisional=false`. El código de merge lee la **máxima versión** activa.
5. Regla de aplicación: para cada `target_field`, tomar valor SIMIT si presente; si no, municipal; nunca pisar un canónico no vacío con municipal.
6. Normalización de `numero_comparendo` (trim / case) se cierra en el spike; hasta entonces: `trim` + conservar case del primer visto, comparar case-insensitive en lookup.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| Hardcode if/else en service sin tabla | No versionable; difícil auditar cambios de API |
| Solo JSONB sin canónico | Merge y filtros 17b inestables |
| Esperar payloads reales antes de cualquier schema | Bloquea CRUD/param/token/sync scaffolding innecesariamente |

## Consecuencias

- **Positivas:** 17a avanza con mocks; spike acota el riesgo de homologación sin reescribir el modelo.
- **Negativas:** Posible drift v1→v2; puede requerir job one-shot de re-merge desde JSONB tras subir versión (documentar en la HU de spike).
- **Referencia de campos (no de transporte):** `apps/api/src/modules/integraciones/simit.direct.ts` — solo como lista de alias conocidos.
- **Supersedes:** ninguno.
