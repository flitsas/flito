---
name: flit-flujo-local
description: |
  Paso 0 de todo desarrollo (FLIT - FLITO): decidir con el humano si el trabajo va DIRECTO A DEV (ciclo estándar) o pasa por FLUJO LOCAL (PR abierto de inmediato con merge retenido + sesión de pruebas locales con el humano antes del merge). Cargar ESTA Skill al arrancar cualquier desarrollo — Feature/lote en modo auto o WI suelto — antes de codear. En flujo local: gates pre-PR intactos, PR abierto con «no mergees» declarado al pr-monitor-agent, sesión local con resumen + hallazgos (solo si hay) + decisiones, NADA en Azure por la parte local, y merge solo tras el OK humano. Triggers — flujo local, validación local, probar en local antes de DEV, merge retenido, no mergees, directo a DEV.
---

# Flujo local vs directo a DEV (Paso 0)

Regla del humano (2026-10-26): **siempre que se inicie un desarrollo se pregunta** si va directo
al ambiente de DEV o si primero pasa por flujo local. Ningún desarrollo arranca sin esta decisión
registrada en el hilo.

## Cuándo se pregunta

| Arranque | Momento de la pregunta | Alcance de la respuesta |
|---|---|---|
| Feature / lote en `flit-modo-desarrollo-auto` | Al arrancar el Feature o lote, antes de la primera rama | Todo el lote, hasta que arranque otro desarrollo |
| HU o Bug suelto (fuera de modo auto) | Al activarlo con `flit-gestion-hu` Paso 1, antes de crear la rama | Ese WI |

La respuesta **no se hereda** entre desarrollos: cada arranque nuevo vuelve a preguntar. Lo que
sí está prohibido es re-preguntar a mitad de un mismo lote ya decidido.

## La pregunta (formulario)

Una sola pregunta estructurada con dos opciones, y en el mismo mensaje la **unidad de prueba
propuesta** si elige flujo local:

- **HU sola** — si la HU se puede probar por sí misma (sin depender de otras del lote).
- **Feature completo** — si las HUs del Feature tienen dependencias entre sí y solo se prueban juntas.
- **Épica / conjunto de Features** — si todos los Features deben validarse en conjunto.

El hilo propone la unidad según las dependencias declaradas en los Acceptance Criteria; el humano
confirma o corrige al responder.

## Opción A — Directo a DEV

El ciclo estándar de `AGENTS.md` y `flit-modo-desarrollo-auto` **sin ningún cambio**: gates
pre-PR → PR → `pr-monitor-agent` con merge al verde → Modo B → M1 → evidencias DEV.

## Opción B — Flujo local

**Lo que NO cambia:** activación ADO, rama, implementación por agentes, y **todos** los gates
pre-PR (qa-agent B, flit-code-review, security/db si aplican). El flujo local **no** es una vía
para validar a mano lo que los gates deben certificar.

**Lo que cambia:** el merge se retiene hasta que el humano valide en local.

1. **PR abierto de inmediato** (no se retiene el PR, se retiene el merge): mismo formato, mismo
   Modo A de `flit-integration-ado`.
2. **`pr-monitor-agent` con opt-out explícito:** lanzarlo en background como siempre, pero con
   «**no mergees — flujo local pendiente de validación humana**» en el prompt. Él vigila checks y
   conflictos y reporta su HANDOFF con el estado del CI, pero **no** ejecuta el merge aunque todo
   esté verde (opt-out «no mergees» de `AGENTS.md`).
3. **Sesión de pruebas locales con el humano** sobre la unidad acordada:
   - Levantar el entorno local del repo (`docker compose` para postgres/redis/minio +
     `npm run dev` de api/web según el alcance) y recorrer el flujo con el humano.
   - Si la unidad es Feature/épica: la sesión espera a que todos los PRs de la unidad estén
     abiertos y verdes en CI; el código se prueba integrado en local (pila rebaseada).
   - Si durante la sesión el CI de un eslabón cae por código: «Pausa por CI rojo» de
     `flit-modo-desarrollo-auto`, igual que siempre.
4. **Entregable de la sesión** (en el chat y, si el humano lo pide, en el cuerpo del PR):
   - Resumen de lo probado (flujos recorridos y resultado).
   - Hallazgos — **solo si los hay** — cada uno con severidad y propuesta.
   - Mejoras sugeridas o decisiones que falten por tomar.
5. **Hallazgos del propio cambio** → se corrigen en el mismo hilo, en este WI (P9): fix → gates
   del diff nuevo (el veredicto de `flit-code-review` queda vencido; qa-agent B re-ejecuta P1) →
   push → CI de nuevo → se repite la validación local si el humano lo pide. **No** se radican
   Bugs ni HUs nuevas por hallazgos del propio desarrollo.
6. **OK humano explícito** → relanzar `pr-monitor-agent` sobre el PR **sin** el opt-out
   («validación local superada — autorizado a mergear»). A partir de ahí el ciclo es el estándar:
   `MERGED` → Modo B (`DeployDEV`) → M1 → `flit-evidencias-dev` en DEV → promoción humana.

### Cadena apilada en flujo local

La pista B (siguiente HU) **sigue arrancando sin esperar**: lo retenido es el merge, no el
desarrollo. Cada PR de la pila se abre con el mismo opt-out y se libera cuando la sesión local
de su unidad de prueba obtiene el OK. En la práctica, si la unidad es el Feature completo, los
merges se liberan en orden tras la sesión conjunta.

### Nada en Azure por la parte local (hard-stop del humano)

La validación local **no deja rastro en Azure DevOps**: ni Discussion, ni `Custom.Evidences`, ni
adjuntos, ni comentario «validado en local». El resumen vive en el chat y, opcionalmente, en el
cuerpo del PR. Lo que sí sigue igual: Modo A/B (campos `Custom.Commits` y `Deploy*`) y, tras el
merge, `flit-evidencias-dev` en DEV — esa sesión **sí** sube capturas al Feature y la sesión
local **no la sustituye** (son ambientes y momentos distintos).

## Hard-stops

- **Mergear un PR de flujo local sin el OK humano explícito de la sesión local.** «El CI está
  verde» no es el OK. El opt-out solo se levanta con la autorización, no por antigüedad.
- **Arrancar a codear sin la decisión del Paso 0.** Si el humano no ha respondido, no hay rama.
- **Subir evidencias o comentarios de la validación local a Azure** (regla explícita del humano).
- **Saltar los gates pre-PR** «porque ya se probará en local»: qa-agent B y `flit-code-review`
  siguen siendo pre-PR, siempre.
- **Radicar Bugs/HUs por hallazgos de la propia sesión local** (P9): se corrigen en el mismo hilo.
  Un hallazgo de deuda preexistente o ajeno al cambio → Nota en el PR, nunca Bug.
- **Retener el PR** (no abrirlo) «hasta que el humano pruebe»: el PR se abre de inmediato con
  gates en verde; lo que se retiene es el merge. Un PR sin abrir no corre CI.

## Espera legítima

Esperar al humano para la sesión local y para su OK **no** es estancamiento (es un gate humano).
Lo que sí es estancamiento prohibido: quedarse idle sin arrancar la siguiente HU de la pila
mientras el humano agenda la sesión, o re-preguntar «¿ya lo probaste?» en bucle.
