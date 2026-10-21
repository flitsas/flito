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

## Encabezado de la ficha (obligatorio — Feature #13691 · HU #13703)

Toda ficha empieza con un bloque `---` (subconjunto de YAML, parseado a mano en
`apps/web/src/lib/ayudaFicha.ts`). Cinco claves, ninguna más (clave desconocida = error):

| Clave | Regla |
|---|---|
| `resumen` | Una línea, sin comillas. Es el subtítulo del índice y de la ficha (fuente única: el catálogo **no** lleva `resumen`; solo `resumenPendiente` en entradas sin `.md`) |
| `palabras_clave` | Lista `  - item`, al menos 1 (términos que un usuario escribiría) |
| `consultas` | Lista `  - item`, al menos 1 (preguntas reales: «cómo…», «por qué…») |
| `version` | `MAYOR.MENOR` (`1.0`) |
| `fecha` | `AAAA-MM-DD` válida |

**`version` y `fecha` se actualizan en cada cambio de la ficha (D7)**: cualquier delta de
contenido sube la `version` (`1.0` → `1.1`; cambio de fondo → `2.0`) y pone la `fecha` del día.
Sin eso, el delta de ayuda no cuenta. Lo vigila `e2e/tests/flito-ayuda-artefactos.spec.ts`.

## Plantilla de ficha (obligatoria)

Copiar `_plantilla.md` (incluido su encabezado). Secciones, en este orden, tono **usted**:

1. **Qué es**
2. **Para quién**
3. **Cómo se entra**
4. **Pasos** (copy real de botones/enlaces)
5. **Estados** (cargando / error / vacío / lleno de ESA pantalla)
6. **Qué no hace**

Prohibido: endpoints, nombres de tablas, PII de ejemplo.

**Capturas y diagramas (HU #13707): permitidos solo con datos demo** — sin cédulas, placas, nombres
ni teléfonos reales. El archivo va en `apps/web/public/ayuda/<clave>/<archivo>` (carpeta = clave de
la ficha; nombre en minúsculas, `png`, `jpg`, `jpeg`, `webp` o `svg`) y se cita con
`![texto alternativo](./<clave>/<archivo>)`. El texto alternativo es obligatorio y describe lo que
muestra. Cualquier otro origen (`http…`, `data:`, `/…`, `..`) no se carga: solo se ve el texto
alternativo. Diagramas exportados a SVG o PNG (sin Mermaid). Añadir o cambiar una imagen es cambio
de la ficha: sube `version` y `fecha`. Lo vigila `e2e/tests/flito-ayuda-artefactos.spec.ts`.

## Qué no hacer

- No inventar un capítulo para un módulo que el pedido no tocó
- No crear el PageSlug `siigo_credenciales` desde esta skill
- No publicar las 18 fichas «para completar el índice»
- No sustituir esta skill con un comentario ADO o un checklist en el chat
