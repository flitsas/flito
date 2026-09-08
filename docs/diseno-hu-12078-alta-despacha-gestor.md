# Diseño slim — HU #12078: el alta del canal Cliente despacha al gestor por defecto de la compañía

**Feature** [#12074](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12074) · **HU** [#12078](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12078) (8 SP, orden 1 del Feature)
**Rama**: `HU/12078-davidchica-alta-despacha-gestor` · worktree `/home/david/flit/flito-hu12078`
**ADR**: **no aplica.** Se añade una columna a una tabla existente y se mueve el despacho de un endpoint a otro. No hay tabla nueva, ni módulo nuevo, ni contrato nuevo, ni integración externa. Los dos tradeoffs con filo —el `ON DELETE` y el CHECK— se resuelven aplicando ADRs ya escritos (0005 y 0008 §3) y el precedente de la migración `0168`, no abriendo uno.
**Decisión de producto (PO, 2026-09-05)**: el destino sale de un gestor por defecto **por compañía**. No se reabre aquí.

Este documento es el contrato. Los AC mandan sobre él.

---

## Contexto medido (verificado en este worktree, 2026-09-05)

| Hecho | Dónde |
|---|---|
| El alta inserta `PENDIENTE_REVISION` y no toca destino | `flito-soat-cliente.service.ts:797`, `:875` |
| `canalDeLaCompania()` ya lee `clients` **fuera** de la transacción (solo el flag y la carpeta) | `flito-soat-cliente.service.ts:266-283` |
| `enviarAlGestor()` es quien hoy pone `estado`, `enviado_por_id`, `enviado_en` y el destino | `flito-soat.service.ts:1191-1249` |
| `validarSolicitud()` reusa esa función con `estadoOrigen: 'pendiente_revision'` | `flito-soat-cliente.service.ts:1110-1150` |
| `clients` no tiene ninguna columna de proveedor SOAT | `schema.ts:110-181` |
| `users.flito_proveedor_soat_id` **no tiene cláusula `ON DELETE`** | `schema.ts:81` |
| El flag `soat_sin_tramite` nació en la `0167`; el CHECK del rol cliente, en la `0168` | `migrations/0167:117`, `migrations/0168` |
| `PATCH /flito/parametrizacion/companias/:id` **no lee la fila previa**: el 404 sale del `returning()` | `flito-parametrizacion.routes.ts:82-113` |
| No existe `DELETE /proveedores-soat`: solo `GET`, `POST` y `PATCH` (que apaga con `activo`) | `flito-parametrizacion.routes.ts:127,139,167` |
| `ESTADOS_SOAT_VISIBLES_GESTOR = ['solicitado','pagado']` — **AC5 no necesita código** | `shared-types/src/flito-estados.ts:197` |
| Convención de `tx`: `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]` (10 módulos) | `flito-impuestos.service.ts:24` y vecinos |
| Siguiente migración libre | `0175` (la última es `0174`) |
| El seed sigue insertando en `flito_reglas_proveedor_soat`; **ningún servicio la consulta** | `scripts/flito-seed.ts:92`; grep sin lectores |

---

## Delta de diseño en una frase

`crearSolicitud` deja de insertar `pendiente_revision` y pasa a insertar `solicitado` **con el destino ya escrito en el mismo INSERT**; el destino sale de una columna nueva de `clients` resuelta dentro de la transacción por una función propia del canal Cliente. Nada del SOAT por trámite se toca.

---

## Decisión 1 — La columna en `clients`

```ts
// schema.ts, dentro de `clients`, INMEDIATAMENTE debajo de `soatSinTramite` (línea 136).
// Vecindad deliberada: las dos son el mismo hecho partido en dos columnas —«el canal está abierto» y
// «hacia dónde»— y el CHECK de la decisión 2 las ata. Separarlas invita a leer una sin la otra.
flitoProveedorSoatSinTramiteId: uuid('flito_proveedor_soat_sin_tramite_id')
  .references(() => flitoProveedoresSoat.id, { onDelete: 'restrict' }),
```

**Nombre.** `flito_proveedor_soat_sin_tramite_id`, con el canal metido en el nombre. Dos motivos, y el segundo es el que importa: (a) el sufijo transporta el límite del AC2e —quien vea la columna en un `\d clients` sabe que el SOAT por trámite no la lee— y (b) `CLIENTS_COLUMNAS_SIN_PII` (`shared-types/src/siigo-terceros.ts:167`) **ya contiene la cadena `'flitoProveedorSoatId'`**, huérfana (esa columna vive en `users`, no en `clients`). Llamarla así habría hecho pasar el canario de PII en verde sin que nadie la clasificara. Ver trampa 5.

**Nulable.** Sí. Una compañía sin el canal abierto —que son casi todas— no tiene destino que declarar, y un `NOT NULL` obligaría a inventarle un gestor a cada una. La obligatoriedad es **condicional al flag**, exactamente como `users.compania_id` es condicional al rol; la sostiene el CHECK de la decisión 2.

**`ON DELETE RESTRICT`, explícito.** ADR-0005 regla 1: nunca se omite la cláusula, `NO ACTION` por omisión es «`RESTRICT` disfrazado de descuido». Y `SET NULL` está descartado por el mismo argumento literal que ya usa `users.compania_id` (ADR-0008 §3): crearía por la puerta de atrás el estado que el AC2c declara imposible —canal encendido, destino vacío— y lo haría en silencio, sin que ninguna consulta lo delatara. Borrar un proveedor que es el destino por defecto de una compañía debe fallar con un error nombrado y obligar a reasignar.

**El hueco de la `0173` se cierra aquí y solo aquí.** `users.flito_proveedor_soat_id` sigue sin cláusula y **no se toca en esta HU**: cambiar el `ON DELETE` de una FK existente es `DROP CONSTRAINT` + `ADD CONSTRAINT` con `ACCESS EXCLUSIVE` sobre `users` (ADR-0005, «Consecuencias»), que es una parada por algo que hoy no se ejecuta nunca y que no pide ningún AC. Queda anotado como deuda, no como alcance.

**Sin índice sobre la columna nueva, y es deliberado.** El precedente (`idx_users_compania`, `idx_flito_gestor_organismos_organismo`) añade índice para que el `RESTRICT` no escanee la tabla entera al borrar. Aquí la tabla referenciante es `clients` —cientos de filas, no millones— y **no existe endpoint de borrado de proveedores**: el escaneo cuesta menos que el índice. La lectura del resolutor filtra por `clients.id`, que es la PK. Si algún día nace `DELETE /proveedores-soat`, el índice entra con él.

**`COMMENT ON COLUMN`** obligatorio (AC2b), y tiene que decir tres cosas: que es **solo** del canal sin trámite, que el SOAT por trámite elige gestor en cada envío (`POST /flito/soat/enviar`), y que un gestor inactivo no rompe el alta sino que la manda a contingencia.

---

## Decisión 2 — La invariante «flag encendido ⇒ gestor configurado»: Zod **y** CHECK

```sql
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_sin_tramite_gestor_chk;
ALTER TABLE clients ADD CONSTRAINT clients_sin_tramite_gestor_chk
  CHECK (soat_sin_tramite = false OR flito_proveedor_soat_sin_tramite_id IS NOT NULL);
```

**Por qué también en la base, en tres líneas.** (1) El `PATCH` es *leer y luego escribir*: dos peticiones concurrentes —una que enciende el flag, otra que quita el gestor— pasan las dos por Zod y confirman entre las dos el estado ilegal; el CHECK es la única capa que ve las dos escrituras. (2) La ruta no es el único escritor: `scripts/flito-seed.ts` y un `psql` de soporte escriben `clients` sin pasar por ella, que es el argumento textual de la `0168`. (3) La forma del predicado es la misma implicación material de `users_cliente_compania_chk` y no dice nada de la dirección contraria: apagar el flag **no** obliga a quitar el gestor, se conserva por si se vuelve a encender (AC2c).

Es la capa 2 de tres, igual que allí: Zod en la ruta (que puede explicar el porqué), este CHECK (que sigue siendo cierto cuando la escritura no viene de la ruta) y el resolutor de la decisión 3, cuyo fallo por defecto es la contingencia y nunca un alta caída.

**Lo que la `0168` podía dar por hecho y esta migración no.** Allí no había ni una fila `cliente` cuando el CHECK entró. Aquí puede haber compañías con `soat_sin_tramite = true` desde el Feature #11912, y ninguna tiene gestor porque la columna acaba de nacer. Por tanto la `0175` va en este orden y **sin `NOT VALID`**:

1. `ADD COLUMN IF NOT EXISTS` + `COMMENT ON COLUMN`.
2. `UPDATE clients SET soat_sin_tramite = false WHERE soat_sin_tramite = true AND flito_proveedor_soat_sin_tramite_id IS NULL`, precedido de un `DO $$ … RAISE NOTICE $$` con **los ids** de las compañías afectadas (sin nombre: el id basta para reconfigurarlas y no es dato personal — mismo criterio que los `NOTICE` de la `0173`). Se leen en el log del CD.
3. `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, ya sobre datos limpios.

`NOT VALID` queda descartado por escrito: dejaría vivas exactamente las filas que la constraint existe para impedir, y el AC2c dice «no puede existir», no «no puede crearse a partir de ahora».

**Consecuencia operativa que hay que anunciar, no esconder:** en el entorno donde haya una compañía con el canal abierto, el merge la deja con el canal **cerrado** hasta que Operaciones le configure un gestor, y sus usuarios `cliente` recibirán el `403 CANAL_DESACTIVADO` que ya existe. Se puede reconfigurar por API el mismo día (el `PATCH` de la decisión 5 acepta el campo desde este PR); la pantalla llega con la HU 2. Ver «Pendiente humano».

---

## Decisión 3 — Dónde vive la resolución del destino

**Archivo:** `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts`, **exportada**. No en `flito-soat.service.ts`, y esa es la decisión: aquel archivo es el del SOAT por trámite y el que exporta `enviarAlGestor()`. Poner ahí el resolutor lo deja a un `import` de distancia de la ruta que el AC2e declara intocable. **La frontera de archivo es la garantía estructural del AC2e**; el test nombrado es la segunda capa, no la primera.

```ts
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];   // la convención de 10 módulos

export interface DestinoCanalCliente {
  proveedorSoatId: string | null;
  gestionOperaciones: boolean;
  /** El literal que va a `flito_estado_historial.motivo`. Nunca vacío. */
  motivoHistorial: string;
  /** Solo en contingencia: lo que verá Operaciones en su bandeja. `null` en el camino feliz. */
  contingenciaMotivo: string | null;
}

export async function resolverDestinoCanalCliente(
  tx: Tx, companiaId: number,
): Promise<DestinoCanalCliente>;
```

**Una sola consulta, y `LEFT JOIN` no dos `select`** (AC2: «una compañía, un destino, una sola consulta»):

```
tx.select({ proveedorId: flitoProveedoresSoat.id, activo: flitoProveedoresSoat.activo })
  .from(clients)
  .leftJoin(flitoProveedoresSoat, eq(flitoProveedoresSoat.id, clients.flitoProveedorSoatSinTramiteId))
  .where(eq(clients.id, companiaId)).limit(1)
```

«Sin gestor» y «gestor inactivo» son el mismo desenlace (contingencia) y tienen que leerse en el **mismo instante**: partirlo en dos consultas abre una ventana en la que el proveedor se desactiva entre una y otra y el alta escribe un destino que ya no atiende. `flito_reglas_proveedor_soat` **no aparece**: sin ámbitos, sin prioridades, sin `PRIORIDAD_POR_AMBITO`.

**Punto de llamada:** dentro de `db.transaction` de `crearSolicitud` (`:786`), después de `upsertVehiculoRunt` y **antes** de `tx.insert(flitoSoat)` (`:792`), para que el destino entre en el **mismo INSERT** que el estado. Es el argumento ya escrito para `procedencia` en `flitoCompradores` (`:838`): escribirlo aparte —un `UPDATE` después— deja una ventana en la que la fila está `solicitado` y no dice a dónde va, más una segunda escritura que puede fallar sola.

**`canalDeLaCompania()` no se amplía.** Sigue leyendo el flag y la carpeta fuera de la transacción; el gestor se relee dentro. Es la misma duplicación deliberada que ya practica el alta con `verificarRn01` (paso 3 barato fuera, paso 6 autoritativo dentro), y el AC2 pide explícitamente la lectura *dentro de la misma transacción*.

---

## Decisión 4 — La contingencia por gestor inactivo (AC2d)

**Dónde se comprueba `activo`:** en el `LEFT JOIN` de arriba, en la misma fila. El predicado de contingencia es uno solo: `fila.proveedorId === null || fila.activo !== true`. No hay un segundo `if` en `crearSolicitud`: el alta recibe un `DestinoCanalCliente` ya decidido y lo esparce en el `values()`.

Lo que escribe cada rama en el **mismo** `tx.insert(flitoSoat)`:

| Campo | Camino feliz | Contingencia |
|---|---|---|
| `estado` | `SOLICITADO` | `SOLICITADO` |
| `enviadoPorId` / `enviadoEn` | `ctx.userId` / `ahora` | igual |
| `proveedorSoatId` | el gestor de la compañía | `null` |
| `proveedorSobrescrito` | `false` | `false` |
| `gestionOperaciones` | `false` | `true` |
| `gestionOperacionesMotivo` | `null` | el literal de abajo |
| `gestionOperacionesEn` | `null` | `ahora` |
| `gestionOperacionesPorId` | `null` | **`null`** |

`proveedorSobrescrito: false` (a diferencia de `enviarAlGestor`, que pone `true`): esa bandera significa «una persona eligió este proveedor a mano», y aquí no eligió nadie — lo dijo la configuración.

**`gestionOperacionesPorId` queda en `null`, a propósito.** Las otras dos escrituras de esa columna (`asumirEnOperaciones`, `flito-soat.service.ts:1423`, y su gemela de impuestos) ponen el usuario porque **una persona** decidió el traspaso. Aquí lo decidió una configuración rota; poner el id del cliente que radica afirmaría que él pidió la contingencia, que es falso, y es exactamente la clase de fila que la regla 2 del ADR-0005 llama «un acto sin actor, indistinguible de un error de escritura». El quién y el cuándo del alta están en `enviado_por_id` y en la fila de historial.

**Constancia en el historial.** Un solo `registrarCambio` en los dos caminos, con `estadoAnterior: null`, `estadoNuevo: 'solicitado'`, `origen: 'usuario'` y el motivo cambiando. Los dos literales se exportan como constantes del servicio para que los tests los nombren en vez de copiarlos:

```ts
export const MOTIVO_ENVIO_DIRECTO = 'Envío directo al gestor (canal Cliente)';           // AC1, literal exacto
export const MOTIVO_ENVIO_CONTINGENCIA =
  'Envío directo al gestor (canal Cliente): el gestor por defecto de la compañía no está disponible, la asume Operaciones';
export const MOTIVO_GESTION_OPERACIONES_ALTA =
  'El gestor por defecto de la compañía no estaba disponible al radicar (canal Cliente).';  // → gestion_operaciones_motivo
```

Forma calcada de los motivos que ya existen (`'Envío al gestor'`, `'Solicitud validada: pasa al gestor'`, `` `Rechazo: ${motivo}` ``): frase corta, prefijo + detalle tras dos puntos. **Sin el uuid del proveedor en el motivo del historial**, por la razón que `asumirEnOperaciones` ya dejó escrita (le quitó el uuid a propósito): el historial es de lo poco que un lector externo llega a ver. El uuid del destino sí va al `audit_logs` del AC7, que el cliente no ve.

---

## Decisión 5 — El endpoint que edita la compañía

**Es `PATCH /api/flito/parametrizacion/companias/:id`** (`flito-parametrizacion.routes.ts:82`, montado en `app.ts:242`), rol `ESCRITURA = requireRole('admin')`. Es el que ya escribe `soatSinTramite` y el que `Clients.tsx:152` llama desde la casilla. **No** `PATCH /api/clients/:id`, que es la ficha comercial y cuyo `createSchema` no toca parametrización.

**Esquema Zod que valida hoy:** `actualizarCompaniaSchema` (`:72`), siete campos, todos `.optional()`, sin `refine` ni `superRefine`. Delta:

```ts
// nombre del cuerpo sin el prefijo `flito`, como `carpetaStorage` ↔ `flitoCarpetaStorage`
proveedorSoatSinTramiteId: z.string().uuid().nullable().optional(),
```

**Cómo entra sin romper lo que ya acepta** —cuatro cambios en el handler, en este orden:

1. **Leer la fila previa antes de construir el `set`.** Hoy no se lee y el 404 sale del `returning()`. Sin el estado previo no se puede validar el estado **resultante** cuando el `PATCH` trae solo una de las dos cosas —y encender el flag a secas es el caso normal. Es el gesto que `clients.routes.ts:255` ya hace para `incoherenciasFiscales`. El 404 se adelanta a esa lectura.
2. **Si viene un uuid**, tiene que existir en `flito_proveedores_soat` **y** tener `activo = true` → si no, `400` (AC2b). El criterio es el que la revisión ya fijó para la causal de rechazo: «válida incluye vigente»; aceptar un proveedor apagado, cuando la pantalla ya no lo ofrece, convierte el catálogo en una lista de sugerencias. `null` explícito sí se acepta: es cómo se desconfigura el destino (con el flag apagado).
3. **Sobre el estado resultante** (`cambios.x ?? previo.x`, las dos claves): si `soatSinTramite === true` y el gestor resultante es `null` → `400` diciendo qué falta (AC2c). Y **ninguna rama escribe `null` en el gestor colgada del `if` del flag**: apagar el canal conserva el gestor. Es literalmente lo que el comentario de la línea 91 ya prohíbe entre banderas.
4. **Traducir `23514`** (violación del CHECK) a `400` en este handler. Con las guardas 2 y 3 no debería llegar; la carrera de dos `PATCH` concurrentes sí puede, y es justo el caso que motiva el CHECK. Sin la traducción sale como 500.

`companiaDto` (`:48`) expone `proveedorSoatSinTramiteId` para que la pantalla pueda pintarlo.

**Lo que este HU deja fuera y la HU 2 recoge:** el selector en `Clients.tsx`. Consecuencia de secuenciación, que el `backend-agent` no ve: la casilla «SOAT sin trámite» (`Clients.tsx:243`) llama a este `PATCH` con un solo campo, así que **desde el merge de esta HU encenderla devuelve 400 hasta que exista el selector**. El mensaje del 400 tiene que decir exactamente qué configurar, porque durante esa ventana es lo único que el usuario verá. Si la HU 2 decide leer el gestor por `GET /clients` —como ya hace con la casilla, porque `financiera` ve esa pantalla y no entra a parametrización—, entonces habrá que añadir la columna a `COLUMNAS_LISTADO` y clasificarla en `COLUMNAS_IMPERSONALES` (`clients.pii.ts`); **eso es decisión de la HU 2**, no de esta, y se anota aquí para que no se cuele por descuido en la 1.

---

## Decisión 6 — Las trampas que hay que vigilar

1. **`POST /api/clients` y `PATCH /api/clients/:id` devuelven la fila ENTERA.** `res.status(201).json(client)` (`clients.routes.ts:244`) y `res.json(updated)` (`:301`), los dos desde un `.returning()` sin proyección. **La columna nueva viaja en las dos respuestas sin que nadie la haya pedido** — el mismo patrón que mordió en la HU #12093 con `flito_compradores`. No es PII (es el uuid de un proveedor), así que no es incidente de Habeas Data, pero sí es contrato accidental: quien la vea ahí creerá que se escribe por esa ruta, y `createSchema` no la acepta. **Decisión: no se convierten esas dos respuestas en proyección dentro de esta HU** (tocaría el módulo `clients` entero y sus consumidores), pero el `backend-agent` tiene que dejarlo anotado en el PR y el test de contrato del alta no debe apoyarse en ese campo.
2. **`db.select().from(clients)` sin proyección, los tres que hay:** `flito-parametrizacion.routes.ts:68` (`GET /companias` → pasa por `companiaDto`, controlado; aquí la columna se añade **a propósito**), `flito-parametrizacion.service.ts:129` (`companiaPorNit()` → devuelve el `CompaniaRow` completo al sync, `flito-sync.service.ts:154`; no sale por HTTP, solo se anota) y `clients.routes.ts:255` (el `previo` del PATCH → alimenta `diffFiscal`, que itera listas cerradas de campos, así que la columna nueva no aparece en el `audit`).
3. **`GET /clients` NO la filtra sola:** usa la proyección `COLUMNAS_LISTADO` (`clients.pii.ts`), así que la columna nueva **no** sale por ahí salvo que alguien la añada. Es el efecto que esa proyección se escribió para tener. No añadirla en esta HU.
4. **El 201 del alta se le entrega entero al cliente.** `flito-soat-cliente.routes.ts:385` hace `res.status(201).json(creada)`. El AC7 obliga a que el `audit()` diga a qué destino fue, así que `crearSolicitud` tiene que **devolver** el destino… y con el `json(creada)` de hoy eso se lo cuenta al cliente **a qué gestor fue su solicitud**, cuando el AC1 dice `{ id, estado }`. **La ruta tiene que proyectar explícitamente** `{ id, estado }` y usar el resto solo para el `audit`.
5. **El canario de PII ya está contaminado.** `CLIENTS_COLUMNAS_SIN_PII` (`shared-types/src/siigo-terceros.ts:167`) contiene `'flitoProveedorSoatId'`, que **no es una columna de `clients`** (la que existe es `users.flito_proveedor_soat_id`). El test `privacy.routes.test.ts:471` solo comprueba que no **falte** ninguna columna, no que no **sobre** ninguna cadena. Hay que: añadir `'flitoProveedorSoatSinTramiteId'` y **borrar la entrada huérfana** en el mismo cambio. Si no se borra, queda una trampa cargada para la siguiente columna.
6. **Los mocks de test mienten en tres sitios que esta HU pisa** (todos ya documentados en el repo): el `chain` devuelve la fila entera aunque el `select` pidiera menos —así que «una sola consulta» se prueba **contando llamadas a `select`**, no leyendo el resultado—; `orderBy` es passthrough; y el stub de `transaction` es pelado en ~30 specs, así que los specs del alta necesitan que el `tx` del mock exponga `select` además de `insert`, o fallarán con un 500 que no es de producción.
7. **`flito_reglas_proveedor_soat` sigue viva y sembrada** por `scripts/flito-seed.ts:92`. El AC2 pide un test que fije por grep que la tabla no se consulta desde el camino del alta; **el seed no es un lector y no se toca** — su `DROP` sigue siendo una migración posterior, como dice el comentario de `flito-parametrizacion.routes.ts:333-336`.
8. **El gate de build:** `build:api` no typechequea `__tests__` (el `tsconfig` incluye solo `src/**/*`) y necesita `NODE_OPTIONS=--max-old-space-size=8192`, o muere por OOM y parece un fallo del código.

---

## Archivos a crear / modificar

**Crear**

| Archivo | Qué |
|---|---|
| `apps/api/src/db/migrations/0175_flito_soat_gestor_por_defecto_compania.sql` | Columna + `COMMENT ON COLUMN` + `NOTICE`/`UPDATE` de las compañías sin destino + `DROP IF EXISTS`/`ADD` del CHECK + `COMMENT ON CONSTRAINT`. Sin `BEGIN/COMMIT` (ADR-DB-001). |
| `apps/api/__tests__/services/flito-soat-migracion-0175-gestor-compania.test.ts` | Guarda de contrato estática, calcada de la suite de la `0174`: tipo y nulabilidad, `ON DELETE r`, forma del predicado del CHECK, ausencia de `NOT VALID`, idempotencia, paridad con `schema.ts` y que la `0174` no se reescribe. |
| `apps/api/__tests__/services/flito-soat.cliente-alta-destino.test.ts` | AC1, AC2, AC2d y AC7 del alta: estado `solicitado`, destino nunca vacío, literales de motivo, contingencia por inactivo y por ausente, `audit` con destino y sin PII, y el grep de `flito_reglas_proveedor_soat`. |
| `apps/api/__tests__/services/flito-parametrizacion.companias-gestor.test.ts` | AC2b y AC2c del `PATCH`: uuid inexistente → 400, proveedor inactivo → 400, encender el flag sin gestor → 400, apagar el flag conserva el gestor, `23514` → 400. |

**Modificar**

| Archivo | Qué |
|---|---|
| `apps/api/src/db/schema.ts` | La columna en `clients`, junto a `soatSinTramite` (`:136`), con su docblock. |
| `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` | `resolverDestinoCanalCliente()` + `DestinoCanalCliente` + los tres literales exportados; `crearSolicitud` inserta `SOLICITADO` con destino, `enviadoPorId`/`enviadoEn`, y `registrarCambio` con el motivo que toque; `SolicitudCreada` gana el destino para el `audit`. |
| `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` | El `audit()` del alta (`:381`) dice el destino; el 201 (`:385`) pasa a proyectar `{ id, estado }` explícitamente. |
| `apps/api/src/modules/flito-parametrizacion/flito-parametrizacion.routes.ts` | `companiaDto` (`:48`), `actualizarCompaniaSchema` (`:72`) y el handler del `PATCH` (`:82`) con los cuatro cambios de la decisión 5. |
| `packages/shared-types/src/siigo-terceros.ts` | Añadir `'flitoProveedorSoatSinTramiteId'` a `CLIENTS_COLUMNAS_SIN_PII` y **borrar** `'flitoProveedorSoatId'` (`:167`). |
| `apps/api/__tests__/services/flito-soat.cliente-alta.test.ts` y `…cliente-alta-runt-compuerta.test.ts` | Sus asertos sobre `pendiente_revision` en el alta dejan de ser ciertos; el `tx` del mock necesita `select`. |
| `apps/api/__tests__/services/flito-soat.revision-rechazo-subsanacion.test.ts` | Solo si algún caso construye la fila de partida vía el alta; la revisión en sí **no** se retira aquí (eso es la HU 3). |

**Que NO se tocan, y es parte del diseño:** `flito-soat.service.ts` (`enviarAlGestor`, AC2e), `POST /flito/soat/enviar`, `POST /flito/soat/cliente/:id/validar` (sigue existiendo hasta la HU 3), `shared-types/src/flito-estados.ts` (AC5 ya se cumple), `clients.pii.ts` y `apps/web` (HU 2).

---

## Notas operativas

**backend-agent.** El orden de implementación es migración → `schema.ts` → resolutor → alta → ruta de parametrización, y el test de paridad de la `0175` se escribe **antes** que el resolutor: es lo que fija el `ON DELETE` y el predicado del CHECK, que son las dos cosas que una revisión puede degradar sin que nada funcional se ponga rojo (ADR-0005, notas para `qa-agent`). El `db:apply` local exige superusuario y el rol `operaciones_app`, y la base real está en el **5434**, no en el 5433 del `.env`. P6 —aplicar el SQL dos veces— va en el HANDOFF, no en el test.

**frontend-agent.** Nada en esta HU. El selector, el copy del 400 y la lectura del campo son la HU 2 (orden 2 del Feature #12074), que ya tiene el catálogo de proveedores cargado en `Clients.tsx` (`FormProveedor`, `:487`).

**qa-agent.** Los tres mutantes que valen: (a) cambiar `RESTRICT` por `SET NULL` en la FK — todo sigue verde y la invariante se abre por detrás; (b) mover el `resolverDestinoCanalCliente` fuera de la transacción — el AC2 cae y ningún aserto funcional lo nota; (c) poner `ctx.userId` en `gestionOperacionesPorId` — la fila afirma que el cliente pidió la contingencia. Cada uno tiene que tumbar un test nombrado.

---

## Pendiente humano (antes del merge)

1. **El apagado del flag que hace la `0175`.** El merge a `develop` **es** el deploy en DEV y aplica migraciones: si hay una compañía con el canal abierto, queda cerrado hasta que Operaciones le configure gestor por API. Hay que confirmar con el PO/Operaciones que es aceptable, o coordinar el merge con la configuración inmediata. Los ids salen en el `NOTICE` del log del CD.
2. **El orden HU 1 → HU 2.** Entre el merge de esta y el de la HU 2, encender «SOAT sin trámite» desde `Clients.tsx` responde 400 sin forma de arreglarlo desde la pantalla. O van seguidas, o se acepta esa ventana por escrito.
