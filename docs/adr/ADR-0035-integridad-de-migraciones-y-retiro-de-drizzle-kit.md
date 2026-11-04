# ADR-0035 — Integridad verificable de migraciones y retiro de drizzle-kit

- **Estado:** Aceptado (decisiones H1 a H4 de David Chica, 2026-11-04; se entrega en 2 PRs del Feature #13974)
- **Fecha:** 2026-11-04
- **Contexto de trabajo:** Épica #13973, Feature #13974, HU #13981 y #14102
- **Supersedes:** ninguno. Complementa ADR-DB-001 (el guard de transacciones no cambia)
- **Alcance:** tooling (`apps/api/src/scripts/db-apply.ts`, CI). No habla con módulos `flito-*` ni legacy

## Contexto: lo que dicen los datos

| Fuente | Dato |
|---|---|
| `git log --first-parent -m` de `develop`, `staging`, `release`, sobre `migrations/*.sql` | **0 renames y 0 borrados en los tres.** Las renumeraciones 5d8cdb85 y 4c74fcaa nunca cruzaron una punta de `develop`: se quedaron en la rama de integración |
| Mismo log, ediciones sobre una punta | `develop`: 0045, 0067, 0116, 0182, 0227. `staging` y `release`: 0045, 0067 (PR #80, cadena en BD limpia). 0182 y 0227 se editaron porque fallaron en el CD de DEV y el runner las revirtió: su versión vieja nunca entró al ledger |
| Ledger de la BD local de David (solo `SELECT`) | 5 derivas, 12 huérfanas, 15 pendientes |
| Las 12 huérfanas locales (0274–0285 → 0275–0286) | Solo **1 de 12** conserva el sha256: la renumeración también editó las cabeceras. **12 de 12** conservan el nombre sin número |

**Predicción, no resultado:** remotamente se esperan derivas (DEV: 0045, 0067, 0116; QA y PDN: 0045, 0067) y ninguna huérfana. Es lo contrario de lo que se suponía. La historia anterior al snapshot del 2026-07-17 no es visible y un `--mark-all` pudo reescribir hashes, así que esto lo confirma solo `--check-drift`.

---

## HU #13981 — Detección de deriva

### A. Separar desplegar de abortar: 2 PRs

**PR 1 (sin aborto).** La constante `DRIFT_ABORTA = false` en `db-apply.ts`; el arranque normal informa y sale con 0. No existe camino de código que aborte por deriva, así que su merge automático a `develop` no puede tumbar un ambiente. Contiene además el `--check-drift`, el `--allow-drift`, el manifiesto vacío, el check de CI y toda la HU #14102.

**Medir (lo hace una persona; ningún agente tiene acceso).** Dos vías, ambas de solo lectura:

- **DEV:** logs del initContainer tras el rollout de PR 1: `kubectl -n flito-dev logs <pod> -c db-apply | grep '\[drift\]'`.
- **QA y PDN, sin promover:** un pod efímero con la imagen de `develop`, que además responde lo correcto: qué pasará cuando *ese* código llegue allí.
  `kubectl -n flito-<env> run drift-check --rm -i --restart=Never --image=<digest de develop> ... -- node dist/scripts/db-apply.js --check-drift`, con `DATABASE_URL` tomada del mismo secreto que usa el initContainer. El nombre del secreto no se verificó: `flit-gitops` no está disponible para este diseño. Si el ambiente conecta por un pooler, puede rechazar el parámetro de solo lectura de `--check-drift`.

En los tres ambientes, además, para ver filas sin hash:

```sql
SELECT is_nullable FROM information_schema.columns
 WHERE table_name='_kyverum_applied_migrations' AND column_name='sha256';
SELECT count(*) FROM _kyverum_applied_migrations
 WHERE sha256 IS NULL OR sha256 !~ '^[0-9a-f]{64}$';
```

Promover PR 1 no es necesario: exigiría evidencias DEV `COMPLETAS` del Feature, que aún no está terminado.

**PR 2 (aborto).** Se abre **solo** con los tres resultados en la HU #13981. Contiene el retiro de `DRIFT_ABORTA` (el aborto queda incondicional), las entradas del manifiesto que resuelven lo hallado y un test que fija el comportamiento. Manifiesto y aborto viajan en la misma imagen, así que un ambiente nunca recibe uno sin el otro. Su cuerpo declara `drift-check: DEV=<resultado> QA=<resultado> PDN=<resultado>`.

**Por decidir o revisar al preparar PR 2 (hallazgos de los gates de PR 1):**

- **Filas con `sha256` NULL, vacío o fuera de formato.** Hoy se reportan como deriva, y el manifiesto no las admite porque exige `shaLedger` de 64 hexadecimales; `--mark-all` tampoco las rellena. Si la medición encuentra alguna, PR 2 necesita una categoría propia con su vía de resolución.
- **Control sobre el manifiesto (security-agent).** Con el aborto activo, `derivas-aceptadas.json` decide si la API arranca, y hoy `pr-monitor-agent` mergea a `develop` con CI verde. Decisión humana: exigir revisión de code owner en `develop`, o que el monitor no mergee sin «sí» si el diff toca ese archivo. En ambos casos, añadir `/scripts/check-migraciones-inmutables*` y `/.github/CODEOWNERS` a `CODEOWNERS`.
- **Archivo ilegible.** PR 1 añade la línea `[drift] ilegible archivo=<nombre>`, que no suma en `[drift] resumen`. Con el aborto activo, un pendiente ilegible saldrá con 3 antes de aplicar nada, en lugar de con 1 en su turno.

**Qué es mecánico y qué no.** PR 1 es seguro por construcción. El gate de PR 2 es procedimental: los datos de su manifiesto solo los tiene quien corrió la medición. Si aun así se mergeara antes de tiempo, el daño se limita a DEV, porque QA y PDN exigen merge humano. Rollback en cualquier ambiente: revertir el commit de digest en `flit-gitops`. Con `replicas: 1` y `Recreate`, un aborto deja la API caída hasta entonces.

**Descartado:** una variable de entorno `warn|abort`. Exige tres commits en `flit-gitops`, deja un interruptor permanente y contradice el AC6 («sin bandera aborta») mientras su default sea `warn`.

### Runner

`--check-drift` no llama a `ensureTrackingTable` (es un `CREATE`): abre la conexión con `default_transaction_read_only=on`, para que el solo-lectura lo imponga Postgres. Si no hay ledger, lo informa. Salida: `0` limpio, `3` con deriva, `1` error de conexión u otro.

Control previo a aplicar nada, en funciones exportadas y sin BD (`detectarDeriva`, `decidir`), y `main` delega en una función con dependencias inyectadas, para probar que **`aplicar` no se llama** al abortar.

Log estable, sin PII: `[drift] deriva archivo=… ledger=… disco=…`, `[drift] huerfana archivo=… ledger=… pista=…`, `[drift] resumen intactas=N aceptadas=N derivas=N huerfanas=N pendientes=N`.

`--allow-drift=<motivo>` exige motivo: sin él, o vacío, es error. Registra archivo y motivo por cada hallazgo. Hoy `args` es un `Set` de coincidencia exacta; hay que parsear este caso.

**`--mark-all` lava la deriva:** su `ON CONFLICT DO UPDATE sha256` reescribe el ledger. Pasa a `DO NOTHING`. Y `fileHash` (Buffer) con `applyOne` (string) se unifican en una función; hoy coinciden porque todos los `.sql` son UTF-8 válido (verificado).

### Cómo se resuelve una deriva preexistente: manifiesto versionado

El AC5 exige dejarla «resuelta» y hoy no hay cómo:

| Vía | Por qué no |
|---|---|
| Restaurar los bytes aplicados | Revive el fallo que motivó la edición: 0045 volvería a morir con `role "postgres" does not exist` en BD limpia |
| Migración `UPDATE` del ledger | Imposible: el control corre antes de aplicar, y aborta primero |
| `--allow-drift` fijo en `flit-gitops` | Apaga el control por completo |
| `UPDATE` manual en cada ambiente | Escritura a mano en PDN, sin rastro en el repo |

**Decisión:** `apps/api/src/db/migrations/derivas-aceptadas.json`, ya incluido en la imagen por el `COPY` del directorio y fuera del runner, que solo lista `.sql`:

```json
[{ "archivo": "0045_….sql", "shaLedger": "…", "shaDisco": "…", "motivo": "…", "wi": "#…" }]
```

Acepta **el par exacto**: otra edición cambia `shaDisco` y vuelve a abortar. Para una huérfana, `shaDisco: null`. Un archivo puede tener varias entradas si los ambientes difieren. El ledger no se toca. Requiere «sí» humano: **pregunta H1**.

### B. Huérfanas: todas abortan; cambia el mensaje

| Caso | Riesgo real | Sin bandera | Acción que indica el mensaje |
|---|---|---|---|
| **1.** Un pendiente tiene el mismo sha | **Se re-ejecutaría** bajo otro nombre | Aborta, `pista=sha:<pendiente>` (AC8) | Restaurar el nombre registrado |
| **2.** Sha ya registrado bajo otro nombre, y ese archivo existe | Ninguno futuro; ya corrió, quizá dos veces | Aborta, `pista=registrada:<nombre>` | Comprobar que el doble efecto fue inocuo; añadir al manifiesto con `shaDisco: null` |
| **3.** Un pendiente tiene el mismo nombre sin número y otro sha | **Se re-ejecutaría** con cambios | Aborta, `pista=nombre:<pendiente>` | Igual que 1, revisando el diff |
| **4.** Sin rastro | Migración retirada | Aborta, `pista=ninguna` | Investigar; manifiesto si procede |

**¿El caso 2 es deriva? Sí.** El AC8 no lo exime y eximirlo tampoco sería seguro: un sha duplicado prueba que el contenido corrió bajo dos nombres, no que hacerlo fuera inocuo. Decidido sin pregunta.

**El caso 3 es una pista adicional al AC8, que no lo debilita.** Solo con el sha, la pista habría fallado en 11 de las 12 renumeraciones reales.

**El AC no alcanza a decidir:** con `--allow-drift` en los casos 1 y 3, el renombrado se re-ejecuta: **pregunta H2**.

### C. Check de CI (AC7)

- **Dónde:** `scripts/check-migraciones-inmutables.mjs` + su `.test.mjs` (`node --test`), como un paso del job `naming`. Ese job ya es check obligatorio, corre solo en PRs y hace `fetch-depth: 0`. Un job nuevo exigiría cambiar la protección de rama.
- **Contra qué:** `git diff --name-status --no-renames origin/develop...HEAD`, limitado a `apps/api/src/db/migrations/*.sql` del primer nivel. En PR, `HEAD` es el merge con la punta de `develop`, así que «existente en develop» es exacto. Solo con base `develop`; en promociones no aplica. Falla con `M`, `D` o `T`, y `--no-renames` convierte un rename en `D`. Nombra cada archivo.
- **Interpretación declarada:** se excluyen `README.md`, `meta/` y el manifiesto; si no, este mismo Feature se pondría en rojo.

**Convivencia con la regla 6: no hay conflicto para la renumeración.** Un archivo que no está en `develop` no se ha aplicado en ningún ambiente, y en la rama aparece como `A`: pasa. Las dos renumeraciones reales habrían pasado.

**Sí hay conflicto real en un caso.** `develop` despliega solo, así que entrar a `develop` equivale a aplicar en DEV, salvo que falle. Y una migración que falla (rollback, sin ledger) o que rompe la cadena en BD limpia solo se arregla editándola, porque una migración nueva nunca llegaría a correr. Cuatro de los cinco archivos editados sobre `develop` son este caso: 0182 (PR #310) y 0227 (PR #484) tumbaron el CD de DEV; 0045 y 0067 (PR #80) rompían la cadena en BD limpia. El AC7 sin válvula bloquearía ese arreglo, y también un `git revert` del PR.

**Propuesta:** el check pasa si el mismo PR añade al manifiesto una entrada con motivo cuyo `shaDisco` coincide con el archivo en `HEAD` (`null` si se borró). Una sola válvula para CI y runner: **pregunta H1**.

### Efecto en local (riesgo aceptado, a confirmar)

Tras PR 2, cambiar de rama con una migración aplicada deja una huérfana local, y el job `migrate` de `docker-compose.yml` abortará y dejará la API local abajo. Esta máquina ya está en ese caso. Sin cambiar código: el README documenta el `command` con `--allow-drift=<motivo>` en `docker-compose.override.yml` (ya es local y sin versionar).

---

## HU #14102 — Retiro de drizzle-kit

**Decisión:** el runner propio reemplaza a drizzle-kit porque el journal se quedó en `0004`: `generate` emitiría una migración recreando ~120 tablas y `migrate` aplicaría 5 de 64 (cifra histórica del README). Las migraciones son SQL a mano, con ledger propio y ahora con verificación de integridad. `drizzle-orm` (runtime) se queda.

### D. Qué se retira

| Elemento | Acción | Evidencia |
|---|---|---|
| `drizzle-kit` en `apps/api/package.json` y lockfile | **Quitar la dependencia** | Sin uso en runtime; `src/` no importa ningún `migrator`. Con ella se va `esbuild@0.19.12`; `tsx` trae su propio esbuild |
| `apps/api/drizzle.config.ts` | Borrar | Fuera del build (`include: src/**/*`) |
| `migrations/meta/` (6 archivos) | Borrar | Ningún test, script ni Dockerfile lo lee; el runner filtra `.sql`, así que ningún sha cambia |
| `db:generate` en `apps/api`; `db:generate` y `db:migrate` en la raíz | **Stub:** imprime el error, remite a este ADR y sale con 1 | La raíz `db:migrate` hoy delega en un script que no existe; se añade el stub en `apps/api` y la raíz sigue delegando |
| Entrada `apps/api/drizzle.config.ts` en `TOOLING_DE_APP` | Quitar | Referencia a un archivo que ya no existe |
| `push`, `check`, `introspect`, `studio` (AC4) | **Retirados.** Sin scripts ni config; la sección de `check` del README se elimina | El CI nunca los usó. Readoptarlos exige un ADR nuevo |

**Por qué quitar la dependencia y no solo los scripts.** Hoy `npx drizzle-kit migrate` falla por casualidad: `Cannot find module 'drizzle-orm/casing'`, porque `drizzle-orm` no está elevado a la raíz. Un cambio en el lockfile podría «arreglarlo» y revivir el peligro.

**Comprobado con la 0.26.2 contra una BD inalcanzable:** sin config, `migrate`, `generate` y `push` terminan con exit 1 sin conectar (`drizzle.config.json file does not exist`). **Comprobado al implementar, sin la dependencia:** sin TTY, `npx` descarga y ejecuta la última versión sin preguntar (0.31.11); sin config termina con exit 1 sin conectar, en un directorio vacío y con `DATABASE_URL` apuntando a una base temporal. Hace falta teclearlo a propósito y ningún proceso automatizado lo invoca. Si se pasan flags explícitos (`push --url …`) es un acto deliberado que ningún retiro impide; queda fuera del AC.

**AC3:** `build:api` con el árbol frío y `db:apply -- --dry`, antes y después, con `sha256sum` de los `.sql` idéntico.

---

## Archivos por bloque

Un solo `backend-agent`, en serie y un commit por bloque. No conviene paralelizar: son ~300 líneas y `README.md` es compartido.

**PR 1**

| Bloque | HU | Archivos |
|---|---|---|
| A. Runner | #13981 | `apps/api/src/scripts/db-apply.ts`, `apps/api/__tests__/scripts/db-apply.test.ts`, `apps/api/src/db/migrations/derivas-aceptadas.json` (`[]`), `apps/api/src/db/migrations/README.md` |
| B. CI | #13981 | `scripts/check-migraciones-inmutables.mjs`, `scripts/check-migraciones-inmutables.test.mjs`, `.github/workflows/ci.yml` |
| C. drizzle-kit | #14102 | `apps/api/package.json`, `package.json`, `package-lock.json`, `apps/api/drizzle.config.ts` (borrar), `apps/api/src/db/migrations/meta/*` (borrar), `scripts/check-naming.mjs`, `apps/api/src/db/migrations/README.md`, un test de AC2, `AGENTS.md` regla 6 (la mención al journal) |

**PR 2**

| Bloque | HU | Archivos |
|---|---|---|
| D. Activación | #13981 | `apps/api/src/scripts/db-apply.ts`, `apps/api/__tests__/scripts/db-apply.test.ts`, `apps/api/src/db/migrations/derivas-aceptadas.json`, `apps/api/src/db/migrations/README.md` |

**Notas operativas**

- Gates: `security-agent` aplica por `package*.json`. `db-review-agent` aplica por tocar `migrations/`, aunque ningún SQL cambia. `flit-ayuda-flito` y `ux-agent`: N/A (sin UI).
- Tras PR 1, HU #13981 sigue `Active`: el Modo B de PR 1 declara AC2, AC6 y AC8 como construidos sin activar. AC2, AC5, AC6 y AC8 se cierran con PR 2. AC1, AC3 y AC7 y toda la HU #14102 quedan cubiertos con PR 1; AC4 se completa con los tests de PR 2.

## Decisiones del humano (David Chica, 2026-11-04)

- **H1 — Manifiesto `derivas-aceptadas.json`: aprobado**, también como válvula de CI (AC7). Los AC no lo nombran: es alcance añadido y aprobado.
- **H2 — `--allow-drift` con un renombrado pendiente: literal al AC8**, con aviso expreso en el log que lo nombra. El archivo se re-ejecuta bajo su nuevo nombre.
- **H3 — Quién mide: Daniel Mejía** corre `--check-drift` en QA y PDN, y aprueba el pod efímero en PDN.
- **H4 — Fricción local: aceptada**, con el override documentado en el README.

## Consecuencias

Ninguna edición silenciosa de una migración aplicada vuelve a pasar. A cambio: dos PRs y una medición humana entre ambos; un archivo nuevo que revisar con cuidado, porque cada entrada es una excepción aprobada; y sin drizzle-kit no hay comparación automática entre `schema.ts` y la base (el CI tampoco la tenía).
