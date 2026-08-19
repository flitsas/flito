# Plantilla: User Story (Azure DevOps)

---

## Title
```
[BACKEND|FRONTEND] – <Módulo> – <Verbo + sustantivo>
```
Ejemplos:
- `[BACKEND] – Personas – Endpoint registro con adjuntos`
- `[FRONTEND] – Personas – Página listado con filtros`

(El prefijo `[US #ID]` no se usa: el ID no existe hasta crear el ítem; ADO lo asigna solo.)

## Type
`User Story`

## Area Path
`FLIT - FLITO`

## Iteration Path
`FLIT - FLITO\<Sprint siguiente al activo>`

## Fields

| Campo | Valor |
|-------|-------|
| `Story Points` | `<Fibonacci: 1,2,3,5,8>` |
| `Custom.Refinement` | `true` |
| `Tags` | `DOR`, `adopcion-ia` |
| `AssignedTo` | `<Humano responsable>` |
| `Parent` | `Feature #<ID>` |
| `Dependencies` | `US #<ID>, US #<ID>` (o "Ninguna") |

## Description

```
Como <rol o tipo de usuario>,
quiero <acción o funcionalidad>,
para <beneficio o valor obtenido>.
```

## Acceptance Criteria

Formato Gherkin (o lista numerada con Given/When/Then):

### AC1 — <Escenario positivo principal>
```gherkin
Given <precondición>
When <acción>
Then <resultado esperado>
```

### AC2 — <Escenario negativo / error>
```gherkin
Given <precondición de error>
When <acción>
Then <resultado esperado de error>
And <mensaje de error específico si aplica>
```

### AC3 — <Escenario de borde>
```gherkin
Given <precondición de borde>
When <acción>
Then <resultado>
```

> **Nota**: Siempre incluir al menos 1 AC positivo + 1 AC negativo. Sin AC negativos, la historia no cumple DoR.

## Notas técnicas (opcionales)

<Notas relevantes para implementación: constraints, patrones recomendados, APIs externas.>

## DoR — Checklist antes de pasar a Active

- [ ] Parent (Feature) en `Active` o `Resolved`
- [ ] Título sigue formato `[BACKEND|FRONTEND] – <Módulo> – <Verbo + sustantivo>` (con guion largo `–`)
- [ ] ≥1 AC positivo + ≥1 AC negativo
- [ ] Story Points asignados (Fibonacci)
- [ ] `Refinement = true`
- [ ] Dependencies explícitas (o "Ninguna")
- [ ] Sprint = siguiente al activo
- [ ] AssignedTo = humano
- [ ] Tag `DOR`
- [ ] Sin placeholders en AC
