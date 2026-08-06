---
name: flit-intake
description: Normaliza un requerimiento en cualquier forma (prosa, bullets, notas, chat) a un borrador canónico antes de Features/HUs o código. Detecta ambigüedades, traduce al glosario de dominio y entrega un paquete listo para tech-lead. Triggers — intake, requerimiento nuevo, “tengo esta idea”, “apunta esto”, “antes de crear el Feature”, normalizar pedido, flit-intake.
---

# Intake de requerimientos — FLITO

Puerta de entrada cuando el humano **no** trae Feature/HU listos en ADO.
**No escribe en Azure DevOps.** **No implementa código.** Traduce → aclara → entrega borrador.

Lee siempre [`docs/dominio.md`](../../../docs/dominio.md). Si el tema toca una integración, abre también el doc de features/integración correspondiente (p. ej. Siigo).

## Cuándo usar

| Situación | Usar intake |
|---|---|
| Pedido informal, bullets, “quiero que…”, notas de reunión | **Sí** |
| Feature/HU ya en ADO con Description + AC Gherkin | **No** → `tech-lead` modo C o implementación |
| Bug concreto con repro | **No** → `qa-agent` / agente de código |
| “Implementa el Feature #N” ya refinado | **No** → `flit-modo-desarrollo-auto` |

Si el orchestrator ve un requerimiento nuevo sin ID de ADO, **el primer paso es esta skill** (luego tech-lead A/B).

## Entrada aceptada

Cualquier forma: prosa, lista, captura descrita, enlace a doc interno, mezcla de negocio + técnico.
No exigir Como/quiero/para ni Gherkin al humano.

## Proceso

### 1. Traducir al glosario

Reescribir el pedido en términos canónicos de `docs/dominio.md`.
Si el humano usa un sinónimo, conservarlo entre paréntesis la primera vez: *compañía (“empresa”)*.

### 2. Separar capas

Clasificar cada pedazo como:

- **Negocio** — qué debe poder hacer quién, y para qué
- **Regla** — restricciones, excepciones, autogestión, ambientes
- **UI / disparador** — pantalla o acción que inicia el flujo
- **Técnico sugerido** — APIs, tablas (hipótesis; no compromiso)
- **Fuera de alcance** — lo que el humano mencionó pero no pide ahora

### 3. Pregunta consolidada (si hace falta)

Máximo **una** pregunta, con este molde:

```
Ambiguo:
- …

Asumo por defecto (si no respondes):
- …

Si avanzamos con esos supuestos:
- el borrador servirá para tech-lead modo A/B
- NO se crea nada en ADO ni se escribe código

Bloquea código/ADO hasta respuesta: sí | no
```

Si no hay ambigüedad que cambie alcance o DoR, **no preguntes**: entrega el borrador.

### 4. Entregar el paquete de intake

Salida obligatoria (markdown en el chat; opcionalmente un borrador bajo `docs/features/` solo si el humano lo pide):

```markdown
## Intake — <título corto>

**Origen:** <cómo llegó el pedido>
**Módulos tocados (hipótesis):** `apps/api/...`, `apps/web/...`
**Glosario aplicado:** <términos canónicos usados>

### Problema / valor
<1 párrafo>

### Alcance propuesto
- In:
- Out:

### Criterios funcionales verificables (borrador)
- …  <!-- aún NO es Gherkin; frases observables -->

### Reglas y supuestos
- …

### Riesgos / dependencias
- PII / Habeas Data: sí|no|revisar
- Integraciones externas:
- Dependencias de Features/HUs existentes:

### Ambigüedades abiertas
- … | ninguna

### Handoff sugerido
- Siguiente: tech-lead-agent modo A (Feature) | modo B (si ya hay Feature padre #…)
- ¿Listo para refinar a Gherkin/SP? sí | no (faltan respuestas)
```

## Qué está prohibido

1. Crear o activar work items en ADO.
2. Abrir ramas, commits o PRs.
3. Inventar AC Gherkin definitivos (eso es tech-lead + `flit-crear-hu`).
4. Tratar “Facturar” (FLITO) y “emisión electrónica” (Siigo/DIAN) como lo mismo.
5. Mezclar módulos `flito-*` con legacy sin marcarlo explícitamente.

## Encadenamiento

```
requerimiento libre
  → flit-intake                         (este skill)
  → tech-lead modo A / B                (Feature + HUs canónicas)
  → architecture / ux si aplica
  → flit-modo-desarrollo-auto u HU suelta
```

DoR de **ejecución** (Gherkin, SP, `Refinement`) sigue siendo del tech-lead modo C.
Este skill solo produce **DoR de borrador**: problema, alcance, criterios observables, supuestos, riesgos.
