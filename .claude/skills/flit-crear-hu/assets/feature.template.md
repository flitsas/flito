# Plantilla de Feature — FLIT - FLITO

> La usa `tech-lead-agent` **Modo A** al redactar un Feature hijo de una Épica.
> La Épica la escribe el PO; el Feature la **porciona**, no la reescribe.
> (Las HUs usan `user-story.template.md`; los Bugs, `bug.template.md`.)

## Título

`[FLITO] <nombre del Feature>` — sustantivo + acción medible. Sin «completo», «módulo de» ni «fase 1».

## Campos

| Campo | Valor |
|---|---|
| Area | `FLIT - FLITO` |
| Iteration | Sprint **siguiente** al activo (nunca el en curso) |
| AssignedTo | El humano que lo pide (obligatorio, sin placeholder) |
| Tags | `DOR; adopcion-ia; fase-1-diseño` — en **petición aparte** (TF401289) |
| Parent | La Épica de la que nace (obligatorio; un Feature sin Épica es error de proceso) |

## Largo (regla de corte)

| Límite | Caracteres visibles | Qué pasa al superarlo |
|---|---|---|
| Objetivo | ~3.000 (legible en 2 min) | — |
| **Máximo** | **6.000** | El Feature **se parte antes de crearse**; no se recorta pegando más texto |

Referencia: la mediana real del board era 4.769 caracteres (sep-2026) y el máximo 29.084 —
por encima de 6.000 el Feature es una especificación, no un ítem de board: no se puede
refinar en Modo B ni trazar en la cascada.

## Description (HTML)

```html
<h3>OBJETIVO</h3>
<p>Qué logra el usuario de negocio cuando este Feature está en producción. 2-4 frases.</p>

<h3>DESCRIPCIÓN FUNCIONAL</h3>
<ul>
  <li>Flujo principal, en pasos o bullets cortos.</li>
  <li>Qué pantallas/operaciones cubre y cuáles NO (alcance explícito).</li>
</ul>

<h3>CRITERIOS DE ACEPTACIÓN</h3>
<ul>
  <li>3-6 criterios verificables a nivel Feature (el detalle Gherkin va en las HUs, no aquí).</li>
</ul>

<h3>NOTAS TÉCNICAS</h3>
<p>Módulos, tablas, integraciones. Opcional y breve: el diseño es de architecture-agent.</p>
```

## Lo que NO va en un Feature

- AC Gherkin detallados → van en cada HU (`user-story.template.md`, tope 10 por HU).
- Diseño técnico → `architecture-agent` / `docs/diseno/`.
- Una reescritura de la Épica → si el borrador supera el máximo, falta partirlo.
