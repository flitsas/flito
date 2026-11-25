# ADR-0027 — Dr. Flit IA: las fichas de ayuda llegan al API como artefacto generado y versionado; el cupo diario vive en PostgreSQL

- **Estado:** Aceptado (2026-10-23, David Chica — «Arranca» tras revisar el corte y las decisiones del F4)
- **Fecha:** 2026-10-22
- **Feature:** #13696 (F4, Conversación con IA en Dr. Flit) · Épica #12757
- **Diseño:** [`docs/diseno/feature-13696-dr-flit-ia.md`](../diseno/feature-13696-dr-flit-ia.md)
- **Relacionados:** ADR-0024 (frontera por enlace), ADR-0026 (Dr. Flit soporte). No reemplaza ninguno.

## Contexto

F4 exige que el modelo responda **solo** con las fichas de Ayuda FLITO que el usuario puede ver, **filtradas en el backend**, y que el costo tenga un tope de 30 mensajes por usuario y día de Colombia (D4), contado en el servidor.

Hoy las fichas (`apps/web/src/content/ayuda/*.md`, 28 fichas, ~191 k caracteres ≈ 55–64 k tokens) y su catálogo con el permiso de cada una (`catalogo.ts`) viven **solo en el web**. La imagen del API (`apps/api/Dockerfile`) no copia `apps/web/src`. Redis es opcional en el despliegue: sin él, los limiters caen a memoria por proceso.

## Decisión

1. **Fichas:** un script del API (`apps/api/scripts/generar-ayuda-drflit.ts`, con `tsx`) genera `apps/api/src/modules/flito-dr-flit/ayuda/fichas-ayuda.generated.ts` reutilizando el código del web (`catalogo.ts`, `parsearFicha`, `seccionesDeFicha`) para que las anclas sean idénticas. El archivo **se commitea** y compila con el API. Un test del API lo regenera en memoria y falla si difiere del commiteado (prueba de deriva, mismo patrón que la comparación existente `PAGINAS_AYUDA_DRFLIT` ↔ catálogo). Los `*.generated.ts` se excluyen de `max-lines`.
2. **Filtrado:** ficha visible ⇔ `pagina.<permiso>` ∈ `funcionesConcedidas(req, …)`. Nunca el nombre del rol. El cliente no envía fichas, slugs ni contexto.
3. **Contexto acotado:** índice de fichas visibles siempre; cuerpos completos si caben en `DRFLIT_IA_CONTEXTO_MAX_CHARS`; si no, secciones rankeadas con el algoritmo de F3 portado al API (con test de paridad).
4. **Cupo:** tabla `flito_drflit_cupo_ia (usuario_id, dia, usados)` (migración 0247) con UPSERT condicionado atómico; día = `(now() AT TIME ZONE 'America/Bogota')::date`; se devuelve el cupo si la llamada al modelo falla por red/timeout/5xx/4xx; un JSON fuera de contrato sí consume. No se usa Redis.

## Alternativas consideradas

| Opción | Por qué no |
|---|---|
| Mover fichas, catálogo y parser a `packages/ayuda-flito` | Esfuerzo L: cambia el glob de Vite, el Dockerfile, workspaces y `package-lock`, la skill de ayuda y los E2E de F1/F2 en producción, sin valor para el usuario |
| Generar el artefacto en el build sin commitearlo | Acopla el build del API al árbol del web (`COPY apps/web/src/...` en el Dockerfile y en CI) y no mejora la garantía frente a commitear + test de deriva |
| El navegador envía las fichas visibles | El servidor no distingue una ficha real de una inventada: respuestas con cita de apariencia oficial sobre contenido falso, inyección por el contexto «confiable» y costo arbitrario. Mitigarlo exige que el servidor ya tenga las fichas. Viola el AC de filtrado en el backend |
| Cupo en Redis (`INCR` + `EXPIREAT` a medianoche Bogotá) | Redis es opcional aquí; sin él el tope se vuelve por proceso y se reinicia con cada deploy: un control de costo no puede fallar abierto |

## Consecuencias

- **+** Cero cambios de infraestructura y cero dependencias nuevas (el cliente es `requestWithRetry`).
- **+** El servidor es la única fuente de contexto del modelo; las citas se validan contra el mismo artefacto.
- **+** El tope es exacto entre pestañas y procesos, y sobrevive a reinicios.
- **−** Editar una ficha exige `npm run ayuda:drflit -w apps/api` (lo fuerza CI). La skill `flit-ayuda-flito` debe añadir el paso (CHORE aparte).
- **−** Un archivo generado de ~200 KB en el repo.
- **−** Una escritura en BD por mensaje con IA (barata: PK compuesta, una fila por usuario y día). Purga a 90 días en el cron existente de Dr. Flit.

## Preguntas abiertas que afectan esta decisión

- Retención del contador (propuesta 90 días) — PO/jurídico.
- ¿Un JSON fuera de contrato debe consumir cupo? (propuesta: sí, hubo llamada real; la falla de red no).
