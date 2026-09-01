# UX slim — La cola SOAT deja de girar sobre el trámite (HU #11905)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU
> [#11905](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11905) (eslabón 1 del
> Feature #11904): **quitar** la columna «Trámite» de la cola `/flito/soat` y el dato «Trámites FLIT»
> del modal **Ver**, para alinear la pantalla con la RN-01 (*un SOAT por VIN, no por trámite*).
>
> Modo **slim**: se especifica **solo lo que cambia** de dos superficies —la tabla `Pólizas SOAT` y el
> modal `SOAT · <placa>`— más lo que el cambio **arrastra sin que el AC lo diga**, que es donde están
> las tres decisiones de verdad. El resto de la pantalla (pastillas de estado, filtros, presets,
> barra de envío, carga masiva, visor de soportes, historial) **no se toca**.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** las fechas **Creado / Aprob. se
> quedan**; la API **sigue enviando** `tramitesFlit` y `tipoTramite` (la UI simplemente deja de
> pintarlos); no se toca `columnasComunes.tsx`; no se tocan tokens ni estilos globales (Feature
> paralelo #11898 de tema oscuro).

---

## Superficie tocada

| | |
|---|---|
| Página | `/flito/soat` — «SOAT», cola de adquisición |
| Archivo | `apps/web/src/pages/FlitoSoat.tsx` — **el único de `src/` que esta HU toca** |
| Superficie 1 | Tabla `Pólizas SOAT`: `thead` (línea ~282) y la celda `<CeldaTramite>` (líneas ~302-304) |
| Superficie 2 | Modal `DetalleSoat`: `<Dato k="Trámites FLIT" …>` (línea ~465) |
| Slug / permiso | `soat` — **sin cambios**. `PAGE_ROLES`: `admin` (todo), `proveedor`, `auditor` (`packages/shared-types/src/permissions.ts:182,186`). Ni un condicional de rol nuevo: el AC3 es precisamente que **no exista** |
| Endpoints | **Ninguno nuevo, ninguno modificado.** `GET /flito/soat` sigue devolviendo `tramitesFlit` y `tipoTramite` |
| PII | **Sin cambios.** No entra ni sale ningún dato personal de la lista ni de la URL; los compradores siguen donde estaban, dentro del modal |

**Prohibido tocar `apps/web/src/components/flit/columnasComunes.tsx`.** Lo comparten
`FlitoImpuestos.tsx`, `FlitoDerechos.tsx` y `FinanzasReporteCostos.tsx`: cualquier cambio ahí
**heredaría** el AC4 al revés y rompería tres colas a la vez. `CeldaVehiculo` y `CeldaFechas` se
siguen usando **tal cual**, importadas de ahí; lo que deja de importarse es `CeldaTramite` y
`ENCABEZADOS_COMUNES`.

---

## Lo que se quita son **tres** datos, no uno

La columna es una sola, pero `<CeldaTramite>` pinta tres cosas y el AC solo nombra dos. La tercera es
la decisión que esta HU no puede tomar en silencio.

```tsx
<CeldaTramite idFlit={f.tramitesFlit.join(', ') || null} tipoTramite={f.tipoTramite}
  varios={f.tramitesFlit.length > 1}
  extra={f.esMultiplePropietario ? 'Múltiple propietario' : null} />
```

| Dato | Qué es | Destino |
|---|---|---|
| `idFlit` (`FLIT-1002`) | Identificador del trámite en FLIT | **Se va.** AC1 lo nombra |
| `tipoTramite` / «Varios trámites» | Tipo del trámite, o el aviso de que sirve a varios que no coinciden | **Se va.** AC1 lo nombra |
| `extra` = **«Múltiple propietario»** | **No es del trámite: es del SOAT** (`esMultiplePropietario`). Viaja como `extra` solo porque la celda del trámite era la que tenía sitio | **Se queda, mudado.** Ver abajo |

> **Decisión 1 — «Múltiple propietario» sobrevive y se muda a la celda del vehículo.**
> Quitarlo sería una pérdida de información **que el AC no pide**: el AC1 prohíbe el trámite, no un
> atributo del SOAT que se pintaba de prestado en esa columna. Va como cuarta línea de la celda del
> vehículo, con **el mismo tratamiento tipográfico que ya tenía** (`text-xs`, color
> `var(--flit-text-muted)`) — el mismo token que esa celda usa hoy para marca y línea. **Cero
> patrones nuevos, cero colores nuevos, cero controles nuevos.**
>
> Descartes: (a) *pasarlo a la columna Estado* — mezcla un atributo del vehículo con la señal
> temporal de riesgo que ya viven ahí (`StatusChip` + `ChipSinGestion`), y competiría con ellas;
> (b) *convertirlo en `StatusChip`* — sería inventar énfasis que hoy no tiene (regla 3);
> (c) *dejarlo caer* — pérdida no pedida.

### La consecuencia que sí se acepta como pérdida

`fechaCreacion` y `fechaAprobacion` de la fila son **`comun(...)` sobre los trámites del SOAT**:
valen `null` cuando el SOAT sirve a varios trámites cuyas fechas no coinciden
(`apps/api/src/modules/flito-soat/flito-soat.service.ts:365-367`, y está anotado en la interfaz del
front). Hoy esas filas se explican solas porque la columna de al lado dice **«Varios trámites»**.
Quitada la columna, la celda de fechas de esas filas dirá **«Creado —»** y **«Sin aprobar»** sin
ninguna pista de por qué — y «Sin aprobar» es una afirmación de negocio, no un hueco.

**Se acepta tal cual en el eslabón 1** (el AC1 no admite matices sobre el trámite) y **se declara
como pérdida**, no se disimula. Si el PO la considera intolerable, la reparación mínima que **no**
reintroduce el trámite es una línea tenue en la celda del vehículo del tipo *«fechas de varios
trámites»* — **no se implementa sin que el PO lo pida**.

---

## El reparto de columnas

### Antes → después

| # | Encabezado | Antes | Después |
|---|---|---|---|
| 1 | *(casilla de selección)* | Solo `admin` **y** si hay `Pendiente` en la página | **igual** |
| 2 | **Trámite** | `ENCABEZADOS_COMUNES[0]` | **se va** |
| 3 | Vehículo | `ENCABEZADOS_COMUNES[1]` | **se queda** (+ «Múltiple propietario») |
| 4 | Fechas | `ENCABEZADOS_COMUNES[2]` | **se queda**, `Creado` / `Aprob.` intactos |
| 5 | Compañía | | igual |
| 6 | Gestiona | | igual |
| 7 | Estado | | igual |
| 8 | Solicitado | | igual |
| 9 | Pagado | | igual |
| 10 | Valor | | igual |
| 11 | *(sin rótulo — botón «Ver»)* | | igual |

**Conteo exacto, que es lo que QA va a medir:** `admin` con al menos un `Pendiente` visible pasa de
**11 a 10** `columnheader`; `admin` sin pendientes, `proveedor` y `auditor` pasan de **10 a 9**
(`puedeOperar` es `role === 'admin'`, `lib/permissions.ts:31-34`).

### El `thead`: rótulos literales, no `slice`

```
{ENCABEZADOS_COMUNES.map((h) => <FlitTh key={h}>{h}</FlitTh>)}
   →  <FlitTh>Vehículo</FlitTh><FlitTh>Fechas</FlitTh>
```

**`ENCABEZADOS_COMUNES.slice(1)` queda prohibido**: ata los rótulos de SOAT a *la posición* dentro de
un array compartido por otras tres pantallas. El día que alguien reordene ese array —cosa que las
otras colas pueden hacer legítimamente— SOAT cambiaría de encabezados en silencio y sin que ningún
test de SOAT lo pida. Dos literales no tienen ese acoplamiento, y el AC4 pide justamente que estas
dos tablas dejen de moverse juntas en esta franja.

### Qué pasa con el ancho liberado: **nada, a propósito**

La tabla es `<table className="w-full">` con **layout automático** dentro del `overflow-x-auto` de
`FlitTable`. Al retirar una columna el navegador reparte su ancho entre las demás sin que nadie lo
declare. La instrucción es explícita:

- **No** se fija `min-w` / `max-w` en ninguna celda de esta tabla.
- **No** se introduce `table-fixed`, `<colgroup>` ni anchos por fracción.
- **No** se «rellena» el hueco moviendo columnas de sitio: el orden de las 9 restantes no cambia.

Motivo: el eslabón 2 (HU #11906) va a gastar ese hueco. Cualquier ancho que se clave hoy hay que
renegociarlo dentro de un mes, y un `min-w` puesto «para que se vea bien» es exactamente lo que
convierte el eslabón 2 en una discusión de píxeles.

**Efecto secundario esperado, y no es una regresión:** la tabla venía de 11 columnas y a 1280 px
desbordaba. Si con 10 deja de desbordar, `FlitTable` **retira sola** el degradado `data-desborde` y
el `tabIndex={0}` del contenedor — es el contrato explícito de `useDesbordaX` (HU #11900: *«una tabla
que cabe no lleva franja, o el indicador deja de indicar»*). Si sigue desbordando, ambos siguen. Las
dos salidas son correctas; lo que **no** es correcto es que la franja y la parada de tabulador
discrepen entre sí.

### Responsive y tema

- **Responsive:** esta cola **no tiene niveles A/B** — no hay un solo `hidden xl:table-cell` en
  `FlitoSoat.tsx`. Su respuesta al ancho es, y sigue siendo, el desplazamiento horizontal de
  `FlitTable`. Esta HU **mejora** el caso estrecho (una columna menos que desplazar) sin añadir
  breakpoints. No se importa el esquema A/B de `docs/ux/shell-tema-y-responsive.md`: ese documento
  gobierna la tabla de comparendos, no esta.
- **Tema oscuro (#11898):** **cero tokens nuevos y cero estilos globales.** La celda que se va usaba
  `--flit-text-secondary` / `--flit-text-muted`; el texto que se muda a la celda del vehículo usa
  `--flit-text-muted`, **que esa misma celda ya pinta hoy** para marca y línea. No hay ningún par
  claro/oscuro que inventar ni ningún color escrito a mano.
  *Aviso honesto:* `npm run check:contraste` **no acredita nada de esto** — su alcance real es la ⌘K
  y los gradientes. Que el token ya esté en uso en la misma celda es el argumento; el gate, no.

### Wireframe de la fila (lo único que cambia de la tabla)

```
ANTES ── 11 columnas (admin con pendientes)
┌──┬───────────────┬──────────────┬────────────┬───────────┬────────────┬─────────┬──────────┬────────┬─────────┬─────┐
│☐ │ FLIT-1002     │ XYZ789       │ Creado 02/… │ Comercial │ Prov. Sur  │ Solicit.│ 02/04/26 │   —    │   —     │ Ver │
│  │ Traspaso      │ 9BW…12345    │ Aprob. 05/… │ del Norte │            │ Sin gest│ hace 3 d │        │         │     │
│  │ Múlt. propiet.│ Mazda CX-30  │             │           │            │         │          │        │         │     │
└──┴───────────────┴──────────────┴────────────┴───────────┴────────────┴─────────┴──────────┴────────┴─────────┴─────┘
   └─ se va entera ─┘  └─ recibe la 4.ª línea ─┘

DESPUÉS ── 10 columnas
┌──┬──────────────┬────────────┬───────────┬────────────┬─────────┬──────────┬────────┬─────────┬─────┐
│☐ │ XYZ789       │ Creado 02/…│ Comercial │ Prov. Sur  │ Solicit.│ 02/04/26 │   —    │   —     │ Ver │
│  │ 9BW…12345    │ Aprob. 05/…│ del Norte │            │ Sin gest│ hace 3 d │        │         │     │
│  │ Mazda CX-30  │            │           │            │         │          │        │         │     │
│  │ Múlt. propiet│            │           │            │         │          │        │         │     │
└──┴──────────────┴────────────┴───────────┴────────────┴─────────┴──────────┴────────┴─────────┴─────┘
```

El alto de fila **no cambia** en el caso general: la fila con «Múltiple propietario» ya medía cuatro
líneas (eran tres del trámite), y ahora las cuatro viven en la celda del vehículo. En las filas sin
múltiple propietario el alto lo sigue fijando la celda más alta, que no era la del trámite.

---

## Modal **Ver** — la rejilla resultante

Se borra **una** entrada de la `<dl className="grid grid-cols-2">`: `<Dato k="Trámites FLIT" …>`.

> ⚠ **La trampa está en el código, no en el diseño.** Hoy «Gestiona» y «Trámites FLIT» comparten
> línea física (`FlitoSoat.tsx:463-465`): `<Dato k="Gestiona" v={…} /><Dato k="Trámites FLIT" v={…} />`.
> **Borrar la línea se lleva «Gestiona» por delante.** Hay que borrar el elemento, no el renglón.

De 10 celdas a 9, así queda la rejilla (2 columnas, en orden de lectura):

| Fila | Izquierda | Derecha |
|---|---|---|
| 1 | VIN | Vehículo |
| 2 | Compañía | Organismo |
| 3 | Gestiona | **Enviado por** *(sube de la fila 4)* |
| 4 | Enviado | Valor pagado |
| 5 | Soporte *(«Ver soporte»)* | *(hueco)* |

**El hueco final se acepta**: «Soporte» es la única acción de la rejilla y terminar en ella, alineada
a la izquierda, se lee mejor que reordenar datos para cuadrar una paridad. **No se reordena nada
más**: el desplazamiento de los pares es consecuencia mecánica del `grid`, no una decisión de diseño.

### Pregunta abierta (afecta al gate de QA, no a la implementación)

**El AC2 dice «*And las fechas Creado y Aprob. siguen visibles*» — y en el modal, hoy, no están.**
Verificado: la `<dl>` muestra VIN, Vehículo, Compañía, Organismo, Gestiona, Trámites FLIT, Enviado
por, Enviado, Valor pagado y Soporte. `fechaCreacion` y `fechaAprobacion` **solo viven en la tabla**.

| Lectura | Qué implica |
|---|---|
| **A (por defecto)** — «siguen visibles» habla de la tabla; el AC2 solo prohíbe «Trámites FLIT» | **No se añade nada al modal.** Es lo que este documento especifica. Una HU de *quitar* no añade datos |
| **B** — el AC2 se lee literal sobre el modal | Añadir dos `<Dato k="Creado">` / `<Dato k="Aprob.">` con `fechaCorta(...)`, al final de la fila 4, dejando «Soporte» sola en la fila 6. Coste: 2 líneas. **Requiere el sí del PO**: es alcance nuevo |

**Recomendación:** preguntar antes del PR; si no hay respuesta, implementar **A** y dejar escrito en
el PR que el AC2 se verifica sobre la ausencia del rótulo «Trámites FLIT», que es lo único que ese AC
prohíbe de verdad. Que un AC se verifique contra una pantalla que no lo cumplía **antes** del cambio
es el tipo de frase que en este repo bloquea un cierre entero.

---

## Estados (4) + copy

**No se añade, cambia ni traduce ni una sola cadena** (salvo la variante B de arriba, si el PO la
aprueba). El copy de vacío y de error se conserva **textual**.

### Tabla de la cola

| Estado | Qué se ve | Copy | ¿Cambia con la HU? |
|---|---|---|---|
| **1 · Cargando** | Cabecera + tarjeta de filtros y **nada más**: `data` es `null` y esta pantalla **no tiene esqueleto**. La ficha de ayuda ya lo dice así: *«Cargando: la tabla aún no aparece»* (`content/ayuda/soat.md:23`) | — | **No.** Es una deuda **preexistente** frente a la regla de los 4 estados, y esta HU **no la paga**: un esqueleto es una pantalla nueva, no una columna menos. Se declara aquí para que no se cuele como regresión de #11905. **Si alguien lo añade en otra HU, debe nacer con 9/10 celdas** |
| **2 · Error** | `FlitCard` con el mensaje del servidor en rojo, **encima de la tabla anterior, que sigue pintada** (`data` no se limpia al fallar) | Mensaje del servidor vía `errorMessage(e)` | **No** — pero ojo: como la tabla anterior **permanece**, el encabezado «Trámite» tampoco puede aparecer en este estado. **Sin botón de reintento**: deuda preexistente (el reintento de facto es cambiar un filtro). Fuera de alcance |
| **3 · Vacío** | `FlitEmpty` en una tarjeta, **sin tabla** | Sin filtros: **«No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.»** · Con filtros: **«Ningún SOAT coincide con los filtros.»** | **No.** Ambas cadenas siguen siendo verdad: hablan de SOAT, no de trámites |
| **4 · Lleno** | Paginación · tabla `Pólizas SOAT` de **9/10** columnas · paginación | — | **Sí, y es el único.** Sin «Trámite»; «Múltiple propietario» bajo el vehículo |

### Modal **Ver**

| Estado | Cómo se manifiesta aquí |
|---|---|
| **1 · Cargando** | **No tiene estado propio**: el modal se pinta con la fila que la cola ya trajo (`filas.find(...)`). La única carga diferida es el **historial**, plegado por defecto y con su propio ciclo (`HistorialEstados`). Sin cambios |
| **2 · Error** | Error de una **acción** (rechazar, reversar, factura…), en rojo dentro del modal. Sin cambios |
| **3 · Vacío** | Por dato: **«—»** en cada `<Dato>` sin valor (`pesos`, `fecha` y los `?? '—'` ya lo resuelven). Por sección: el visor de soportes dice **«Este SOAT no tiene ninguna factura cargada todavía.»** Sin cambios. **Desaparece un «—» posible**: el de «Trámites FLIT» vacío |
| **4 · Lleno** | La rejilla de **9** celdas de arriba, sin «Trámites FLIT» |

---

## Accesibilidad — lo que esta HU no puede pagar de más

- **Cero paradas de tabulador nuevas o menos.** Se quita una celda de **texto**; el botón «Ver» y la
  casilla de `Pendiente` siguen siendo las únicas paradas por fila. Lo que se muda («Múltiple
  propietario») **sigue siendo texto**.
- **El dato se deja de renderizar; no se oculta.** Prohibido `hidden`, `sr-only`, `display:none` o
  un `<td>` vacío «por si acaso»: un lector de pantalla seguiría leyendo el id FLIT y el AC1 dice que
  **no lo ve**, no que no lo vea *quien mira*.
- **Prohibido meter el id FLIT en `data-*` o `aria-label`** «para que el test lo encuentre». Dos
  motivos independientes: reintroduce en el DOM justo lo que el AC quita, y los selectores de axe
  arrastran valores de atributo hasta 31 caracteres — identificadores de trámite acabarían en el
  informe de a11y.
- **Sin nombre accesible en la última columna** (`<FlitTh />` vacío del botón «Ver»): deuda
  **preexistente y compartida** con las otras colas. **No se arregla aquí** — sería tocar el patrón
  de las cuatro tablas justo en la HU que promete no heredarles nada.
- axe: recordar `QA_AXE_CDN=1` o salen ~10 rojos que no son regresión de nada.

---

## Impacto sobre pruebas existentes (hay **una** y hay que renombrarla)

`apps/web/e2e/tests/flito-soat.spec.ts`, test **«la cola enseña tipo de trámite y las dos fechas,
como las demás tablas»** (líneas 226-236):

| Línea | Aserto | Qué le pasa |
|---|---|---|
| 232 | `expect(fila).toContainText('Traspaso')` | **Se invierte** a `not.toContainText` |
| 233 | `expect(fila).toContainText('FLIT-1002')` | **Se invierte** a `not.toContainText`. Es el corazón del AC1 |
| 235 | `expect(fila ABC123).toContainText('Sin aprobar')` | **Sobrevive intacto** — es lo que acredita el *«And sí ve … las fechas Creado y Aprob.»* |

**Y se renombra el test**: un título que siga diciendo «enseña tipo de trámite» es una mentira
archivada. Propuesta: *«la cola enseña vehículo y las dos fechas, y **ya no** el trámite»*.

**Ningún otro test se rompe** (verificado): `kit-flit-tema-oscuro.spec.ts` usa `FLIT-9099` sobre
`/flito/derechos`, no sobre SOAT; `modales-encima-del-menu.spec.ts` solo lo lleva en el *fixture*;
las fichas de ayuda no enumeran esta columna (`soat.md:26` lista «compañía, quién gestiona, estado,
solicitado, pagado y valor») y ningún test compara esa ficha con la pantalla. **`soat.md` no queda
desactualizada.**

**Dato que ahorra una discusión:** el buscador de la cola **no busca por id FLIT** — solo placa, VIN,
nombre y documento de comprador (`flito-soat.service.ts:183-197`). Y no hay faceta, filtro ni orden
por trámite. Quitar la columna **no deja ningún control huérfano**: nadie podrá filtrar por algo que
ya no ve.

---

## Notas QA (10) — cada una con el mutante que debe matar

1. **AC1, y el aserto tiene que estar ANCLADO.** Primero `expect(tabla.getByRole('columnheader')).toHaveCount(10)`
   (admin con pendientes) y **solo entonces** `expect(tabla.getByRole('columnheader', { name: 'Trámite' })).toHaveCount(0)`,
   con `tabla = page.getByRole('region', { name: 'Pólizas SOAT' })`. *Mutante:* reponer
   `ENCABEZADOS_COMUNES` → 11 y 1. **Sin el conteo previo, el aserto de ausencia pasa también con la
   tabla sin cargar, vacía o en error**: es el falso verde más barato de esta HU.
2. **AC1 en la fila, filtrando por placa y no por el id.** `fila = getByRole('row').filter({ hasText: 'XYZ789' })`;
   `not.toContainText('FLIT-1002')` y `not.toContainText('Traspaso')`. *Mutante:* reponer `<CeldaTramite>`.
3. **El fixture debe SEGUIR trayendo el trámite, y el test debe exigirlo.** La API no deja de
   enviarlo; si alguien «arregla» el rojo vaciando `tramitesFlit`/`tipoTramite` del mock, el test
   queda verde sin probar nada. Se blinda con `expect(SOAT_FIXTURE.tramitesFlit).toContain('FLIT-1002')`
   dentro del propio test. *Mutante:* vaciar el fixture.
4. **AC1 — lo que sí sigue.** En la misma fila: la placa, el VIN, «Creado» con su fecha, y «Sin
   aprobar» en la fila sin aprobación. *Mutante:* llevarse `<CeldaFechas>` de paso al borrar la
   columna vecina (dos celdas contiguas, un borrado descuidado).
5. **AC3 — los tres roles, en bucle.** El mismo aserto para `admin`, `auditor` y `proveedor`
   (conteo 10/9/9). *Mutante:* `{esOperaciones && <CeldaTramite …/>}`, una «vista privilegiada» —
   probar solo con `proveedor` la deja viva; probar solo con `admin` deja viva la inversa.
6. **AC2 acotado al `<dl>`, NUNCA al `dialog` entero.** El aserto es la ausencia del **rótulo**
   «Trámites FLIT». Un `expect(modal).not.toContainText('FLIT-1002')` sale **rojo por un motivo que
   el AC no prohíbe**: el historial de estados trae la cadena dentro del texto «Alta desde FLIT
   (trámite FLIT-1002)» (ver el propio spec, línea 199) — y «arreglarlo» borrando ese motivo sería
   destruir trazabilidad para pasar un test.
7. **AC2 — el vecino de línea.** Comprobar que el modal **conserva** «Gestiona» con su valor (y
   «Enviado por», «Enviado», «Valor pagado», «Ver soporte»). *Mutante:* borrar la línea 465 entera,
   que se lleva «Gestiona» por delante. Es el error más probable de toda la HU.
8. **AC4 — las tres colas vecinas, con aserto propio.** En `flito-impuestos`, `flito-derechos` y
   `finanzas-reporte-costos`: `expect(tabla.getByRole('columnheader', { name: 'Trámite' })).toHaveCount(1)`
   y el id FLIT visible en su fila. *Mutante:* tocar `ENCABEZADOS_COMUNES` o `CeldaTramite` en
   `columnasComunes.tsx` — **las tres caen a la vez**. Sin estos asertos, el AC4 es una promesa; con
   ellos, es un gate.
9. **El dato fuera del DOM, no oculto.** `expect(tabla.getByText('FLIT-1002')).toHaveCount(0)`:
   `toHaveCount` cuenta nodos aunque estén ocultos, así que mata al mutante «esconderlo con
   `hidden`/`sr-only`», que `toBeVisible()` dejaría pasar.
10. **Desborde coherente, medido en los dos sentidos.** A un viewport fijo (1280): medir
    `scrollWidth > clientWidth` en el contenedor de `FlitTable` y exigir que `[data-desborde]` y el
    `tabIndex` **coincidan con la medida**, no con un valor fijado a ciegas. *Mutante:* `table-fixed`
    o un `min-w` clavado en la tabla, que desacopla lo pintado de lo medido.

> **Recordatorio de infraestructura:** el CI **solo corre un spec E2E** (el visor de PDF).
> `flito-soat.spec.ts` está en la lista fija del **nocturno**: verde en el PR no significa que nadie
> lo haya ejecutado. Quien cierre la HU debe correrlo a mano.

---

## Recomendación para el eslabón 2 (HU #11906) — cilindraje, carrocería, tipo de servicio

Es una recomendación de diseño **para no implementar hoy**, escrita ahora porque decide qué se hace
con el hueco que esta HU abre.

### 1. En la celda del vehículo, **no** en tres columnas nuevas

La tabla venía de 11 columnas; con tres nuevas subiría a **13** — más que antes de esta HU, y con el
desborde de vuelta y peor. Además son tres atributos **del mismo objeto que ya tiene columna**, con
«—» frecuente: tres columnas casi vacías para servir a una minoría de filas es exactamente lo que
`columnasComunes.tsx` ya argumenta que no se haga.

**Forma propuesta —** una línea más en la celda del vehículo, `text-xs`, `--flit-text-muted`, con
**rótulo corto** y las **tres ranuras siempre presentes** en orden fijo:

```
XYZ789
9BW…12345
Mazda CX-30
Cil. 1.600 · Carr. Sedán · Serv. Particular      ← eslabón 2
Múltiple propietario                              ← eslabón 1
```

Los rótulos no son adorno: es el mismo argumento por el que `CeldaFechas` rotula «Creado» y «Aprob.»
—está escrito en ese archivo—. Sin ellos, la fila a la que FLIT no le manda nada diría `— · — · —`,
que no informa de qué falta. **Coste declarado:** ~18 px de alto en **todas** las filas. Se paga en
alto, que en esta tabla es el recurso abundante; el ancho, que es el escaso, lo pone el hueco que
deja «Trámite».

### 2. **Celda local**, no una prop nueva en la compartida

`CeldaVehiculoSoat`, **local a `FlitoSoat.tsx`** — y conviene que **nazca ya en el eslabón 1**, que
es donde hay que alojar «Múltiple propietario»: así el chip no se muda dos veces y el diff del
eslabón 2 es una línea.

Se descarta añadir `atributos?: ReactNode` a la `CeldaVehiculo` compartida aunque sea aditiva y
aunque las otras tres colas no la pasarían: el AC4 quedaría satisfecho **por omisión de un
argumento** en tres llamadas, no por construcción, y rompería en silencio el invariante que ese
archivo declara —*«si mañana el vehículo gana un dato, lo ganan las cinco tablas a la vez o
ninguna»*—. **Contrapartida honesta:** ~12 líneas duplicadas que pueden derivar del kit. Se mitiga
con un comentario cruzado en los dos archivos, y se acepta.

### 3. **Los tres datos no existen: hay requerimiento previo**

Verificado, y esto es lo que puede bloquear la #11906 si nadie lo mira antes:

- `SoatColaItem` **no** los tiene, ni en el front ni en `flito-soat.service.ts`.
- `flito_tramites` **no** los tiene (`schema.ts:2591`); apunta al vehículo por `vehiculo_id`.
- `vehicles` **no** tiene cilindraje, carrocería ni tipo de servicio (`schema.ts:136`).
- Lo único parecido es **`flito_mock_tramite.cilindraje`** (`migrations/0096`), que es **andamiaje
  del mock** y se retira con FLIT real. Carrocería y servicio no están ni ahí.

> **Handoff necesario antes de la #11906:** `architecture-agent` / backend deben decidir de dónde
> salen los tres (adaptador FLIT, `flitRaw`, o consulta al RUNT), dónde se persisten y cómo entran al
> contrato de la cola. Conviene **confirmarlo contra la BD real**, no solo contra `schema.ts`.
> Mientras tanto la #11906 es una HU de datos con una línea de UI, y no al revés.

---

## Decisiones y descartes (resumen citable en el PR)

| # | Decisión | Descarte principal |
|---|---|---|
| 1 | «Múltiple propietario» **se conserva**, mudado a la celda del vehículo, con su tipografía actual | Dejarlo caer con la columna: pérdida que ningún AC pide |
| 2 | El ancho liberado **no se reparte a mano**: sin `min-w`, sin `table-fixed`, sin reordenar | Clavar anchos «para que quede bonito», y renegociarlos en la #11906 |
| 3 | `thead` con **dos literales**, no `ENCABEZADOS_COMUNES.slice(1)` | Depender de la posición dentro de un array de otras tres pantallas |
| 4 | «Varios trámites» **se pierde** y la pérdida se declara (fechas `null` sin explicación) | Reintroducir el trámite por la puerta de atrás para explicarlas |
| 5 | El modal **no gana** «Creado»/«Aprob.» sin el sí del PO; la variante B queda escrita y lista | Ampliar alcance en una HU de quitar |
| 6 | Eslabón 2: celda **local**, atributos **dentro** del vehículo, con rótulos cortos | Tres columnas nuevas (13 en total) o una prop en la celda compartida |
