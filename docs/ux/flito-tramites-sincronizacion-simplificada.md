# UX slim — Gestión Trámites: sincronización simplificada y aviso de trámites nuevos (HU #13680, #13678, #13684)

Delta sobre `docs/ux/flito-tramites-sincronizacion-interruptores.md` (sección «Sincronización»),
`docs/ux/hu-13098-estado-conexion-flit2.md` y `docs/ux/hu-13634-ultimo-aviso-flit2.md`. Pantalla
existente `/flito/tramites` (Gestión Trámites), con público de operador interno. Habla con los módulos **FLITO**
(`/api/flito/sync/*`, `/api/flito/tramites`), no con el legacy `tramites`.

**Qué viene a hacer el operador a la sección Sincronización:** saber en un vistazo si cada fuente
está trayendo trámites, y cuándo fue lo último. La mecánica (frecuencias, próximas lecturas,
cuentas regresivas, reintentos) no responde a esa visita: sale de la vista o pasa a un clic.

**Tono:** la sección ya **tutea** («Avísale», «Revisa», «Pídele»). Se calca: los ejemplos de los AC
en «usted» («Revise Acceso a FLIT 2») se escriben aquí en tú («Revisa…»). La ficha de Ayuda (AC5
de #13680) va en **usted**, como todas las fichas.

**Primaria de la zona:** con estas tres HU la sección Sincronización se queda **sin primaria**:
«Parámetros de lectura» y «Acceso a FLIT 2» son secundarios gemelos, uno en cada barra. «Guardar
parámetros» sigue siendo primaria, pero ahora **dentro de la modal**, que es otra superficie.

---

## HU #13680 — FLIT 1: solo «Última lectura» y los parámetros en una modal

### Superficie tocada

Grupo FLIT 1 de `SincronizacionTramites.tsx` (+ `LecturaFlit1.tsx`). Nada más de la página.

### Delta de claridad

**Siempre visible en el grupo (en este orden):**
1. Cabecera de la fuente: «FLIT 1» + interruptor + estado (sin cambios, `CabeceraFuente`).
2. Par «Última lectura» con su valor.
3. Las notas muted que ya existen bajo el par: «La primera lectura trae los trámites desde la
   fecha de arranque.» (sin lecturas y encendida) y «Último fallo: …» (fallo superado, o fallo con
   la fuente apagada). No las piden quitar los AC y responden a «¿está trayendo?»: se quedan.
4. Aviso de apagada (`motivo-flit1`) y aviso de fallo vigente (`AvisoFalloFlit1`): sin cambios.
5. Barra de acciones (`BARRA`, `mt-auto`, a la derecha): botón secundario **«Parámetros de lectura»**.

**Se quita del grupo:**
- El párrafo «FLITO lee FLIT 1 automáticamente cada N minutos.» / «FLITO lee FLIT 1 automáticamente.»
  (`explicacion-flit1`).
- El par «Próxima lectura» y todos sus valores («Lectura detenida», «En unos minutos», «En
  cualquier momento», «hacia las…»).
- El formulario de parámetros en línea (`ParametrosLecturaFlit1Form` dentro del grupo), con su
  separador, subtítulo y «Guardar parámetros».

**Pasa a un clic (modal):** frecuencia, ventana, ventana nocturna, fecha de arranque, sus ayudas y
topes, y la línea «Cambiados por… / Valores por defecto…».

**Densidad:** aliviada. El grupo FLIT 1 baja de ~10 elementos a 4, y queda simétrico con FLIT 2:
estado arriba y un secundario abajo a la derecha.

### Wireframe (grupo)

```
┌─ FLIT 1 ────────────────────────────── [● Encendida  ⏻] ┐
│ Activada por Ana Pérez el 2 oct. 2026                      │  ← sin cambios (CabeceraFuente)
│                                                            │
│ Última lectura                                             │
│ hoy a las 3:24 p. m.                                       │
│                                                            │
│ [aviso de fallo vigente / de apagada, si aplica]           │
│                                       [ Parámetros de lectura ] │  ← secundario, barra mt-auto
└────────────────────────────────────────────────────────────┘
```

### Decisiones pedidas

| Pregunta | Decisión |
|---|---|
| ¿Reusa el patrón de «Acceso a FLIT 2»? | **Sí, el mismo componente:** `FlitModal` con `lateral`, título, ✕, Esc y clic fuera (`useBackdropClose`) que ya trae, y `cierreBloqueado` mientras guarda. Así los dos botones gemelos de la sección abren lo mismo. No se crea un componente nuevo. |
| ¿Dónde va el botón? | En la **barra de acciones del grupo** (abajo a la derecha, `BARRA`), a la misma altura que «Acceso a FLIT 2» del grupo FLIT 2. No va junto a «Última lectura»: ahí competiría con el dato y rompería la simetría entre los dos grupos. |
| FLIT 1 apagada | **El botón sigue visible y funciona igual.** Los parámetros son configuración y no dependen del interruptor. Tiene sentido ajustarlos *antes* de encender. El aviso de apagada ya cuenta lo que pasa. |
| Nunca ha leído | «Última lectura: **Aún sin lecturas**» y, si está encendida, la nota muted «La primera lectura trae los trámites desde la fecha de arranque.». Esa nota es la pista para abrir «Parámetros de lectura» y ver la fecha. |
| ¿Quién ve el botón? | **Solo** quien tiene `tramites.sincronizacion.configurar` (decisión del humano: «sin permiso no hay botón»; ver «Permiso / slug»). Sin `configurar` el botón no aparece y el grupo FLIT 1 muestra solo el estado, igual que hoy (AC3). No hay modal de solo lectura. |
| ¿Cuándo sale el GET de parámetros? | **Al abrir la modal**, no al montar la página (mismo criterio que «Acceso a FLIT 2»). Como el grupo ya no pinta «cada N minutos», la página no necesita ese GET. |
| ¿Qué pasa con lo escrito al cerrar sin guardar? | **Se descarta.** Al reabrir se ven los valores vigentes. Son 4 campos: no se añade un diálogo de «¿Descartar cambios?», que sería un patrón nuevo. Hoy el borrador sobrevive al acordeón; con la modal deja de hacerlo, y es a propósito. |

### Modal «Parámetros de lectura de FLIT 1»

```
                              ┌─ Parámetros de lectura de FLIT 1 ─────── ✕ ┐
                              │ Cómo y desde cuándo FLITO lee los trámites  │
                              │ de FLIT 1.                                  │
                              │ Cambiados por Ana Pérez hoy a las 9:10 a. m.│  ← muted
                              │                                             │
                              │ Frecuencia (minutos)                        │
                              │ [ 5                                      ]  │
                              │ Cada cuánto lee FLITO a FLIT 1. De 1 a 60.  │  ← ayuda (topes de LIMITES_…)
                              │                                             │
                              │ Ventana (días)                              │
                              │ [ 3 ]  …ayuda…                              │
                              │ Ventana nocturna (días)                     │
                              │ [ 30 ] …ayuda…                              │
                              │ Fecha de arranque                           │
                              │ [ 2026-09-19 ] …ayuda…                      │
                              │                                             │
                              │ [aviso role=alert si falló el guardado]     │
                              │                         [ Guardar parámetros ] │  ← única primaria
                              └─────────────────────────────────────────────┘
```

- Campos, etiquetas, ayudas, topes y validación: **los de hoy, sin cambios** (`ETIQUETA`, `ayuda`,
  `validar`, `LIMITES_PARAMETROS_LECTURA_FLIT1`). En el panel lateral van **en una columna** (una
  por fila), no en la rejilla de 2: el panel es angosto y las ayudas son largas.
- Única primaria: **«Guardar parámetros»** (`flitBtnPrimary`), abajo a la derecha. Sin «Cancelar»:
  ✕ y Esc cierran. Con `aria-disabled` y el sr-only «Cambia un valor para guardar.» si no hay
  cambios (igual que hoy). Mientras guarda dice «Guardando…», lleva `aria-busy` y el cierre queda
  bloqueado.

**Sin modo solo lectura (decidido):** la modal solo existe con `configurar`, así que no hay `<dl>`
ni nota de solo lectura. Un 403 al guardar (permiso retirado con la sesión abierta) se trata en la
tabla de abajo como un aviso dentro de la modal.

### Estados (4) de la modal

| Estado | Qué se ve | Copy |
|---|---|---|
| Cargando | Esqueleto de los 4 campos en una columna (rótulo real + hueco `--flit-bg-hover`) y un hueco donde va la primaria, con `aria-busy`. | — |
| Error al cargar | Aviso `role="alert"` con botón secundario «Reintentar» (patrón `Aviso` de Acceso). No hay primaria. | «No se pudieron cargar los parámetros de lectura. Vuelve a intentarlo.» · [Reintentar] |
| Vacío | No existe como tal: el API siempre devuelve valores (por defecto si nadie los cambió). La línea muted lo dice. | «Valores por defecto: nadie los ha cambiado en este ambiente.» |
| Lleno | Campos + primaria. | — |

### Acciones, validación y notificación

| Caso | Comportamiento | Copy |
|---|---|---|
| Valor fuera de tope o vacío (validación local, al salir del campo y al guardar) | No sale el PUT. Error en línea bajo el campo (`aria-invalid` + `aria-describedby`) y foco al primer campo inválido. **La modal sigue abierta.** | Los mensajes de hoy: «Debe ser un número entero de {min} a {max}.», «Escribe la frecuencia en minutos.», «No puede ser menor que la ventana ({n} días).», «Elige la fecha de arranque.», «No puede ser una fecha futura.» |
| 400 con `campos` | La modal sigue abierta, los campos marcados y foco al primero. | `role="alert"`: «No se guardó: revisa los campos marcados.» |
| Guardado OK | **Se cierra la modal**, el foco vuelve a «Parámetros de lectura» y sale un **toast** de éxito cerrable (~4 s, `id: 'sync-parametros-flit1'`). Después hay un GET silencioso del estado de lectura (`alGuardar`, igual que hoy). | «Parámetros de lectura guardados. FLITO los usa desde la próxima lectura.» |
| 403 al guardar | **Sin toast.** La modal sigue abierta, conserva lo escrito y muestra un aviso `role="alert"` encima de la primaria, sin reintento. | «No tienes permiso para cambiar los parámetros de lectura. Pídeselo a un administrador.» |
| Otro error (red, 5xx, timeout) | **Sin toast.** La modal sigue abierta y se conserva lo escrito. Aviso `role="alert"` encima de la primaria, con el enlace `Reintentar` del kit (`LecturaFlit1.Reintentar`), que vuelve a lanzar el guardado. La primaria sigue activa. | «No se pudieron guardar los parámetros de lectura. Revisa la conexión y vuelve a intentarlo.» · [Reintentar] |

Nunca se pinta `e.message`, ni el status, ni el código. Hoy los dos errores salen por `toastError`.
Con la modal pasan a aviso dentro de ella: los principios mandan el error de un modal en
`role="alert"` dentro del modal, no en un toast.

### Responsive (<lg)

- Grupo: los dos grupos ya se apilan (`grid-cols-1 lg:grid-cols-2`). El botón «Parámetros de
  lectura» ocupa el ancho completo en móvil y `sm:w-auto` desde `sm`, igual que «Acceso a FLIT 2».
- Modal: el `lateral` de `FlitModal` ocupa el ancho en móvil (comportamiento del kit). Campos en
  una columna y primaria a ancho completo en móvil (`w-full sm:w-auto`). El cuerpo hace scroll, no
  la página.

### Feedback y a11y

- El botón es `flitBtnSecondary`, que ya trae hover del kit y foco `flit-focus`. Si al
  implementarlo se ve plano en los dos temas, se añade el velo `--flit-bg-hover` con
  `transition-colors`. Lo mismo vale para ✕, Reintentar y la primaria.
- El botón guarda una `ref` que se pasa a `FlitModal.restoreFocusRef`: al cerrar con Esc, ✕, clic
  fuera o guardado OK, el foco **vuelve al botón** (AC2).
- Al abrir, el foco va al primer campo editable.
- Cada input con `<label htmlFor>`, y la ayuda y el error enlazados con `aria-describedby`. Esto ya
  existe y se conserva.
- Errores del guardado en `role="alert"` dentro de la modal. Éxito en el toast, que ya es live
  region.

### Permiso / slug

Página y `PageSlug` existentes de Gestión Trámites, sin cambios. El botón «Parámetros de lectura»
existe **solo** con `tramites.sincronizacion.configurar`; sin ella no se pinta y no sale el GET de
parámetros. Quien tiene `sync.sync.ver_estado` sin `configurar` ve el estado del grupo FLIT 1 (Última
lectura, notas y avisos), sin botón.

**Decisión del humano (HU #13680):** el GET de parámetros sigue exigiendo `configurar` y el front no
lo abre a `ver_estado` (se descartó la salida «backend abre la lectura»). Sin cambios de API.

### Copy de referencia para la ficha de Ayuda (AC5, en usted)

> **Lectura de FLIT 1.** FLITO lee FLIT 1 sola, sin que usted tenga que lanzar nada. En
> Sincronización, el grupo FLIT 1 muestra si la fuente está encendida y la **Última lectura**. Si
> una lectura falla, aparece un aviso con lo que pasó y qué hacer.
>
> **Parámetros de lectura.** Con el botón «Parámetros de lectura» se abre una ventana con la
> frecuencia, la ventana de días, la ventana nocturna y la fecha de arranque, cada una con su rango
> permitido. Cambie los valores y pulse «Guardar parámetros»: FLITO los usa desde la próxima lectura.
> El botón solo aparece si su perfil puede configurar la sincronización.

### Notas para QA (HU #13680)

1. Grupo FLIT 1: no aparecen los textos «cada N minutos», «Próxima lectura», «Lectura detenida»,
   «En unos minutos», «En cualquier momento» ni «hacia las», ni ningún input en línea.
2. Con FLIT 1 apagada, el botón está visible y abre la modal.
3. Si se abre y se cierra con Esc, con ✕ y con clic fuera, el foco vuelve al botón en los tres casos.
4. Sin `configurar` (con o sin `ver_estado`): **sin** botón «Parámetros de lectura» en el DOM y sin
   GET de parámetros; el grupo muestra solo el estado.
5. Frecuencia = max+1: no sale el PUT (red), sale el mensaje del tope, el foco va al campo y la
   modal sigue abierta.
6. Con PUT OK: la modal se cierra, sale el toast de éxito cerrable y el foco vuelve al botón.
7. Con PUT en 500 o sin red: la modal sigue abierta, el aviso `role="alert"` no muestra texto del
   API, «Reintentar» reenvía y se conserva lo escrito. No sale toast.
8. Con PUT en 403: la modal sigue abierta con el aviso de permiso (sin reintento) y sin toast.
9. Si se escribe, se cierra sin guardar y se reabre, se ven los valores vigentes.
10. Revisar en claro y en oscuro, a 375 px y a ≥ lg.

---

## HU #13678 — FLIT 2: solo conexión y última actualización

### Superficie tocada

Grupo FLIT 2 de `SincronizacionTramites.tsx`: `LineaEstadoFlit2`, `IndicadorFlit2` y
`AvisoEstadoFlit2` (`EstadoFlit2.tsx`). No se tocan el grupo FLIT 1, el resumen ni el distintivo de
la cabecera del acordeón, el aviso de apagada (`motivo-flit2`) ni «Acceso a FLIT 2».

### Delta de claridad

**Siempre visible (en este orden):**
1. Cabecera de la fuente: sin cambios.
2. Dos pares, con el mismo `Par` que FLIT 1:
   - **«Conexión»**: `Conectado` · `Sin conexión` · `Sin configurar` · `Apagada` · `Apagada en el servidor`.
     A la izquierda del valor va el **punto estático** que ya existe en `IndicadorFlit2` (sin pulso):
     `--flit-success-text` para Conectado, `--flit-danger-text` para Sin conexión y
     `--flit-text-muted` para el resto. El texto lleva el significado; el punto solo acompaña.
   - **«Última actualización»**: la más reciente entre `ultimoAvisoEn` y `ultimaExitosaEn`, con el
     formato del grupo FLIT 1 («hoy a las 3:24 p. m.» / «el 14 oct. 2026 a las 3:24 p. m.»). Si no
     hay ninguna de las dos: «Aún sin datos». Con «Sin configurar» este par no se pinta.
3. Si hay Sin conexión: **aviso de página** con motivo y acción (tabla de abajo). Se conserva el
   párrafo de compradores sin datos personales.
4. Aviso de apagada (`motivo-flit2`): sin cambios.
5. Barra: «Acceso a FLIT 2» (secundario), sin cambios.

**Se quita:**
- Toda la línea de `IndicadorFlit2`: «Lectura automática cada N min · próxima en m:ss», «Leyendo
  FLIT 2 ahora…», «reintenta en…», «Acceso bloqueado · reintenta en…», «Avisos con firma no válida ·
  próxima lectura en…», «Sin leer hace más de…», etc. El tic por segundo (`useRestante`) deja de
  hacer falta.
- Los pares «Última lectura buena» y «Último aviso» (la línea doble), y « · lectura atrasada».
- En el aviso: la línea «Última lectura buena: …», la cuenta regresiva («vuelve a intentarlo en
  m:ss»), «cada pocos minutos», «Esto no detiene la lectura automática de cada N min» y las horas
  del problema («A las 9:40 a. m., …»). La recencia ya la dice «Última actualización».

**Densidad:** aliviada. Pasan de 4 líneas cambiantes (con una de ellas en vivo) a 2 pares estables
más un aviso, que solo aparece si hay algo que hacer.

### Regla «Conexión»

Con precedencia de arriba abajo; gana la primera fila que aplique:

| Condición (datos actuales) | Conexión |
|---|---|
| `!configurado` | Sin configurar |
| `habilitada=false` y `motivoDeshabilitada='maestro'`, o `automatica.activa=false` | Apagada en el servidor |
| `habilitada=false` (interruptor) | Apagada |
| `problema` presente (cualquier tipo), **o** `alerta` (atraso por umbral) | **Sin conexión** |
| resto, incluida una lectura en curso | **Conectado** |

- Una lectura en curso (`enCurso`) **no** cambia el valor: se queda en el que corresponda por el
  resto de la tabla.
- «Requiere atención» en la cabecera del acordeón y el `role` del aviso (alert/status) siguen con
  `alertaFlit2`, **igual que hoy** (AC2). Hay un matiz que QA debe conocer: un fallo de lectura
  suelto (por ejemplo «FLIT 2 pidió esperar») da «Sin conexión» sin «Requiere atención», porque el
  servidor no lo marca como alerta. Es lo que piden los AC. *Pregunta abierta al PO, que no
  bloquea: ¿el código `espera` (429) debe contar como «Sin conexión»? No es una caída.*

### Copy de motivos (aviso «Sin conexión»)

Formato del aviso (`AVISO`, el mismo contenedor de hoy). Primera línea en negrita con
`--flit-danger-text` solo si `alertaFlit2`, y en negrita normal si no. Segunda línea: la acción.
**«Acceso a FLIT 2»** va en negrita, como hoy. No lleva botones: la acción ya está en la barra.

| Caso (`problema.tipo` / `motivo` / `codigo`) | Motivo (línea 1) | Acción (línea 2) |
|---|---|---|
| `rechazado` / `credenciales` | FLIT 2 rechazó el usuario y la contraseña guardados. | Revísalos en **Acceso a FLIT 2**. |
| `rechazado` / `cambio_clave` | FLIT 2 pide cambiar la contraseña del usuario de servicio. | Cámbiala en FLIT 2 y guárdala de nuevo en **Acceso a FLIT 2**. |
| `rechazado` / otro | FLIT 2 rechazó el acceso de FLITO. | Revisa **Acceso a FLIT 2**; «Probar conexión» te dice la causa. |
| `bloqueado` con `hasta` futuro | FLIT 2 bloqueó el acceso por intentos fallidos hasta las {hora} (o «hasta el {día} a las {hora}»). | No hace falta hacer nada: FLITO vuelve a leer solo después. |
| `bloqueado` sin `hasta` (o vencido) | FLIT 2 bloqueó el acceso por intentos fallidos. | FLITO lo vuelve a intentar solo. Si no se resuelve, revisa **Acceso a FLIT 2**. |
| `avisos_firma` | FLIT 2 está enviando avisos con firma no válida y FLITO los rechaza. | Avísale a quien administra el ambiente: la clave compartida de los avisos debe ser la misma en FLIT 2 y en FLITO. |
| Atraso por umbral (`alerta` sin `problema`), con umbral U | FLITO lleva más de {U} minutos sin leer trámites de FLIT 2 («{h} h», «{h} h {m} min» desde 60, con `duracionUmbral`). | Revisa **Acceso a FLIT 2**; si el acceso está bien, avísale a quien administra el ambiente. |
| Atraso sin intervalo conocido | FLITO no ha leído trámites de FLIT 2 en el tiempo esperado. | (misma acción) |
| `lectura` / `invalid_cursor` | FLIT 2 no reconoció el punto donde iba la lectura; FLITO no avanza para no perder trámites. | Avísale a soporte técnico. |
| `lectura` / `insufficient_scope` | El usuario de servicio no tiene permiso para leer trámites en FLIT 2. | Pídele a FLIT 2 que lo habilite. |
| `lectura` / `espera` | FLIT 2 pidió esperar antes de seguir. | No hace falta hacer nada: la lectura sigue donde quedó. |
| `lectura` / `no_responde` | FLIT 2 no respondió. | FLITO lo vuelve a intentar solo. Si sigue así, avísale a quien administra el ambiente. |
| `lectura` / `flit2_respuesta` | FLIT 2 respondió de forma inesperada. | Si sigue así, avísale a soporte técnico. |
| `lectura` / `llave_maestra` o `acceso_descifrado` | El servidor no pudo leer el acceso guardado. | Avísale a quien administra el ambiente. |
| `lectura` / código desconocido | Falló la última lectura de FLIT 2 en FLITO. | Si sigue así, avísale a soporte técnico. |
| Tipo de problema desconocido | Hay un problema con la conexión a FLIT 2. | Si sigue así, avísale a soporte técnico. |

**No son «Sin conexión»:** sus avisos quedan como hoy.

| Caso | Aviso |
|---|---|
| `!configurado`, motivo `ambiente` | «FLIT 2 no está configurado en este servidor. Avísale a quien administra el ambiente.» |
| `!configurado`, con `tramites.flit2.guardar_acceso` | «FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Configura el acceso en **Acceso a FLIT 2**.» |
| `!configurado`, sin ese permiso | «FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Pídele a un administrador que configure el acceso.» |
| Apagada por interruptor o en el servidor | `motivo-flit2` de hoy, sin cambios. **No** se pinta aviso de motivo de conexión (la fuente detenida lo sustituye, como hoy). |
| Compradores sin datos personales (`piiEnmascarada.tramites > 0`) | Se conserva literal (`frasePii`), en el mismo aviso y separado por la raya de hoy, en cualquier estado. |

Ningún motivo pinta `codigo`, `status` ni texto del API. Un código nuevo cae en la fila «desconocido».

### Estados (4)

| Estado | Qué se ve |
|---|---|
| Cargando | Los dos pares con su rótulo real y un hueco `--flit-bg-hover` como valor, con `aria-busy`. |
| Error (primer GET o Reintentar) | Línea de hoy: «No se pudo consultar · [Reintentar]» (`aria-label` «Reintentar la consulta del estado de FLIT 2»). Los refrescos silenciosos que fallan conservan el último dato. |
| Vacío | Configurado y sin ningún dato: «Conexión: Conectado» (si no hay problema) + «Última actualización: Aún sin datos». |
| Lleno | Pares + aviso si aplica. |

### Responsive (<lg)

Los pares ya envuelven (`flex flex-wrap gap-x-6`). En móvil «Última actualización» cae debajo de
«Conexión». El aviso ocupa el ancho con `break-words`. «Acceso a FLIT 2» va a ancho completo en
móvil (sin cambios).

### Feedback, notificación y a11y

- No se añaden controles. Reintentar y «Acceso a FLIT 2» conservan el hover y el foco de hoy.
- Notificación: aviso de página (nunca toast). `role="alert"` con `alertaFlit2` y `role="status"`
  en los demás casos, como hoy.
- Región viva: **solo el valor de «Conexión»** va en una región `role="status"` (aria-live polite),
  porque cambia pocas veces. «Última actualización» queda fuera de la región, para que el polling
  de 2 min no lo anuncie cada vez. Se elimina la región del indicador (`anuncio`) y los sr-only de
  la cuenta.
- El punto es `aria-hidden`; el texto «Conectado» / «Sin conexión» basta.

### Permiso / slug

Sin cambios: el grupo existe con `sync.sync.ver_estado` (estado) y `tramites.flit2.ver_acceso` (botón).

### Notas para QA (HU #13678)

1. En estado sano: «Conexión: Conectado» y «Última actualización» = máx(último aviso, última
   lectura buena). Probar con aviso más reciente y con lectura más reciente.
2. En ningún estado aparecen «cada … min», «próxima en», «Leyendo FLIT 2 ahora», «reintenta en»,
   «lectura atrasada», «cada pocos minutos», «m:ss», «Última lectura buena» ni «Último aviso».
3. Rechazado (las 3 variantes), bloqueado con y sin `hasta`, `avisos_firma`, atraso y cada código
   de lectura: «Sin conexión» + el motivo y la acción exactos de la tabla.
4. «Requiere atención» aparece exactamente en los mismos casos que antes (comparar con
   `alertaFlit2`). Un `espera` suelto da «Sin conexión» sin distintivo.
5. Si está sin configurar (ambiente / con permiso / sin permiso): «Conexión: Sin configurar», sin
   «Última actualización» y con el aviso de hoy.
6. Si está apagada por interruptor o en el servidor: valor «Apagada» o «Apagada en el servidor», el
   aviso `motivo-flit2` y ningún aviso de motivo de conexión.
7. Compradores sin datos personales: el párrafo se conserva literal, también con «Sin conexión».
8. Con lector de pantalla, el polling no re-anuncia nada si «Conexión» no cambió.
9. El grupo FLIT 1 no cambia por esta HU.
10. Revisar en claro y en oscuro, a 375 px y a ≥ lg.

---

## HU #13684 — Aviso de trámites nuevos o actualizados sin recargar

### Superficie tocada

Tarjeta de la lista de `FlitoTramites.tsx`. Se añade un aviso **entre la barra superior (búsqueda,
filtros rápidos, orden, paginación, «Limpiar filtros» y su nota de fuente) y `FlitTable`**. Si la
lista está en estado vacío (`FlitEmpty`, con o sin filtros), el aviso va en el mismo sitio,
encima del vacío.

### Delta de claridad

- **Lo que se vino a ver no cambia solo:** la tabla, la página, el orden y la selección quedan
  quietos hasta que el operador pulsa «Ver» (AC1). Esto es intencional: nada se mueve bajo el
  puntero mientras el operador trabaja.
- Se ve una sola línea de aviso, solo cuando hay algo. Sin aviso no hay hueco reservado.
- No se marca ni se resalta qué filas son nuevas, ni hay animación de entrada.
- **Densidad:** +1 línea, temporal. Es aceptable porque responde a esa visita: «¿llegó algo
  mientras trabajaba?».

### Wireframe

```
┌─ Gestión Trámites ───────────────────────────────────────────────┐
│ [Buscar…] [Presets] [Autogestión ▾] [Fuente ▾] [Orden ▾]  120 · ‹ 1/6 › │
│ [Limpiar filtros]                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Hay 3 trámites nuevos                                [ Ver ] │ │  ← aviso role=status
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌ FlitTable ───────────────────────────────────────────────────┐ │
│ │ ☐ Placa  Estado  …                                           │ │
└──────────────────────────────────────────────────────────────────┘
```

Contenedor: el `AVISO` de la sección (`rounded-lg px-3 py-2.5 text-sm`, borde
`--flit-border-soft`, fondo `--flit-bg-card`, texto `--flit-text-primary`). Es informativo, así que
va sin color de peligro ni ícono. Dentro, `flex flex-wrap items-center justify-between gap-2`: el
texto a la izquierda y «Ver» a la derecha. En el texto, el «·» de los AC se representa con la
separación visual; el botón es un elemento aparte.

### Copy

| Caso | Texto |
|---|---|
| 1 nuevo | Hay 1 trámite nuevo |
| N nuevos (2–99) | Hay {N} trámites nuevos |
| Más de 99 nuevos | Hay más de 99 trámites nuevos |
| Solo actualizados | Hay trámites actualizados |
| Nuevos + actualizados (1) | Hay 1 trámite nuevo y otros actualizados |
| Nuevos + actualizados (N) | Hay {N} trámites nuevos y otros actualizados |
| Botón | **Ver** · `aria-label` «Ver los trámites nuevos y actualizados» (o «Ver los trámites nuevos» / «Ver los trámites actualizados», según el caso) |

- «Nuevo» = entró por FLIT 1 o FLIT 2, cumple los filtros y la búsqueda actuales y no estaba en la
  línea base.
- «Actualizado» = un trámite **de la página visible** que cambió.
- Los actualizados no se cuentan (AC2).

### Comportamiento

| Momento | Qué pasa |
|---|---|
| Línea base | Se fija al terminar cada carga visible de la lista: la primera, cambiar filtros, búsqueda, orden o página, y «Ver». Cada cambio de esos **reinicia** la línea base y **quita** el aviso. |
| Consulta en segundo plano | Una cada ≤ 60 s **solo si**: pestaña visible, ningún diálogo abierto (`FlitModal`, historial, panel de Acceso, modal de parámetros…), ninguna acción en curso (lote de SOAT/impuestos/entrega, descarga) y no hay una carga visible de la lista en marcha. Al volver a la pestaña, consulta enseguida. |
| La consulta falla | **En silencio:** sin toast y sin aviso. Si ya había un aviso, se queda como estaba. |
| Llegan novedades con el aviso ya visible | El texto se actualiza en el sitio (por ejemplo, de 2 a 3 nuevos). La región polite lo anuncia una vez. |
| «Ver» | Recarga la página actual con los mismos filtros, búsqueda, orden y página. La selección se queda solo con los ids que siguen en las filas. Si la página actual ya no existe (bajó el total), va a la última. El aviso desaparece. |
| «Ver» falla | Se aplica el estado de error de la lista que ya existe, con su Reintentar. El aviso desaparece y no se añade copy nuevo. |

### Estados (4)

| Estado | Qué se ve |
|---|---|
| Cargando (la carga de «Ver») | El estado de carga que ya tiene la lista. El aviso se quita al pulsar. |
| Error | Consulta de fondo: silenciosa, sin UI. Carga de «Ver»: el error de la lista de hoy, con Reintentar. |
| Vacío | Sin novedades no hay aviso ni hueco. Si la lista está vacía y llega un trámite que cumple el filtro, el aviso aparece encima del `FlitEmpty`. |
| Lleno | Una línea con el texto y «Ver». |

### Responsive (<lg)

El aviso ocupa el ancho de la tarjeta. El texto envuelve y «Ver» se queda a su derecha mientras
quepa; si no, baja a la línea siguiente alineado a la derecha (`flex-wrap`, sin `min-w`). «Ver»
mantiene un área táctil de al menos 40 px de alto en móvil.

### Feedback y a11y

- «Ver» es `flitBtnSecondary` en compacto (misma altura que los controles de la barra, `h-9`), con
  hover del kit o velo `--flit-bg-hover` y `transition-colors`, y foco `flit-focus`.
- El contenedor del aviso está **siempre montado** y vacío con `role="status"` (aria-live polite),
  para que el lector anuncie el texto al aparecer. **No mueve el foco** al aparecer ni al
  actualizarse (AC5).
- Tras «Ver», el foco no se pierde en `body`: va al contenedor de la tabla (`tabIndex={-1}`,
  `aria-label="Trámites"`), y la región dice una vez «Lista actualizada.» en sr-only.
- Nada de toast: lo que hay es un estado vigente de la página, así que corresponde un aviso en
  página.

### Datos — requisito nuevo (para `architecture-agent` y `backend-agent`)

Hoy no hay una forma barata de preguntar «¿hay algo nuevo para este filtro?». Repetir
`GET /api/flito/tramites?…` cada 60 s y comparar no detecta los nuevos que caen en otra página
(por ejemplo, con orden «antiguos»), y además cuesta una página completa. Se pide:

- `POST /api/flito/tramites/novedades` (autenticado, mismos roles que el listado). Recibe en el
  **body** los filtros y la búsqueda actuales (la búsqueda puede llevar placa o nombre: van en el
  body por AGENTS §14, no en la query), la marca de la línea base y los `{tramiteId, version |
  actualizadoEn}` de la página visible.
- Responde `{ nuevos: number, actualizados: boolean }`, sin PII ni payloads de fila.
- La marca de línea base la devuelve el servidor junto con el listado (evita el desfase de relojes).

Si arquitectura decide otra forma (por ejemplo, un cursor de cambios), el contrato UX sigue igual:
un número de nuevos y un sí/no de actualizados.

### Permiso / slug

`PageSlug` de Gestión Trámites, sin cambios. El aviso lo ve quien ve la lista.

### Notas para QA (HU #13684)

1. Con filtros aplicados, si entra un trámite que los cumple: en ≤ 60 s aparece «Hay 1 trámite
   nuevo» y la tabla **no** cambia. Si no los cumple, no aparece aviso.
2. Plural, caso «más de 99» y combinado («… y otros actualizados»).
3. Si cambia un trámite de la página visible: «Hay trámites actualizados». Si cambia uno de otra
   página, no aparece aviso.
4. «Ver» conserva filtros, búsqueda, orden, página y la selección que sigue existiendo. El aviso
   desaparece y el foco va a la tabla.
5. Con la pestaña oculta, un diálogo abierto o un lote en curso, no sale ninguna petición de
   novedades (pestaña Red).
6. Si la consulta de novedades da 500 o falla la red, no hay toast ni aviso.
7. Cambiar el filtro o la página a mano quita el aviso y reinicia la base.
8. Lector de pantalla: el aviso se anuncia y el foco no se mueve. «Ver» tiene foco visible y hover.
9. La búsqueda no viaja en la query de la petición de novedades.
10. Revisar en 375 px (el aviso envuelve) y en claro y oscuro.

---

## Decisiones y descartes

- **Modal lateral para los parámetros (#13680) y no centrada:** es el mismo componente y el mismo
  gesto que «Acceso a FLIT 2», en la misma sección. Una centrada habría metido un segundo patrón
  para lo mismo.
- **Botón en la barra y no junto a «Última lectura»:** así los dos grupos quedan gemelos (dato
  arriba, secundario abajo a la derecha).
- **Sin «Cancelar» ni confirmación de descarte en la modal:** ✕ y Esc bastan. Son 4 campos.
- **Errores del guardado dentro de la modal, no en toast:** son errores de un modal (principios).
  El toast queda solo para el éxito, que además cierra la modal.
- **«Conexión» como par de texto con el punto estático existente** (#13678), no un `StatusChip`
  nuevo en la línea: es la misma familia visual que «Última lectura» de FLIT 1.
- **Sin horas en los motivos de FLIT 2:** la recencia la dice «Última actualización». Repetirla en
  cada frase era ruido.
- **Aviso de novedades sin conteo de actualizados ni resaltado de filas** (#13684): los AC no los
  piden y añaden ruido y movimiento.
- **Sin efectos:** ni animación de entrada del aviso, ni pulso del punto, ni contador en vivo.

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Saber si cada fuente trae trámites y cuándo fue lo último. En la lista, enterarse de que llegó algo sin perder lo que está haciendo. |
| ¿Qué se ve primero? | FLIT 1: interruptor + «Última lectura». FLIT 2: «Conexión» + «Última actualización». Lista: la tabla, quieta. |
| ¿Qué se calla y dónde vive? | Parámetros: en la modal. Frecuencia, próxima lectura y cuentas: fuera. Hora del problema: fuera (la cubre «Última actualización»). |
| ¿Primaria única? | En la sección, ninguna (dos secundarios gemelos). En la modal, «Guardar parámetros». En la lista, «Ver» es secundario. |
| ¿Vacío y error con siguiente paso? | Sí: cada motivo de FLIT 2 trae su acción; los errores de la modal tienen Reintentar; la consulta de fondo es silenciosa por AC. |
| ¿Efectos o patrón nuevo? | Ninguno: `FlitModal lateral`, `Par`, `AVISO`, `flitBtnSecondary`. |
| ¿Móvil? | Dicho en cada HU. |
| ¿Feedback? | Botones del kit con hover y foco. El foco vuelve al botón al cerrar la modal y va a la tabla tras «Ver». |
| ¿Notificación? | Toast solo para el guardado OK de parámetros. Todo lo demás, aviso en página o `role="alert"` en la modal. |
