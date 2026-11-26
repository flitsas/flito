# Runners propios de flito (`vars.RUNNER`)

Prepara CI, CD y smokes para el pool de self-hosted de la 177 (grupo GitHub `flit-ci`),
como paso previo a pasar el repo a **privado**. El interruptor es la variable de
repositorio `RUNNER`.

## Interruptor (seguro por defecto)

| Valor de `vars.RUNNER` | Comportamiento |
|---|---|
| *(vacío / no definida)* | Todo sigue en GitHub-hosted (`ubuntu-latest` / `ubuntu-24.04` en el e2e del visor PDF). |
| `flit-ci` (u otra etiqueta del pool) | Jobs usan ese runner. |

Validación sin tocar la variable: en CI, `workflow_dispatch` con input `runner=flit-ci`.

```bash
gh workflow run ci.yml --ref CHORE/jormancopete-runner-propio -f runner=flit-ci
```

## Beneficios

1. **Costo de Actions al privatizar** — con el repo privado, los minutos de GitHub-hosted se cobran; el pool propio no consume esa cuota.
2. **CI más rápido en el host** — en la 177 ya están `poppler-utils`/`qpdf` y las libs de Chromium: se evita `sudo apt` y `playwright install --with-deps`.
3. **CD más robusto** — en runner propio, Buildx usa driver `docker` (capas en disco), sin imagen `moby/buildkit` ni caché GHA (mismo patrón que flit-firmas; menos timeouts a Docker Hub).
4. **Smokes alineados** — nightly E2E y smoke HTTP de prod pueden correr en el mismo pool.
5. **Rollback trivial** — borrar o vaciar `vars.RUNNER` vuelve todo a GitHub-hosted sin revertir código.

## Activación (fuera de este PR)

1. Agregar el repo `flitsas/flito` al grupo de runners `flit-ci` (hoy suele tener solo a `flit`).
2. Validar con `workflow_dispatch` + `runner=flit-ci` (CI verde en el pool).
3. Crear `RUNNER=flit-ci` **solo cuando el repo sea privado** (o cuando se decida migrar el pool).
4. Para volver atrás: borrar la variable.

## Archivos tocados

- `.github/workflows/ci.yml`
- `.github/workflows/cd.yml`
- `.github/workflows/e2e-smoke-nightly.yml`
- `.github/workflows/prod-smoke.yml`

No cambia comportamiento de producto (`apps/**`, `packages/**`).
