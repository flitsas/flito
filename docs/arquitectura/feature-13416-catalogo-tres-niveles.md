# Diseño slim — Feature #13416: catálogo de permisos nuevo y panel en tres niveles

Fase 3 de la Épica #13411. Fija el contrato de las 6 HUs: #12873, #13427, #13428 (BACKEND, catálogo
por área), #13429 (BACKEND, árbol y legacy), #13430 y #13431 (FRONTEND). Habla con los módulos
**FLITO** (`flito-*`) y con el motor `apps/api/src/modules/permisos/` + `apps/api/src/shared/permisos-*`;
los módulos legacy solo entran como ítems de nivel 2.

Tradeoff de modelo resuelto en **ADR-0025 (Propuesto)**:
`docs/adr/ADR-0025-arbol-de-permisos-acciones-que-expanden-operaciones.md`.

Fuente del catálogo: la propuesta de intake del 2026-10-07 21:30 («Propuesta de catálogo de permisos
(nivel 3)», aprobada «con sugerencias [+]») + las decisiones de la Discussion de #13411 y de la segunda
ronda. **El catálogo acción por acción NO está en la Discussion de la Épica** (solo el resumen de
decisiones); se leyó del transcript de la sesión de intake. Conviene que el hilo lo pegue en la
Discussion de #13416 como anexo (ver §7, P-0).

---

## 1. Patrón reutilizado

| Pieza | Se reutiliza | Delta |
|---|---|---|
| Catálogo código ↔ base | `modules/permisos/catalogo.ts` (`catalogoCompleto`, `CatalogoIncoherenteError`, `verificarCatalogoAlArrancar`) | emite nodos `menu.*` / `accion.*`; deja de emitir operaciones absorbidas |
| Nombres de operación | `catalogo-operaciones.ts` / `.legado.ts` (llave = guarda real) | **sin cambios**: las guardas siguen pidiendo operaciones |
| Agrupación | `catalogo-agrupacion.ts` | queda solo para operaciones aún concedibles; el árbol la sustituye por área |
| Resolver | `shared/permisos-efectivos.ts` `conjuntoEfectivo` (R ∪ C) \ V, caché 60 s | evaluación **por nodo** + gating de ancestros + expansión a operaciones |
| Anti-bloqueo | `shared/permisos-anti-bloqueo.ts` (`FUNCIONES_DE_ADMINISTRACION`, `conSeguroAntiBloqueo`) | evalúa sobre el conjunto **expandido** |
| Marcas | `permisos_rol_funcion`, `permisos_usuario_funcion` | sin tabla nueva; filas sobre cualquier nodo |
| Siembra con generador | patrón 0205 (`generar-seed-permisos.ts --reagrupar` + test que compara SQL ↔ TS) | `--arbol <area>` genera siembra y reparto |
| Reporte en seco | `scripts/permisos-reparto-en-seco.ts` + `modules/permisos/reparto-en-seco.ts` | modo `--hu <id>` que simula la regla «todos» del área |
| Panel | `apps/web/src/pages/roles-permisos/` (`CuadroRol`, `modulos.ts`) | `CuadroRol` pasa a árbol |

## 2. Modelo del árbol

### 2.1 Dónde vive

- **Estructura y nombres (lo que lee la web):** `packages/shared-types/src/permisos-arbol/` — un
  archivo por elemento/área (cada uno ≤800 líneas): `gestion.ts` (#12873), `finanzas.ts` (#13427),
  `administracion.ts` + `general.ts` + `perfil.ts` (#13428), `legado.ts` + `elementos.ts` (#13429),
  `index.ts` (ensambla `ARBOL_PERMISOS`).
- **Acción → operaciones (solo API):** `apps/api/src/modules/permisos/arbol/acciones-<area>.ts`
  (mismo corte por HU) + `arbol/expansion.ts` (puro: expande, valida, calcula efectivos).
- **Base:** `permisos_funciones` con 3 columnas nuevas (siembra generada desde lo anterior). La base es
  espejo; la comprobación de arranque la ata al código.

### 2.2 Nodos y códigos

| Nivel | `tipo` | Código | Ejemplo |
|---|---|---|---|
| 1 elemento | `elemento` | `menu.<elemento>` | `menu.gestion`, `menu.finanzas`, `menu.perfil` |
| 2 ítem | `pagina` (sin cambio) | `pagina.<slug>` existente | `pagina.flito_soat`, `pagina.pesv_tablero` |
| 3 acción | `accion` | `accion.<item>.<accion>` | `accion.soat.exportar` |
| 3 anidada | `accion` | idem, `padre_codigo` = acción madre | `accion.soat.exportar_pago` ← `accion.soat.exportar` |

`varchar(80)` alcanza. Las operaciones (`soat.cola.ver`…) **no son nodos**: son identificadores de guarda.
Elemento «Ayuda» **no se siembra** (Ayuda FLITO no tiene permiso: derivada de ≥1 capítulo visible); el
árbol de shared-types lo declara como `derivado: true` para que el panel lo pinte informativo y el menú
lo arme. `pagina.flito_ayuda` sigue en `PAGINAS_NO_CONCEDIBLES`.

### 2.3 Esquema (delta, #12873)

```sql
ALTER TABLE permisos_funciones ADD COLUMN IF NOT EXISTS padre_codigo varchar(80)
  REFERENCES permisos_funciones(codigo) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE permisos_funciones ADD COLUMN IF NOT EXISTS nivel smallint;   -- 1|2|3, null = operación aún concedible
ALTER TABLE permisos_funciones ADD COLUMN IF NOT EXISTS orden integer NOT NULL DEFAULT 0;
-- CHECK tipo IN ('pagina','operacion','elemento','accion') — revisar el CHECK vigente antes (si existe, DROP/ADD idempotente)
CREATE INDEX IF NOT EXISTS permisos_funciones_padre_idx ON permisos_funciones(padre_codigo);
```

`pagina.*` recibe `padre_codigo = menu.*` recién en #13429 (cuando existen los elementos). Drizzle:
`padreCodigo`, `nivel`, `orden` en `apps/api/src/db/schema/permisos.ts` (self-reference con
`AnyPgColumn`).

### 2.4 Permiso efectivo (resolver)

```
marcado(n)  = n ∈ (Rol ∪ Conceder) \ Revocar                 -- por nodo, cualquier nivel
efectivo(n) = marcado(n) ∧ efectivo(padre(n))                -- raíz: efectivo = marcado
operaciones = ⋃ ops(a)   para a acción efectiva
            ∪ ops(i)     para i ítem legacy efectivo         -- «ve y hace todo»
            ∪ {o}        para o operación aún concedible y marcada (áreas no migradas)
funciones   = nodos efectivos ∪ operaciones                  -- lo que ven exigirFuncion/hasFuncion
```

- Desmarcar un padre borra **solo su fila**: los hijos quedan marcados y no efectivos → al remarcar
  reaparecen (AC4/AC5 #13429).
- `pagina.<slug>` efectiva solo si `menu.*` efectivo → `hasPage` y el menú se apagan solos.
- `sinAcciones(i)` = ítem FLITO efectivo sin ninguna acción hija marcada.
- `version` (hash) se calcula sobre `funciones` expandido: la web detecta el cambio en ≤60 s igual que hoy.
- Implementación: `conjuntoEfectivo` delega en `arbol/expansion.ts` (puro, testeable sin base). El índice
  acción→ops se construye una vez al cargar el módulo. `filtrarPorFuncion` / `usuariosConFuncion` usan
  la misma función (hoy leen filas crudas: si no se cambian, las notificaciones verían el mundo viejo).
- **Coexistencia:** si un área aún no migró, sus operaciones siguen en `permisos_funciones` con
  `nivel NULL` y se conceden directo (rama 3 de la fórmula). Cada PR deja develop desplegable.

### 2.5 Compatibilidad

`exigirFuncion('soat.cola.ver')`, `requirePage`, `hasFuncion('soat.excel.exportar')`, `hasPage('flito_soat')`
no cambian: el conjunto efectivo sigue conteniendo esos códigos. Excepción nombrada de
`soat.solicitud.crear` (ADR-0024 / #12874): se mantiene en la guarda; la acción
`accion.soat.solicitar_sin_tramite` la expande. Test nuevo: ningún código de operación ni de guarda
empieza por `accion.`/`menu.`.

## 3. Contrato delta del API

| Método y ruta | Guarda | Cuerpo / respuesta | HU |
|---|---|---|---|
| `GET /api/permisos/arbol` | `permisos.catalogo.ver` | `{ arbol: NodoArbol[] }` sin marcas | #13429 |
| `GET /api/permisos/roles/:codigo/arbol` | `permisos.cuadro.ver` | `{ rol, arbol: NodoArbolRol[] }` | #13429 |
| `PUT /api/permisos/roles/:codigo/funciones` | `permisos.cuadro.guardar` | **sin cambio de forma**: `{ funciones: string[] }` = todos los nodos marcados (incluidos los ocultos), reemplazo completo; 400 `FuncionesInexistentes`, **409** `BloqueoAdministracion` (nada se guarda) | #13429 ajusta validación |
| `GET /api/permisos/usuarios/:id/arbol` | la misma que hoy lee las excepciones en `users.routes.ts` (HU #12087) | `{ userId, rol, arbol: NodoArbolUsuario[] }` | #13429 |
| Guardar excepciones | **reutilizar** el `PATCH /api/users/:id` `{ funciones: [{codigo, efecto}] }` (reemplazo completo) si ya corre `conSeguroAntiBloqueo`; si no, `PUT /api/permisos/usuarios/:id/excepciones` con 409 | #13429 |
| `GET /api/permisos/mios` | sesión | sin cambio de forma; `funciones` ya expandidas | #12873 |
| `GET /api/permisos/funciones` | `permisos.catalogo.ver` | se mantiene hasta #13430 (panel plano en la cadena); se retira con #13430 o queda deprecado | — |

`:id` es el id numérico interno (opaco, sin PII). Ninguna respuesta incluye nombre, cédula ni correo:
el panel de excepciones ya tiene al usuario cargado. Sin `logPiiAccess` nuevo.

### shared-types (`packages/shared-types/src/permisos-arbol/index.ts`)

```ts
export type TipoNodoPermiso = 'elemento' | 'item' | 'accion';
export interface NodoArbolDef {
  codigo: string; nombre: string; tipo: TipoNodoPermiso; padre: string | null; orden: number;
  slug?: PageSlug;          // ítems: la página que representan (menú y hasPage)
  legado?: boolean;         // ítem sin nivel 3
  derivado?: boolean;       // «Ayuda»: no se marca, se calcula
}
export interface NodoArbolRol extends NodoArbolDef { marcado: boolean; efectivo: boolean; sinAcciones: boolean; hijos: NodoArbolRol[] }
export interface NodoArbolUsuario extends Omit<NodoArbolRol, 'hijos'> {
  heredado: boolean; excepcion: 'conceder' | 'revocar' | null; hijos: NodoArbolUsuario[];
}
export const ARBOL_PERMISOS: readonly NodoArbolDef[];
export const PREFIJO_ACCION = 'accion.'; export const PREFIJO_ELEMENTO = 'menu.';
```

Cambiar estos tipos exige `grep` en `apps/web` (regla 7). `PAGE_GROUPS` sigue vivo para lo que no esté en
el árbol; #13431 hace que el menú lea `ARBOL_PERMISOS`.

## 4. Migraciones y orden de la cadena

Numeración tentativa (se reasigna al **siguiente libre en el rebase** previo a cada PR; hay otras
sesiones migrando):

| HU | Siembra | Reparto | Qué |
|---|---|---|---|
| #12873 | 0232 | 0233 | columnas del árbol; `accion.*` de Gestión Trámites, SOAT, Impuestos, Logística, Mi ruta, Derechos, Comparendos, Organismos STT, Revisiones OCR; retira operaciones absorbidas y `pagina.flito_compuerta` |
| #13427 | 0234 | 0235 | Finanzas (+ Integración Siigo, ver P-3); retira operaciones `liquidacion.*`, `bolsas.*`, `conciliacion.*`, `comprobantes.*`, `parametrizacion.tarifas.*`, `*.servicios_adicionales.*`, `siigo.*`, `finanzas.*` y el transitorio `siigo.parametrizacion.administrar`, `liquidacion.pago_manual.administrar` |
| #13428 | 0236 | 0237 | Usuarios, Roles y permisos, Bitácora, Clientes y proveedores, Tablero, Perfil; operaciones nuevas de Perfil + guardas en sus rutas; retira `clients.clientes.administrar` |
| #13429 | 0238 | 0239 | `menu.*` + `padre_codigo` de cada `pagina.*`; legacy a nivel 2; retira los transitorios restantes y las operaciones legacy concedibles |
| #13430, #13431 | — | — | solo web (si #13431 necesita sembrar una página, migración de siembra propia) |

Orden: **#12873 → #13427 → #13428 → #13429 → (#13430 ∥ #13431)**, cadena apilada. #13427/#13428 no
dependen entre sí en código, pero se serializan por numeración y por `catalogo.ts`.

### 4.1 Forma de cada par de migraciones (generado, no tecleado)

Generador: `npm run permisos:seed -w apps/api -- --arbol <area>` (extender `generar-seed-permisos.ts`)
emite ambos SQL desde `permisos-arbol/<area>.ts` + `arbol/acciones-<area>.ts`. Un test compara el SQL en
disco con la salida del generador (patrón 0205).

**Siembra** (idempotente): `INSERT … ON CONFLICT (codigo) DO UPDATE SET nombre_negocio, descripcion,
modulo, padre_codigo, nivel, orden` — padres antes que hijos.

**Reparto** (idempotente, transaccional, en este orden):

1. Roles — por acción A con predecesores P (|P| = k):
   ```sql
   INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
   SELECT rf.rol_codigo, 'accion.soat.ver_listado' FROM permisos_rol_funcion rf
   WHERE rf.funcion_codigo IN ('soat.cola.ver','soat.cola.filtrar', …)
   GROUP BY rf.rol_codigo HAVING count(DISTINCT rf.funcion_codigo) = k
   ON CONFLICT DO NOTHING;
   ```
2. Usuarios — CTE `viejo(user_id, codigo)` = (rol ∪ conceder) \ revocar sobre los predecesores;
   `conceder A` si el usuario tiene todos P y su rol (ya repartido) no tiene A; `revocar A` si su rol
   tiene A y al usuario le falta alguno de P. Así cada persona queda con exactamente la regla «todos»
   sobre **su** conjunto efectivo (AC5 #12873).
3. Borrar marcas de las operaciones absorbidas (`permisos_rol_funcion`, `permisos_usuario_funcion`).
4. Borrar las operaciones absorbidas de `permisos_funciones`.
5. Fila en `permisos_auditoria` por lote con `origen = 'migracion'` (si el CHECK lo admite; si no, Nota).

Segunda corrida: los predecesores ya no existen → 1–4 no tocan filas (AC9/AC10).

**Sin literales de rol:** prohibido `VALUES ('admin', …)` y `WHERE rol_codigo = '<x>'`. Todo `INSERT …
SELECT` desde filas existentes (un rol ausente = 0 filas, nunca FK rota). Test de migración: el SQL no
contiene ningún `USER_ROLES` entre comillas. Admin recibe todo **por la regla «todos»** (tiene todos los
predecesores); nodos sin predecesor declaran uno:
- `menu.<x>` ← cualquier `pagina.*` hija marcada (OR, no «todos»: es contenedor, no agrupa permisos).
- Perfil (`accion.perfil.*`) ← `pagina.perfil` (hoy solo la tiene quien recibió la 0218).
- Tablero ← `pagina.dashboard`.
- `pagina.*` nuevas de ítems que hoy no tienen página (P-4) ← unión de sus operaciones.

El reporte en seco **verifica** «el rol que tenía todo el catálogo tiene todo el catálogo nuevo» (AC8
#12873, AC7 #13427/#13428) en vez de codificarlo.

### 4.2 Reporte en seco por HU

`npm run permisos:en-seco -w apps/api -- --hu <id>` reusa `repartoEnSeco` con la propuesta del área
(acción → predecesores) y lista por rol y por usuario: ganancias, pérdidas (grupos parciales) y, en
#13429, las ganancias de administración legacy (decisión del PO). Se corre contra una copia de DEV y se
pega en la Discussion de la HU **antes del PR**; la salida no se commitea (ADR-0023).

### 4.3 Coexistencia viejo ↔ nuevo

- Tras #12873: Gestión/Tránsito por acciones; el resto por operaciones directas. El panel actual
  (`GET /funciones` + `CuadroRol` plano) sigue funcionando: las acciones llegan como funciones con
  `modulo` = clave de su ítem y `nombreNegocio` = nombre de pantalla.
- Gating de ancestros (elemento/ítem/acción madre) entra **solo en #13429**. Antes, la expansión es
  plana (acción marcada ⇒ sus operaciones), para que cada HU de catálogo cambie una sola cosa y su
  reporte en seco mida solo el reagrupamiento. #13429 tiene su propio reporte (pérdidas por gating:
  p. ej. `exportar_pago` sin `exportar`, acción sin su página).
- Cada PR lleva código + migración; el CD de DEV aplica migraciones antes de la API. PDN: `db:apply`
  manual con `pg_dump` previo (AGENTS §6). **Promover las 4 HUs backend juntas** a staging/release.

## 5. Mapeo operación vieja → acción nueva (#12873)

Método: el mapeo se escribe en `arbol/acciones-gestion.ts`; el test AC6 lo valida en doble sentido
contra `OPERACIONES_DECLARADAS` filtradas por los ficheros/módulos del área: (a) toda operación del
área está en ≥1 acción (o declarada `apoyo` o `fueraDeArea` con el ítem destino); (b) toda acción tiene
≥1 operación viva; (c) ninguna operación referida es inexistente. «Exactamente» = el conjunto de la
acción es el declarado, y el test de rutas (supertest) hace un muestreo 200/403 por acción. Abajo,
borrador a validar por el test (las marcadas **?** son las preguntas de §7):

| Ítem (`pagina.*`) | Acción (`accion.<item>.*`) | Operaciones |
|---|---|---|
| Gestión Trámites (`flito_tramites`) | `ver_listado` | `tramites.cola.ver`, `.cola.filtrar`, `tramites.tramite.ver_historial` |
| | `solicitar_soat` / `solicitar_impuestos` | `tramites.solicitud.pedir_soat` / `.pedir_impuestos` · `pedir_ambos` exige las dos (doble guarda en la ruta, se retira la op) |
| | `ver_factura` | **?** (ninguna op `tramites.*` de factura; candidatas `soat.factura.leer`/`impuestos.factura.ver`) |
| | `descargar_soportes` | `tramites.soportes.descargar`, `tramites.tramite.ver_soportes` |
| | `sincronizar` | `sync.sync.lanzar`, `sync.sync.ver_estado` |
| | `configurar_sincronizacion` | `tramites.sincronizacion.configurar`, `tramites.flit2.ver_acceso`, `.flit2.guardar_acceso` |
| | `crear_demo` | `tramites.demo.sembrar` |
| | `entregar` | `tramites.tramite.entregar`, `compuerta.cola.ver`, `compuerta.tramite.ver`, `compuerta.tramite.entregar` |
| | *fuera de área → Clientes (#13428)* | `tramites.autogestion.desbloquear/revocar`, `tramites.empresa.crear` |
| SOAT (`flito_soat`) | `ver_listado` | `soat.cola.ver`, `.cola.filtrar`, `soat.solicitud.ver`, `.ver_historial`, `soat.causales.ver` |
| | `ver_soportes` | `soat.solicitud.ver_soportes` |
| | `cargar_comprobantes` | `soat.comprobante.cargar`, `soat.masiva.cargar` |
| | `exportar` → hija `exportar_pago` | `soat.excel.exportar` → `soat.excel.exportar_pago` |
| | `cambiar_proveedor` | `soat.proveedor.cambiar` |
| | `solicitar_sin_tramite` | `soat.solicitud.crear` (2 rutas), `soat.runt.preconsultar`, `soat.factura.leer` **?** |
| | `gestionar_solicitudes` | `soat.solicitud.enviar/asumir/devolver/reactivar/reversar/rechazar`, `soat.solicitud.subsanar` **?** |
| | `ver_por_validar` | `soat.incompletas.buscar`, `soat.incompleta.ver`, `soat.solicitud.reintentar_runt`, `soat.revision.validar/rechazar` **?** |
| | `descargar_zip` | `soat.soportes.descargar` |
| | `ver_/cargar_/eliminar_documentos_adicionales` | `soat.documentos_adicionales.ver/.cargar/.eliminar` (1:1, AC7) |
| Impuestos (`flito_impuestos`) | `ver_listado` | `impuestos.cola.ver/.filtrar`, `impuestos.tramite.ver/.ver_historial`, `impuestos.factura.ver` **?** |
| | `ver_soportes` · `cargar_comprobantes` · `exportar`→`exportar_pago` · `descargar_zip` | `impuestos.tramite.ver_soportes` · `impuestos.recibos.cargar` · `impuestos.excel.exportar`→`.exportar_pago` · `impuestos.soportes.descargar` |
| | `gestionar_solicitudes` | `impuestos.tramite.enviar/asumir/devolver/reactivar/reversar/rechazar` |
| | `certificar_runt` | `impuestos.tramite.certificar`, `.certificar_lote` |
| | `cargar_recibo_caja` · `reemplazar_comprobante` · `corregir_direccion` · `descargar_certificado` | `impuestos.recibos.cargar_caja` · `.recibos.reemplazar` · `impuestos.tramite.corregir_direccion` · `impuestos.certificado.descargar` |
| Logística (`flito_logistica`) | `ver_consola` | `logistica.consola.ver/.filtrar`, `logistica.documento.ver` |
| | `registrar_viajes` | `logistica.viajes.registrar/.quitar/.ver` |
| | `generar_actas` | `logistica.lt.validar` **?** |
| | `ver_actas` | `logistica.actas.listar/.ver/.descargar` |
| | `despachar_entregar_devolver` | `logistica.actas.despachar/.entregar/.devolver` |
| | `cerrar_lote` · `reversar_paso` | `logistica.lote.cerrar` · `logistica.documento.reversar` |
| | — | `logistica.actas.operar_ajenas` **?** |
| Mi ruta (`flito_logistica_ruta`) | `ver` · `escanear` · `reportar_novedad` **?** | `logistica.ruta.ver` (+`documento.ver` apoyo) · `logistica.documento.escanear` · `.reportar_novedad` |
| Derechos (`flito_derechos`) | `ver_listado` | `derechos.cola.ver/.filtrar` |
| | `cargar` | `derechos.recibos.cargar`, `derechos.candidatos.ver` |
| | `procesar_drive` | `derechos.drive.listar/.procesar/.ver_registro` |
| | `ver_soportes` | `derechos.soporte.descargar` |
| Comparendos (`flito_comparendos`) | `ver_listado` (incluye exportar) | `comparendos.registros.listar/.buscar/.exportar`, `comparendos.registro.ver/.ver_eventos` |
| | `gestionar` · `sincronizar` | `comparendos.registro.gestionar` · `comparendos.sync.lanzar/.ver_corrida/.ver_corridas` |
| | `configurar` | `comparendos.nits.*`, `.municipios.*`, `.causales.*`, `.simit.*` (12) |
| Organismos STT (`transito_organismos`) | `ver` | `parametrizacion.organismos.listar/.ver_vigencias`, `transito.config.listar/.ver`, `transito.logo.ver`, `transito.checklist.ver` |
| | `editar` | `parametrizacion.organismos.editar/.fijar_modalidad`, `transito.config.editar`, `transito.logo.cargar/.borrar`, `transito.checklist.editar` |
| Revisiones OCR (`flito_revisiones`) | **?** 3 acciones por concepto vs 1 | `revisiones.cola.ver`, `.campos.ver`, `.revision.resolver/.descartar`, `.soporte.descargar` |

**Apoyo** (en ≥1 acción, nunca predecesor, no visibles en el panel): `transito.organismos.listar`,
`parametrizacion.companias.listar`, `parametrizacion.proveedores.listar` y las que el test detecte como
compartidas. **No son de #12873:** `transito.bandeja.*`, `transito.tramite.tomar`, `transito.placa.*`,
`transito.traspasos.*` (Bandeja de trámites, legacy → #13429) y `tramite.*` (Trámite Digital → #13429).

`predecesores` por defecto = operaciones no-de-apoyo de la acción. Ojo: con «todos», un rol al que hoy le
falte `soat.causales.ver` **pierde «Ver listado»** entero. Es la regla aprobada; el reporte lo mostrará y
el PO decide (P-1).

## 5-bis. Finanzas e Integración con Siigo (HU #13427)

Mismo método que el §5: el mapeo va en `arbol/acciones-finanzas.ts` (`ACCIONES_FINANZAS`, se suma a
`ACCIONES_ARBOL` en `expansion.ts`) y el test AC6 lo valida en doble sentido contra
`OPERACIONES_DECLARADAS` filtradas por `AREA_FINANZAS = /^(liquidacion|bolsas|conciliacion|comprobantes|finanzas|siigo)\.|^parametrizacion\.(tarifas|servicios_adicionales)\./`.
Reglas del paso (PO, 2026-10-13, AC5): modifica → «todos»; lectura (flag `lectura: true`) → «alguna»;
descargar/exportar → «todos»; `opcionales` ni agrupan ni se expanden y quien los tiene los conserva;
admin recibe todo. Fuente de las operaciones: `catalogo-operaciones.ts` (`flito-*`) y
`catalogo-operaciones.legado.ts` (`finanzas/`, `liquidacion/`, `siigo/`), contrastadas con la guarda de
cada ruta. Partida = migraciones 0001..0231 plegadas (`leerRepartoSembrado(MIGRACIONES_ANTES_DEL_ARBOL)`
del helper de tests): en las 68 operaciones del área solo aparecen `admin`, `financiera` y `auditor`.

### 5-bis.1 Delta del modelo (dos piezas que #12873 no necesitó)

1. **`predecesores` explícito** en `AccionArbol` (`predecesoresDe` = `a.predecesores ?? a.operaciones`).
   Hace falta porque dos guardas de hoy son **un solo código para varias acciones aprobadas**:
   - `finanzas.reporte_costos.ver` guarda listado, facetas, consolidado, exportes, soportes y viajes
     (`finanzas/finanzas.routes.ts`). Sin partirlo, marcar «Exportar» daría también «Ver soportes».
   - `siigo.parametrizacion.administrar` (transitorio de F1a) guarda credenciales, mapeo, terceros,
     sincronizar catálogos y freno.
   Se parten en **operaciones nuevas** (guarda nueva en la ruta) cuyo predecesor es el código viejo:
   quien tenía el viejo recibe todas las acciones que lo sustituyen, sin copiar marcas a mano. Las
   operaciones nuevas nacen absorbidas (no se siembran como concedibles); el código viejo entra en
   `CODIGOS_ABSORBIDOS` por ser predecesor.
2. **Predecesor de página**: `predecesores: ['pagina.finanzas_gastos_diarios']`. Los predecesores
   `pagina.*` **no se absorben** (la página sigue siendo el ítem). `CODIGOS_ABSORBIDOS` = operaciones ∪
   (predecesores \ `pagina.*`).

### 5-bis.2 Tabla de acciones

`L` = lectura (umbral 1), `M` = modifica (umbral |grupo|). «Pred.» solo cuando difiere del grupo.
Partida = roles que hoy tienen **todo** el grupo (o alguna en `L`).

| Ítem (`pagina.*`) | Acción `accion.<item>.<accion>` — nombre literal | Tipo | Grupo de operaciones (guarda real) | Partida |
|---|---|---|---|---|
| Reporte de costos (`finanzas_reporte_costos`) | `reporte_costos.ver_listado` — Ver el listado de trámites | L | `finanzas.reporte_costos.ver` (GET `/reporte-costos`, `/facetas`, `/facturacion-electronica`, `/consolidado`), `liquidacion.liquidacion.ver`, `.ver_eventos`, `finanzas.servicios_adicionales.ver` | admin, auditor, financiera |
| | `reporte_costos.exportar` — Exportar a Excel | M | **nueva** `finanzas.reporte_costos.exportar` (POST `/reporte-costos/export`, `/consolidado/export`) · pred. `finanzas.reporte_costos.ver` | admin, auditor, financiera |
| | `reporte_costos.ver_soportes` — Ver soportes | L | **nueva** `finanzas.reporte_costos.ver_soportes` (GET `/tramites/:id/soportes`) · pred. ídem | admin, auditor, financiera |
| | `reporte_costos.ver_viajes_adicionales` — Ver viajes adicionales | L | **nueva** `finanzas.reporte_costos.ver_viajes` (GET `/tramites/:id/viajes-logistica`) · pred. ídem | admin, auditor, financiera |
| | `reporte_costos.asignar_servicios_adicionales` — Asignar servicios adicionales | M | `finanzas.servicios_adicionales.asignar`, `.quitar` · apoyo `finanzas.servicios_adicionales.ver` | admin, financiera |
| | `reporte_costos.liquidar` — Liquidar (incluye en lote) | M | `liquidacion.liquidacion.liquidar`, `.liquidar_lote` | admin, financiera |
| | `reporte_costos.facturar` — Facturar | M | `liquidacion.liquidacion.facturar` | admin, financiera |
| | `reporte_costos.enviar_siigo` — Enviar a Siigo | M | `siigo.factura.emitir` (POST `/api/siigo/facturacion`, POST `/api/siigo/terceros/cliente/:id`) | admin, financiera |
| | `reporte_costos.reversar_liquidacion` — Reversar una liquidación | M | `liquidacion.liquidacion.reversar` | admin |
| Gastos diarios (`finanzas_gastos_diarios`) | `gastos_diarios.ver` — Ver los gastos diarios | L | **nueva** `finanzas.gastos_diarios.ver` (GET `/api/finanzas/gastos-diarios`, junto al `requirePage` actual) · pred. `pagina.finanzas_gastos_diarios` (P-19) | admin |
| Bolsas (`flito_bolsas`) | `bolsas.ver_clientes` — Ver bolsas de clientes | L | `bolsas.consolidado.ver`, `.bolsa.ver`, `.movimientos.ver`, `.cierres.ver`, `.soporte.descargar` | admin, financiera |
| | `bolsas.ver_transito` — Ver bolsas de tránsito | L | `bolsas.transito.listar`, `.transito.ver`, `.transito.ver_movimientos` | admin, financiera |
| | `bolsas.crear` — Crear bolsas | M | `bolsas.transito.crear` | admin, financiera |
| | `bolsas.editar` — Editar bolsas | M | `bolsas.transito.editar` | admin, financiera |
| | `bolsas.registrar_recargas` — Registrar recargas y cargar saldo | M | `bolsas.recarga.registrar`, `bolsas.transito.cargar` | admin, financiera |
| | `bolsas.movimientos_manuales` — Registrar y corregir movimientos manuales | M | `bolsas.movimiento.registrar`, `.movimiento.corregir` | admin, financiera |
| | `bolsas.cerrar_periodo` — Cerrar periodo y descargar extracto | M | `bolsas.cierre.crear`, `bolsas.extracto.descargar` | admin, financiera |
| | `bolsas.ver_alertas` — Ver alertas y riesgo de saldo | L | `bolsas.alertas.ver`, `bolsas.riesgo.ver` | admin, financiera |
| Tarifas (`flito_tarifas`) | `tarifas.ver` — Ver las tarifas (incluye historial) | L | `parametrizacion.tarifas.listar`, `.ver_por_cliente`, `.historial` | admin, financiera |
| | `tarifas.crear_modificar` — Crear y modificar tarifas | M | `parametrizacion.tarifas.crear`, `.editar` | admin, financiera |
| Servicios adicionales (`flito_servicios_adicionales`) | `servicios_adicionales.ver` · `.crear` · `.editar` · `.dar_de_baja` — Ver · Crear · Editar · Dar de baja | L · M · M · M | 1:1 `parametrizacion.servicios_adicionales.listar` · `.crear` · `.editar` · `.dar_de_baja` | admin, financiera |
| Comprobantes (`flito_comprobantes`) | `comprobantes.cargar` — Cargar comprobantes | M | `comprobantes.lote.cargar` | admin, financiera |
| | `comprobantes.asociar` — Asociar manualmente | M | `comprobantes.tramites.buscar`, `comprobantes.comprobante.aplicar` | admin, financiera |
| | `comprobantes.ver_cola` — Ver la cola de comprobantes | L | `comprobantes.cola.ver`, `.comprobante.ver`, `.archivo.descargar` | admin, financiera |
| | `comprobantes.resolver` — Descartar, releer o aceptar una diferencia | M | `comprobantes.comprobante.descartar`, `.comprobante.releer`, `.diferencia.aceptar` | admin, financiera |
| Conciliación (`flito_conciliacion`) | `conciliacion.ver_boletas` — Ver las boletas cargadas | L | `conciliacion.boletas.listar`, `.boleta.ver`, `.comprobante.descargar` | admin, financiera |
| | `conciliacion.cargar_boleta` — Cargar boleta | M | `conciliacion.boleta.cargar` | admin, financiera |
| | `conciliacion.conciliar` — Conciliar, descartar o volver a cruzar | M | `conciliacion.boleta.conciliar`, `.boleta.descartar`, `.boleta.recruzar` | admin, financiera |
| | `conciliacion.comprobante` — Cargar o reemplazar el comprobante de la boleta | M | `conciliacion.comprobante.cargar`, `.comprobante.reemplazar` | admin, financiera |
| Facturación electrónica · Parametrización (`siigo_parametrizacion`) | `facturacion_parametrizacion.mapeo_conceptos` — Mapeo de conceptos | M | **nuevas** `siigo.conceptos.administrar` (mapeo-conceptos POST `/`, POST `/revalidar`, POST `/:id/producto`, PATCH `/:id`, DELETE `/:id`), `siigo.catalogos.sincronizar` (parametrizacion POST `/catalogos/sincronizar`) · pred. `siigo.parametrizacion.administrar` · **opcional** `siigo.conceptos.confirmar` (P-16) | admin |
| | `facturacion_parametrizacion.terceros` — Configuración de terceros | M | **nueva** `siigo.terceros.configurar` (ciudades POST `/cargar`, clientes-ciudades POST `/:id/confirmar`, clientes POST `/validacion/recalcular-duplicados`) · pred. `siigo.parametrizacion.administrar` | admin |
| | *(propuesta P-15)* `facturacion_parametrizacion.ver` — Ver la parametrización | L | `siigo.parametrizacion.ver` (compuerta, ciudades, mapeo, validación GETs), `siigo.emision.ver` (GET `/catalogos`, `/catalogos/:tipo`) | admin, auditor, financiera |
| Facturación electrónica · Operación (`siigo_operacion`) | `facturacion_operacion.ver_facturas` — Ver las facturas emitidas | L | `siigo.factura.consultar` (bandeja, línea de tiempo, facturación GETs, correcciones/envíos GETs, terceros/productos/elegibilidad GETs, `catalogos-vivo` P-20) · apoyo `siigo.parametrizacion.ver` (estado del freno) | admin, auditor, financiera |
| | `facturacion_operacion.gestionar` — Reintentar, reenviar el correo, marcar como fallida y reactivar | M | `siigo.factura.reintentar`, `.reenviar_correo`, `.marcar_fallido` (bandeja + reconciliación), `.reactivar` · **opcionales** `siigo.factura.corregir`, `siigo.factura.anular` (P-17) | admin, financiera |
| | `facturacion_operacion.freno` — Activar o quitar el freno de emisión | M | **nueva** `siigo.freno.reactivar` (freno POST `/reactivar`) · pred. `siigo.parametrizacion.administrar` (P-18) | admin |
| Integración con Siigo (`siigo_credenciales`, elemento Administración, P-3) | `integracion_siigo.credenciales_pruebas` — Registrar credenciales de pruebas | M | **nueva** `siigo.credenciales.registrar_pruebas` (POST `/` y DELETE `/:id` con `ambiente = pruebas`) · apoyo **nueva** `siigo.credenciales.ver` (GET `/`) · pred. `siigo.parametrizacion.administrar` | admin |
| | `integracion_siigo.credenciales_produccion` — Registrar credenciales de producción | M | **nueva** `siigo.credenciales.registrar_produccion` (ídem, `ambiente = produccion`) · apoyo `siigo.credenciales.ver` · pred. ídem | admin |
| | `integracion_siigo.probar_conexion` — Probar la conexión | M | **nueva** `siigo.credenciales.probar` (POST `/probar-conexion`) · apoyo `siigo.credenciales.ver` · pred. ídem | admin |

Opcionales del área: `siigo.conceptos.confirmar` (Mapeo de conceptos), `siigo.factura.corregir` y
`siigo.factura.anular` (Gestionar facturas). Apoyo: `finanzas.servicios_adicionales.ver` (en Asignar,
además de grupo de Ver el listado), `siigo.parametrizacion.ver` (en Ver las facturas emitidas, si P-15
se aprueba; si no, ver P-15), `siigo.credenciales.ver`.

### 5-bis.3 Cobertura total (68 códigos del área)

| Familia | Códigos | Destino |
|---|---|---|
| `bolsas.*` | 18 | 8 acciones de Bolsas (5+3+1+1+2+2+2+2) |
| `conciliacion.*` | 9 | 4 acciones de Conciliación (3+1+3+2) |
| `comprobantes.*` | 9 | 4 acciones de Comprobantes (1+2+3+3) |
| `liquidacion.liquidacion.*` | 6 | Ver el listado (2), Liquidar (2), Facturar, Reversar |
| `liquidacion.pago_manual.administrar` | 1 | **fuera de área** → Órdenes de trabajo, legado #13429 (P-14). Va en `FUERA_DE_AREA_FINANZAS` |
| `parametrizacion.tarifas.*` | 5 | Ver (3), Crear y modificar (2) |
| `parametrizacion.servicios_adicionales.*` | 4 | 1:1 |
| `finanzas.servicios_adicionales.*` | 3 | Ver el listado (`ver`), Asignar (`asignar`, `quitar`) |
| `finanzas.reporte_costos.ver` | 1 | Ver el listado + predecesor de Exportar / Ver soportes / Ver viajes |
| `siigo.factura.*` | 8 | Ver facturas (`consultar`), Enviar a Siigo (`emitir`), Gestionar (4), opcionales `corregir`, `anular` |
| `siigo.parametrizacion.ver`, `siigo.emision.ver` | 2 | Ver la parametrización (P-15) |
| `siigo.conceptos.confirmar` | 1 | opcional de Mapeo de conceptos (P-16) |
| `siigo.parametrizacion.administrar` | 1 | **retirado** (transitorio): predecesor de Mapeo, Terceros, Freno y las 3 de Integración |

Ninguna huérfana. Sin acción aprobada sin operación salvo Gastos diarios (P-19), que se respalda con
una operación nueva. `parametrizacion.companias.*` / `.proveedores.*` / `.organismos.*` que montan las
mismas rutas `flito-parametrizacion` **no** son de esta HU (#13428 / #12873).

### 5-bis.4 Transitorios de F1a que se retiran

| Transitorio | Quién lo tiene (partida) | Paso |
|---|---|---|
| `siigo.parametrizacion.administrar` (14 guardas) | admin | se parte en 8 operaciones nuevas (contando `siigo.credenciales.ver`); quien lo tenía recibe Mapeo de conceptos, Configuración de terceros, Freno y las 3 de Integración con Siigo (regla «todos», grupo = 1). Excepciones de usuario (conceder/revocar) siguen la misma CTE del §4.1 paso 2. Luego se borra de marcas y de `permisos_funciones` |
| `liquidacion.pago_manual.administrar` | admin | **no se retira aquí** (P-14): es de Órdenes de trabajo (`liquidacion/` legacy, `/api/liquidaciones`, lo pide `WorkOrderDetail.tsx`), lo retira #13429 |

No hay más `<item>_<accion>.administrar` de Finanzas ni de Siigo en `NOMBRES_LEGADO`.
`clients.clientes.administrar` es de #13428: no se toca.

### 5-bis.5 Pérdidas previsibles por rol (partida 0001..0231)

| Rol | Con las recomendaciones de P-14..P-20 | Si el PO dice «no» |
|---|---|---|
| admin | ninguna (tiene todos los predecesores, el transitorio y la página de gastos) | ninguna |
| financiera | ninguna | P-15 no: pierde `siigo.parametrizacion.ver` y `siigo.emision.ver` (Parametrización en blanco, estado del freno, `EmisionPorEmpresa`). P-16 no: pierde confirmar el mapeo. P-17 no: pierde corregir y anular |
| auditor | ninguna; **gana** `siigo.emision.ver` (copia local de catálogos, solo lectura) por la regla «alguna» de P-15 | P-15 no: pierde la lectura de la Parametrización y del freno |
| demás roles | sin operaciones de Finanzas en la partida | — |

La partida no es DEV: las marcas editadas desde el panel solo las ve el reporte en
seco (`--hu 13427`), obligatorio en la Discussion antes del PR (§4.2). Con un único rol completo por
grupo, el riesgo de «todos» aquí es bajo; lo vigilable es quien tenga un subconjunto editado a mano.

### 5-bis.6 Preguntas para el PO (con recomendación)

- **P-14** — `liquidacion.pago_manual.administrar` está en el §4 como de #13427, pero es el transitorio
  de **Órdenes de trabajo** (Mantenimiento, `liquidacion/` legacy, pago manual de una OT); no cabe en
  ninguna acción de Finanzas. *Rec.:* moverlo a #13429 (legado) y corregir el §4.
- **P-15** — Parametrización de facturación no tiene acción «Ver», y sus dos acciones aprobadas
  modifican y quedan solo para admin: auditor y financiera perderían lo que hoy leen
  (`siigo.parametrizacion.ver`, y financiera `siigo.emision.ver`). *Rec.:* añadir «Ver la
  parametrización» (lectura) con esas dos operaciones, y `siigo.parametrizacion.ver` como apoyo de
  «Ver las facturas emitidas» (el freno se lee en Operación). Alternativa sin acción nueva: ambas como
  apoyo de «Ver las facturas emitidas».
- **P-16** — `siigo.conceptos.confirmar` (admin, financiera) cae dentro de «Mapeo de conceptos», cuyo
  grupo es el transitorio (solo admin): financiera dejaría de confirmar mapeos. *Rec.:* opcional de
  «Mapeo de conceptos» (la conserva quien la tiene, nadie la gana).
- **P-17** — `siigo.factura.corregir` (ruta viva: corrige y vuelve a emitir, escritura en Siigo) y
  `siigo.factura.anular` (declarada, sin ruta aún) no caben en ninguna acción aprobada. *Rec.:*
  opcionales de «Reintentar, reenviar…» (mismos titulares hoy; ni se ganan ni se pierden).
- **P-18** — «Activar o quitar el freno»: solo existe **quitar** (POST `/api/siigo/freno/reactivar`);
  el freno se activa solo. *Rec.:* mantener la acción con esa operación y ajustar el copy a «Quitar el
  freno de emisión», o dejar el nombre aprobado y documentarlo en la ficha de ayuda.
- **P-19** — «Ver los gastos diarios» no tiene operación: la ruta solo pide la página. *Rec.:* operación
  nueva `finanzas.gastos_diarios.ver` en la ruta, con la página como predecesor (hoy solo admin).
- **P-20** — `siigo.factura.consultar` (lectura) también guarda `GET /api/siigo/parametrizacion/catalogos-vivo/:tipo`,
  que **sale a la red contra Siigo** (coste de cuota, sin escritura). *Rec.:* dejarlo así (decisión ya
  documentada en la ruta, con `vivoLimiter`); la alternativa es moverlo a «Enviar a Siigo», que es donde
  se usa.

Decisiones de diseño que **no** son del PO (no cambian el reparto de nadie): partir
`finanzas.reporte_costos.ver` y `siigo.parametrizacion.administrar` en operaciones nuevas (§5-bis.1);
`siigo.catalogos.sincronizar` dentro de «Mapeo de conceptos» (el catálogo de productos alimenta el
mapeo); «Crear bolsas» y «Editar bolsas» solo tienen operación en las bolsas de tránsito (las de clientes
se abren con la compañía); `comprobantes.comprobante.releer` (OCR con coste) va en una acción que modifica.

### 5-bis.7 Migraciones y archivos

- **0234** `0234_permisos_arbol_finanzas_siembra.sql` y **0235** `0235_permisos_arbol_finanzas_reparto.sql`.
  Confirmado el 2026-10-13: `git ls-tree origin/develop` termina en `0231_enlace_proveedor_y_retiro_tipo_principal.sql`
  (0232/0233 son de #12873, apilada) y ninguna rama de `origin` trae 0234+. Se reasigna en el rebase si
  otra sesión entra antes. Generadas (`--arbol finanzas`), no tecleadas; las tablas temporales con sufijo
  de la HU (`tmp_*_13427`) y el test de la 0235 con la paridad AC9 plegando 0001..0235.
- **API:** `apps/api/src/modules/permisos/arbol/acciones-finanzas.ts` (nuevo: `ACCIONES_FINANZAS`,
  `AREA_FINANZAS`, `FUERA_DE_AREA_FINANZAS`), `arbol/expansion.ts` (unión de áreas, `predecesores`,
  predecesor `pagina.*` no absorbido), `arbol/sql-arbol.ts` / `reparto-arbol.ts` (parametrizar área y
  sufijo), `catalogo-operaciones.legado.ts` (operaciones nuevas de `finanzas/` y `siigo/`; fuera el
  transitorio), `inventario.generado.ts` (foto, por el generador), `scripts/generar-seed-permisos.ts`.
- **Guardas:** `finanzas/finanzas.routes.ts` (2 exportes, soportes, viajes, gastos diarios),
  `siigo/credenciales.routes.ts` (POST y DELETE deciden por ambiente en línea con códigos literales,
  como `siigo.permisos.ts`; DELETE lee el ambiente de la credencial antes de decidir), `siigo/mapeo-conceptos.routes.ts`,
  `siigo/parametrizacion.routes.ts`, `siigo/ciudades.routes.ts`, `siigo/ciudades-mapeo.routes.ts`,
  `siigo/validador-cliente.routes.ts`, `siigo/freno.routes.ts`.
- **shared-types:** `packages/shared-types/src/permisos-arbol/finanzas.ts` (nuevo) y `administracion.ts`
  (nuevo, solo con Integración con Siigo; #13428 lo amplía) + `index.ts`.
- **Web (mismo PR, regla 7):** `apps/web/src/pages/SiigoParametrizacion.tsx:71` y
  `apps/web/src/components/siigo/PanelTerceros.tsx:65,68` preguntan por `siigo.parametrizacion.administrar`,
  que deja de estar en el conjunto efectivo: pasan a `siigo.conceptos.administrar` /
  `siigo.terceros.configurar`. Sin ese cambio admin pierde los botones (el API sí aceptaría).
- **Tests:** `permisos-arbol-finanzas.test.ts` (catálogo literal del anexo + AC6), `migracion-0234/0235.test.ts`,
  supertest 200/403 por acción en las rutas con guarda nueva.

### Anexo — catálogo aprobado por el PO (2026-10-07, literal, con los [+])

```
Finanzas → Reporte de costos: Ver el listado de trámites · Exportar a Excel · Ver soportes · Ver viajes adicionales · Asignar servicios adicionales · Liquidar (incluye en lote) · Facturar · Enviar a Siigo · Reversar una liquidación
Finanzas → Gastos diarios: Ver los gastos diarios
Finanzas → Bolsas: Ver bolsas de clientes · Ver bolsas de tránsito · Crear bolsas · Editar bolsas · Registrar recargas y cargar saldo · Registrar y corregir movimientos manuales · Cerrar periodo y descargar extracto · Ver alertas y riesgo de saldo
Finanzas → Tarifas: Ver las tarifas (incluye historial) · Crear y modificar tarifas
Finanzas → Servicios adicionales: Ver · Crear · Editar · Dar de baja
Finanzas → Comprobantes: Cargar comprobantes · Asociar manualmente · Ver la cola de comprobantes · Descartar, releer o aceptar una diferencia
Finanzas → Conciliación: Ver las boletas cargadas · Cargar boleta · Conciliar, descartar o volver a cruzar · Cargar o reemplazar el comprobante de la boleta
Finanzas → Facturación electrónica · Parametrización: Mapeo de conceptos · Configuración de terceros
Finanzas → Facturación electrónica · Operación: Ver las facturas emitidas · Reintentar, reenviar el correo, marcar como fallida y reactivar · Activar o quitar el freno de emisión
Administración → Integración con Siigo: Registrar credenciales de pruebas · Registrar credenciales de producción · Probar la conexión
```

## 6. Web

### #13430 — panel en tres niveles

- Consume `GET /permisos/roles/:codigo/arbol`, `GET /permisos/usuarios/:id/arbol` y guarda con el `PUT`
  de siempre (lista completa de nodos marcados, incluidos los ocultos). 409 → aviso de página con copy
  propio, sin perder el estado local; éxito → toast cerrable.
- Estado local: `Set<string>` de marcados; `efectivo`/parcial se recalcula en cliente con la misma
  fórmula (helper puro en `pages/roles-permisos/arbol.ts`) para que desmarcar un padre deje los hijos
  visibles, deshabilitados y marcados. Parcial = `aria-checked="mixed"`.
- `sinAcciones` del API al cargar; tras editar, recalculado en cliente.
- Botones por acción: `hasFuncion('permisos.cuadro.guardar')` (asignar), `permisos.rol.crear/.borrar`.
- Archivos: `CuadroRol.tsx` (pasa a orquestar), nuevos `ArbolPermisos.tsx`, `NodoPermiso.tsx`,
  `arbol.ts` (+ test de tipos con `tsc`), editor de excepciones en la ficha de usuario reutilizando
  `ArbolPermisos` con modo `usuario` (heredado vs excepción), `lib/api.ts` (`getArbolRol`,
  `getArbolUsuario`), `modulos.ts`/`dependencias.ts` (retirar lo que el árbol sustituye), spec E2E
  `e2e/tests/roles-permisos-arbol.spec.ts`. ux-agent **full** antes.

### #13431 — shell

- `navItems.ts`: grupos y etiquetas desde `ARBOL_PERMISOS` (nombre del elemento e ítem); visibilidad
  por `hasPage(slug)` (ya gated por `menu.*` en el conjunto efectivo). Nuevo grupo «Ayuda» con Ayuda
  FLITO por `puedeVerAyudaFlito`; sale de General.
- Perfil: menú de usuario y ruta en `App.tsx` con `hasFuncion('perfil.datos.ver')`; el flujo de cambio
  obligatorio (`mustChangePassword`) no pasa por esa guarda.
- Tablero por bloques: el endpoint del tablero (#13428) devuelve solo bloques de páginas efectivas,
  con `conAlcance` (ADR-0024) para enlace compañía.
- `e2e/fixtures` `loginAs` / `FUNCIONES_POR_ROL`: códigos nuevos (`accion.*`, `menu.*`, `perfil.*`).

## 7. Riesgos y cortes de PR

| Riesgo | Mitigación |
|---|---|
| Pérdida de acceso por «todos» (sobre todo en «Ver listado») | reporte en seco por HU aprobado en la Discussion antes del PR; `predecesores` explícito si el PO excluye alguna op |
| Pérdidas por gating de ancestros (#13429) | reporte propio de #13429; la siembra de `menu.*` por OR evita la mayoría |
| Bloqueo de admin | anti-bloqueo sobre el conjunto **expandido**, con lock; test: desmarcar `menu.administracion`, `pagina.users`, `pagina.roles_permisos` → 409 |
| Caché 60 s | migración = reinicio (caché vacía); `invalidarPermisosDeRol`/`De` tras commit, como hoy |
| API que no arranca (`CatalogoIncoherenteError`) | código y migración en el mismo PR; PDN `db:apply` manual; promover las 4 HUs backend juntas |
| CD roto por literal de rol | solo `INSERT … SELECT`; test que busca literales de `USER_ROLES` en el SQL |
| ≤800 líneas | árbol y mapeo partidos por área; `catalogo-operaciones*.ts` no crecen; `permisos-efectivos.ts` delega en `arbol/expansion.ts` |
| Bitácora del 403 | `permisos_intentos_denegados` guarda la operación; la vista la traduce a «la concede: <acción>» vía el índice inverso (si hoy hace JOIN a `permisos_funciones`, las ops borradas saldrían sin nombre → usar `catalogo-operaciones` para el nombre) |
| Notificaciones por función (`usuariosConFuncion`) | migrar a la expansión en #12873 |

**Cortes:** un PR por HU (6). Si #12873 pasa de ~1 500 líneas de diff, partir en dos PRs dentro de la
misma HU: (a) schema + expansión + generador + Gestión Trámites/SOAT/Impuestos; (b) resto de ítems.
Gates: db-review + security en #12873, #13427, #13428, #13429; ux full en #13430; security en #13431 solo
si toca rutas de API (Perfil lo hace en #13428).

## 8. Preguntas para el PO (con recomendación)

- **P-0 (proceso)** — El catálogo acción por acción solo está en el transcript de intake, no en ADO.
  *Rec.:* pegarlo en la Discussion de #13416 como anexo antes de #12873 (fuente auditable del AC1).
- **P-1** — «Todos los del grupo» en «Ver listado» hace perder el listado entero a quien le falte una
  pieza (p. ej. historial o causales). *Rec.:* mantener la regla, revisar el reporte; si salen muchas
  pérdidas, definir como predecesor solo el núcleo (`cola.ver`).
- **P-2** — Clientes y proveedores y Bitácora: el menú (agrupación «queda igual») los tiene en
  **Gestión**; #13428 AC1 los pone en **Administración**. *Rec.:* seguir el menú (Gestión), corregir el AC.
- **P-3** — Integración Siigo: el catálogo y el menú la tienen en **Administración**; #13427 la lista en
  **Finanzas**. *Rec.:* Administración (sigue el menú); la siembra la hace igual #13427.
- **P-4** — Facturación electrónica · Parametrización / · Operación y Gastos diarios: confirmar que
  existen como páginas propias tras F1a; si no, #13427 siembra `pagina.*` nuevas (y #13431 las
  registra). *Rec.:* una página por ítem, como ADR-0023.
- **P-5** — Impuestos «los mismos de SOAT»: «Cambiar proveedor», «Solicitar sin trámite», «por validar»
  y documentos adicionales no tienen operación en Impuestos. *Rec.:* no sembrarlas (acción sin efecto).
- **P-6** — «Ver y descargar la factura de venta» (Gestión Trámites) no tiene operación propia.
  *Rec.:* si la factura se ve dentro del detalle de SOAT/Impuestos, quitar la acción de Gestión
  Trámites y dejar `soat.factura.leer`/`impuestos.factura.ver` en sus «Ver listado».
- **P-7** — Revisiones OCR por concepto (SOAT/impuestos/derechos): las operaciones no distinguen
  concepto. *Rec.:* una sola acción «Revisar lecturas OCR» + «Ver»; partir por concepto exige filtro en
  el servicio (alcance nuevo).
- **P-8** — Mi ruta es ítem FLITO con nivel 3 pero el catálogo no lista sus acciones. *Rec.:* «Ver mi
  ruta», «Escanear documentos», «Reportar novedad».
- **P-9** — Sin acción en el catálogo: `logistica.actas.operar_ajenas`, `soat.solicitud.subsanar`,
  `soat.revision.validar/rechazar`, `logistica.lt.validar`. *Rec.:* `operar_ajenas` → «Despachar,
  entregar y devolver» (mensajero ve todo por ahora); `subsanar` → «Gestionar solicitudes»;
  `revision.*` → «Ver por validar»; `lt.validar` → «Generar actas».
- **P-10** — Compuerta: deja de ser ítem, pero tiene pantalla propia (`/flito/compuerta`). *Rec.:* la
  pantalla queda accesible desde Gestión Trámites con guarda `hasFuncion('accion.tramites.entregar')` y
  sale del menú (ux-agent la ubica en #13430/#13431).
- **P-11** — Tablero FLITO (`flito_tablero`, op `tablero.tablero.ver`) vs Tablero de General
  (`dashboard`): la decisión fue «Tablero = el de General». *Rec.:* `flito_tablero` se retira como ítem
  y su op pasa al «ver» del Tablero de General (bloques).
- **P-12** — Cambio de contraseña propio: la memoria del 7-oct registra que David aprobó que
  **cualquiera** cambie su contraseña sin Perfil (#13425, relaja #13255); #13428 AC3 lo condiciona a
  «Perfil: cambiar mi contraseña» salvo el cambio obligatorio. Son contradictorias. *Rec.:* seguir el AC
  de #13428 (es posterior y es el catálogo aprobado) y confirmar con David.

## Archivos a crear/modificar

**API (#12873 base; las demás añaden su área):**
- `apps/api/src/db/schema/permisos.ts` (columnas) · `apps/api/src/db/migrations/0232…0239_*.sql`
- `apps/api/src/modules/permisos/arbol/expansion.ts` (nuevo) · `arbol/acciones-gestion.ts` (#12873),
  `acciones-finanzas.ts` (#13427), `acciones-administracion.ts` (#13428), `acciones-legado.ts` (#13429)
- `apps/api/src/modules/permisos/catalogo.ts` (nodos; excluir absorbidas) · `permisos.routes.ts` +
  `permisos-arbol.service.ts` (nuevo, GETs del árbol, #13429) · `permisos-roles.service.ts` (validación)
- `apps/api/src/shared/permisos-efectivos.ts` · `apps/api/src/shared/permisos-anti-bloqueo.ts`
- `apps/api/scripts/generar-seed-permisos.ts` (`--arbol`) · `apps/api/scripts/permisos-reparto-en-seco.ts` (`--hu`)
- Guardas a tocar: ruta `pedir_ambos` (#12873), rutas de Perfil (#13428), guardas con `.administrar` (#13429)
- Tests: `apps/api/src/__tests__/…/permisos-arbol-<area>.test.ts` (catálogo vs lista aprobada + AC6),
  `permisos-expansion.test.ts`, test de cada migración (SQL ↔ generador, sin literales de rol)

**shared-types:** `packages/shared-types/src/permisos-arbol/{index,gestion,finanzas,administracion,general,perfil,legado,elementos}.ts` + export en `src/index.ts`.

**Web:** #13430 `apps/web/src/pages/roles-permisos/{CuadroRol,ArbolPermisos,NodoPermiso}.tsx`, `arbol.ts`,
`modulos.ts`, `dependencias.ts`, `apps/web/src/lib/api.ts`, editor de excepciones de usuario, spec E2E.
#13431 `apps/web/src/components/shell/navItems.ts`, `apps/web/src/App.tsx`, página/menú de Perfil,
tablero, fixtures E2E `loginAs`.

## ADR

ADR-0025 (Propuesto): `docs/adr/ADR-0025-arbol-de-permisos-acciones-que-expanden-operaciones.md`.

## 9. Respuesta a los requisitos de datos de UX (`docs/ux/hu-13430-panel-tres-niveles.md` §R1–R5)

| Req. | Resuelto | Cómo |
|---|---|---|
| **R1** árbol con nivel, padre, orden y nombres del menú | Sí | `GET /api/permisos/arbol` (sucesor de `GET /funciones`) devuelve `NodoArbolDef` con `codigo`, `nombre` (= nombre del menú, misma fuente `ARBOL_PERMISOS` que lee el shell en #13431), `descripcion`, `tipo`, `nivel` = **profundidad 1–4** (la acción anidada es 4), `padre`, `orden`. Orden de nivel 1: General, Gestión, Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Finanzas, Administración, Ayuda, Perfil. |
| **R2** nivel 1 (y 2) con código propio que se guarda | Sí | nivel 1 = `menu.<elemento>`, nivel 2 = `pagina.<slug>`; ambos van en el `PUT …/funciones` como cualquier código. **Única excepción: «Ayuda»** es `derivado: true` (sin permiso propio por decisión del PO): el panel la pinta como fila informativa sin casilla. |
| **R3** conservación persistida en BD | Sí, es el modelo | el `PUT` guarda los hijos marcados bajo un padre desmarcado (no se filtran); el resolver exige la cadena entera (§2.4). #13429 debe **quitar del servicio** cualquier limpieza heredada de la regla 4 de #12717 (acciones borradas al desmarcar la pantalla) si vive en el `PUT` o en `guardarCuadro`. |
| **R4** sin huérfanos | Sí, desde #13429 | test en #13429: todo nodo de `permisos_funciones`/`catalogoCompleto()` salvo `menu.*` tiene `padre_codigo` y su cadena termina en un `menu.*`; al cerrar #13429 no queda ninguna operación concedible (`nivel NULL`). Entre #12873 y #13429 el panel sigue siendo el plano (el árbol llega con #13430), así que el estado intermedio no se pinta. |
| **R5** códigos de Roles y permisos | Reutilizados como operaciones | acciones `accion.permisos.ver` (⊇ `permisos.rol.listar`, `permisos.cuadro.ver`, `permisos.catalogo.ver`), `.crear` (`permisos.rol.crear`), `.editar` (`permisos.rol.editar`), `.asignar` (`permisos.cuadro.guardar`), `.eliminar` (`permisos.rol.borrar`). **La web sigue preguntando por la operación** (`hasFuncion('permisos.cuadro.guardar')`…): es lo que el API exige, así el botón aparece si y solo si el API aceptaría; no cambia con reagrupaciones del catálogo. |

**«Desmarcar conserva» en los 4 niveles:** no choca; es exactamente la fórmula `efectivo(n) = marcado(n) ∧
efectivo(padre(n))` de ADR-0025, aplicada a elemento, ítem, acción y acción anidada. Sustituye la regla 4
de #12717. Efecto en el paso: como la regla vieja borraba, hoy no hay marcas ocultas que «reaparezcan»;
el reporte en seco de #13429 sí debe listar a quien tenga hoy una operación de acción sin su página
(antes funcionaba por API, con el gating la pierde).

- **P-13 (nueva, de UX)** — El menú dice «Cumplimiento» y el catálogo aprobado dice «LAFT» para el
  mismo elemento. Con «nombres del catálogo» solo puede quedar uno. *Rec.:* «LAFT» (es el nombre de la
  decisión cerrada del 7-oct; manda el catálogo mientras el PO no diga otra cosa). Bloquea el copy, no
  el modelo.
