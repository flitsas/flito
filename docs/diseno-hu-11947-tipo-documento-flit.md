# Diseño slim — HU #11947 · Tipo de documento de FLIT en Excel y colas

Feature #11908 (Active). HU **#11934 Resolved** — esta HU **corrige su regla**: la clase del titular la afirma `flit_raw->>'tipo'`, no la presencia de apellidos. Módulos FLITO `flito-soat`, `flito-impuestos` y `flito-tramites` (no el legado `soat/` / `tramites/`). Worktree `flito-11947`.

Decisiones **ya cerradas** (no reabrir). El código del worktree ya las ejecuta; este doc es el mapa para backend/frontend, no un debate.

## Patrón reutilizado

| Pieza | Path real | Qué se extiende |
|---|---|---|
| Derivados de cola / Excel | `apps/api/src/shared/export/cola-flito-derivados.ts` | Misma pieza de la #11934. `CLAVES_FLIT_RAW` gana la **novena** clave `tipo`. `bloqueTitular` deja de mirar `apellidos.trim()` y llama a `clasificacionDeTipoFlit` (única copia de la tabla en el repo). `claveTitular` pasa a **tripla** `[tipo, nombres, apellidos]` para que SOAT reconcilie el titular entero y clasifique después. |
| Extracción SQL | `expresionesFlitRaw` en el mismo archivo | Una expresión más: `->>` + `case jsonb_typeof` (descarta object/array). Cero joins nuevos. `flit_raw` **no** se proyecta entera. |
| Hoja de 25 columnas | `apps/api/src/shared/export/cola-flito-excel.ts` | **Mismas** 25 cabeceras. Cambia **cómo** se llenan las cinco del titular. `CAMPOS_PII_COLA_EXPORT` declara `tipo_documento`. |
| Export SOAT | `flito-soat.export.service.ts` | Sigue reconciliando con `comun()`; la tupla ahora incluye `tipo`. Canal Cliente → `TITULAR_VACIO` por no tener trámite/`flit_raw`, no por un `if` de origen. |
| Export Impuestos | `flito-impuestos.export.service.ts` | 1:1 con el trámite; `bloqueTitular({ tipo, nombres, apellidos })` directo. |
| Colas | `flito-soat.service.ts`, `flito-impuestos.service.ts`, `flito-tramites.service.ts` | Proyectan `tipoTitularFlit` con la **misma** `expresionesFlitRaw(…).tipo` y emiten el código **ya resuelto** (`clasificacionDeTipoFlit(…).claseId`). |
| Pintura de documento | `apps/web/src/components/flit/columnasComunes.tsx` (`documentoConTipo`) | Prefijo visual. **Sin** tabla `n`/`cc`/`ps`/`ce`. |

**No** se toca el sync, `schema.ts`, ni `flito_compradores.tipo_documento` (0/7052 en filas del sync: no es fuente). **No** se toca canal Cliente ni certificación RUNT (`TIPOS_DOCUMENTO_RUNT` / `PAS` intacto — AC8).

## Contrato delta

**Excel** (`POST /api/flito/soat/export`, `POST /api/flito/impuestos/export`) — mismas 25 columnas. Las cinco del titular las decide `bloqueTitular`:

| `tipo` normalizado (trim + minúsculas del **formato**) | ClaseDeInterlocutor | NombrePila / Apellidos | RazonSocial | ClaseId |
|---|---|---|---|---|
| `n` | `PJUR` | vacías | `nombres` (puede ir vacío) | `NIT` |
| `cc` | `PNAT` | `nombres` / `apellidos` | vacía | `CC` |
| `ps` | `PNAT` | ídem | vacía | `PP` (**nunca** `PAS`) |
| `ce` | `PNAT` | ídem | vacía | `CE` |
| `otro` | `PNAT` | ídem | vacía | vacía (no `OTRO`/`TI`/`CC`) |
| ausente / `""` / `c` / cualquier otro | vacías las cinco | | | |

`NumeroId` sigue de `cedulanit` / `flito_compradores.numero_documento`. Heurística `apellidos.trim()` de #11934 **muere**. `" CC "` = `cc`; `c` ≠ `cc`.

**Colas** (sin rutas nuevas; el DTO gana el código resuelto, nunca el crudo de FLIT):

- `GET /api/flito/soat` y `GET /api/flito/soat/:id` → `compradores[].tipoDocumento`: `'CC' \| 'NIT' \| 'PP' \| 'CE' \| null`
- `GET /api/flito/impuestos` y detalle → `compradorTipoDocumento`: mismo vocabulario
- `GET /api/flito/tramites` → `compradorPrincipal.tipoDocumento` y `compradores[].tipoDocumento`: ídem

`null` = origen no afirma (`tipo` ausente/desconocido/`otro` sin `ClaseId`) **o** fila del canal Cliente (sin `flit_raw`). El front pinta `documentoConTipo(codigo, numero)` → `CC 1020304050` o solo el número.

**shared-types:** no aplica. `TIPOS_DOCUMENTO_RUNT` no se toca.

## Archivos a crear/modificar

**Crear**

- `docs/diseno-hu-11947-tipo-documento-flit.md` — este doc.

**Modificar (ya en el worktree, sin commit)**

- `apps/api/src/shared/export/cola-flito-derivados.ts` — novena clave, `TABLA_TIPO_FLIT`, `clasificacionDeTipoFlit`, `bloqueTitular`, `claveTitular` tripla.
- `apps/api/src/shared/export/cola-flito-excel.ts` — `tipo_documento` en `CAMPOS_PII_COLA_EXPORT`.
- `apps/api/src/modules/flito-soat/flito-soat.export.service.ts` — tripla en `datosDeTramitePorSoat`.
- `apps/api/src/modules/flito-impuestos/flito-impuestos.export.service.ts` — `bloqueTitular` con `tipo`.
- `apps/api/src/modules/flito-soat/flito-soat.service.ts` — `tipoTitularFlit` + `tipoDocumento` resuelto en cola/detalle.
- `apps/api/src/modules/flito-impuestos/flito-impuestos.service.ts` — `compradorTipoDocumento` resuelto.
- `apps/api/src/modules/flito-tramites/flito-tramites.service.ts` — `tipoTitularFlit` + cuelga el código en cada comprador.
- `apps/api/src/modules/flito-soat/flito-soat.pii.ts` — `tipo_documento` en `CAMPOS_PII_SOAT` (el export lo hereda).
- `apps/api/src/modules/flito-impuestos/flito-impuestos.pii.ts` — `tipo_documento` en `CAMPOS_PII_IMPUESTO`.
- `apps/web/src/components/flit/columnasComunes.tsx` — `documentoConTipo`.
- `apps/web/src/pages/FlitoSoat.tsx` · `FlitoImpuestos.tsx` · `FlitoTramites.tsx` — consumen el código resuelto; **no** mapean.

**Tests P1 (lista explícita)**

- `apps/api/__tests__/services/cola-flito-derivados.test.ts`
- `apps/api/__tests__/services/flito-soat-export.test.ts`
- `apps/api/__tests__/services/flito-impuestos-export.test.ts`
- `apps/api/__tests__/services/flito-soat.cola-propietario-canal.test.ts`
- `apps/api/__tests__/services/flito-impuestos.cola-certificacion.test.ts`
- `apps/api/__tests__/services/flito-tramites.test.ts`

**No tocar (declarado)**

- `apps/api/src/db/schema.ts`, `src/db/migrations/`, sync FLIT.
- Canal Cliente (`flito-soat-cliente*`, wizard, `TIPOS_DOCUMENTO_RUNT` / `PAS`).
- PDF / certificación RUNT (`POST …/certificar`, catálogo `PAS`).
- `packages/shared-types` (salvo que un grep posterior demuestre un tipo de cola compartido; hoy el DTO vive en cada servicio).
- `docs/ux/flito-soat-impuestos-export-excel.md` (filtro/botón de #11909; no es esta superficie).

## ADR: no aplica

Extiende el patrón de #11934 (leer claves de `flit_raw` con `->>`, no columna propia). No sienta precedente nuevo: misma decisión de no migrar, misma lista blanca de Excel, misma función de mapeo para las dos colas. `docs/adr/` no se toca.

## Notas operativas (backend / frontend)

**backend-agent**

- Fuente de verdad = `clasificacionDeTipoFlit` / `TABLA_TIPO_FLIT`. Prohibido un segundo `switch` en un servicio o en el front.
- Lectura: `expresionesFlitRaw(flitoTramites.flitRaw).tipo` en las cuatro proyecciones (2 exports + 3 colas). No `sql` suelto con la clave concatenada.
- `flito_compradores.tipo_documento` **no se lee** para clasificar. Tests ya cubren el caso `CC` en tabla + `n` en payload → `NIT` en hoja/cola.
- SOAT cola: el tipo se cuelga **por trámite dueño del comprador** (1:1), no con `comun()`. El Excel sí reconcilia la tripla porque hay **una** fila por SOAT.
- Canal Cliente: `tipoDocumento: null` por ausencia de `flit_raw`, no por `if (origen === 'cliente')`.
- PII: `tipo` pasa de adivinado a afirmado → `tipo_documento` en `CAMPOS_PII_SOAT`, `CAMPOS_PII_IMPUESTO` y `CAMPOS_PII_COLA_EXPORT`. El número ya viajaba. Gestión de trámites **no** tiene `*.pii.ts` propio: no inventar uno.
- P1: los seis `*.test.ts` de arriba, no el glob del módulo. Impl **no** muta (P2).
- Gates: `security-agent` **sí** (PII afirmado). `db-review-agent` **no aplica** (cero `schema.ts` / migraciones).

**frontend-agent**

- Alcance AC7: pintar el código que el API ya resolvió. `documentoConTipo(tipo, numero)` es el único helper; las tres pantallas lo llaman.
- Prohibido: mapa `n→NIT` / `cc→CC` en `apps/web`. Si llega un código fuera de los cuatro, se pinta tal cual.
- `tipo`/`compradorTipoDocumento` nulo → solo el número, sin `—` de prefijo ni espacio suelto.
- Canal Cliente y RUNT: no tocar (`FlitoSoatSolicitud`, `bloques.tsx`, `TIPOS_DOCUMENTO_RUNT`).
- `ux-agent`: **omit** (prefijo en celdas existentes, sin pantalla nueva). Declarar en el PR.
- Verificación: typecheck web; E2E de cola **no** es default (P1 = tests API de este WI + typecheck si se tocó web).

**Fuera de alcance (no preguntar: ya cerrado)**

- Columna `tipo` en esquema / sync / `flito_compradores.tipo_documento` como fuente.
- Unificar `PP` (plantilla cliente) con `PAS` (RUNT).
- Heurística de apellidos como fallback cuando `tipo` falta.
- Canal Cliente y certificación RUNT.
