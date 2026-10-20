# UX slim — Grupo FLIT 2: «Último aviso», «Última lectura buena» y avisos con firma no válida (HU #13634)

Feature #13613 · Épica #13576 · módulo **FLITO** `flito-sync` (no el legacy). Delta sobre
`docs/ux/hu-13098-estado-conexion-flit2.md` (estado de la conexión), `docs/ux/hu-13189-flit2-en-vivo.md`
(indicador) y `docs/ux/flito-tramites-sincronizacion-interruptores.md` (grupo FLIT 2 dentro del acordeón
«Sincronización», delta HU #13630 de FLIT 1). Contrato: HU #13633, `Flit2EstadoConexion` en
`packages/shared-types/src/flito-flit2.ts` (`ultimoAvisoEn`, `problema.tipo = 'avisos_firma'`, umbral
`2R + 5 min`). Tono de la pantalla: **tú**. Ficha de ayuda: **usted**.

> Lo que esta spec dice sobre el umbral («30 minutos») **sustituye** a lo escrito en las specs #13098 y
> #13189. Lo demás de esas specs sigue vigente.

---

## Superficie tocada

1. **Grupo FLIT 2** de «Sincronización» (`/flito/tramites`), bloque de estado que hoy pinta
   `LineaEstadoFlit2` (`components/flito/tramites/EstadoFlit2.tsx`): el rótulo único «Última lectura FLIT 2»
   pasa a **dos pares rótulo/valor**, como «Última lectura · Próxima lectura» de FLIT 1 (`Par` de
   `LecturaFlit1.tsx`): **Última lectura buena** · **Último aviso**. El indicador en vivo
   (`IndicadorFlit2`) queda debajo, sin cambio de sitio.
2. **Aviso de página de FLIT 2** (`AvisoEstadoFlit2`): un título y una frase nuevos para `avisos_firma`,
   una frase de reserva para un tipo de problema desconocido, «Última lectura exitosa» pasa a
   «Última lectura buena», y el título de atraso deja de decir «30 minutos».
3. **Indicador en vivo** (`IndicadorFlit2.tsx`): dos casos nuevos (`avisos_firma` y tipo desconocido) y
   el caso `alerta` deja de decir «30 min».
4. **Resumen del acordeón**: sin cambio de código. «Requiere atención» ya sale de `alertaFlit2`, y el
   servidor marca `alerta: true` con `avisos_firma`.
5. Ficha `apps/web/src/content/ayuda/flito_tramites.md` (delta al final).

No cambian el grupo FLIT 1, «Acceso a FLIT 2», el interruptor, la tabla ni los filtros. No hay control
nuevo ni primaria nueva.

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** responder «¿FLIT 2 está entrando bien?». Ahora hay dos vías de entrada: la lectura
automática (el respaldo) y los avisos que manda FLIT 2. El operador tiene que ver las dos horas sin
confundir una con la otra.

**Qué se ve primero:** **Última lectura buena**. Es lo que dice si los trámites están entrando: un aviso
no cuenta como lectura (contrato). **Último aviso** va **a su derecha** (debajo en móvil), y el
indicador «Lectura automática cada 5 min · próxima en 3:12» va **debajo de los dos**, porque habla de
la lectura y no del aviso.

| Dato | Dónde | Por qué |
|---|---|---|
| `ultimaExitosaEn` | Par 1, «Última lectura buena» | Responde «¿entra?». Lleva el sufijo «· lectura atrasada» como hoy |
| `ultimoAvisoEn` | Par 2, «Último aviso» | Dice si FLIT 2 está avisando. Es secundario: va segundo |
| `automatica.*` | Indicador debajo de los pares | Sin cambio de sitio |
| `problema.tipo = 'avisos_firma'` | Título y frase de la tarjeta de aviso + caso del indicador + «Requiere atención» | Exige que alguien corrija la clave |
| Umbral de alerta | Se calcula como `2 · automatica.intervaloMs + 5 min` | La web ya no afirma «30 minutos» |

**Se calla:**
- el código `avisos_firma` y cualquier `tipo` o `codigo` crudo;
- cuántas firmas fallaron (el contrato no lo da, y al operador no le cambia qué hacer);
- si los avisos están habilitados en el ambiente (el contrato no lo expone). Ver la decisión siguiente.

### Cuándo se muestra «Último aviso»

**Siempre que FLIT 2 esté configurado**, también con los avisos apagados en el ambiente y con la fuente
apagada por el interruptor. Con `ultimoAvisoEn: null` dice **«Sin avisos recibidos»**, en el mismo tono
que cualquier valor (`--flit-text-secondary`, semibold): sin color de peligro, sin ícono y sin aviso
(AC2).

- El API no dice si los avisos están habilitados. Ocultar el par cuando es null haría que el bloque
  cambiara de forma según el ambiente, y en QA el par no se vería nunca.
- «Sin avisos recibidos» es un hecho, no un error: en QA y PDN es el estado normal hoy.
- Con `configurado: false` el par **no** se pinta: solo queda «Última lectura buena: Sin configurar», y la
  tarjeta da el siguiente paso, como hoy. Hablar de avisos sin acceso configurado es ruido.

**Densidad:** el bloque pasa de un rótulo + valor a dos pares en fila. Es el mismo peso que el grupo
FLIT 1, y los dos grupos quedan más gemelos. No hay control nuevo.

**Primaria:** no cambia. La zona sigue con **«Guardar parámetros»** (FLIT 1, solo con `configurar`). FLIT
2 conserva «Acceso a FLIT 2» como secundaria. Esto es estado, no acción.

---

## Wireframe — escritorio (≥ lg, grupo FLIT 2)

```
┌ grupo FLIT 2 ────────────────────────────────────────────┐
│ FLIT 2 (h3)                              (●━━) Encendida │
│                                                          │
│ Última lectura buena          Último aviso               │  ← rótulos 11 px, --flit-text-muted
│ 16 oct. 2026, 3:25 p. m.      16 oct. 2026, 3:27 p. m.   │  ← valores semibold, --flit-text-secondary
│ ● Lectura automática cada 5 min · próxima en 3:12        │  ← IndicadorFlit2, sin cambio de sitio
│                                                          │
│ ┌ aviso role=alert (solo con avisos_firma) ────────────┐ │
│ │ FLIT 2 está enviando avisos con firma no válida.     │ │  ← --flit-danger-text, semibold
│ │ Última lectura buena: 16 oct. 2026, 3:25 p. m.       │ │  ← --flit-text-secondary
│ │ FLITO los rechaza y no los tiene en cuenta. Avísale a│ │
│ │ quien administra el ambiente: hay que revisar que la │ │
│ │ clave compartida de los avisos sea la misma en FLIT 2│ │
│ │ y en FLITO. Esto no detiene la lectura automática de │ │
│ │ cada 5 min.                                          │ │
│ └──────────────────────────────────────────────────────┘ │
│                                     [ Acceso a FLIT 2 ]  │
└──────────────────────────────────────────────────────────┘
```

Sin avisos (QA/PDN hoy):

```
│ Última lectura buena          Último aviso               │
│ 16 oct. 2026, 3:25 p. m.      Sin avisos recibidos       │
│ ● Lectura automática cada 60 min · próxima en 41:08      │
```

Alerta por respaldos fallidos (AC4): la última lectura buena queda visible en el bloque **y** en la tarjeta.

```
│ Última lectura buena          Último aviso               │
│ 16 oct. 2026, 1:02 p. m.      Sin avisos recibidos       │
│ ● Sin leer hace más de 15 min · reintenta en 2:40        │  ← punto --flit-danger-text
│ ┌ aviso role=alert ────────────────────────────────────┐ │
│ │ FLIT 2 lleva más de 15 minutos sin leer trámites.    │ │
│ │ Última lectura buena: 16 oct. 2026, 1:02 p. m.       │ │
│ │ La lectura automática vuelve a intentarlo en 2:40; si│ │
│ │ no lee, revisa Acceso a FLIT 2.                      │ │
│ └──────────────────────────────────────────────────────┘ │
```

## Wireframe — móvil (375, sin scroll horizontal)

```
┌ FLIT 2 ─────────────────────┐
│ FLIT 2       (●━━) Encendida│
│ Última lectura buena        │  ← los pares se apilan (flex-wrap)
│ 16 oct. 2026, 3:25 p. m.    │
│ Último aviso                │
│ Sin avisos recibidos        │
│ ● Lectura automática cada 5 │  ← el indicador envuelve
│   min · próxima en 3:12     │
│ ┌ aviso (si aplica) ──────┐ │  ← ancho completo, break-words
│ └─────────────────────────┘ │
│ [     Acceso a FLIT 2     ] │
└─────────────────────────────┘
```

---

## Estados (4) + copy

### Bloque de estado (pares + indicador)

Mismo `Par` que FLIT 1: contenedor `flex flex-wrap gap-x-6 gap-y-2`, cada par `min-w-0 text-[11px]
leading-tight`, rótulo en `--flit-text-muted` y valor semibold en `--flit-text-secondary`. Se reutiliza o
se extrae el `Par` de `LecturaFlit1.tsx`; **no** se crea un componente de kit. Se conserva
`data-testid="linea-estado-flit2"` en el contenedor y se añaden `data-testid="ultima-lectura-flit2"` y
`data-testid="ultimo-aviso-flit2"` en los valores.

| Estado | Última lectura buena | Último aviso | Debajo |
|---|---|---|---|
| **Cargando** | Rótulo real + hueco `h-3 w-28 animate-pulse`, `--flit-bg-hover`, `aria-hidden` | Rótulo real + el mismo hueco | Hueco `h-3 w-32` del indicador, como hoy. Contenedor `aria-busy="true"` |
| **Error** (primer GET o Reintentar) | Una sola línea en el lugar de los dos pares: `No se pudo consultar · [Reintentar]`, igual que FLIT 1. `aria-label="Reintentar la consulta del estado de FLIT 2"` (sin cambio) | — | Nada |
| **Vacío: sin configurar** | `Sin configurar` | No se pinta | Nada. La tarjeta da el siguiente paso (sin cambio) |
| **Vacío: nunca leyó / sin avisos** | `Aún sin lecturas` | `Sin avisos recibidos` | Indicador como hoy |
| **Lleno** | `16 oct. 2026, 3:25 p. m.` (`fechaHora`, `es-CO`, Bogotá, como hoy) + `· lectura atrasada` si aplica, con su `sr-only` | `16 oct. 2026, 3:27 p. m.` (mismo formato) | Indicador |

- Fecha del aviso inválida (no parsea) → `Sin avisos recibidos`. Nunca `Invalid Date`.
- Los refrescos silenciosos siguen igual: si fallan, se conserva el último dato.

### Umbral de atraso: qué copy deja de afirmar «30 minutos»

`U = 2 · automatica.intervaloMs + 5 min`. Se escribe con un helper:
- menos de 60 min → `{m} minutos` en la tarjeta y `{m} min` en el indicador;
- 60 min o más → `{h} h` si es exacto, o `{h} h {r} min`, igual en los dos sitios.

Ejemplos: R = 5 → «15 minutos» / «15 min». R = 60 → «2 h 5 min».

| Sitio | Hoy | Después |
|---|---|---|
| Título de la tarjeta (atraso) | `FLIT 2 lleva más de 30 minutos sin leer trámites.` | `FLIT 2 lleva más de {U} sin leer trámites.` Sin `intervaloMs`: `FLIT 2 no ha leído trámites en el tiempo esperado.` |
| Regla del título (Bug #13198) | Atraso «de verdad» = `ahora − ultimaExitosaEn ≥ 30 min` | `≥ U`, con el reloj corregido por `desfaseMs`. Sin `intervaloMs` no se afirma el atraso por tiempo: manda la causa (problema) o el título de reserva de arriba |
| Indicador, caso `alerta` | `Sin leer hace más de 30 min · reintenta en {cuenta}` | `Sin leer hace más de {U} · reintenta en {cuenta}`. Anuncio: `FLIT 2 lleva más de {U} sin leer.` |
| Constante `MEDIA_HORA_MS` y comentarios con «30 min» en `EstadoFlit2.tsx` | — | Desaparecen. El umbral sale del pulso del estado, no de una constante |

La web **no** decide si hay alerta: eso sigue siendo `alerta` del servidor. `U` solo sirve para elegir y
redactar el título.

### Tarjeta de aviso: `avisos_firma` (AC3)

`alerta: true` → `role="alert"`, como cualquier alerta.

- **Título** (`--flit-danger-text`, semibold): `FLIT 2 está enviando avisos con firma no válida.`
- **Línea de fecha** (`--flit-text-secondary`): `Última lectura buena: {fecha, hora}.` Si nunca leyó:
  `Todavía no hay ninguna lectura buena.`
- **Cuerpo**: `FLITO los rechaza y no los tiene en cuenta. Avísale a quien administra el ambiente: hay que revisar que la clave compartida de los avisos sea la misma en FLIT 2 y en FLITO.` A continuación:
  - con `automatica.activa` e `intervaloMs`: ` Esto no detiene la lectura automática de cada {N} min.`
    (`{N}` igual que el `cada()` del indicador);
  - sin ellos, la frase se omite.

No hay hora: `en` llega null. El cuerpo no lleva `{hora}`, ni conteo, ni el nombre del tipo.

**Precedencia del título** (amplía la de `tituloAlerta`; gana la primera que aplique):
1. `rechazado` → `FLIT 2 rechazó el acceso de FLITO.` (sin cambio)
2. `bloqueado` → `FLIT 2 bloqueó el acceso por un tiempo.` (sin cambio)
3. Atraso real (`ultimaExitosaEn` existe y `≥ U`) → `FLIT 2 lleva más de {U} sin leer trámites.`
4. `avisos_firma` → `FLIT 2 está enviando avisos con firma no válida.`
5. `lectura` → `Falló la última lectura de FLIT 2.` (sin cambio)
6. Tipo desconocido → `FLIT 2 necesita revisión.`
7. Sin problema → título de atraso con `{U}`, o el de reserva sin `intervaloMs`.

Con atraso real **y** `avisos_firma`, el título dice el atraso y el cuerpo es la frase de `avisos_firma`.
Las dos cosas son ciertas, y la frase cierra con «no detiene la lectura automática», sin afirmar que
lea bien.

Sin `alerta` (no debería pasar con `avisos_firma`, pero el código no lo asume): sin título ni fecha,
solo el cuerpo, con `role="status"`, igual que hoy con cualquier `problema`.

### Tipo de problema desconocido (texto de reserva)

`fraseProblema` hoy cae en el `switch` de códigos de lectura con cualquier tipo que no sea
`rechazado`/`bloqueado`. Un tipo nuevo diría «La lectura falló», que es falso. Cambio:
- el `switch` de códigos **solo** con `tipo === 'lectura'`;
- cualquier otro tipo no conocido (ni `avisos_firma`) → `Hay un problema con la conexión a FLIT 2. Si sigue después de la próxima lectura, avísale a soporte técnico.`
  Si `en` llega, se antepone `{ALas(m)}, ` y la frase sigue en minúscula: «A las 3:40 p. m., hay un
  problema…».
- Título, si hay alerta: `FLIT 2 necesita revisión.`

Nunca se pinta el `tipo` ni el `codigo`.

### Indicador en vivo (`IndicadorFlit2`): casos nuevos

Precedencia de `casoDe`, calcada de la del servidor: `rechazado` > `bloqueado` > **`avisos_firma`** >
`lectura` > **tipo desconocido** > `alerta` > encendida.

| Caso | Tono del punto | Línea visible (`aria-hidden`) | Anuncio (`role="status"`, sr-only) | Cuenta |
|---|---|---|---|---|
| `avisos_firma` | `warning` | `Avisos con firma no válida · próxima lectura en {cuenta}` | `FLIT 2 está enviando avisos con firma no válida.` | Sí. Lector: «Próxima lectura a las …» |
| desconocido | `warning` | `Conexión por revisar · próxima lectura en {cuenta}` | `La conexión con FLIT 2 necesita revisión.` | Sí. Igual |
| `alerta` | `danger` (sin cambio) | `Sin leer hace más de {U} · reintenta en {cuenta}` | `FLIT 2 lleva más de {U} sin leer.` | Sí (sin cambio) |

`avisos_firma` va en `warning` y no en `danger`: la lectura automática sigue trayendo trámites. `danger`
queda para «no entra nada» (rechazo, atraso). La urgencia ya la dicen la tarjeta (`role="alert"`) y
«Requiere atención».

### Resumen del acordeón («Requiere atención»)

**Sin cambio de código ni de copy.** Con `avisos_firma` el servidor manda `alerta: true`, `alertaFlit2`
devuelve `true` (fuente encendida y configurada) y sale el distintivo existente, «Requiere atención» +
ícono en `--flit-danger-text`, junto a «FLIT 2: Encendida». Es correcto: hay algo que alguien tiene que
corregir (la clave). No se añade un segundo texto ni una variante «Avisos rechazados» en el resumen. El
detalle va dentro del grupo. Con la fuente apagada, `alertaFlit2` lo anula, como hoy.

---

## Responsive + feedback del delta

- **< lg / 375 px:** los dos pares van en `flex flex-wrap gap-x-6 gap-y-2`, cada uno `min-w-0`, así que
  se apilan cuando no caben, sin `min-w` ni anchos fijos. El indicador ya envuelve. La tarjeta ocupa el
  ancho completo con `break-words`. Sin scroll horizontal (AC5).
- **Tema oscuro:** solo tokens con par oscuro (`--flit-text-muted/secondary/primary`,
  `--flit-danger-text`, `--flit-warning-text`, `--flit-border-soft`, `--flit-bg-card`,
  `--flit-bg-hover`). Hay que verificar ≥ 4.5:1 del rótulo muted de 11 px y del título de peligro en los
  dos temas.
- **Feedback:** no hay control nuevo. El único interactivo del bloque sigue siendo [Reintentar]
  (`hover:underline`, `flit-focus`). Los pares y la tarjeta no son clicables y no llevan hover.
- **Notificación:** aviso de **página**, **nunca toast** (AC3). `avisos_firma` es un estado que sigue
  siendo cierto mientras se mira. La tarjeta mantiene su `key` estable para no volver a anunciarse en
  cada poll. Los pares **no** son región viva: el «Último aviso» cambiaría con cada aviso y haría ruido.

## Permiso/slug

Sin cambio. La ruta y el `PageSlug` de Gestión de Trámites siguen igual. El bloque, la tarjeta y el
polling existen solo con `sync.sync.ver_estado`. Con 403 no se pinta nada, como hoy.

---

## Delta de la ficha de ayuda (`apps/web/src/content/ayuda/flito_tramites.md`, en **usted**)

1. **Pasos, 1**, frase «Si FLIT 2 necesita su atención —el acceso fue rechazado, la lectura está
   bloqueada o lleva más de 30 minutos sin leer—, …». Cambia a:
   > Si FLIT 2 necesita su atención —el acceso fue rechazado, la lectura está bloqueada, lleva más tiempo del esperado sin leer o FLIT 2 está enviando avisos con firma no válida—, junto a FLIT 2 verá **Requiere atención** con un ícono de advertencia.
2. **Pasos, 1**, desde «En el grupo **FLIT 2**, FLITO lee FLIT 2 solo, cada 5 minutos. Junto a
   **Última lectura FLIT 2** verá la hora de la última lectura que salió bien y, debajo, …». Cambia a:
   > En el grupo **FLIT 2**, FLITO lee FLIT 2 solo, cada pocos minutos: la línea de la lectura automática le dice cada cuántos. Además, FLIT 2 puede avisar a FLITO cuando hay trámites nuevos o con cambios. Junto a **Última lectura buena** verá la hora de la última lectura que salió bien y, junto a **Último aviso**, la del último aviso que llegó de FLIT 2. Si dice **Sin avisos recibidos**, no ha llegado ninguno en este ambiente; no es un error: la lectura automática trae los trámites igual. Debajo verá cuándo es la próxima lectura («próxima en 3:12») o «Leyendo FLIT 2 ahora…» mientras lee.

   El resto de la frase (lectura atrasada, apagada en este ambiente) no cambia.
3. **Estados**, ítem «Aviso de FLIT 2». Cambian estas frases:
   - «si FLIT 2 rechaza o bloquea el acceso, o lleva más de 30 minutos sin leerse» →
     > si FLIT 2 rechaza o bloquea el acceso, envía avisos con firma no válida o lleva sin leerse más del doble del intervalo de la lectura automática y cinco minutos más (15 minutos si lee cada 5)
   - «(acceso rechazado, acceso bloqueado por un tiempo, falló la última lectura o más de 30 minutos sin
     leer), y debajo, la última lectura exitosa y qué hacer» →
     > (acceso rechazado, acceso bloqueado por un tiempo, sin leer más tiempo del esperado, avisos con firma no válida o falló la última lectura), y debajo, la última lectura buena y qué hacer
   - Se añade después de «…cuando vuelve una lectura exitosa.»:
     > Si FLIT 2 envía varios avisos seguidos con firma no válida, FLITO no los tiene en cuenta y el aviso le pide avisar a quien administra el ambiente para revisar la clave compartida de los avisos; la lectura automática sigue funcionando aparte.

   «El aviso se quita solo cuando vuelve una lectura exitosa» se deja tal cual: es la regla del atraso.
   Que `avisos_firma` se quite con el siguiente aviso válido depende del backend, y la ficha no lo afirma.
4. **Para quién:** no cambia.

---

## Notas para QA (≤10)

1. AC1: configurado, con `ultimaExitosaEn` y `ultimoAvisoEn` → «Última lectura buena» y «Último aviso»
   con fecha y hora de Bogotá (`16 oct. 2026, 3:25 p. m.`). El indicador queda debajo de los dos.
2. AC2: `ultimoAvisoEn: null` → «Sin avisos recibidos» en el mismo color que los demás valores, sin
   tarjeta, sin «Requiere atención» y sin rojo. Con `configurado: false` no aparece el par.
3. AC3: `problema: { tipo: 'avisos_firma', … null }` + `alerta: true` → tarjeta `role="alert"` con el
   título y el cuerpo exactos de esta spec, «Requiere atención» en el resumen contraído y el indicador
   «Avisos con firma no válida · próxima lectura en m:ss». El DOM no contiene `avisos_firma`.
4. AC4: R = 5 y `ultimaExitosaEn` de hace 20 min, sin problema → título «…más de 15 minutos…» e indicador
   «Sin leer hace más de 15 min», con «Última lectura buena» visible en el bloque y en la tarjeta. Con
   R = 60: «2 h 5 min». En ningún sitio aparece «30 minutos».
5. Atraso de 10 min con R = 5 y `problema.tipo = 'lectura'` → título «Falló la última lectura de FLIT 2.»,
   no el de atraso (regla del Bug #13198 con `U`).
6. Tipo inventado (`tipo: 'xyz'`) → frase y título de reserva. Ni «xyz» ni «La lectura … falló» en el DOM.
7. Cuatro estados del bloque: esqueleto con los dos rótulos reales; error con [Reintentar] de una línea;
   «Sin configurar»; lleno.
8. 375 px, tema claro y oscuro: los pares se apilan sin scroll horizontal y el contraste del rótulo muted
   y del título de peligro es ≥ 4.5:1.
9. El polling con el mismo `avisos_firma` no vuelve a anunciar la tarjeta. No sale ningún toast.
10. Ficha: el delta aplicado y ningún «30 minutos» en `flito_tramites.md` (`flit-ayuda-flito`).

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Saber si FLIT 2 está entrando: por lectura y por avisos. |
| ¿Qué se ve primero y qué se calla? | «Última lectura buena» primero, «Último aviso» a su lado y el indicador debajo. Se callan los códigos, el conteo de firmas y si los avisos están habilitados. |
| ¿Primaria única? | Sin cambio. Es estado, no acción. |
| ¿Vacío y error con siguiente paso? | «Sin avisos recibidos» es un hecho, no un error. `avisos_firma` dice a quién avisar y qué revisar. El tipo desconocido manda a soporte si persiste. El error de consulta tiene [Reintentar]. |
| ¿Efectos o patrón nuevo? | Ninguno. El `Par` de FLIT 1, la tarjeta y el indicador existentes. |
| ¿Móvil? | Los pares se apilan (`flex-wrap`, `min-w-0`) y la tarjeta ocupa el ancho completo. |
| ¿Feedback? | No hay control nuevo. [Reintentar] sin cambio. |
| ¿Notificación? | Aviso de página (`alert`), nunca toast. |

## Decisiones y descartes

- **«Última lectura buena» en lugar de «Última lectura FLIT 2»**: AC1 lo pide, y junto a «Último aviso»
  hay que distinguir lectura de aviso. «FLIT 2» sobra dentro del grupo FLIT 2. FLIT 1 conserva «Última
  lectura» porque no tiene avisos. La asimetría es intencional y no se toca FLIT 1 en esta HU.
- **Formato de fecha absoluto (`fechaHora`)** y no el «hoy a las…» de FLIT 1: AC1 pide fecha y hora, y
  es el formato vigente del grupo FLIT 2 (menos cambio y e2e estables). Unificar los dos grupos sería
  otra HU.
- **«Último aviso» siempre visible con FLIT 2 configurado**, aunque los avisos estén apagados en el
  ambiente: el API no expone la habilitación, y ocultarlo según null haría el bloque inestable.
- **Sin línea explicativa de qué es un aviso** en la pantalla: lo explica la ficha. Una frase más en el
  grupo competiría con el estado.
- **Descartado** un distintivo distinto en el resumen para `avisos_firma`: «Requiere atención» ya dice
  lo único que importa con la zona contraída.
- **Descartado** botón o enlace en la tarjeta para «revisar la clave»: la clave no se edita en FLITO
  (es del ambiente), y no hay acción que ofrecer.
- **`avisos_firma` en `warning` en el indicador**: no se pierden trámites, porque el respaldo lee.
  `danger` se reserva para «no entra nada».
- **Entrega en archivo propio** y no como sección dentro de `hu-13098-…` o
  `flito-tramites-sincronizacion-interruptores.md`: el ux-agent no tiene `Edit`, y reescribir a mano
  esos documentos largos con `Write` arriesgaba alterarlos. Queda pendiente un puntero de una línea en
  los dos (ver HANDOFF).
