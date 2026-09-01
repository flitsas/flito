# UX slim — La columna «Municipio» del visor de comparendos (HU #11879)

> **Anexo de `docs/ux/flito-comparendos-visor.md`, no lo sustituye.** Mismo patrón que
> `docs/ux/flito-comparendos-estado-fuente.md` (HU #11777): una decisión sobre una sola celda vive en
> su propio archivo y el documento madre la referencia con un tachado y una remisión. Al final está la
> lista exacta de remisiones a insertar en el documento madre.
>
> **Lo que aquí se decide ya está decidido por el Líder Técnico.** Este anexo no reabre nada: escribe
> las consecuencias en pantalla, el copy y las notas de QA. Lo cerrado, en tres líneas:
> la columna se llama **«Municipio»**, a secas; **ninguna celda rotula su contenido**; la celda pinta
> **`municipioComparendo`** (HU #11878) y, si no se pudo resolver, **el organismo tal cual**.

---

## 1 · Qué cambió debajo, que es lo que legitima el cambio de arriba

La HU #11795 dejó la columna «Municipio u organismo»: una cabecera que anuncia **una disyunción** y
una celda que **rotula cuál de las dos ramas trae**. Era la única salida honesta mientras el dato de
la tabla fuera `municipioFuente` —el municipio **al que se preguntó**, `null` en toda fila que solo
vio el SIMIT—, porque entonces la celda de verdad mostraba dos cosas distintas según la fila.

La HU #11878 acaba con esa premisa. `ComparendoRegistro` trae ahora **`municipioComparendo`**: el
municipio **de donde ES el comparendo**, derivado por el sync en dos escalones —el municipio que
respondió; y si no, el único `codigoFuente` del catálogo que aparece en el texto del `organismo` con
límite de palabra— y `null` cuando ninguno de los dos resuelve o cuando el organismo reconoce **dos**
(la ambigüedad no se desempata, se declara). El filtro del listado y la columna «Municipio» del
`.xlsx` **ya comparan y publican esa columna** (`flito-comparendos.ts:277-298, 507-523`;
`flito-comparendos.export.service.ts:102`).

Consecuencia de diseño, y es toda la HU: **la celda deja de mostrar dos datos distintos y pasa a
mostrar uno**. Un rótulo por celda que anuncia la rama sobra cuando ya no hay dos ramas; una cabecera
que dice «u» miente por exceso de cautela. Lo que David reportó —una columna que cambia de
significado obliga a leer cada celda dos veces— era cierto y ahora tiene arreglo, no solo mitigación.

**Lo que NO se cae con esto**, y hay que dejarlo escrito porque es lo que se revoca a medias:

- **La prohibición de deducir en el cliente sigue entera.** El front no busca «Medellin» en el
  catálogo, no normaliza con `normalizarCodigoFuente` «a ver si coincide» y no escribe nada. La
  deducción la hace el **servidor**, la persiste y la audita; el SPA pinta lo que le llegó.
- **`municipioFuente` no cambia de valor ni de significado.** Sigue en el contrato como trazabilidad
  de la corrida. Lo que cambia es que **el SPA deja de pintarlo**, en la tabla y en el panel (§4).
- **«Organismo» no vuelve como columna.** Sería la quince (#11713). Sigue entero en el panel y en el
  Excel, que es donde el operador lo cita cuando reclama.

---

## 2 · La celda, en concreto

```
┌ Municipio ─────────────┐   ┌ Municipio ─────────────┐   ┌ Municipio ─────────────┐
│ Medellín               │   │ STRIA DE TTOyTTE       │   │ —                      │
│                        │   │ MEDELLIN               │   │                        │
└────────────────────────┘   └────────────────────────┘   └────────────────────────┘
  municipioComparendo          municipioComparendo=null      los dos en null
  = 'MEDELLIN'                 organismo con valor
```

**Regla de contenido, en una línea:** `municipioComparendo` traducido por el catálogo si lo hay; **si
y solo si** es `null`, el `organismo` **tal cual**; si tampoco hay organismo, `—`.

| Caso | Qué se pinta | Detalles que no se ven en el JSX |
|---|---|---|
| **Municipio resuelto** | `catalogos.municipios[municipioComparendo] ?? municipioComparendo` | Misma búsqueda que hoy, **otra clave**: `municipioComparendo` es un `codigoFuente` igual que `municipioFuente`, así que el catálogo sirve sin tocarlo. Catálogo caído → **código crudo** («ITAGUI») y la tabla se pinta igual (nota 35 del documento madre) |
| **Sin municipio, con organismo** | `organismo`, **sin rótulo, sin prefijo y sin `sr-only`** | Tal cual lo mandó la fuente: ni `capitalize`, ni `uppercase`, ni tildes puestas por nosotros, ni traducido por el catálogo de municipios. «Medellin» se queda sin tilde y «STRIA DE TTOyTTE MEDELLIN» se queda entero: es lo que el operador puede tener que citar |
| **Ninguno de los dos** | `—` + `<span className="sr-only">Sin dato</span>` | Ya existe: `SinDato()` en `TablaComparendos.tsx:160`. Un guion solo se lee como un guion, o no se lee |

**Nunca los dos a la vez.** Pintar «Medellín · STRIA DE TTOyTTE MEDELLIN» sería reponer la columna
«Organismo» dentro de otra celda, con la misma anchura y ninguna de las dos decisiones de la #11713
respetada.

### Ancho y alto — el organismo es `varchar(120)`

**El tratamiento medido de la #11777 se conserva tal cual y no se recalcula**, porque el peor caso no
cambió: `municipioComparendo` es un código corto, pero la rama de respaldo sigue admitiendo 120
caracteres.

- `wrap-anywhere` (no `break-words`: es el único que no infla la contribución de tamaño **mínimo** de
  la celda en una tabla de layout automático).
- `min-w-[11rem]` **y** `max-w-[11rem]`, los dos. El techo solo, en una tabla que ya desborda, aprieta
  la columna contra su mínimo —que con `wrap-anywhere` es **un carácter**— y el organismo vuelve a
  cortarse en horizontal. Está medido en el documento madre: 120 caracteres de la letra más ancha dan
  `scrollHeight` 200 px en `clientWidth` 176 px, con `scrollWidth` = `clientWidth`, o sea nada
  cortado.
- `line-clamp-[12]` sigue siendo **airbag**, no recorte: 10 líneas es el peor caso medido, dentro de
  `varchar(120)` nunca actúa y existe para que ampliar la columna en la base no convierta una fila en
  veinte líneas sin que nadie se entere.
- **No se estrecha la columna «porque ahora casi siempre cabe "Medellín"».** Estrecharla optimizaría
  el caso común rompiendo el caso que la celda existe para no esconder. 11 rem es el ancho, y el
  ancho **no cambia**: esta HU no añade ni un píxel de scroll horizontal a 1280 px.

**El alto de la fila BAJA una línea**, y eso tiene una consecuencia obligatoria que se olvida sola:

> **La celda sale de `COLUMNAS_A_DE_DOS_LINEAS`** (`TablaComparendos.tsx:157`). El esqueleto tiene que
> pasar de **dos** barras apiladas a **una**; ese `Set` se queda solo con `TH_FECHAS`. Si no se toca,
> la fila fantasma es **más alta** que la fila con datos y la tabla **encoge** al cargar, que es
> exactamente el defecto que el esqueleto existe para evitar, con el signo cambiado.

**La tabla sigue en 14 columnas** con «Inactivado» puesto y **10** por debajo de 1280 px. Ni una
columna nueva, ni una retirada.

---

## 3 · Los cuatro estados de las superficies tocadas

### Tabla de registros (`TablaComparendos` dentro de `VistaRegistrosComparendos`)

Los cuatro estados de la **lista** no cambian —esta HU no toca la consulta ni sus respuestas—; lo que
se especifica es qué se ve **en la celda «Municipio»** dentro de cada uno.

| Estado | La superficie | La celda «Municipio» |
|---|---|---|
| **1 · Cargando** | Ocho filas fantasma dentro de `FlitTable`, `role="status" aria-busy="true" aria-label="Cargando comparendos"`; `animate-pulse motion-reduce:animate-none`. La barra de filtros **no se desmonta ni se inhabilita** | **UNA barra**, del alto de una línea (cambio respecto de la #11795). La cabecera sale de `COLUMNAS_A`, que sigue siendo fuente única |
| **2 · Error** | Banda `role="alert"` dentro de `FlitCard`, encima de la tabla, **con la tabla anterior borrada**. Copy derivado del código de estado, **sin eco del mensaje del servidor** (#11559, sigue en suspenso). `[Reintentar]`; el 403 sin reintento; `cursor_invalido` → `[Volver a la primera página]` | No se pinta ninguna celda: no hay tabla |
| **3 · Vacío** | **A** (sin filtros): «Todavía no hay comparendos registrados…». **B** (con filtros): «Ningún comparendo coincide con lo que buscaste», repitiendo los filtros puestos + `[Quitar los filtros]`. **La frase condicionada al filtro de municipio cambia de texto — ver §5** | No se pinta ninguna celda |
| **4 · Lleno** | Tabla + `PaginacionCursor` («50 comparendos en esta página · página 2»), sin total | Los tres casos de §2. `<td>` **mudo**: sin `tabIndex`, sin control dentro, una sola parada de tabulador por fila (el número de comparendo) |

### Panel de detalle (`PanelDetalleComparendo`)

| Estado | Qué se ve |
|---|---|
| **1 · Cargando** | Esqueleto dentro del panel; el `<dl>` no se pinta a medias |
| **2 · Error** | Error **dentro del panel** + `[Reintentar]`. 404 → «Ya no existe» + `[Cerrar y recargar la lista]` |
| **3 · Vacío** | El panel no tiene vacío propio: la ausencia es **por campo**. «Municipio» → `—` cuando `municipioComparendo` es `null`; «Organismo» → `—` cuando no vino. Mismo tratamiento de ausencia que el resto del `<dl>` |
| **4 · Lleno** | «Organismo» con el texto **entero y tal cual**, y «Municipio» **inmediatamente después**, en el orden que ya tienen. Los dos siguen siendo **dos `<dt>` separados**: aquí no hay respaldo ni fusión de ningún tipo |

---

## 4 · El panel no puede contradecir a la tabla — el cambio que se olvida

`PanelDetalleComparendo.tsx` deriva hoy su municipio de **`municipioFuente`** en dos sitios:

- `:141-143` — `const municipio = detalle?.municipioFuente ? catalogos.municipios[…] : null`
- `:193` — la línea de resumen «Municipio: …» junto al chip de estado y al origen
- `:221` — el `<dt>` «Municipio» del `<dl>` de datos de fuente

Si esta HU solo toca la tabla, una fila que solo reportó el SIMIT enseñará **«Medellín» en el
listado** y **«Municipio: —» en su propio detalle**, con el panel abierto encima de la fila que dice
lo contrario. Eso no es una inconsistencia cosmética: es la pantalla desmintiéndose a sí misma sobre
el dato por el que además se filtra.

**Decisión: las tres lecturas pasan a `municipioComparendo`**, con la misma traducción por catálogo.
El panel queda diciendo lo mismo que la celda de su fila en el caso resuelto, y en el caso sin
resolver dice **más** —«Municipio: —» y «Organismo: STRIA DE TTOyTTE MEDELLIN»—, que es justo lo que
el panel existe para hacer: desambiguar lo que la tabla resume.

**`municipioFuente` deja de pintarse en el SPA, y no se le añade un campo propio.** Es trazabilidad de
la corrida —a quién se le preguntó—, no un hecho del comparendo; hoy tampoco tiene rótulo propio en
ninguna superficie y el `.xlsx` de la #11878 ya prescindió de él sin añadir columna. Un tercer campo
con la palabra «municipio» en el mismo `<dl>` recrearía en el detalle exactamente la confusión que
esta HU cierra en la tabla. **Si producto lo quiere visible, es una HU aparte con su rótulo propio**
(«Municipio consultado») — no un efecto colateral de esta.

---

## 5 · Copy que hay que cambiar porque hoy afirma algo falso

Tres textos del SPA dan por cierto que «los comparendos que solo reportó SIMIT no tienen municipio».
**Con la #11878 dentro eso es falso**, y dejarlos es peor que no haberlos escrito nunca: enseñan al
operador a no usar un filtro que ya funciona.

### 5.1 · Ayuda del filtro de municipio — `BarraFiltrosComparendos.tsx:348`

**Hoy (falso):**
> «El filtro busca por el municipio al que se le consultó. Los comparendos que solo reportó SIMIT no
> tienen municipio y no salen aquí, aunque su organismo lo mencione.»

**Nuevo:**
> «Busca por el municipio donde se impuso el comparendo, lo haya reportado SIMIT o el municipio. Los
> pocos cuyo municipio no se pudo determinar —en la tabla se les ve el organismo— no salen aquí.»

Por qué así y no más corto: la frase tiene que hacer **dos** trabajos. Decir lo que ahora sí ocurre
—las filas de SIMIT entran— y seguir cubriendo el residuo, que es pequeño pero existe por
construcción (organismo que no reconoce ningún municipio del catálogo, o que reconoce dos). El
paréntesis es lo que ata el residuo a algo **visible**: quien lea «no se pudo determinar» sin más se
queda sin saber qué filas son, y con el paréntesis puede reconocerlas en la tabla a simple vista.

**Se mantiene el comentario del código en ese punto, reescrito:** el filtro sigue siendo igualdad
exacta contra un `codigoFuente` normalizado —ahora `municipioComparendo`— y esa exactitud es lo que
sostiene el índice y el cursor. Que ahora acierte más no lo convierte en una búsqueda por texto.

### 5.2 · Frase condicionada del Vacío B — `VistaRegistrosComparendos.tsx:344-349`

Se conserva la **condición** (solo con el filtro de municipio puesto; con otro filtro sería ruido) y
se cambia el texto.

**Hoy (falso):**
> «Los comparendos que solo reportó SIMIT no tienen municipio, así que no aparecen con este filtro
> aunque su organismo diga ese mismo nombre.»

**Nuevo:**
> «Si sabes que hay comparendos de ese municipio, puede que no se haya podido determinar de dónde
> son: en la tabla esas filas muestran el organismo en el lugar del municipio.»

### 5.3 · `caption` `sr-only` de la tabla — `TablaComparendos.tsx:225-226`

**Hoy (falso):**
> «"Municipio u organismo" dice a qué municipio se consultó; cuando el comparendo solo lo reportó
> SIMIT, la celda muestra el organismo que lo impuso, rotulado como tal.»

**Nuevo:**
> «"Municipio" es el municipio donde se impuso el comparendo. Cuando no se pudo determinar, la celda
> muestra el organismo de tránsito que lo impuso.»

Las otras tres frases del `caption` —«Monitoreo» no habla de pagos, «Estado en la fuente» sin
normalizar y puede venir vacío, «Tipo» distingue comparendo de multa— **no se tocan**.

> **Comprobación de regresión, barata y literal:** tras la HU, `grep -r "no tienen municipio"
> apps/web` y `grep -r "u organismo" apps/web` no devuelven nada. Son las dos cadenas que quedan
> mintiendo si alguien cambia el JSX y se olvida del texto.

---

## 6 · Accesibilidad

### Cabecera

`<th scope="col">Municipio</th>` — **una palabra**. Un lector de pantalla en modo tabla anuncia la
cabecera **cada vez que se cambia de celda**: con 50 filas, «Municipio u organismo… Medellín» son
cinco palabras repetidas cincuenta veces para un dato de una. La cabecera corta es, por sí sola, una
mejora de escucha, no solo de lectura.

**Qué se pierde al quitar el rótulo doble, dicho sin adornos.** El argumento de la #11795 era
correcto en su contexto: una cabecera que **afirma una categoría** sobre una celda que a veces
contiene otra miente en esas filas. Eso sigue pasando en **las filas sin municipio resuelto** —«Municipio…
STRIA DE TTOyTTE MEDELLIN»— y no se disimula. Lo que cambió es cuánto pesa: con la #11878 esas filas
dejan de ser «todas las de SIMIT» para ser el residuo que ni la consulta municipal ni el catálogo
resolvieron. Se compensa por tres vías, ninguna de ellas un rótulo por celda:

1. **El `caption`**, que es el único texto que un lector anuncia con seguridad **al entrar** en la
   tabla, y que lo dice explícitamente (§5.3). Es donde la #11713 ya puso las advertencias que
   ninguna cabecera de una palabra puede dar.
2. **El panel de detalle**, a un Enter de la fila, donde «Municipio» y «Organismo» son **dos `<dt>`
   distintos** y la ambigüedad no existe.
3. **La ayuda del filtro** (§5.1), visible siempre, que nombra el mismo residuo desde el otro lado.

**La discusión «u» contra «/» se cierra sola y conviene que quede escrito**, porque el motivo de
aquella elección era de accesibilidad y alguien va a querer «restaurarla»: sin disyunción en la
cabecera **no hay separador que pronunciar**. Ni «/» ni «u» ni «o». La cabecera es un sustantivo.

### Celda

- **Ni `title` ni `aria-label` sobre el organismo largo, y no es un olvido.** Un `title` no lo alcanza
  el teclado, no existe en táctil y los lectores lo anuncian de forma desigual; un `aria-label` sobre
  un `<td>` no es fiable —no es un elemento etiquetable— y, sobre todo, **sustituiría** el texto
  visible por otro en la escucha. Y no hacen falta para nada: **la celda envuelve y muestra los 120
  caracteres enteros**, así que no hay texto escondido que un tooltip tenga que revelar. Es la misma
  conclusión que ya rigen la infracción (#11562) y el estado en la fuente (#11777).
- **Tampoco un `sr-only` que diga «Organismo» en las filas de respaldo.** Sería dar a quien escucha
  una desambiguación que a quien mira se le niega, y la asimetría al revés ya se rechazó en la #11795
  con este mismo argumento. Quien ve la pantalla tiene exactamente el mismo problema que quien la
  oye, y por eso la respuesta va en el `caption` y en el detalle, que sirven a los dos.
- **El `—` conserva su `sr-only` «Sin dato».** Esto sí se queda: un guion suelto o se lee «guion» o no
  se lee, y en ningún caso significa nada.
- **Contraste y color: el valor va en `--flit-text-primary`, siempre, venga de donde venga.** No se
  atenúa el organismo con `--flit-text-muted` para «marcar que es el respaldo» —no llega a 4.5:1, es
  el gris de los guiones, y sería reintroducir el rótulo por medio del color, que además ningún lector
  anuncia—. Ni cursiva, ni tamaño distinto, ni un icono. El rótulo secundario que la celda tenía
  desaparece con él; no queda ningún texto nuevo que medir.
- **Foco:** la celda sigue siendo un `<td>` mudo. Una parada de tabulador por fila —el `<button>` del
  número de comparendo, con su nombre accesible propio—. Con 50 filas × 14 columnas, celdas
  enfocables serían 700 paradas hasta la paginación.
- **Reflow (1.4.10) y espaciado (1.4.4):** el `wrap-anywhere` con `min-w` **y** `max-w` es lo que
  garantiza que a 200 % de zoom el texto se reacomode en vertical y no quede cortado en horizontal.
  Es una comprobación **medida en el navegador** (`scrollWidth` contra `clientWidth`), no a ojo.

---

## 7 · Notas para QA

1. **Cabecera exacta:** existe un `th` cuyo texto es exactamente `Municipio`, y **no existe** ninguno
   que diga `Municipio u organismo`. Aserción por texto exacto, no `contains`.
2. **Resuelto:** fila con `municipioComparendo: 'MEDELLIN'` y `organismo: 'STRIA DE TTOyTTE MEDELLIN'`
   → la celda dice `Medellín` (catálogo cargado) y **no contiene** `STRIA` ni la palabra `Municipio`
   dentro del `<td>`.
3. **De SIMIT y resuelto — el caso que la HU #11878 arregla:** fila con `municipioFuente: null`,
   `municipioComparendo: 'MEDELLIN'`, `organismo: 'Medellin'` → la celda dice `Medellín`, **con
   tilde** (viene del catálogo, no del organismo). Es la aserción que distingue esta HU de la #11795.
4. **Sin resolver:** fila con `municipioComparendo: null` y `organismo: 'Medellin'` → la celda dice
   `Medellin` **sin tilde**, y **no contiene** el rótulo `Organismo`, ni el rótulo `Municipio`, ni
   `—`. Mismo caso con `'Bogota D.C.'`: se lee tal cual, con el punto y sin tilde.
5. **Ausencia total:** los dos en `null` → un solo `—` y el `sr-only` `Sin dato`.
6. **Catálogo caído** + `municipioComparendo: 'ITAGUI'` → se lee `ITAGUI` y **la tabla se pinta igual**
   (nota 35 vigente del documento madre).
7. **Organismo de 120 caracteres** (el peor caso del contrato) **se lee entero**: medido en el
   navegador, `scrollWidth === clientWidth` en la celda y el `line-clamp` no actúa. No vale a ojo.
8. **Esqueleto:** la celda de «Municipio» tiene **UNA** barra fantasma, no dos, y el alto de la fila
   fantasma coincide con el de la fila con datos. Es la regresión que deja la #11795 si nadie toca
   `COLUMNAS_A_DE_DOS_LINEAS`.
9. **Filtro:** filtrar por municipio `MEDELLIN` **sí** devuelve la fila del punto 3 (solo SIMIT), y la
   petición **no manda ningún parámetro nuevo** (el esquema del backend es `.strict()`). La tabla
   sigue con **14** cabeceras con «Inactivado» puesto y **10** por debajo de 1280 px; `Organismo`
   **no** es un `th`.
10. **Copy y coherencia:** la ayuda del filtro está visible **siempre** con el texto de §5.1; el
    Vacío B trae la frase de §5.2 **solo** con el filtro de municipio puesto; el `caption` trae la de
    §5.3; `grep -r "no tienen municipio" apps/web` y `grep -r "u organismo" apps/web` **no devuelven
    nada**. Abrir la fila del punto 3 → el panel dice `Municipio: Medellín`, **no** `—`, y conserva
    `Organismo: Medellin` como campo aparte; el `.xlsx` no cambia.

**Mutaciones obligatorias — una por decisión, y hay tres:**

- **a.** Leer `municipioFuente` en vez de `municipioComparendo` en la celda → **la prueba 3 se pone
  roja**. Si sigue verde, el fixture no distingue los dos campos y la prueba no comprueba la HU.
- **b.** Traducir el organismo con el catálogo de municipios (`'Medellin'` → `'Medellín'`) → **la
  prueba 4 se pone roja**. Es la mutación de «el organismo se pinta tal cual».
- **c.** Reponer un rótulo (`Organismo`, o un `sr-only` equivalente) en la rama de respaldo → **la
  prueba 4 se pone roja**. Si sigue verde, la aserción mira el valor y no la ausencia de rótulo, que
  es la decisión entera de esta HU.

---

## 8 · Remisiones a insertar en `docs/ux/flito-comparendos-visor.md`

El documento madre **no se reescribe**: se tacha lo que caduca y se remite aquí, que es como se
resolvieron la #11713, la #11777 y la propia #11795. Lo que caduca, con su línea:

| Línea | Qué dice hoy | Qué hacer |
|---|---|---|
| **371** (tabla de columnas, fila «Municipio u organismo») | «Renombrada el 24 ago 2026… la celda muestra `organismo` **con el rótulo «Organismo»**» | Tachar el texto de la #11795 y remitir a este anexo: la columna vuelve a llamarse **«Municipio»**, la celda pinta `municipioComparendo` y **ninguna celda rotula** |
| **1630-1663** (§9, «una sola columna, dos rótulos posibles») | La regla de contenido contra `municipioFuente`, el rótulo obligatorio y el párrafo de «ninguna columna puede llamarse solo Municipio» | **Revocado por la HU #11879**, con el motivo del §1 de este anexo: la premisa era que la celda mostraba dos datos distintos, y la #11878 la deshizo. Lo que **sigue vigente**: nunca los dos a la vez; el organismo tal cual; «Organismo» no vuelve como columna |
| **1664-1701** (§10, «cómo se distingue») | Rótulo primero, rótulo siempre, valor nunca desnudo | **Revocado** salvo los dos últimos bullets: «el valor se pinta TAL CUAL» y el tratamiento de ancho (`wrap-anywhere` + `min-w` **y** `max-w` + `line-clamp` de airbag, 11 rem medidos) **siguen enteros** |
| **1702-1711** (§11, cuatro estados de la celda) | Cuatro filas con rótulo, y «dos barras apiladas» en el esqueleto | Sustituir por el §3 de este anexo. **Ojo a la barra del esqueleto: pasa de dos a una** |
| **1735-1766** (§13, «la consecuencia contraintuitiva») | «Una fila de SIMIT cuya celda dice "Organismo · Medellin" NO aparece al filtrar por MEDELLIN» | **Revocado: ya no es cierto.** La #11878 mudó el filtro a `municipioComparendo` y esas filas **sí** salen. Queda un residuo distinto —el municipio que no se pudo determinar—, con el copy nuevo del §5 |
| **1793-1834** (notas de QA 10-24, bloque «Municipio u organismo») | Aserciones sobre los rótulos `Municipio` / `Organismo` en la celda | Sustituir por el §7 de este anexo. Las notas 11, 12, 13, 20 y las tres mutaciones **afirman lo contrario** de lo que esta HU implementa: si se quedan, QA da la HU por rota |
| **160-167** (requerimiento 4) | Ya enmendado el 24 ago | Añadir una línea: desde la #11879 la celda pinta `municipioComparendo`; la **prohibición de deducir en el cliente** sigue entera y ahora además es innecesaria, porque la deducción la hace el sync y queda auditada |

---

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: docs/ux/flito-comparendos-municipio.md (anexo; el documento madre se tacha y remite, §8)
  Pantallas: 2 superficies tocadas (tabla de registros + panel de detalle) | Requerimientos nuevos de datos: ninguno
             (`municipioComparendo` ya llega en cada fila y en el detalle desde la HU #11878)
  Cambios normativos:
    · La columna vuelve a llamarse «Municipio», a secas; NINGUNA celda rotula su contenido
    · La celda pinta `municipioComparendo` traducido por el catálogo; si es null, el `organismo` TAL
      CUAL; si tampoco hay, «—» con sr-only «Sin dato». Nunca los dos a la vez
    · El esqueleto pasa de DOS barras a UNA en esa celda (sale de COLUMNAS_A_DE_DOS_LINEAS), o la
      fila fantasma queda más alta que la fila con datos
    · Ancho intacto: wrap-anywhere + min-w Y max-w 11 rem + line-clamp de airbag (medida de la #11777).
      No se estrecha «porque ahora casi siempre cabe Medellín». 14 columnas / 10 bajo 1280 px
    · El panel de detalle pasa sus TRES lecturas de `municipioFuente` a `municipioComparendo`
      (PanelDetalleComparendo.tsx:141-143, :193, :221), o el panel contradice a su propia fila
    · `municipioFuente` deja de pintarse en el SPA. NO se le añade campo propio: sería otra HU
    · Tres textos que hoy afirman algo falso se reemplazan: ayuda del filtro, frase del Vacío B y
      caption sr-only. Regresión: `grep "no tienen municipio"` y `grep "u organismo"` en apps/web = 0
    · A11y: sin title, sin aria-label y sin sr-only de rótulo. La disyunción «u» vs «/» se cierra sola
      porque la cabecera deja de ser una disyunción. Compensación en caption + detalle + ayuda del filtro
  Siguiente:
    · frontend-agent (#11879), sobre la rama apilada, con la #11878 dentro
    · qa-agent: 10 notas + 3 mutaciones nombradas; las notas 11, 12, 13, 20 y las mutaciones de la
      #11795 en el documento madre AFIRMAN LO CONTRARIO y hay que retirarlas en la misma HU
  Pendiente humano: ninguno. Si producto quiere ver «Municipio consultado» (`municipioFuente`) en el
    detalle, es HU aparte con rótulo propio — no entra aquí
```
