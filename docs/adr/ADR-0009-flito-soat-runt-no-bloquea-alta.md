# ADR-0009 — El RUNT no bloquea el alta del canal Cliente

## Estado

**Propuesto — SUPERSEDED por [ADR-0010](./ADR-0010-flito-soat-runt-compuerta-alta.md)** (HU [#11966](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11966)).
Nunca fue aprobado por el Líder Técnico. Su decisión rigió el código entregado en DEV/QA entre la
HU [#11935](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11935) y la #11966: las solicitudes radicadas en ese intervalo se crearon bajo esta regla y **no
se reescriben ni se reconsultan** (AC6 de la #11966). El cuerpo de este ADR se conserva sin cambios
porque es la única explicación de por qué existen las cuatro columnas de verificación del satélite.

*(Cabecera original: **Propuesto** — HU #11935, Feature [#11912](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11912), pendiente de aprobación del Líder Técnico.)*

**Supersedes** (parcial) [ADR-0008](./ADR-0008-flito-soat-canal-cliente.md) (sigue **Propuesto**; no se reescribe):

- La parte de §1.6 que obliga a resolver `organismo_codigo` **antes** del INSERT.
- §6 fila 1: `POST /cliente/preconsulta` como paso 1 **bloqueante** del alta, y los 409-vigente / 503 / 422-organismo como aborto de `POST /cliente`.
- El orden de `crearSolicitud` que espera a Kyverum (paso 4 del canal).

**No supersede:** satélite 1:1 (§1.2), propietario en `flito_compradores` (§1.3), **no persistir el payload crudo del RUNT** (§1.6, esa frase se conserva), RN-01, estados `pendiente_revision` / `rechazada`, ni el reúso de `enviarAlGestor` al validar.

Los CF-07/10 del Feature #11912 quedan desfasados con esta decisión. **No se reescribe el Feature** (pedido del hilo de la #11935).

## Contexto

ADR-0008 diseñó el alta así: consultar Kyverum, y si el RUNT está caído, no hay registro, no cuadra, hay SOAT vigente o el organismo no está en catálogo, **no se crea la fila**. Eso convertía una integración externa en compuerta de negocio. Operaciones no podía validar a mano lo que no existía.

La #11935 invierte la regla de producto: **crear es enviar**; el RUNT informa **después**; Operaciones decide.

Hechos medidos en `origin/develop` (worktree `flito-11935`):

1. `crearSolicitud` llama `consultarRunt` **antes** del INSERT y traduce cada «no» en 503/422/409 (`flito-soat-cliente.service.ts`).
2. `flito_soat.organismo_codigo` es `NOT NULL` + FK. `conJoinsCola` y `detalle()` hacen `innerJoin` a `organismos_transito_config`: una fila con organismo NULL **desaparece** de cola, detalle, facetas, export y ZIP.
3. El wizard (`FlitoSoatSolicitud.tsx`) exige `runtListo` para habilitar Enviar. Eso es UI, no el contrato del POST. Esta HU no la toca.

## Decisión

1. **`POST /cliente` no espera a Kyverum.** 201 con `origen='cliente'` y `pendiente_revision`. Marca/organismo no viajan en el multipart.
2. **Verificación post-commit**, fire-and-forget con `setImmediate` (precedente `tramites/lote.ts`). Sin cola Redis. El satélite guarda solo derivados: estado (`pendiente|caido|sin_registro|no_cuadra|ok`), `soat_vigente`, `soat_vigente_hasta`, `verificacion_codigo`. Cero jsonb crudo.
3. **SOAT vigente no auto-solicita.** Se crea; el aviso y la fecha (si viene) viven en el satélite; el estado sigue `pendiente_revision`.
4. **`organismo_codigo` pasa a nullable.** FK intacta. El sync/trámite sigue escribiendo código. Cuando el job cruza catálogo + `organismos_transito_config`, rellena. Cola/detalle/export: `leftJoin`.
5. **Validar / rechazar / subsanar no esperan** a que la verificación esté lista. Validar con vigente es excepción permitida.
6. **Preconsulta se depreca como paso del alta**, no se borra. Fuera de esta HU: el wizard.

## Consecuencias

- Una solicitud puede vivir días con organismo NULL y `verificacion_estado=pendiente` o `caido`. Eso es el diseño, no un fallo.
- Si el proceso muere entre el COMMIT y el job, la fila queda `pendiente`. No hay reintento automático. AC6 cubre el hueco.
- El wizard actual sigue bloqueando al usuario hasta un 200 de preconsulta. El AC1 se cumple en API; desbloquear la pantalla es otra HU.

## Relación con otros ADR

- **ADR-0008** — supersede parcial, arriba.
- **ADR-0010** — **supersede a este**, para solicitudes nuevas. Ver la cabecera de Estado.
- **ADR-DB-001** — la `0171` no lleva `BEGIN/COMMIT` propio.
