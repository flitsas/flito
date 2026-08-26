---
name: flit-ayuda-flito
description: >
  Actualiza o declara N/A la ficha de ayuda in-app de un módulo FLITO documentado cuando el diff
  cambia el comportamiento visible de esa pantalla. Gate pre-PR: sin delta de ayuda no se abre el PR.
  Triggers — ficha, ayuda FLITO, docs/usuario, cambio visible de pantalla documentada, pre-PR,
  flit-ayuda-flito, _plantilla.md.
---

# flit-ayuda-flito — fichas de ayuda in-app

Fuente de las fichas: `apps/web/src/content/ayuda/{slug}.md`. Catálogo: `catalogo.ts` (18 claves).
Plantilla: `_plantilla.md`. El índice las publica por permiso (`puedeVerAyudaFlito`); esta skill
**no inventa alcance** ni redacta módulos que el pedido no tocó.

## Cuándo dispara (gate duro)

Invocar **antes de `create_pull_request`**, junto a `qa-agent` B y `flit-code-review` (paso 4b).

| Disparador | ¿Invocar? |
|---|---|
| HU **FRONTEND** o Bug que cambia lo que se ve o se hace en un módulo **con ficha** (`{slug}.md` ya existe en el catálogo) | **Sí** — el PR debe traer el delta del `.md` (pasos, copy de botones, estados) |
| El diff toca la pantalla y la ficha queda desactualizada (botón renombrado, estado nuevo, flujo distinto) | **Sí** — actualizar la ficha; sin eso **no se abre el PR** |

Sin delta de ayuda en ese caso → **no** llamar a `create_pull_request`. Corregir en el mismo hilo.

## N/A (declarar en el PR; no bloquea)

Declarar «ayuda: N/A — …» en el cuerpo del PR. No inventar una ficha para salir del paso.

- **BACKEND-only** (API, esquema, cron, sin UI)
- **Copy / a11y** menor que no cambia el flujo ni los nombres de controles que cita la ficha
- Ramas **CHORE/** y **DOCS/**
- **Bug** que no cambia lo que se ve o se hace (infra, test, tipo interno)
- Módulo **sin ficha aún** (el `.md` no existe; el índice muestra «Ficha pendiente»). Las 18 del catálogo ya están publicadas (Gestión #11894; Finanzas y Administración #11895). No inventar un capítulo extra.

## Dónde viven

| Qué | Path |
|---|---|
| Fichas | `apps/web/src/content/ayuda/{PageSlug}.md` (clave de `catalogo.ts`) |
| Plantilla AC6 | `apps/web/src/content/ayuda/_plantilla.md` |
| Catálogo | `apps/web/src/content/ayuda/catalogo.ts` |
| Renderer | `apps/web/src/lib/ayudaMarkdown.ts` + `components/ayuda/AyudaMarkdown.tsx` |

Un archivo por clave del catálogo. Prefijo `_` no es ficha. Ausencia = pendiente, no error.

**Publicadas (18):** Gestión (HU #11894) y Finanzas/Administración (HU #11895): `flito_bolsas`, `flito_conciliacion`, `finanzas_reporte_costos`, `siigo_parametrizacion`, `siigo_operacion`, `siigo_credenciales`.

`siigo_credenciales` se lista solo si `user.role === 'admin'`. **No** aliasar a `siigo_parametrizacion`.

## Plantilla de ficha (obligatoria)

Copiar `_plantilla.md`. Secciones, en este orden, tono **usted**:

1. **Qué es**
2. **Para quién**
3. **Cómo se entra**
4. **Pasos** (copy real de botones/enlaces)
5. **Estados** (cargando / error / vacío / lleno de ESA pantalla)
6. **Qué no hace**

Prohibido: capturas, diagramas como imagen, endpoints, nombres de tablas, PII de ejemplo.

## Qué no hacer

- No inventar un capítulo para un módulo que el pedido no tocó
- No crear el PageSlug `siigo_credenciales` desde esta skill
- No publicar las 18 fichas «para completar el índice»
- No sustituir esta skill con un comentario ADO o un checklist en el chat
