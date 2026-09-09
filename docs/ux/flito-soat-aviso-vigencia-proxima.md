# UX slim — Aviso de SOAT próximo a vencer en el alta del canal Cliente (HU #12213)

Delta sobre `apps/web/src/pages/FlitoSoatSolicitud.tsx`, bloque **1 · Vehículo**. No rediseña el
asistente. **El modal del `409` no se toca**: cuando el SOAT vence en más de un mes, la pantalla
sigue cortando exactamente como hoy (`ModalSoatVigente`).

## Superficie tocada

Un solo punto: la respuesta `200` de `POST /flito/soat/cliente/preconsulta` trae ahora
`vigenciaProxima: { venceEl: 'yyyy-mm-dd' } | null` —**la clave está siempre presente**— y cuando
no es `null` el bloque 1 pinta un aviso **informativo** y el flujo continúa hasta «Enviar al gestor».

La pantalla **no calcula el umbral**. No hay resta de fechas, no hay «un mes» derivado en el
cliente: si llega el objeto, se avisa; si llega `null`, no hay nada que pintar. La frase «falta un
mes o menos» es una explicación de lo que el servidor ya decidió, no una condición evaluada aquí.

### Qué vino a hacer quien abre esto

Una persona de una compañía transportadora que entra a pedir el SOAT de **un** vehículo suyo. No
conoce «desenlace», «compuerta» ni «preconsulta». Lo que necesita saber en este punto es una sola
cosa: **si puede seguir o no**. El malentendido caro de esta HU es que lea el aviso como un error y
abandone creyendo que no puede pedirlo — que es justo lo que la HU viene a evitar.

## Delta de claridad (qué se ve / qué se calla)

### Dónde va

Dentro de la `<Seccion titulo="1 · Vehículo">`, **entre el botón de consulta y `FichaRunt`**: en el
mismo hueco donde hoy vive la banda de desenlace del RUNT (`ID_BANDA_RUNT`, hoy en
`FlitoSoatSolicitud.tsx:823-835`).

```
┌ 1 · Vehículo ──────────────────────────── [✓ Consultado] ┐
│  VIN (número de chasis)  [ 9FKRG2222T2042405 ]           │
│  Está en la tarjeta de propiedad y en la factura…        │
│                                                          │
│  [ Consultar de nuevo ]   ← secundario en fase ok        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │  ← AVISO (nuevo)
│  │ (•) Puede continuar          chip success        │    │     role="status"
│  │ Este vehículo todavía tiene SOAT vigente, hasta  │    │     solo si
│  │ el 5 de octubre de 2026.                         │    │     vigenciaProxima
│  │ Falta un mes o menos para que venza, así que sí  │    │     !== null
│  │ puede enviar esta solicitud.                     │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌ Datos del RUNT ─────────── Traídos el 09/09/26 … ┐    │  ← FichaRunt, sin cambios
│  │ Placa · VIN · Marca · Línea · …                  │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

**Encima de la ficha y no dentro ni debajo.** Quien acaba de pulsar el botón lee hacia abajo desde
él: la respuesta a «¿puedo seguir?» tiene que llegar antes que once pares etiqueta–valor. Y ese
hueco ya es, en esta pantalla, el sitio canónico de «qué dijo el RUNT»; el aviso lo ocupa cuando la
respuesta fue buena, igual que la banda lo ocupa cuando fue mala.

**No va dentro de `FichaRunt`.** Esa ficha es texto de solo lectura sobre el vehículo («¿es mi
carro?») y su propio copy dice que sus datos no se editan; el aviso habla del trámite, no del
vehículo. Meterlo ahí le añade una idea ajena a un componente que hoy tiene una sola.

### Con qué peso: reusa, no estrena

| Pieza | De dónde sale |
|---|---|
| Carcasa del recuadro | La misma de la banda de desenlace y de `AvisoLectura` fase `fallo`: `rounded-[10px] p-3`, `border: 1px solid var(--flit-border-soft)`, `background: var(--flit-bg-app)` |
| Chip | `StatusChip tone="success"` — `apps/web/src/components/flit/StatusChip.tsx` |
| Fecha | `fechaLarga()` — `apps/web/src/lib/soatCliente.ts:41` |
| Título / detalle | `text-sm font-semibold` en `--flit-text-primary` / `text-xs` en `--flit-text-secondary` |

**Componente nuevo: ninguno.** Es la carcasa que la pantalla ya usa dos veces, con otra tinta y otro
rol ARIA. Si al implementar sale un tercer sitio con la misma carcasa, la extracción razonable es un
`Banda` en `components/flito/soat-cliente/bloques.tsx` (donde ya viven `AvisoLectura` y
`BandaSobrescritura`) — no un componente en `components/flit/`, que es kit transversal.

### Cómo se distingue a simple vista de los otros tres

Los cuatro desenlaces son **fases excluyentes** del mismo estado `Consulta`
(`FlitoSoatSolicitud.tsx:118-127`): el aviso solo existe en `fase: 'ok'` y las bandas de error solo
en `fase: 'fallo'`. **Nunca se pintan a la vez.** Encima de eso, tres señales redundantes:

| | 422 revise los datos | 503 RUNT no disponible | **Aviso de vigencia (nuevo)** |
|---|---|---|---|
| Color del título | `--flit-danger-ink` | `--flit-warning-ink` | **`--flit-text-primary`, sin tinta de estado** |
| Chip | ninguno | ninguno | **`success` · «Puede continuar»** |
| Rol ARIA | `alert` | `alert` | **`status`** |
| ¿Hay ficha del RUNT debajo? | No | No | **Sí** |
| Rótulo del botón | «Volver a consultar» | «Volver a consultar» | «Consultar de nuevo» |
| Foco | al campo VIN | al botón | **no se mueve** |
| VIN marcado inválido | Sí | No | No |

El aviso es el único de los cuatro que **no lleva color de estado en el título**. Es deliberado:
colorearlo —aunque fuera en azul— lo iguala visualmente a las bandas de fallo, que es el
malentendido que hay que evitar. Lo verde es el chip, que es lo que dice la buena noticia.

**Lo que se calla:** el número de póliza y la aseguradora, aunque el RUNT los traiga (el `200` no
los expone en `vigenciaProxima` y el modal del `409` ya tomó esa decisión: no hacen falta para
decidir y son de un contrato con un tercero). Tampoco «renovación anticipada», que es la clase con
la que el backend guarda la fila: es vocabulario de la cola de Operaciones, no de esta visita.
Tampoco el número de días que faltan: el servidor no los manda y calcularlos aquí es reimplementar
el umbral.

## Copy literal

Tratamiento **usted**, el asentado en todo `soatCliente.ts` («Escriba el VIN…», «Compruébelo…»,
«Vuelva a consultar»). Sin tuteo, sin jerga.

**Chip:** `Puede continuar`

**Título (con fecha — el caso del contrato):**
> Este vehículo todavía tiene SOAT vigente, hasta el 5 de octubre de 2026.

**Detalle:**
> Falta un mes o menos para que venza, así que sí puede enviar esta solicitud.

Las tres cosas y ninguna más: *todavía* tiene SOAT · *hasta cuándo* · *sí puede enviar*, con el
porqué. El «todavía» y el «sí» cargan el trabajo: sin ellos la primera frase se lee igual que el
título del modal que bloquea («Este vehículo ya tiene SOAT vigente»), y esa es la confusión que
hace abandonar. No lleva botón: la acción de esta pantalla ya existe abajo.

**Redacción de respaldo, sin fecha.** El contrato dice que `venceEl` viene siempre dentro del
objeto; si llegara vacío o sin forma `yyyy-mm-dd`, se cambia la **frase entera** y jamás se escribe
«hasta el —» ni se inventa una fecha — misma regla que `ModalSoatVigente` (`ModalesBloqueo.tsx:72-79`):
> Este vehículo todavía tiene SOAT vigente y le falta un mes o menos para vencerse, así que sí puede enviar esta solicitud.

### Formato de la fecha

`fechaLarga('2026-10-05')` → **«5 de octubre de 2026»**. Ya existe en `lib/soatCliente.ts:41`, ya la
usa el modal del `409` y ya resuelve la trampa: parte el ISO por componentes porque
`new Date('2026-10-05')` es medianoche UTC y en Colombia (−05) **restaría un día** — el aviso diría
el 4 de octubre. No se usa `fechaCorta` (`05/10/26`, de `vigenciaSoatCola.ts`): esa es densidad de
tabla para Operaciones, y aquí la fecha va dentro de una oración que se lee una vez.

## Estados (4) + copy

Estado del bloque 1 (fases reales de `Consulta` entre paréntesis). **El aviso solo existe en el
cuarto**, y solo si `vigenciaProxima !== null`.

| Estado | Fase | Qué se ve | ¿Aviso? |
|---|---|---|---|
| **Cargando** | `cargando` | Botón «Consultando el RUNT…» deshabilitado, VIN en `readOnly`, `role="status"`: «La consulta puede tardar hasta un minuto. No cierre esta página.» | No |
| **Vacío / sin consultar** | `inicial`, `invalidada` | Campo VIN + su ayuda, botón «Consultar el RUNT». En `invalidada`, `role="status"`: «Cambió el VIN: vuelva a consultar el RUNT antes de enviar.» Sin ficha. | No |
| **Error** | `fallo`, `sin-banda` | `fallo`: banda `role="alert"` con el desenlace (422 en `danger-ink` y foco al VIN; 503 en `warning-ink` y foco al botón). `sin-banda`: lo explicó un modal (`soat_vigente` a más de un mes, `vin_ya_tiene_soat`). Sin ficha, compuerta cerrada. | No |
| **Con datos** | `ok` | Chip «✓ Consultado» en el encabezado, aviso (si aplica), `FichaRunt`, botón secundario «Consultar de nuevo». Compuerta abierta. | **Sí, si `vigenciaProxima !== null`** |

Copy de vacío y de error: **no cambian**. Ya dicen el siguiente paso y están en `soatCliente.ts`
(`DESENLACE`, `DESENLACE_GENERICO`, `DESENLACE_SIN_RED`). Esta HU no toca ninguno.

Las tres frases quedan separadas por lo que la persona debe hacer, que es lo único que importa:

- **503 «El RUNT no está disponible, vuelva a consultar.»** → no hay nada que corregir; **se
  reintenta** con el mismo botón, cuyo rótulo es esa misma frase.
- **422 «Revise el VIN: no coincide…»** → **hay que corregir** un dato; el foco cae en el VIN y el
  campo queda marcado inválido.
- **Aviso de vigencia** → no hay nada que corregir **ni** nada que reintentar; **se sigue**. Ninguna
  de sus dos frases contiene «revise», «vuelva» ni «no pudimos».

## Permiso/slug

Sin cambio. Ruta y capacidad existentes: `puedeSolicitarSoat(user)` sobre el slug `flito_soat`
(canal Cliente). El aviso no añade superficie con permiso propio ni cambia quién ve la pantalla.

**Una primaria, sin cambio:** «Enviar al gestor». En `fase: 'ok'` el botón de consulta ya baja a
`flitBtnSecondary` y el aviso **no lleva ningún botón**.

**Densidad:** sin cambio en el caso normal (`vigenciaProxima: null` no pinta nada). En el caso del
aviso, +1 chip y 2 líneas en un bloque de un solo campo — y **alivia**: sustituye un modal que hoy
corta el flujo entero por dos frases que lo dejan seguir.

## Accesibilidad

- **`role="status"`** en el contenedor del aviso (live polite, atómico). Es la consecuencia de una
  acción del usuario y aparece después de ella, así que se anuncia solo al montarse; no hay
  anuncio al cargar la página porque en `inicial` el nodo no existe. **No `role="alert"`**: es
  assertive, interrumpe, y ese registro es el de los fallos. Es el mismo criterio que la pantalla ya
  aplicó a «Cambió el VIN…» (`:839-843`) y a `AvisoLectura` fase `vacia`.
- **El foco no se mueve.** El efecto de foco de la página solo actúa en `fase === 'fallo'`
  (`:291-298`) y no debe extenderse: aquí no hay nada que corregir y robar el foco interrumpiría a
  quien ya esté escribiendo abajo.
- Sin `aria-describedby` desde el VIN: el campo no está en cuestión.
- El texto es autosuficiente. Ni el chip verde ni el color son portadores de información (SC 1.4.1):
  quitando todo el color, las dos frases siguen diciendo lo mismo.
- El punto del `StatusChip` ya es `aria-hidden`; el lector anuncia «Puede continuar» y sigue.
- **Dos regiones vivas en el mismo montaje:** `FichaRunt` ya trae un `role="status"` con «Traídos el
  …». Al llegar un `ok` con aviso, el lector encola dos anuncios. Es tolerable —el aviso va primero
  en el DOM— pero si en QA se oye ruidoso, lo que se retira es el `role="status"` del sello de
  procedencia (un metadato), **nunca** el del aviso.

### Contraste

**Ningún par de color nuevo.** Se reusan tres pares ya medidos en esta misma superficie:

| Elemento | Par | Ratio |
|---|---|---|
| Título | `--flit-text-primary` `#162744` sobre `--flit-bg-app` `#EAF2FF` | ~13:1 |
| Detalle | `--flit-text-secondary` `#59677D` sobre `--flit-bg-app` `#EAF2FF` | 5,09:1 |
| Chip | `--flit-success-ink` `#3C7C17` sobre `#EBF8E3` (fondo **opaco** del propio chip) | 4,66:1 |

El chip no depende de la superficie padre: su fondo es hex opaco desde el Bug #11604, justamente
para que no cambie de ratio al posarse sobre `--flit-bg-app`.

**Prohibido `--flit-info` (`#4F74C9`) como color de texto**: es token de *superficie*. Su variante
tinta es `--flit-blue-ink` (`#4264B7`) — y aun así no se usa aquí, porque colorear el título es lo
que igualaría el aviso a las bandas de error.

`npm run check:contraste` **no acredita esto**: solo mide la ⌘K y los gradientes. La evidencia real
es axe sobre la pantalla, con `QA_AXE_CDN=1`.

## Notas para QA

1. `vigenciaProxima: { venceEl }` en un `200` → aviso visible **encima** de `FichaRunt`, ficha
   presente, «Enviar al gestor» alcanzable y el envío llega a completarse.
2. `vigenciaProxima: null` en un `200` → **cero** aviso; el bloque 1 se ve exactamente como hoy.
3. La clave siempre viene: comprobar también que un `200` sin la clave (API desfasada) no rompe la
   pantalla y se comporta como `null`.
4. `409 soat_vigente` → **`ModalSoatVigente` intacto**, sin aviso y sin ficha. Regresión obligatoria:
   esta HU no lo toca.
5. `venceEl: '2026-10-05'` renderiza «5 de octubre de 2026» y **no** «4 de octubre» — el fallo del
   huso se ve corriendo con `TZ=America/Bogota`.
6. `venceEl` vacío o con otro formato → sale la redacción de respaldo entera, nunca «hasta el —».
7. `422` y `503` en la misma sesión que un `ok` previo: al fallar, el aviso **desaparece** junto con
   la ficha (fases excluyentes); no queda un aviso viejo debajo de una banda roja.
8. Editar el VIN después de un `ok` con aviso → `invalidada`: se retiran ficha y aviso, y aparece
   «Cambió el VIN: vuelva a consultar el RUNT antes de enviar.»
9. Lector de pantalla: el aviso se anuncia una vez al aparecer, **no** al cargar la página, y el
   foco se queda donde estaba (en el botón de consulta).
10. axe con `QA_AXE_CDN=1` sobre el bloque 1 en fase `ok` con aviso: cero violaciones de contraste.
