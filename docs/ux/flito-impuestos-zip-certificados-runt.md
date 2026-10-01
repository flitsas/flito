# UX slim — Descargar certificados RUNT en ZIP desde la cola de Impuestos (HU #13206)

> Entrada del `frontend-agent` para la HU #13206 (Feature #12954, módulo `flito-impuestos`,
> endpoint de la HU #13205: `POST /api/flito/impuestos/certificados/zip`, contrato en
> `docs/diseno/hu-13205-zip-certificados-runt.md` §Contrato delta).
> Modo **slim**: la cola no se rediseña. Se añade **un** botón secundario a la barra de selección,
> su tarjeta de aviso y la guarda de permiso del chip «Certificado» de la fila.
> Patrón base que no se reescribe: `components/flito/DescargarSoportesZip.tsx` (HU #11910 / #12817)
> y `AvisoVisible` de `ExportarCola.tsx`.

---

## Superficie tocada

| | Hoy | Con esta HU |
|---|---|---|
| Página | `/flito/impuestos` (`FlitoImpuestos.tsx`) | la misma; sin `PageSlug` nuevo |
| Barra de selección (`BarraSeleccion`) | `N seleccionado(s)` · Enviar al gestor · Gestionar en Operaciones · Certificar · **Descargar soportes (N)** | lo mismo + **Descargar certificados (N)** justo después de «Descargar soportes» |
| Aviso bajo la barra | `AvisoSoportesZip` | + `AvisoCertificadosZip` (misma tarjeta), debajo del de soportes |
| Chip «Certificado» de la fila (`AccionCertificacion`, `puedeDescargar`) | guarda por rol: `esOperaciones \|\| esGestor` | guarda por función: `hasFuncion('impuestos.certificado.descargar')` |
| Columna de casillas y barra | cuelgan de `puedeDescargarSoportes` | cuelgan de `puedeDescargarSoportes \|\| puedeDescargarCertificados` |
| Detalle del impuesto | no tiene botón de certificado | **no cambia**: no se añade ninguno |

Componente nuevo pedido por la HU: `components/flito/DescargarCertificadosZip.tsx` (botón + aviso),
reutilizando `useDescargaZip` / el candado `enVuelo`, `AvisoVisible`, `esNombreDeExport` y
`downloadPostNamed`. **Cero patrón visual nuevo**: botón `flitBtnSecondary`, tarjeta `AvisoVisible`,
tokens existentes.

**PII:** ids (uuid) solo en el **cuerpo** del POST. Nada en la URL. Las placas que se pintan en el
aviso del 409 son placas de la propia cola del usuario (las mismas que ya ve en la tabla).

---

## Delta de claridad (qué se ve / qué se calla)

Quien marca filas en esta cola vino a **operar el lote**: enviarlo, certificarlo o sacar sus
documentos para entregarlos. «Descargar certificados» es la tercera forma de «sacar documentos»,
hermana de «Descargar soportes». No es la acción del día (eso sigue siendo cargar recibos / enviar /
certificar), así que **entra con peso secundario** y pegado a su hermana.

| Siempre visible | Se calla |
|---|---|
| El botón `Descargar certificados (N)`, N = filas marcadas | Cuántas tienen certificado **antes** del clic (el cliente no lo sabe con certeza: la vigencia la decide el servidor) |
| Mientras trabaja: el rótulo `Preparando certificados…` y la tarjeta de espera | Porcentaje, barra, «generando PDF 14 de 80» |
| Al terminar: nombre del ZIP + cuántos entraron y cuántos quedaron fuera, con la referencia a `omitidos.csv` | La lista de omitidos en pantalla cuando **sí** hubo ZIP (ya va en `omitidos.csv`) |
| Si no hubo ZIP (409): la lista de omitidos **agrupada por causa**, con placa | El uuid interno de un registro (nunca se pinta); el código `zip_sin_certificados`; el texto crudo del API |

**Densidad:** empeora en un botón, y se acepta sin preguntar al PO porque (1) solo aparece con filas
marcadas, (2) es secundario y (3) la barra ya envuelve. La línea de desajuste existente se ajusta en
una palabra (ver más abajo), no se añade otra.

**Línea de desajuste de la barra** (la que hoy termina en `. Descargar soportes usa las {marcadas}.`):

- con las dos descargas visibles → `. Descargar soportes y certificados usan las {marcadas}.`
- solo soportes → sin cambio
- solo certificados → `. Descargar certificados usa las {marcadas}.`

---

## Oficio

- **Qué vino a hacer:** sacar en bloque los certificados RUNT de las filas marcadas para entregarlos.
- **Qué se ve primero:** el botón en la barra, junto a «Descargar soportes»; tras el clic, la tarjeta.
- **Primaria única:** el botón nuevo es **secundario** (`flitBtnSecondary`) y no lleva la prop
  `primaria`. No cambia el peso de nada existente.
  *Nota (deuda preexistente, no se toca en esta HU):* la barra ya puede mostrar a la vez
  «Enviar al gestor» y «Certificar» con peso primario; no se agrava.
- **Vacío / error con siguiente paso:** ver §Estados; ningún aviso termina sin decir qué hacer.
- **Efectos:** ninguno. Sin spinner animado nuevo, sin barra de progreso.
- **Voz:** la cola **tutea** («Quita el filtro», «Sincroniza desde el Tablero»). Todo el copy nuevo tutea.
  La ficha de Ayuda sigue en **usted**.

---

## Botón (orden en la barra, rótulo, a11y)

```
┌ FlitCard ────────────────────────────────────────────────────────────────────────────────────┐
│ 5 seleccionado(s)  [Enviar al gestor (2 de 5)] [Gestionar en Operaciones (2 de 5)]            │
│                    [Certificar (3 de 5)] [▣ Descargar soportes (5)] [✓ Descargar certificados (5)] │
│ De las 5 filas marcadas, 2 están Pendientes …. Descargar soportes y certificados usan las 5.  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | Reposo | Descargando |
|---|---|---|
| Rótulo visible | `Descargar certificados ({N})` | `Preparando certificados…` |
| Icono | `FileCheck` (lucide, `aria-hidden`, 16 px) — distinto del `FileArchive` de soportes para que no sean dos botones gemelos | el mismo |
| `aria-label` | `Descargar certificados RUNT de {N} registros marcados` (contiene el texto visible: label-in-name) | `Preparando el ZIP de certificados de {N} registros` |
| Estado | habilitado | `aria-disabled="true"` + `aria-busy="true"`; el clic no hace nada (candado `enVuelo`) |
| Foco | `flit-focus` del kit | **se conserva y se ve** (ver nota) |

**Nota AC5 — deshabilitado y con foco a la vez.** Un `disabled` nativo saca el botón del orden de
tabulación y el foco se pierde en `<body>` justo cuando el usuario espera. Por eso en esta acción se
usa `aria-disabled="true"` (no `disabled`) mientras descarga: el foco se queda en el botón, el anillo
`flit-focus` sigue visible, el lector anuncia «no disponible, ocupado», y el candado `enVuelo` ya
garantiza que no sale una segunda petición. Apariencia: la misma que el `:disabled` del kit
(atenuado, `cursor-not-allowed`, sin velo de hover); si `flitBtnSecondary` solo estiliza `:disabled`,
añadir las variantes `aria-disabled:` equivalentes con las mismas clases — sin tokens nuevos.
Fuera de la descarga en curso, `disabled` nativo como siempre.

**Las dos descargas son independientes.** Mientras se preparan certificados, «Descargar soportes»
sigue usable (y al revés): son endpoints y limitadores distintos. Cada botón bloquea solo su propia
petición.

**Hover:** el de `flitBtnSecondary` (velo `--flit-bg-hover`, `transition-colors`). Nada más.

---

## Estados (4) + copy

Todos los resultados van a **una tarjeta `AvisoVisible`** bajo la barra (montada fuera de ella, como
la de soportes, para que sobreviva a «limpiar la selección»), cerrable con su ✕ («Descartar»).
Éxito por `role="status"` (región siempre montada), errores por `role="alert"`; nunca los dos.

| Estado | Qué se ve | Siguiente paso |
|---|---|---|
| **Vacío** (sin selección) | No hay barra ni botón (como hoy). | Marcar filas. |
| **Cargando** | Botón `Preparando certificados…` (aria-disabled, foco). Tarjeta: **«Preparando el ZIP de certificados de {N} registros…»** / segunda línea muted: **«Se arma un PDF por registro antes de empezar la descarga; puede tardar un par de minutos. Puedes seguir usando la cola.»** | Esperar. |
| **Lleno — completo** (`X-Certificados-Omitidos: 0`) | Tarjeta tono `ok`: **«ZIP descargado: {nombre} — {N} certificados.»** (singular: «1 certificado») | Ninguno; ✕ para cerrar. |
| **Lleno — parcial** (cabecera > 0) | Tarjeta tono `aviso`: ver copy AC1. | Revisar `omitidos.csv`; certificar los que faltan. |
| **Error — todos omitidos (409)** | Tarjeta tono `error` con la lista agrupada: ver copy AC2. Sin «Reintentar». | Certificar / actualizar la cola. |
| **Error — tope (cliente o 400)** | Tarjeta `error`, sin «Reintentar». **Cero** petición si el cliente lo detecta. | Marcar menos filas. |
| **Error — frecuencia (429)** | Tarjeta `error`, **con** «Reintentar la descarga». | Esperar 1 minuto. |
| **Error — sin permiso (403)** | Tarjeta `error`, sin «Reintentar». | Pedir el permiso. |
| **Error — red / tiempo / otro** | Respaldos de `avisoDeError` (`tiempo` / `otro`), **con** «Reintentar la descarga». | Reintentar. |

### AC1 — copy del ZIP parcial

`o` = valor de `X-Certificados-Omitidos`, `N` = filas marcadas en la petición, `i = N − o`.

```
ZIP descargado: {nombre} — {i} de las {N} filas marcadas tenían certificado; las otras {o} quedaron fuera. En omitidos.csv, dentro del ZIP, está cuáles y por qué.
```

Singulares: `…; la otra quedó fuera. En omitidos.csv, dentro del ZIP, está cuál y por qué.` ·
`1 de las {N} filas marcadas tenía certificado…`.

Ejemplo: `ZIP descargado: certificados-runt_20260930-1015.zip — 37 de las 40 filas marcadas tenían certificado; las otras 3 quedaron fuera. En omitidos.csv, dentro del ZIP, está cuáles y por qué.`

**Nunca se inventan cifras:** si la cabecera falta o no es un entero ≥ 0 (o `o > N`), la tarjeta
dice solo `ZIP descargado: {nombre}.` en tono `ok` — el mismo criterio de `cifraDeCabecera`.

### AC2 — copy del 409 (todos omitidos, no hay ZIP)

Encabezado de la tarjeta (`role="alert"`):

```
Ninguna de las {N} filas marcadas tiene un certificado para descargar. No se descargó nada.
```

Debajo, **un bloque por causa presente** (solo las que vengan), cada uno con su siguiente paso y la
lista de identificadores en una línea que envuelve:

```
Sin certificación vigente ({k}): ABC123, DEF456, GHI789
Certifícalas con «Certificar» en la barra o en la fila, y vuelve a descargar.

Ya no están en tu cola ({m}): JKL012, MNO345
Cambiaron de estado u organismo. Actualiza la página y vuelve a marcarlas.
```

Reglas de la lista:

- Causa → rótulo (la pantalla traduce el código; nunca se pinta `sin_certificacion_vigente`):
  `sin_certificacion_vigente` → **«Sin certificación vigente»**; `no_disponible` → **«Ya no están en tu cola»**.
- **Identificador que se pinta:** para `sin_certificacion_vigente` el `identificador` del servidor
  (placa o ID FLIT). Para `no_disponible` el servidor devuelve el **uuid** del registro: la pantalla
  lo resuelve a la placa de la fila marcada (`filasSeleccionadas`, como `placaDe` de la barra) y, si
  no la encuentra, pinta **«un registro»** — el uuid **nunca** se muestra.
- Hasta **20** identificadores por causa; luego `y {r} más`. Las filas siguen marcadas en la tabla,
  que es donde se ven todas.
- Tipografía: rótulo de causa `text-sm font-medium` `--flit-text-primary`; identificadores
  `text-sm` (font-mono no: la tabla tampoco lo usa); línea de siguiente paso `text-sm`
  `--flit-text-secondary`. Encabezado con la tinta de error del `AvisoVisible` (`--flit-danger-ink`).
- Lista semántica: `<ul>` con un `<li>` por causa (no por placa: 300 `li` serían 300 paradas para el lector).
- Si el 409 llega **sin** `omitidos` legible: solo el encabezado + `Revisa en la cola cuáles no tienen el chip «Certificado».`

### AC3 — tope y frecuencia

Tope (cliente lo ataja antes de la petición con `ZIP_SOPORTES_MAX_REGISTROS`; el 400
`zip_demasiados_registros` usa **el mismo copy**, no el eco del servidor, porque el texto del
servidor es el genérico de la familia ZIP y habla de «documentos»):

```
Solo se pueden descargar los certificados de 300 registros a la vez y marcaste {N}. Marca menos filas y vuelve a intentarlo.
```

(300 sale de la constante, nunca escrito a mano.)

Frecuencia (429; copy propio, no el eco `Demasiadas descargas seguidas, espera 1 minuto`):

```
Hiciste varias descargas de certificados seguidas. Espera 1 minuto y vuelve a intentarlo.
```

Con botón **«Reintentar la descarga»** (repite exactamente los mismos ids, `ultima` del hook).

### 403 y resto

- 403: `No tienes permiso para descargar certificados RUNT. Pídeselo a un administrador.` (copy propio).
- Tiempo / red / 5xx: los respaldos `tiempo` / `otro` de `avisoDeError`, con Reintentar. **Nunca**
  `e.message`, códigos ni el cuerpo del API.
- Tope de la petición: el mismo `ZIP_TIMEOUT_MS` (600 s) del ZIP de soportes; con 300 PDF generados
  en el servidor, los 90 s por defecto cortarían un ZIP sano.

---

## Permiso (AC4)

- Slug: `flito_impuestos` (sin cambio). Función: **`impuestos.certificado.descargar`** (ya existe;
  la exigen el GET individual y el POST del ZIP).
- `puedeDescargarCertificados = hasFuncion('impuestos.certificado.descargar')` gobierna **dos** cosas:
  1. el botón masivo de la barra (no se pinta sin la función — no se pinta apagado);
  2. el chip «Certificado» de la fila como **botón** de descarga (`AccionCertificacion` →
     `puedeDescargar`). Sin la función, la fila sigue mostrando el chip **como estado, no clicable**
     (comportamiento ya existente de `AccionCertificacion` con `puedeDescargar=false`).
- **No** se toca la guarda de **certificar** (`puedeCertificarFila`): hoy reutiliza `puedeDescargarCert`;
  hay que separar las dos variables para que quitar la descarga no quite certificar.
- Columna de casillas y barra: visibles si `puedeDescargarSoportes || puedeDescargarCertificados`.
  Dentro de la barra, cada botón con su propia guarda.
- Detalle del impuesto: hoy no tiene botón de certificado; no se añade (AC4 se cumple sin cambio ahí).
- Fixtures e2e: si `impuestos.certificado.descargar` no está en `FUNCIONES_POR_ROL` para admin y
  gestor_impuestos, añadirla allí (no en el spec).

---

## Responsive (<lg) y tema oscuro

- **Barra:** ya es `flex flex-wrap gap-3`; el botón nuevo envuelve con las demás. En **<sm** los dos
  botones de descarga ocupan el ancho (`w-full justify-center sm:w-auto`, la variante `llenaEnMovil`
  del de soportes, aplicada a **los dos** para que queden parejos uno bajo otro).
- **Tarjeta de aviso:** ancho completo; el texto y la lista de placas envuelven (`break-words`); el
  ✕ y «Reintentar la descarga» van en la fila de acciones de `AvisoVisible`, que ya envuelve.
- **Sin altura nueva de control:** misma altura que el resto de botones de la barra.
- **Oscuro:** solo tokens con par oscuro — `--flit-text-primary`, `--flit-text-secondary`,
  `--flit-danger-ink` (nunca `text-red-*`), fondo de tarjeta `bg-flit-card`, borde
  `--flit-border-soft`. Ningún color ni token nuevo. Verificar en los dos temas.

---

## Notificación (toast vs aviso)

**Aviso en página (tarjeta `AvisoVisible`, cerrable), en todos los resultados; ningún toast.**
Motivo: el conteo de omitidos y la lista del 409 hay que poder leerlos **después** de abrir el ZIP o
mientras se certifica lo que falta — es estado que sigue siendo cierto, no un destello. Y es el mismo
patrón que su hermano «Descargar soportes» en la misma barra: dos patrones distintos para dos botones
gemelos serían peores que la regla general. Un solo aviso por descarga (no uno al empezar y otro al
terminar: la tarjeta de espera **se sustituye** por la de resultado en el mismo sitio).

---

## Accesibilidad (delta)

- Botón con texto visible + `aria-label` que lo contiene; `aria-busy` y `aria-disabled` durante la
  descarga; foco conservado y visible (`flit-focus`, contraste ≥ 3:1 en claro y oscuro).
- Regiones: una `role="status"` **siempre montada** para «Preparando…» y el éxito; errores por
  `role="alert"` dentro de `AvisoVisible`. No se anuncian dos veces. Es la misma pareja de
  `AvisoSoportesZip`; la de certificados es una región propia (no comparte la de soportes, para que
  dos descargas a la vez no se pisen el texto).
- Al terminar, el foco **no** se mueve (se queda en el botón); el anuncio llega por la región.
- Lista del 409 en `<ul>`; un `li` por causa.

---

## Ficha de ayuda (propuesta para `flit-ayuda-flito`, usted)

> En la barra que aparece al marcar filas, **Descargar certificados** baja en un ZIP el certificado
> RUNT de cada registro marcado (hasta 300 a la vez), nombrado con la placa. Los que no tienen
> certificación vigente quedan fuera y se listan en **omitidos.csv**, dentro del mismo ZIP. Si
> ninguno tiene certificado, no se descarga nada y FLITO le muestra cuáles y por qué. Requiere el
> permiso de descargar certificados.

---

## Notas para QA (≤10)

1. Con la función: marcar 3 filas certificadas → `Descargar certificados (3)` → ZIP + tarjeta `ok` «— 3 certificados.».
2. Marcar 5 con 2 sin certificación → tarjeta `aviso` «3 de las 5… las otras 2 quedaron fuera… omitidos.csv»; la cifra sale de `X-Certificados-Omitidos`, no del cliente.
3. Todas sin certificación (409) → tarjeta `error` con bloque «Sin certificación vigente (k): placas…» y su siguiente paso; **ningún** uuid, código ni texto crudo en pantalla; sin «Reintentar»; no se descarga archivo.
4. 409 con `no_disponible` → se pinta la placa de la fila marcada (o «un registro»), nunca el uuid.
5. 301 marcadas → copy del tope con 300 y **cero** POST (Network). Forzando el 400 del servidor → el mismo copy.
6. 429 (descargas seguidas) → copy de «Espera 1 minuto», con «Reintentar la descarga».
7. Durante la descarga: rótulo `Preparando certificados…`, `aria-busy`/`aria-disabled`, el foco **sigue** en el botón y se ve; doble clic / Enter repetido → **una** sola petición; «Descargar soportes» sigue usable.
8. Sin `impuestos.certificado.descargar`: ni botón masivo ni chip clicable (el chip «Certificado» queda como estado); «Certificar» **sigue** disponible si el rol lo tenía.
9. Con solo la función de certificados (sin soportes): aparecen casillas y barra con «Descargar certificados» y sin «Descargar soportes».
10. 375 px y tema oscuro: los dos botones de descarga a ancho completo uno bajo otro; tarjeta y lista legibles, error en `--flit-danger-ink`.

---

## Decisiones y descartes

- **Secundario, no primario**, y pegado a «Descargar soportes»: es una descarga, no la acción del día.
- **Aviso en página, no toast** (ver §Notificación).
- **Sin «(k de N)» antes del clic** (a diferencia de SOAT, #12815): el chip «Certificado» de la fila no
  garantiza vigencia en el servidor; contar en el cliente podría prometer una cifra que el ZIP no cumple.
  La cifra real llega en la cabecera.
- **Sin lista de omitidos cuando sí hubo ZIP:** ya está en `omitidos.csv`; duplicarla en pantalla
  sería la tarjeta más larga de la cola para un dato que el usuario tiene en la mano.
- **Lista del 409 agrupada por causa y con tope de 20 por grupo:** cada causa tiene un remedio
  distinto; 300 placas en línea serían un log, y las filas siguen marcadas en la tabla.
- **Copy propio para 400 / 429 / 403** en vez del eco del servidor: el texto del 400 es el genérico de
  la familia ZIP («documentos») y el del 429 no tiene el pulido del producto.
- **`aria-disabled` en vez de `disabled` durante la descarga:** es lo único que deja cumplir a la vez
  «deshabilitado» y «foco visible» del AC5.
- **Icono distinto (`FileCheck`)** del de soportes: dos botones vecinos con el mismo icono se leen como uno.
- **Observación para backend (no bloquea esta HU):** en `omitidos.csv` la causa `no_disponible` lleva el
  **uuid** como identificador, que el usuario no reconoce. Se deja anotado; la pantalla ya lo resuelve
  a placa en el 409.
- **Observación (deuda preexistente, fuera de alcance):** el error de la descarga individual del
  certificado sigue usando `setError(errorMessage(e))`; no se toca en esta HU.
