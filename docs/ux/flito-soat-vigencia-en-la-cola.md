# UX slim — La vigencia del SOAT en la cola (HU #12097)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU
> [#12097](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12097), eslabón 2 de 2 del
> Feature #12075 (*verificación diaria del SOAT contra el RUNT a las 00:10*). El eslabón 0 (#12095) ya
> está en el repo —`flito-soat-vigencia.cron.ts`, el andamiaje del cron— y el eslabón 1 (#12096) es el
> que llenará `recorrerVigenciaSoat` y creará las columnas. **Esta HU no consulta nada: solo pinta lo
> que el proceso de madrugada dejó escrito.**
>
> Modo **slim**: se especifica el delta sobre `/flito/soat`, que ya está documentada en
> `docs/ux/flito-soat-cola-sin-tramite.md` (HU #11905) y cuyo reparto de columnas viene de ahí y de la
> #11906. Lo que no se nombra aquí **no se toca**: pastillas de estado, buscador, presets, rangos de
> fecha, barra de envío, carga masiva, visor de soportes, historial, export a Excel.
>
> **Público: Operaciones y el gestor.** El `cliente` NO ve nada de esta HU (§6).

---

## 1 · Superficie tocada

| | |
|---|---|
| Página | `/flito/soat` — «SOAT», cola de adquisición |
| Archivo | `apps/web/src/pages/FlitoSoat.tsx` — **el único de `src/` que esta HU toca** |
| Superficie 1 | La celda **Estado** de la fila (`FlitoSoat.tsx:604-609`): hoy `StatusChip` + `ChipSinGestion` |
| Superficie 2 | La barra de filtros (`FlitoSoat.tsx:426-475`): **un** control nuevo, junto a «Gestiona» |
| Superficie 3 | La `<dl>` del modal **Ver** (`FlitoSoat.tsx:759-782`): dos `<Dato>` de solo lectura |
| Superficie 4 | `apps/web/src/content/ayuda/soat.md` — delta de copy (§8) |
| Slug / permiso | **`flito_soat`, sin cambios.** No es `soat`: esa es la del módulo legacy (`permissions.ts:117`). Titulares: `admin`, `proveedor`, `auditor`, `cliente` (`ROLE_DEFAULT_PAGES`, líneas 217-268) |
| Endpoints | **Ninguno nuevo.** Los datos viajan en la fila de `GET /flito/soat`, que ya se llama. El filtro viaja en su querystring. Ver §7: son **campos nuevos de un endpoint existente**, y hoy no existen |
| PII | El filtro viaja como `vigencia=vencido\|sin_registro\|no_verificado` — **valores máquina, ni placa, ni VIN, ni documento** (AGENTS.md §14). El **número de póliza del RUNT no entra ni en la lista ni en la URL**: es cuasi-PII por el mismo criterio que `flito_soat.numero_poliza` (`schema.ts:2731`) |

**Ni un botón nuevo, ni un campo editable (AC4).** Esta pantalla no tiene «Verificar ahora» y no lo
tendrá: la verificación es del proceso de las 00:10 y un botón que la dispare a mano convierte una
corrida acotada por candado y reintentos (`flito-soat-vigencia.cron.ts`) en N consultas sin control
a un registro nacional de pago. Nada de lo que pinta esta HU se puede editar.

---

## 2 · Delta de claridad — qué se ve, qué se calla, y **dónde cabe**

### 2.1 Qué vino a hacer quien abre esto

A trabajar la cola de adquisición: enviar al gestor, cargar facturas, perseguir lo estancado. La
vigencia **no cambia ese trabajo**: añade una segunda pregunta que antes no se podía hacer —*¿lo que
compramos sigue estando y el RUNT lo reconoce?*—, y que se responde de dos maneras: de reojo (una
señal en la fila) o de frente (filtrando por ella y trabajando esa lista).

### 2.2 La disposición: **dentro de la celda «Estado»**, no en una columna nueva

Esta es la única decisión de arquitectura de la HU, y hay un tripwire escrito en el repo que la
condiciona:

```
apps/web/e2e/tests/flito-soat.spec.ts:341-343
// El conteo de columnas viaja con el aserto: los tres datos van DENTRO de la celda del vehículo.
// Si esto sube a 11/12, alguien metió columnas nuevas y la tabla volvió a ser más ancha que antes
// de la HU #11905.
```

La #11905 bajó esta tabla de 11 a 10 columnas porque a 1280 px desbordaba, y la #11906 se negó a
gastar el ancho liberado. Una columna «Vigencia» la devuelve a **11** y reabre el desborde.

| | **A — dentro de «Estado»** (recomendada) | **B — columna propia «Vigencia RUNT»** |
|---|---|---|
| Columnas | **10 / 9 / 10** (admin / auditor / gestor) — **sin cambio** | 11 / 10 / 11 |
| Desborde a 1280 | como hoy | vuelve, y `FlitTable` repinta la franja `data-desborde` |
| Filas sin comprobante | **no se pinta nada**: la ausencia es correcta y muda | hay que pintar «—» en la mayoría de las filas (pendiente y solicitado), una columna casi vacía |
| Sentinela de densidad | **lo respeta**: los tres conteos del spec siguen valiendo 10/9/10, y eso es la prueba de que la HU no ensanchó la tabla | hay que reescribir el aserto que existe para impedirlo |
| Coste | la celda «Estado» pasa de ≤2 a ≤3 líneas en las filas verificadas | +1 encabezado explorable, referente literal del filtro |

**Se recomienda A**, y el argumento no es solo el conteo: la celda «Estado» es, por definición de la
propia #11905, donde viven *«las señales temporales de riesgo»* (`StatusChip` + `ChipSinGestion`) —y
la vigencia es exactamente eso sobre el mismo SOAT, no un atributo del vehículo. Además las dos
ocupaciones son **casi disjuntas**: `ChipSinGestion` solo aparece en `solicitado` estancado, y la
vigencia solo en filas con comprobante (`pagado` en la práctica), donde el chip de sin gestión ya no
se pinta. La celda sigue teniendo como mucho dos pastillas.

**B queda escrita y lista** por si el PO prefiere el encabezado explorable: cuesta 11 columnas, el
desborde de vuelta, un «—» en la mayoría de las filas y reescribir dos bucles del spec. **No se
implementa sin ese sí.**

### 2.3 Qué se calla, y dónde vive

| Dato | Dónde | Por qué |
|---|---|---|
| Estado de vigencia | **fila**, chip en «Estado» | es lo que decide si esta fila se trabaja hoy |
| Antigüedad de la última respuesta del RUNT | **fila**, una línea bajo el chip | un dato viejo *es* la señal (es lo que el Feature mide) |
| Fecha y hora exactas de esa respuesta | **modal Ver** | precisión de auditoría, no de barrido |
| Fecha de vencimiento | **dentro del propio chip** cuando existe | sin ella, «Vigente» no dice hasta cuándo |
| **Número de póliza del RUNT** | **en ningún sitio de esta HU** | ningún AC lo pide, es cuasi-PII y **colisiona** con `flito_soat.numero_poliza`, que es otro número (el que el OCR sacó de la factura de FLITO). Pintar los dos sin decir cuál es cuál es una trampa; cruzarlos es otra HU |
| Intentos, corrida, `parcial`/`completa` | **fuera**: eso vive en el log del cron | es telemetría del proceso, no trabajo de esta visita |

---

## 3 · Las cuatro etiquetas (AC3) — texto exacto, tono y ratio

**El corazón de la HU.** «Sin registro en el RUNT» y «no verificado» significan cosas opuestas: la
primera es un problema **del vehículo** (contradice lo que FLITO pagó, alguien reclama hoy); la
segunda es un problema **nuestro** (no dice nada del vehículo). Confundirlas manda a reclamarle al
gestor por una consulta que se cayó, o a archivar como «fallo técnico» un SOAT que no existe.

### 3.1 Los chips y sus líneas

| Estado | **Texto exacto del chip** | Tono `StatusChip` | Segunda línea (§4) |
|---|---|---|---|
| `vigente` **con** `venceEl` | **`Vigente hasta 12/03/27`** | `success` | `Verificado hoy` |
| `vigente` **sin** `venceEl` | **`Vigente`** | `success` | `Verificado hoy` |
| `vencido` | **`Venció el 12/03/26`** | `warning` | `Verificado hoy` |
| `sin_registro` | **`Sin SOAT en el RUNT`** | `danger` | `Verificado hoy` |
| `no_verificado` **con** `verificadaEn` | **`No se pudo consultar`** | `active` (azul) | **`Último dato: hace 3 días (4/09/26)`** |
| `no_verificado` **sin** `verificadaEn` | **ningún chip** | — | **`Sin verificar`** (§4.2) |

**Dos redacciones enteras para `vigente`, no una con un hueco.** Que el RUNT reporte vigencia por
estado y sin fecha es frecuente y legítimo —está escrito en `soatCliente.ts:113-122` para el
`409 soat_vigente`—, así que se cambia la frase, no se escribe «Vigente hasta —».

### 3.2 Por qué esos textos no se malinterpretan a las 7 a.m.

- **`Sin SOAT en el RUNT`** tiene sujeto y lugar: la ausencia está **en el registro**, no en nuestro
  proceso. No hay lectura posible en la que describa una consulta fallida.
- **`No se pudo consultar`** no tiene sujeto y describe **una acción nuestra que no salió**. No
  afirma nada del vehículo, que es justo lo que no se puede afirmar.
- **Nada de jerga de máquina.** «no_verificado», «sin_registro», «estado de verificación» y
  «verificación pendiente» quedan prohibidos en pantalla: son nombres de columna.
- **La segunda línea es un segundo discriminador, independiente del color.** Tres estados la abren
  con **«Verificado …»** —hubo respuesta y esta es su fecha—; el `no_verificado` con fecha la abre
  con **«Último dato: …»**, que es otra gramática y otra afirmación (*lo que sabemos es de antes*); y
  el que no tiene fecha dice **«Sin verificar»**, la negación limpia de las otras tres. Cambiando la
  paleta entera, los tres casos seguirían distinguiéndose por el texto.
- **`Sin verificar` no se confunde con `Sin SOAT en el RUNT`** aunque las dos empiecen por «Sin»: la
  segunda nombra al RUNT y a la póliza; la primera no nombra nada, porque no hay nada que nombrar. Y
  una es una pastilla roja y la otra una línea gris sin pastilla. Por eso se descartó «Sin dato del
  RUNT», que sí se le parecía peligrosamente (§11, descarte 5).
- El par que más se parece **en color** es `vencido` (naranja) / `sin_registro` (rojo), y por eso son
  los dos cuyos textos son más distintos entre sí («Venció el …» vs «Sin SOAT en el RUNT»).

**Por qué rojo es «Sin SOAT en el RUNT» y no «Vencido»:** vencer es el ciclo normal de una póliza y
es trabajo previsible; que el RUNT no reporte SOAT **contradice lo que FLITO pagó** y es lo único de
esta columna que se reclama el mismo día. Si el PO lo ve al revés, se intercambian los dos tonos y
**nada más** cambia.

### 3.3 Contraste — los pares y su ratio

> **Ningún gate automático cubre esto.** `npm run check:contraste` mide **solo** la ⌘K y los
> gradientes; y el E2E de a11y necesita `QA_AXE_CDN=1` o salen ~10 rojos que no son de nadie. Los
> ratios de abajo son los medidos y anotados en `StatusChip.tsx:21-23` (verificados a mano en este
> documento para `danger`: 4,708) y **la única garantía que hay es que estos cuatro tonos ya están
> en uso**.

| Tono | Tinta (`fg`) | Fondo del chip (`bg`) | Ratio | Tema |
|---|---|---|---|---|
| `success` | `--flit-success-ink` `#3C7C17` | `#EBF8E3` | **4,66** | claro y oscuro |
| `warning` | `--flit-warning-ink` `#B94120` | `#FDE8E3` | **4,64** | claro y oscuro |
| `danger` | `--flit-danger-ink` `#C02F24` | `#FBE4E2` | **4,70** | claro y oscuro |
| `active` | `--flit-blue-ink` `#4264B7` | `#E6ECF7` | **4,73** | claro y oscuro |
| 2.ª línea | `--flit-text-muted` `#646E82` | `--flit-bg-card` `#FFFFFF` | **5,12** | claro |
| 2.ª línea, fila en `:hover` | `#646E82` | `--flit-bg-app` `#EAF2FF` | **4,55** | claro |
| 2.ª línea | `--flit-text-muted` `#A1AEC2` | `--flit-bg-card` `#1E2F4C` | **5,97** | oscuro |
| 2.ª línea, fila en `:hover` | `#A1AEC2` | `--flit-bg-app` `#0F1B2E` | **7,69** | oscuro |

Los cuatro chips valen **igual en claro y en oscuro** por construcción: el `bg` es un hex OPACO y el
`fg` es un token `-ink`, y `flit-tokens.css:252` deja escrito que **los `-ink` no se tocan en
oscuro**.

> ⚠ **Por eso `neutral` y `draft` están prohibidos para estos chips, y hay un Bug que radicar.**
> Sus tintas **sí** se redefinen en oscuro (`--flit-text-muted` → `#A1AEC2`, `--flit-draft` →
> `#BCC8DA`) contra un fondo de chip que se queda en el hex claro. Calculado en este documento:
> **`neutral` cae a 1,98:1 y `draft` a 1,37:1 en tema oscuro.** Es un defecto **preexistente** del
> kit —afecta hoy al chip «Pendiente» y a `AntiguedadPill`—, **fuera del alcance de esta HU** y
> merece Bug propio; aquí solo decide que el estado «No se pudo consultar» use `active` y no el gris
> que pediría el instinto.

---

## 4 · La antigüedad del dato (AC1)

`verificadaEn` es **la última respuesta del RUNT**, no el último intento (§7). Esa semántica es la que
hace que la métrica del Feature —*cuánto tiempo lleva sin actualizarse el dato más viejo de la cola*—
siga midiendo algo: si la fecha se moviera con cada intento fallido, la cola se vería fresca con el
RUNT una semana caído.

**Decisión: relativa visible, y la absoluta aparece exactamente cuando la relativa deja de ser una
fecha.** Una línea, siempre: `text-xs`, `--flit-text-muted`, `tabular-nums`.

### 4.1 Las dos redacciones con fecha

| Edad de `verificadaEn` | `vigente` · `vencido` · `sin_registro` | `no_verificado` |
|---|---|---|
| mismo día | `Verificado hoy` | `Último dato: hoy` |
| día anterior | `Verificado ayer` | `Último dato: ayer` |
| ≥ 2 días | `Verificado hace 3 días (4/09/26)` | `Último dato: hace 3 días (4/09/26)` |

La línea de `no_verificado` **informa más que la que había** («Último intento hoy», que ya no es
pintable y que además solo repetía lo que el chip dice): el chip dice que **hoy** falló, y la línea
dice **desde cuándo no sabemos nada**. Juntos son la frase entera: *«no se pudo consultar, y lo
último que supimos es de hace tres días»*.

En la práctica la rama `hoy` de la columna derecha **no se alcanza**: si el RUNT hubiera respondido
hoy, el estado sería concluyente y no `no_verificado`. Se especifica igual —sin caso especial ni
frase aparte— para que un dato anómalo no deje la línea muda.

### 4.2 `verificadaEn` nulo — **dos filas que la base no distingue**, y una sola frase honesta

Con `verificadaEn` nulo conviven dos historias que en la base son **indistinguibles** (mismo
`estado`, misma fecha ausente). Separarlas exigiría una columna `intentada_en` que se descartó:

1. **Nunca se ha intentado.** El comprobante se cargó a las 10:00 y la primera corrida es a las 00:10
   de mañana. Es el caso normal y no ha fallado nada.
2. **Se intentó, falló los cuatro intentos del día y nunca hubo respuesta previa.** Aparece durante
   una caída larga del RUNT, y de forma **permanente** sobre un VIN que el registro nunca acepta.

**La pantalla no afirma cuál de las dos es**, porque no puede saberlo. Dice lo único que es verdad en
las dos:

- **Sin chip.** Un chip es una afirmación sobre el vehículo y aquí no hay ninguna que hacer. Además
  el único tono que le pegaría —gris— está roto en oscuro (§3.3).
- **Solo la línea**, con el mismo `text-xs` / `--flit-text-muted`: **`Sin verificar`**.
- **Sin «todavía».** «Sin verificar todavía» era la redacción anterior y se cae con el caso 2: sobre
  un VIN que el RUNT nunca acepta, esa fila diría «todavía» **para siempre** y se leería como una
  espera benigna. «Sin verificar» es verdad en las dos historias y no promete ninguna.
- **Y es la misma palabra que el filtro que las devuelve** (§5.1), que es lo que hace la lista
  aprendible: quien filtra por «Sin verificar» reconoce lo que le sale.

> **Regla de precedencia, y es del front: manda `verificadaEn`, no `estado`.** Si `verificadaEn` es
> `null` se pinta «Sin verificar» **sea cual sea** el valor de `estado`. Pintar ahí «No se pudo
> consultar» afirmaría un fallo que puede no haber ocurrido —y el chip azul se llenaría cada mañana
> de comprobantes cargados ayer a los que aún no les ha tocado—. Es el error más fácil de cometer si
> el mapeo se escribe como un `switch (estado)`.

### 4.3 Por qué así y no de otra manera

- **Relativa primero** porque la edad es la señal, no la fecha.
- **«hoy» y «ayer» son la fecha** para quien lee. A partir de dos días dejan de serlo y entra la
  absoluta corta, con año: si el cron estuvo apagado un mes, el año es lo que lo delata.
- **Nada en `title`.** Un `title` no lo ve quien navega con teclado ni quien está en una tableta, y
  el AC1 dice que la fila **muestra** la fecha. La absoluta completa con hora vive en el modal.
- **No se reusa `AntiguedadPill`.** Cuenta desde `enviadoEn` con los umbrales de `ANS_OPERATIVO`
  —«recién ingresado», «por vencer», «atrasado»—, que aquí no significan nada: el ANS del gestor no
  gobierna la frescura de una consulta al RUNT. Reusarlo importaría una semántica ajena y añadiría
  una **tercera** pastilla a la celda.
- **Sin color en esta línea.** El dato viejo se lee en el texto; teñirlo sería otro criterio que
  depende del color, justo lo que el AC3 combate.

**Dos trampas de implementación, las dos con precedente en este repo:**

1. **Días de calendario en `America/Bogota`, no cubos de 24 horas.** La corrida es a las 00:10 y sus
   reintentos a las 01:10, 02:10 y 03:10 (`flito-soat-vigencia.cron.ts`): con `Math.floor(ms/86400000)`
   —lo que hace `diasDesde` de `AntiguedadPill`— una verificación de las 03:10 de ayer, leída a las
   02:00 de hoy, sale como «hoy». La zona se resuelve con `Intl` sobre `America/Bogota`, igual que en
   el cron (RN-D4).
2. **Los tests de esta línea van con `TZ=UTC`.** En `-05` un aserto de «ayer» pasa por el huso local
   del que corre la prueba y el mutante del reloj sobrevive.

---

## 5 · Los tres filtros (AC2)

### 5.1 Un `select`, no tres chips

La barra ya lleva nueve controles (pastillas, buscador, tres multiselect, «Gestiona», presets, tres
rangos y una casilla). **Tres controles más la convierten en un panel.** Se añade **uno**:

```
Vigencia  [ Cualquiera ▾ ]
```

Calcado del `select` **«Gestiona»** que ya está justo al lado (`FlitoSoat.tsx:442-452`): mismo
`<label>` envolvente con el rótulo visible —que es además su nombre accesible—, mismo `flitInp`,
mismo `max-w`. **Cero patrones nuevos.**

| Nombre en el AC2 | Opción visible | Valor en la URL |
|---|---|---|
| — | `Cualquiera` | *(no viaja)* |
| «vencido» | `Vencido` | `vigencia=vencido` |
| «sin registro en el RUNT» | `Sin SOAT en el RUNT` | `vigencia=sin_registro` |
| «sin verificar» | **`Sin verificar`** | `vigencia=no_verificado` |

- **Dos de las tres opciones dicen exactamente lo mismo que su chip**, para no obligar a traducir
  mentalmente en cada barrido. **La tercera nombra el CONJUNTO y no a uno de sus miembros**, y es
  deliberado: la lista «Sin verificar» trae las filas que dicen «No se pudo consultar» **y** las que
  dicen «Sin verificar» (§5.2). Llamarla «No se pudo consultar» sería **falso para la mitad de lo que
  devuelve**; y «sin verificar» es además el nombre que le da el propio AC2, que con esas palabras es
  correcto: ninguna de las dos está verificada.
- **Excluyentes por construcción**, que es lo que hace verdadero el *«cada uno devuelve exactamente
  su conjunto»* del AC2. Tres casillas combinables plantearían un «vencido **y** sin registro» que
  ningún AC define.
- **No se ofrece «Vigente».** El AC pide tres y nadie barre la cola buscando lo que está bien.
- **Posición:** después de «Gestiona» y antes de `FiltrosInteligentes`.
- **No es un preset.** Los presets son *combinaciones* de filtros (`Listos para enviar`, `Sin
  gestión`); esto es un filtro suelto.
- **Visible para `admin`, `proveedor` y `auditor`; oculto para `cliente`** (§6). Ojo: la guarda es
  `!esCliente`, **no** la de «Gestiona» (`!esGestor && !esCliente`): al gestor sí le sirve, es su
  reclamación.

### 5.2 El universo de los tres filtros: **el comprobante vivo**

**El universo es el mismo `EXISTS` del comprobante que decide si `vigencia` viaja o va `null`** — un
solo criterio en los dos sitios (§7, exigencia 2).

| Fila | ¿Entra en algún filtro? | En cuál |
|---|---|---|
| Sin comprobante cargado (`pendiente`, `solicitado`) | **No** | nunca entra en la verificación; si entrara, la lista devolvería media cola y el AC2 sería falso |
| Con comprobante, `no_verificado` **sin** fecha (pinta **«Sin verificar»**) | **Sí** | «Sin verificar» |
| Con comprobante, `no_verificado` **con** fecha (pinta **«No se pudo consultar»**) | **Sí** | «Sin verificar» |
| Con comprobante y respuesta concluyente | **Sí**, si le toca | «Vencido» o «Sin SOAT en el RUNT» |

**Por qué entran las dos sin fecha y no solo la que ya tenía dato.** Acotar el universo a
`verificada_en IS NOT NULL` dejaba fuera la fila que **se intentó cuatro veces, falló y nunca tuvo
respuesta previa** (§4.2, caso 2), indistinguible en la base de la que aún no se ha intentado. El
resultado habría sido una lista de fallos **que se vacía justo durante la avería que existe para
hacer visible**, y un VIN que el registro nunca acepta invisible para siempre. Se prefiere una lista
que trae de más y lo enseña.

**Y la distinción del AC3 no se pierde: la hace la pantalla**, que es donde el AC la pide. Dentro de
esa única lista conviven, y se separan **sin leer**:

```
┌──────────────────────────────┐
│ [Pagado]                     │
│ [No se pudo consultar]       │ ← pastilla azul + fecha: hoy se intentó y no salió
│ Último dato: hace 3 días     │
├──────────────────────────────┤
│ [Pagado]                     │
│ Sin verificar                │ ← sin pastilla: nunca ha habido respuesta
└──────────────────────────────┘
```

> **Lo que esto cuesta, dicho con todas las letras:** la lista «Sin verificar» **casi nunca estará
> vacía**, porque cada día trae los comprobantes cargados desde la última corrida, que se resuelven
> solos a las 00:10. Los fallos reales van dentro, distinguibles pero **diluidos**: es una lista que
> trae de más a cambio de no ocultar nada. Es la decisión correcta con el esquema que hay, y queda
> como **pregunta 2 al PO** (§11) con su alternativa: separarlas de verdad exige una `intentada_en`
> en la base, que es esquema, es de la #12096 y no de esta pantalla.

### 5.3 Las cuatro costuras que hay que coser, o el filtro miente

Están todas en `FlitoSoat.tsx` y cada una tiene un síntoma distinto:

| Costura | Línea | Si se olvida |
|---|---|---|
| `hayFiltros` | 205-207 | el vacío dice **«No hay SOAT en esta vista. Sincroniza desde el Tablero…»**, que es falso, y **no aparece «Limpiar filtros»**: el usuario queda encerrado en su propio filtro |
| `limpiarFiltros` | 209-215 | «Limpiar filtros» y los presets dejan el filtro puesto |
| El `useEffect` de `setPage(1)` y el de la consulta | 245-266 | se pide la página 3 de un conjunto que ya no tiene tres páginas → **vacío falso**; o el filtro no se aplica hasta que se toque otra cosa |
| `filtrosExport` | 303-317 | el Excel deja de ser «lo que estoy viendo», que es el contrato escrito de esa función |

> ⚠ **Y una quinta, en el API:** `colaFiltrosCampos` (`flito-soat.routes.ts:179-195`) es el esquema
> del que se **deriva** el del export con `.strict()`. Mandar `vigencia` en el cuerpo del
> `POST /export` sin declararlo ahí no es un filtro ignorado: es un **400**.

**El Excel no gana columnas en esta HU** (el export escribe su propia lista). Consecuencia honesta:
descargar el filtro «Vencido» da un archivo que no dice por qué esas filas están ahí. Si el PO lo
quiere, son dos columnas más y es alcance nuevo — **variante B, no se implementa sin su sí.**

---

## 6 · El `cliente` no ve nada de esta HU

La cola es también la pantalla del rol `cliente` (Feature #11912). **La columna, el chip, la línea de
antigüedad, el `select` y los datos del modal van todos detrás de `!esCliente`** —la misma guarda que
ya esconden «Gestiona» y «Valor».

Motivo: «Sin SOAT en el RUNT» y «No se pudo consultar» son **el estado de un proceso interno de
FLITO**, y a un Cliente le dirían que su póliza está en duda sin que él pueda hacer nada, o que
FLITO no pudo consultar —una frase sobre nuestra trastienda—. El AC no lo pide y los principios lo
prohíben (canal Cliente: menos columnas, cero jerga interna).

**Queda preguntado al PO** (§11): «su SOAT vence el 12/03/27» sí sería un dato suyo, pero es otra
pantalla, otro copy (usted), y otra HU.

| Rol | Columnas `columnheader` — hoy y después | Ve el chip | Ve el `select` |
|---|---|---|---|
| `admin` | **10 → 10** | sí | sí |
| `proveedor` (gestor) | **10 → 10** | sí | sí |
| `auditor` | **9 → 9** | sí (solo lectura) | sí |
| `cliente` | **7 → 7** | **no** | **no** |

*(El conteo no cambia porque la disposición A no añade columnas — §2.2. `puedeOperar` es
`role === 'admin'`, `lib/permissions.ts:38-41`; la casilla cuelga de `esOperaciones || esGestor`.)*

---

## 7 · Datos — lo que la API tiene que mandar (requerimiento, hoy no existe)

**Verificado en el repo:** `flito_soat` **no** tiene todavía `estado`, `verificada_en`, `vence_el` ni
`poliza` de vigencia; `recorrerVigenciaSoat` devuelve ceros y lo dice en su docstring. Lo único
parecido que existe son las cuatro columnas de `flito_soat_solicitud` (migración 0171:
`verificacion_estado`, `soat_vigente`, `soat_vigente_hasta`, `verificacion_codigo`) y **no son esto**:
aquello es la compuerta RUNT del **alta** del canal Cliente, con otro vocabulario
(`pendiente|caido|sin_registro|no_cuadra|ok`) y otro momento. **No se pueden mezclar.**

Lo que esta pantalla necesita en cada ítem de `GET /flito/soat`:

```ts
/**
 * Ausente (o `null`) = este SOAT NO tiene comprobante vivo y por tanto NO entra en la verificación
 * diaria. Es el MISMO predicado que acota el universo de los tres filtros (exigencia 2).
 */
vigencia?: {
  /** Ya DERIVADO en el servidor, incluido `vencido`. Ver la exigencia 1. */
  estado: 'vigente' | 'vencido' | 'sin_registro' | 'no_verificado';
  /**
   * ISO de la ÚLTIMA RESPUESTA DEL RUNT. `null` mientras no haya habido ninguna —y con `null` la
   * base NO distingue «nunca se intentó» de «se intentó y falló sin respuesta previa» (§4.2).
   * NO se mueve con un intento fallido (exigencia 3).
   */
  verificadaEn: string | null;
  /** `yyyy-mm-dd`. Solo con `vigente`/`vencido`, y puede faltar: el RUNT reporta a veces por estado. */
  venceEl: string | null;
} | null;
```

Y cuatro exigencias que, si no se cumplen, rompen un AC:

1. **`vencido` lo deriva el SERVIDOR, no la pantalla.** El filtro tiene que correr en SQL sobre el
   conjunto entero (AC2: «exactamente su conjunto», no «lo de esta página»). Si el back deriva
   «vencido» de una manera y el front de otra, **el filtro y el chip se contradicen** en las filas de
   frontera —justo las del día del vencimiento—. Un solo sitio: el servidor.
2. **El universo de los tres filtros es el `EXISTS` del comprobante vivo, y es el MISMO predicado que
   decide si `vigencia` viaja o va `null`.** Un solo criterio en los dos sitios: si divergieran,
   habría filas que salen en un filtro y se pintan sin chip ni línea —o al revés—, y nadie sabría
   cuál de los dos miente. **No se acota con `verificada_en IS NOT NULL`**: eso deja fuera la fila que
   agotó los cuatro intentos sin respuesta previa, y vacía la lista de fallos justo durante la avería
   que existe para hacer visible (§5.2).
3. **`verificadaEn` NO se mueve cuando el RUNT no responde.** Es la última respuesta, no el último
   intento, por dos motivos que se sostienen solos: (a) la **métrica del Feature** —«cuánto tiempo
   lleva sin actualizarse el dato más viejo»— se falsearía y la cola se vería fresca con el RUNT una
   semana caído; (b) el **reintento horario** del cron se saltaría exactamente a los vehículos que
   fallaron. La pantalla está diseñada sobre esta semántica: el chip cuenta lo de hoy, la línea
   cuenta la antigüedad de lo que sabemos (§4.1), y el nulo tiene su propia frase (§4.2).
4. **El número de póliza del RUNT no se proyecta en la cola.** No lo pide ningún AC, es cuasi-PII y
   colisiona de nombre con `flito_soat.numero_poliza`, que es otro número.

> **Handoff a `architecture-agent` / backend:** las cuatro exigencias son contrato de la HU #12096.
> Esta HU **no arranca** hasta que `vigencia` llegue en la fila; hasta entonces el front no tiene qué
> pintar y cualquier implementación sería contra un endpoint inventado.

**Compatibilidad hacia atrás, que en DEV no es teórica:** el merge *es* el deploy, así que el bundle
puede ir por delante del API. **`vigencia` ausente tiene que renderizar la fila exactamente como hoy**
—sin chip, sin línea, sin `—`, sin excepción—. Prohibido asumir que el campo existe, y prohibido
asumir que `verificadaEn` trae fecha.

---

## 8 · Estados (4) + copy

### 8.1 Los cuatro de la vista

| Estado | Qué se ve | ¿Cambia con la HU? |
|---|---|---|
| **1 · Cargando** | `PageContentSkeleton` (ya trae `role="status"` y `aria-busy`), como hoy | **No.** Y **el chip no tiene «cargando» propio**: viaja en la misma respuesta que la fila. Prohibida una segunda llamada para la vigencia — sería un quinto estado y una pantalla que se pinta a trozos |
| **2 · Error** | `FlitCard` roja con el mensaje del servidor + **Reintentar** (`refrescar`), como hoy | **No.** Un fallo de la vigencia **es** un fallo de `GET /flito/soat`: no hay superficie de error nueva |
| **3 · Vacío** | `FlitEmpty`, dos redacciones, **las de hoy** (§8.2) | **No se añade ni una cadena** — pero **sí** hay que meter el filtro en `hayFiltros` o la redacción que sale es la equivocada (§5.3) |
| **4 · Lleno** | La misma tabla de 10/9/10 columnas; las filas con comprobante ganan chip y/o línea en «Estado» | **Sí, el único** |

### 8.2 El vacío de cada filtro

Con `vigencia` puesto, `hayFiltros` es `true` y sale la redacción que ya existe:

> **«Ningún SOAT coincide con los filtros.»** + el botón **«Limpiar filtros»**, que aparece solo
> porque `hayFiltros` lo enciende. Ese botón **es** el siguiente paso.

Qué significa cero en cada uno, que es lo que hay que entender para no leerlo como un fallo:

| Filtro | Cero significa |
|---|---|
| `Vencido` | ningún SOAT con comprobante ha vencido — **no hay trabajo** |
| `Sin SOAT en el RUNT` | todo lo que el RUNT ha contestado está en el registro — **no hay trabajo** |
| `Sin verificar` | **no queda ni un comprobante sin verificar**: ni fallos, ni recién llegados |

Con el universo del comprobante vivo, la tercera fila dice por fin **exactamente lo que parece**: ya
no hay que advertir de ninguna bolsa invisible, porque no queda nada fuera. Lo que sí conviene saber
—y va en §5.2, no en el copy— es que **ese cero es raro**: la lista se repuebla cada vez que se carga
un comprobante y se vacía sola en la corrida siguiente.

**No se añade ni una cadena.** Es un `slim`, y tres frases nuevas para tres listas es copy que nadie
lee. *Variante B, si el PO la quiere:* una línea propia para «Sin verificar» del tipo **«Todos los
SOAT con comprobante están verificados.»** — **no se implementa sin su sí**.

### 8.3 Los tres «vacíos por dato», que no son el mismo

Esta es la parte que hay que leer entera antes de escribir el mapeo:

| Fila | Chip | Línea | Se lee como |
|---|---|---|---|
| **Sin comprobante cargado** | ninguno | **ninguna** | la celda «Estado» queda **exactamente como hoy**: no hay nada que verificar |
| **Con comprobante, `verificadaEn` nulo** | ninguno | **`Sin verificar`** | nunca ha habido respuesta del RUNT para este SOAT (§4.2) |
| **Con comprobante, `no_verificado` con fecha** | `No se pudo consultar` (azul) | `Último dato: …` | hoy se intentó y no salió |

Las tres se distinguen sin leer: **nada**, **una línea gris**, **una pastilla azul con su línea**. Es
la ventaja concreta de la disposición A: no hay una columna cuyo hueco haya que rellenar con «—» en
la mayoría de las filas. Y las dos últimas son justo las que conviven dentro del filtro «Sin
verificar» (§5.2).

**Delta de copy en `apps/web/src/content/ayuda/soat.md`** (ficha en **usted**, como el resto del
archivo; la pantalla tutea y eso tampoco se toca):

- En **Pasos**, punto 2, al final: *«Para revisar la vigencia frente al RUNT, use el filtro
  **Vigencia**: **Vencido**, **Sin SOAT en el RUNT** o **Sin verificar**.»*
- En **Estados → Lleno**, al final: *«En las filas con comprobante cargado, junto al estado aparece
  la vigencia frente al RUNT —**Vigente hasta**, **Venció el**, **Sin SOAT en el RUNT** o **No se
  pudo consultar**— con la fecha de la última respuesta del RUNT. FLITO la comprueba sola cada
  madrugada; mientras no haya habido ninguna respuesta, la fila dice **Sin verificar**. **Una fila
  sin comprobante cargado no se verifica y no muestra nada.** El filtro **Sin verificar** trae las
  dos: las que se acaban de cargar y las que no se pudieron consultar.»*
- En **Qué no hace**, una viñeta: *«No consulta el RUNT cuando usted lo pida: la verificación de
  vigencia la hace FLITO una vez al día y su resultado **no se edita** desde esta pantalla.»* (AC4).

### 8.4 El modal **Ver** — dos `<Dato>` de solo lectura

Detrás de `!esCliente`, al final de la `<dl>` y **antes** del bloque «Soporte»:

| Rótulo | Valor | Cuando no hay dato |
|---|---|---|
| `Vigencia` | el mismo texto de la fila (`Vigente hasta 12/03/27`, `Venció el …`, `Sin SOAT en el RUNT`, `No se pudo consultar`, `Sin verificar`) | `—` (fila sin comprobante) |
| `Último dato del RUNT` | fecha **y hora** con el helper `fecha()` que ya existe | `—` |

El rótulo es **«Último dato del RUNT»** y no «Verificado» en los cuatro estados: es siempre la misma
cosa —cuándo contestó por última vez— y un rótulo que cambiara con el estado obligaría a leer dos
veces. Aquí sí se pinta `—` (el modal ya lo hace en todos sus `<Dato>`) y aquí sí va la hora: es el
nivel de auditoría. **Ni un botón**: el modal no gana acciones (AC4).

---

## 9 · Accesibilidad

- **Cero paradas de tabulador nuevas en la tabla.** El chip es un `<span>` y la línea de antigüedad
  es texto. Las únicas paradas por fila siguen siendo la casilla y «Ver». El `select` de la barra
  añade **una** parada, en la barra, donde ya hay controles.
- **El nombre accesible del `select` es su rótulo visible**, con el `<label>` envolvente de
  «Gestiona». Con eso `getByLabel('Vigencia')` funciona, igual que `getByLabel('Gestiona')` hoy.
- **El criterio nunca depende del color (AC3):** el texto del chip lo dice entero, y la segunda línea
  lo repite por otra vía («Verificado …» / «Último dato: …» / «Sin verificar»). El puntito de color
  del `StatusChip` ya es `aria-hidden` y redundante por diseño del kit.
- **Nada de `title`, `sr-only` ni `aria-label` que digan algo distinto de lo visible.** Y **prohibido
  meter placa, VIN o número de póliza en un `data-*` o un `aria-label`** «para que el test lo
  encuentre»: los selectores de axe arrastran valores de atributo al informe.
- **Contraste:** §3.3. Lo cubre el criterio escrito, **no un gate**. `check:contraste` mide la ⌘K y
  los gradientes; el E2E de a11y necesita `QA_AXE_CDN=1` para no dar ~10 rojos ajenos.
- **Sin efectos.** Ni transición al aparecer el chip, ni parpadeo al refrescar, ni tono que «lata»
  cuando el dato envejece.

---

## 10 · Notas para QA (10) — cada una con el mutante que mata

1. **El conteo de columnas NO cambia: 10 / 9 / 10 (`admin` / `auditor` / `proveedor`).** Es el aserto
   que prueba que la HU no ensanchó la tabla; los dos bucles que ya lo comprueban
   (`flito-soat.spec.ts:317-319` y `344-346`) **siguen valiendo tal cual y no se tocan**. *Mutante:*
   implementar la disposición B sin el sí del PO — los dos bucles se ponen rojos, que es su trabajo.
2. **AC3, el par que importa, en la MISMA corrida.** Dos filas del fixture, una `sin_registro` y otra
   `no_verificado` **con fecha**: `toContainText('Sin SOAT en el RUNT')` en una y `toContainText('No
   se pudo consultar')` en la otra, **y `not.toContainText` cruzado**. *Mutante:* un `switch` con
   `default` que colapse los dos estados en una etiqueta — probar una sola fila lo deja vivo.
3. **AC3, sin depender del color:** el aserto es sobre **texto**, nunca sobre `background` ni sobre
   una clase de tono. *Mutante:* cambiar el tono de un chip; el test debe seguir **verde** (el
   criterio es el texto) y el cambio de tono se revisa a ojo, porque **ningún gate mide el contraste
   de estas etiquetas**.
4. **AC1, la fecha, con `TZ=UTC` y reloj fijado.** Tres filas: verificada hoy, ayer y hace 3 días →
   `Verificado hoy`, `Verificado ayer`, `Verificado hace 3 días (…)`. *Mutante:* volver a
   `Math.floor(ms/86400000)`; sin fijar `TZ` el mutante sobrevive por el huso local del que corre.
5. **La línea de `no_verificado` es la de la ÚLTIMA RESPUESTA, no la del intento.** Fila con
   `estado: 'no_verificado'` y `verificadaEn` de hace 3 días: `toContainText('No se pudo consultar')`
   **y** `toContainText('Último dato: hace 3 días')`, con `not.toContainText('Verificado hace')`.
   *Mutante:* una sola redacción para los cuatro estados —mata además el discriminador del AC3—, o
   pintar «hoy» porque el intento fallido fue hoy.
6. **`verificadaEn` nulo: línea sin chip, y manda la fecha sobre el estado.** Fila con comprobante,
   `verificadaEn: null` **y `estado: 'no_verificado'` a propósito** en el fixture:
   `toContainText('Sin verificar')` y `not.toContainText('No se pudo consultar')`; la celda de estado
   sigue con **un** chip. *Mutante:* mapear con `switch (estado)` sin mirar la fecha, que es el error
   más fácil de toda la HU.
7. **La fila SIN comprobante no gana nada.** Fila `pendiente`: `not.toContainText('Verificado')`,
   `not.toContainText('Sin verificar')`, `not.toContainText('No se pudo consultar')` y exactamente un
   chip en la celda de estado. *Mutante:* pintar «—» o «Sin verificar» a todas.
8. **AC2 — «Sin verificar» trae LAS DOS, y el filtro viaja bien.** Con la opción puesta: (a) la
   petición sale con `vigencia=no_verificado` y **sin `placa`, `vin` ni `documento` en la query**;
   (b) la lista contiene **a la vez** una fila «No se pudo consultar» y una «Sin verificar».
   *Mutante:* acotar el universo con `verificada_en IS NOT NULL` —la segunda desaparece y la lista de
   fallos se vacía justo durante la avería—; mandar la etiqueta visible en vez del valor máquina; o
   filtrar en el cliente sobre la página cargada.
9. **AC2, el vacío correcto.** Con el filtro puesto y respuesta vacía: sale **«Ningún SOAT coincide
   con los filtros.»** y el botón **«Limpiar filtros»**. *Mutante:* olvidar el filtro en `hayFiltros`
   → aparece el texto del Tablero y desaparece la única salida.
10. **AC4 + API vieja.** `getByRole('button', { name: /Verificar/i })` → `toHaveCount(0)` en la fila
    y en el modal, en los tres roles; y un fixture **sin** el campo `vigencia` que se pinta como hoy
    y no revienta. *Mutante:* añadir un botón de re-consulta «ya que estamos»; leer
    `f.vigencia.estado` sin guarda — en DEV el merge es el deploy y eso se ve en DEV, no en el CI.

> **Infraestructura:** el CI corre **un** spec E2E (el visor de PDF). `flito-soat.spec.ts` está en la
> lista fija del **nocturno**: verde en el PR no significa que nadie lo haya ejecutado. Quien cierre
> la HU lo corre a mano, con `QA_AXE_CDN=1` si toca a11y.

---

## 11 · Decisiones, descartes y las preguntas al PO

| # | Decisión | Descarte principal |
|---|---|---|
| 1 | La vigencia va **dentro de la celda «Estado»**: 10/9/10 columnas, sin desborde nuevo, y las filas sin comprobante no necesitan «—» | Columna propia «Vigencia RUNT»: 11 columnas, reabre el desborde y reescribe el sentinela de densidad que dejó la #11906 (queda como variante B) |
| 2 | **«Sin SOAT en el RUNT»** (rojo) vs **«No se pudo consultar»** (azul), con segunda línea de otra gramática | Etiquetas simétricas del tipo «Sin registro» / «Sin verificar» como chips: se confunden a las 7 a.m., que es lo que el AC3 prohíbe |
| 3 | Los cuatro tonos salen de `success`/`warning`/`danger`/`active` | `neutral` y `draft`: sus tintas se redefinen en oscuro contra un fondo de chip fijo y caen a 1,98:1 y 1,37:1 (Bug preexistente del kit, §3.3) |
| 4 | La línea de `no_verificado` cuenta **desde la última respuesta del RUNT**, no desde el último intento | «Último intento hoy»: no es pintable con el contrato real y además solo repetía lo que el chip ya dice |
| 5 | `verificadaEn` nulo → **«Sin verificar», sin chip**, y **la fecha manda sobre el estado** | «Sin verificar **todavía**»: «todavía» promete una espera que no es cierta sobre un VIN que el RUNT nunca acepta, y esa fila se leería como benigna para siempre. **«Sin dato del RUNT»**: se parecía demasiado a «Sin SOAT en el RUNT» |
| 6 | La opción del filtro se llama **«Sin verificar»** —el nombre del AC2 y el del conjunto— aunque no coincida con ningún chip | «No se pudo consultar» como nombre del filtro: **falso para la mitad de las filas que devuelve**. Una opción nombra el conjunto, no a uno de sus miembros |
| 7 | Universo de los filtros: **el `EXISTS` del comprobante vivo**, el mismo predicado que decide si `vigencia` viaja | `verificada_en IS NOT NULL`: vacía la lista de fallos justo durante la avería y esconde para siempre un VIN que el registro nunca acepta |
| 8 | Antigüedad **relativa**, con la absoluta a partir de dos días; nada en `title` | `title` (invisible a teclado y a tableta) y `AntiguedadPill` (importa los umbrales del ANS del gestor, que aquí no significan nada) |
| 9 | **Un** `select` «Vigencia», calcado del de «Gestiona» | Tres chips o tres casillas: tres controles más en una barra de nueve, y una semántica de combinación que ningún AC define |
| 10 | `vencido` lo **deriva el servidor**; el front solo pinta | Derivarlo en el front: el filtro corre en SQL y los dos criterios divergirían justo el día del vencimiento |
| 11 | El `cliente` **no ve nada** de esta HU | Enseñárselo «porque es su vehículo»: es el estado de un proceso interno, con jerga interna, en la única pantalla que ese rol tiene |
| 12 | El número de **póliza del RUNT** no se pinta en ninguna parte | Meterlo en la fila o en el modal: no lo pide ningún AC, es cuasi-PII y colisiona con `flito_soat.numero_poliza`, que es otro número |
| 13 | **No se deduce** «nunca se intentó» de `pagadoEn` ni de la hora de la última corrida | Sería inventar en la pantalla un criterio que la base no tiene —el mismo error que se prohíbe con `vencido`— y se rompería con las reversas y con `con_novedad` |

### Preguntas al PO (ninguna bloquea la implementación de lo anterior)

1. **¿Rojo para «Sin SOAT en el RUNT» y naranja para «Vencido», o al revés?** Aquí se decidió que el
   rojo es para lo que contradice lo que FLITO pagó. Si la operación lo lee al revés, se intercambian
   los tonos y nada más cambia.
2. **«Sin verificar» mezcla los comprobantes recién cargados con los fallos reales, y eso hace la
   lista menos útil para Operaciones**: casi nunca estará vacía y los fallos van diluidos entre los
   del día. Se acepta a propósito —una lista que trae de más y lo enseña es mejor que una que oculta
   fallos en silencio—, y la pantalla los separa sin leer (§5.2). Si el PO quiere dos listas de
   verdad, hace falta una `intentada_en` en la base: es esquema, es de la #12096 y no de esta
   pantalla. *(Mitigación intermedia, no implementada: ordenar esa lista poniendo delante las que
   tienen «Último dato», que son las que ya fallaron.)*
3. **¿El Excel del export debe llevar la vigencia?** Hoy no la lleva: descargar el filtro «Vencido»
   da un archivo que no dice por qué esas filas están ahí. Son dos columnas más y es alcance nuevo.
4. **¿El Cliente debería ver «Vigente hasta …» de sus propios SOAT?** Sería un dato suyo y útil, pero
   con otro copy (usted), sin los dos estados de trastienda, y en otra HU.
