# UX slim: estado de la conexión con FLIT 2 y aviso a los 30 minutos (HU #13098)

Feature #13060 · Épica #12736. Público: operador interno (administradores y Operaciones) en Gestión
Trámites. Módulo `flito-sync` (`/api/flito/sync/flit2/*`), no el legacy `tramites`.
HU backend hermana: #13097 (`GET /api/flito/sync/flit2/estado`). El contrato que la UI necesita está
al final de este doc, en «Contrato propuesto».
Análogas: el bloque «Última actualización» de FLIT 1 en la cabecera de `FlitoTramites.tsx`,
`SincronizarFlit2.tsx` (`docs/ux/hu-13096-boton-sincronizar-flit2.md`) y `AccesoFlit2.tsx`
(`docs/ux/hu-13064-13069-acceso-flit2.md`).

> **Los AC salen del prompt del hilo (refinamiento del tech-lead), no de ADO.** Si el Gherkin de
> ADO dice otra cosa, manda el AC y hay que avisar al ux-agent.

---

## Superficie tocada

1. **Cabecera de Gestión Trámites:** un bloque nuevo, **«Última lectura FLIT 2»**, justo antes de
   «Sincronizar FLIT 2». Es el calco del bloque «Última actualización» de FLIT 1, que va antes de
   «Sincronizar FLIT»: dos líneas de 11 px, a la derecha, y sin botón propio.
2. **Aviso de página «FLIT 2»:** una tarjeta debajo de la cabecera, **antes** de `resumenSync` y de
   la tarjeta `error` del listado. Solo se pinta cuando hay algo que contar (tabla de abajo). Cuando
   todo va bien, no existe.
3. **No se toca el panel «Acceso a FLIT 2».** Pide otro permiso (`tramites.flit2.ver_acceso`) y se
   abre a demanda, así que un aviso que tiene que seguir visible no puede vivir ahí. Duplicar el
   estado en los dos sitios sería ruido. El panel sigue siendo el sitio donde se **corrige** el
   acceso, y el aviso manda allí con texto.
4. **Código:** un componente nuevo, `components/flito/tramites/EstadoFlit2.tsx`, hermano de los
   otros dos. Exporta:
   - el hook `useEstadoFlit2()`, que hace el GET, el refresco y el polling;
   - `<LineaEstadoFlit2 estado={…} />`, para la cabecera;
   - `<AvisoEstadoFlit2 estado={…} />`, para debajo de la cabecera.

   La página tiene el techo de líneas congelado, así que solo suma el import, la llamada al hook y
   dos elementos JSX.

   `SincronizarFlit2` recibe una prop opcional `onIntento?: () => void` que se llama en el `finally`,
   tanto si la lectura acaba bien como si falla. La página le pasa `estadoFlit2.refrescar`. Así un
   fallo manual también actualiza el estado, porque cambia `ultimoIntentoEn`.

### Wireframe (≥ lg)

```
┌ Gestión Trámites ───────────────────────────────────────────────────────────────────────────────────┐
│ Centro de gestión…                                                                                  │
│  Última actualización  [☐ Elegir fecha] [ Sincronizar FLIT ]  Última lectura FLIT 2  ( Sincronizar  │
│  29 sep. 2026, 9:10                                           29 sep. 2026, 9:40      FLIT 2 )      │
│                                                               · lectura atrasada                    │
│                                                        ( + Trámite demo ) ( Acceso a FLIT 2 )       │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Aviso FLIT 2 (solo si hay algo que contar) ─────────────────────────────────────────────────────────┐
│ FLIT 2 lleva más de 30 minutos sin leer trámites.            ← título, --flit-danger-ink, semibold  │
│ Última lectura exitosa: 29 sep. 2026, 9:10.                                                         │
│ FLIT 2 rechazó el acceso guardado a las 9:40. Revisa el usuario y la contraseña en Acceso a FLIT 2. │
│ ─────                                                                                               │
│ 12 trámites de FLIT 2 llegaron sin los datos del comprador: su SOAT y sus impuestos quedan en       │
│ espera. Pídele a FLIT 2 que habilite el permiso de datos personales para el usuario de servicio.    │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
[ tabla de la cola, sin cambios ]
```

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** saber de un vistazo si FLITO está leyendo FLIT 2 y, si no, por qué y qué hacer.
La visita principal sigue siendo la cola. Esto es una señal de estado, no una pantalla.

**Qué se ve primero:**
- Si todo va bien: la hora de la última lectura exitosa, en la cabecera y junto al botón que la
  fuerza. Nada más.
- Si algo va mal: la tarjeta de aviso, con **una** frase de qué pasó y otra de qué hacer.

| Dato del backend | Dónde | Por qué |
|---|---|---|
| `ultimaExitosaEn` | Cabecera, siempre | Es la respuesta a «¿está leyendo?». |
| `atrasada` | Cabecera, como sufijo «· lectura atrasada» | Es normal que pase (quedan páginas y la lectura automática sigue), así que no merece una tarjeta. |
| `alerta` | Título de la tarjeta | Es el AC de los 30 minutos. |
| `problema` (rechazo, bloqueo o error de la última lectura) | Cuerpo de la tarjeta, con la hora del intento | Explica la causa y dice qué hacer. |
| `piiEnmascarada.tramites > 0` | Párrafo aparte en la misma tarjeta | Hay trámites detenidos por una causa que corrige FLIT 2. |
| `ultimoIntentoEn` | Solo dentro de la frase del problema («a las 9:40») | Suelto no aporta nada. |
| Código crudo (`invalid_cursor`…), `cursor_relectura`, `rechazo_motivo` literal, usuario de servicio, contraseña, pase, PII | **Nunca** | Son de trastienda, secretos o datos personales. |

**Densidad:**
- La cabecera suma un bloque de texto de dos líneas, sin control nuevo.
- La tarjeta solo aparece cuando hay algo que resolver. En un ambiente sano la página queda igual que
  hoy.
- **Una sola tarjeta** agrupa todo lo de FLIT 2, con dos párrafos como máximo (el problema o la
  alerta, y la PII). No se apilan varias tarjetas.

**Primaria:** no cambia. Sigue siendo «Sincronizar FLIT». La tarjeta **no lleva botones**: la acción
(«Sincronizar FLIT 2» o «Acceso a FLIT 2») ya está en la cabecera, y el copy la nombra con texto.

---

## Estados (4) + copy

Tono: **tú**, como el resto de la pantalla y de los componentes de FLIT 2. El producto es FLITO; FLIT
y FLIT 2 son los sistemas de origen.

Formatos: la fecha con `fmtFechaHora` (`es-CO`, `America/Bogota`), igual que en `AccesoFlit2.tsx`.
Dentro de una frase se usa solo la hora («a las 9:40») si es del mismo día en Bogotá; si no, fecha y
hora.

### Cabecera («Última lectura FLIT 2»)

| Estado | Línea 1 (muted) | Línea 2 (semibold, secondary) |
|---|---|---|
| **Cargando** (primer GET) | Última lectura FLIT 2 | Barra de esqueleto de `h-3 w-24` con `--flit-bg-hover`, `animate-pulse` como el `Esqueleto` de `AccesoFlit2` y `aria-hidden`. El bloque lleva `aria-busy="true"`. |
| **Error** (el primer GET falla, o falla un Reintentar) | Última lectura FLIT 2 | «No se pudo consultar» seguido de un botón de texto **[Reintentar]** (texto `--flit-blue-text`, subrayado al hover, `flit-focus`, `type="button"`, `aria-label="Reintentar la consulta del estado de FLIT 2"`). |
| **Vacío** (`configurado: false`) | Última lectura FLIT 2 | «Sin configurar». El siguiente paso va en la tarjeta (ver abajo). |
| **Lleno, nunca leyó** (`configurado`, `ultimaExitosaEn: null`) | Última lectura FLIT 2 | «Aún sin lecturas» |
| **Lleno** | Última lectura FLIT 2 | `29 sep. 2026, 9:40`. Si `atrasada`, se añade «· lectura atrasada». Para el lector de pantalla va además un texto `sr-only`: «Quedan trámites por leer; la lectura automática sigue donde quedó.» |

**Refrescos silenciosos** (polling, `onIntento`, vuelta a la pestaña): si fallan, **se conserva el
último dato** y no se pinta error. El AC dice que la alerta solo desaparece tras una lectura exitosa,
y un fallo de red del GET no puede borrarla. El estado de error es solo para el primer GET o para un
Reintentar.

**403 del GET:** se trata como «sin permiso». No se pinta nada, ni error ni tarjeta, y se detiene el
polling.

### Tarjeta de aviso: qué se pinta y en qué orden

La tarjeta se muestra si se cumple **cualquiera** de estas condiciones:
- `configurado: false`;
- `alerta`;
- `problema != null`;
- `piiEnmascarada.tramites > 0`.

El párrafo 1 sale de la primera fila que aplique. El párrafo 2 (PII) se añade aparte.

| Prioridad | Condición | Título (solo con `alerta`) | Cuerpo |
|---|---|---|---|
| 1 | `configurado: false`, `motivo: 'sin_acceso'` | (nunca hay alerta, por AC) | Con `tramites.flit2.guardar_acceso`: «FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Configura el acceso en **Acceso a FLIT 2**.» Sin ese permiso: «FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Pídele a un administrador que configure el acceso.» |
| 1b | `configurado: false`, `motivo: 'ambiente'` | (sin alerta) | «FLIT 2 no está configurado en este servidor. Avísale a quien administra el ambiente.» |
| 2 | `alerta` | **«FLIT 2 lleva más de 30 minutos sin leer trámites.»** | Primera línea: «Última lectura exitosa: {fecha, hora}.» Si `ultimaExitosaEn` es null: «Todavía no hay ninguna lectura exitosa.» A continuación, la frase del `problema` si lo hay. Si no lo hay: «Pulsa **Sincronizar FLIT 2** para intentarlo ahora; si no lee, revisa **Acceso a FLIT 2**.» |
| 3 | Sin alerta y con `problema` | — | Solo la frase del `problema` (tabla siguiente). |

Párrafo PII (si `piiEnmascarada.tramites > 0`, con o sin alerta, separado por un borde
`--flit-border-soft`):
> «{n} trámites de FLIT 2 llegaron sin los datos del comprador: su SOAT y sus impuestos quedan en espera. Pídele a FLIT 2 que habilite el permiso de datos personales para el usuario de servicio; al habilitarlo, FLITO los vuelve a leer solo.»

Con 1: «1 trámite de FLIT 2 llegó sin los datos del comprador: su SOAT y sus impuestos quedan en
espera. …». No se nombra ningún trámite, placa ni comprador.

### Frase del `problema` (nunca el código, el `status` ni el texto del API)

`{hora}` es `problema.en`, la hora del intento o del rechazo.

| `problema.tipo` / `codigo` | Frase |
|---|---|
| `rechazado`, `motivo: 'credenciales'` | «FLIT 2 rechazó el acceso guardado a las {hora}. Revisa el usuario y la contraseña en **Acceso a FLIT 2**.» |
| `rechazado`, `motivo: 'cambio_clave'` | «FLIT 2 pide cambiar la contraseña del usuario de servicio (aviso de las {hora}). Cámbiala en FLIT 2 y guárdala de nuevo en **Acceso a FLIT 2**.» |
| `rechazado`, `motivo: 'otro'` | «FLIT 2 rechazó el acceso guardado a las {hora}. Revísalo en **Acceso a FLIT 2**; «Probar conexión» te dice la causa.» |
| `bloqueado` (con `hasta`) | «FLIT 2 bloqueó el acceso por intentos fallidos a las {hora}, hasta las {hasta}. FLITO vuelve a leer solo después; no hace falta hacer nada.» Si `hasta` ya pasó o falta: «… FLITO vuelve a intentarlo en la siguiente lectura automática.» |
| `lectura`, `invalid_cursor` | «La lectura de las {hora} falló: FLIT 2 no reconoció el punto donde iba la lectura. FLITO no avanza para no perder trámites. Avísale a soporte técnico.» |
| `lectura`, `insufficient_scope` | «La lectura de las {hora} falló: el usuario de servicio no tiene permiso para leer trámites en FLIT 2. Pídele a FLIT 2 que lo habilite.» |
| `lectura`, `espera` | «A las {hora}, FLIT 2 pidió esperar antes de seguir. La lectura automática continúa donde quedó.» |
| `lectura`, `no_responde` | «A las {hora}, FLIT 2 no respondió. FLITO vuelve a intentarlo solo cada pocos minutos.» |
| `lectura`, `flit2_respuesta` u otro código de FLIT 2 | «A las {hora}, FLIT 2 respondió de forma inesperada. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.» |
| `lectura`, `llave_maestra` / `acceso_descifrado` | «A las {hora}, el servidor no pudo leer el acceso guardado. Avísale a quien administra el ambiente.» |
| `lectura`, `error_interno` o cualquier código desconocido | «La lectura de las {hora} falló en FLITO. Se reintenta sola; si se repite, avísale a soporte técnico.» |

- `rechazado` y `bloqueado` salen de `flito_sync_flit2_acceso`, y el `problema` de tipo `lectura` sale
  de `ultimo_error_codigo`. Si coinciden, el backend manda **uno** con esta precedencia: rechazado,
  luego bloqueado, luego lectura.
- `lectura_concurrente` y `sin_acceso` no son problemas de estado: el backend no los manda como
  `problema`.

**Tokens:**
- Tarjeta: el mismo patrón que el `Aviso` local de `AccesoFlit2.tsx` (`rounded-lg`, borde
  `--flit-border-soft`, fondo `--flit-bg-card`). Se extrae a un util de `flito/tramites/` o se duplica,
  sin crear un componente de kit nuevo.
- Título de la alerta: `--flit-danger-ink`, semibold. El resto va en `--flit-text-primary` y la
  línea de fecha en `--flit-text-secondary`. Los nombres de botones van en `<strong>`.
- Sin iconos, sin fondo de color, sin animación.

---

## Refresco

| Momento | Qué pasa |
|---|---|
| Al abrir la página | Un GET, con esqueleto en la cabecera. |
| Tras «Sincronizar FLIT 2» (éxito **o** error) | `onIntento` hace un GET silencioso. |
| Polling | Un GET silencioso **cada 2 minutos** mientras la pestaña está visible (`document.visibilityState`). Se pausa en segundo plano y, al volver, hay un GET inmediato. Motivo: el aviso de los 30 minutos tiene que aparecer y desaparecer con la página abierta, aunque nadie pulse nada, y la lectura automática corre cada 5 minutos. Con 2 minutos el retraso máximo es ~2 min, a un coste de un GET liviano. |
| Sin `sync.sync.ver_estado` o con 403 | No hay GET ni polling. |

No hace falta refrescar al cerrar el panel «Acceso a FLIT 2». El polling lo recoge en menos de
2 minutos, y la corrección del acceso solo se nota cuando la siguiente lectura sale bien.

---

## Responsive + feedback del delta

- **< lg (375 px):**
  - Las acciones de la cabecera ya envuelven (`flex-wrap gap-3`). El bloque «Última lectura FLIT 2»
    baja junto a «Sincronizar FLIT 2»: los dos van en un `div` `flex flex-wrap items-center gap-3`
    propio, como el par de FLIT 1, para no quedar separados.
  - El texto del bloque no lleva `min-w` y puede partir en dos líneas («· lectura atrasada» baja).
    Por debajo de `sm` se alinea a la izquierda (`text-left sm:text-right`), porque en una fila
    envuelta el texto a la derecha queda huérfano.
  - La tarjeta ocupa el ancho completo, el copy envuelve (`break-words`) y no hay nada en horizontal.
- **Tema oscuro:** solo tokens con par oscuro (`--flit-text-muted/secondary/primary`,
  `--flit-danger-ink`, `--flit-blue-text`, `--flit-border-soft`, `--flit-bg-card`, `--flit-bg-hover`).
  No se usan `red-*`, `slate-*` ni `bg-white`. Hay que verificar en los dos temas que el título de la
  alerta cumple ≥ 4.5:1 sobre `--flit-bg-card`.
- **Feedback:** el único control nuevo es **[Reintentar]** del estado de error: hover con subrayado y
  cambio de tono a `--flit-blue-text` con `transition-colors`, foco `flit-focus`. La tarjeta no es
  clicable, así que no lleva hover.
- **Notificación:** aviso de **página**, **nunca toast**, porque es un estado que sigue siendo cierto
  mientras se mira la página (AC).
  - La tarjeta con `alerta` lleva `role="alert"`; sin alerta, `role="status"`.
  - Mantiene una `key` estable entre refrescos para no volver a anunciarse con cada poll: solo se
    anuncia cuando aparece o cuando cambia su texto.
  - La línea de la cabecera **no** es región viva, porque el polling haría ruido.
  - El toast de «Sincronizar FLIT 2» (HU #13096) no cambia.

---

## Permiso/slug

- No hay página nueva: se mantienen la ruta y el `PageSlug` de Gestión Trámites.
- La línea de la cabecera, la tarjeta y el polling existen solo con `hasFuncion('sync.sync.ver_estado')`.
  Sin esa función no se pintan en el DOM, ni siquiera deshabilitados, y no se hace el GET.
- La guarda va **fuera** de `esOperaciones`, igual que `SincronizarFlit2`.
- **R0 para el backend:** hay que comprobar que `sync.sync.ver_estado` está en el catálogo sembrado.
  Si no está, hace falta una migración de siembra, porque una función nueva no nace sola. Si el rol
  del spec e2e no la tiene, va a `FUNCIONES_POR_ROL` del helper, no al spec.
- La variante del copy de «sin configurar» consulta además
  `hasFuncion('tramites.flit2.guardar_acceso')`. Es solo lectura del permiso y no amplía nada.

---

## Delta de la ficha de ayuda (`apps/web/src/content/ayuda/flito_tramites.md`)

Va en **usted**, como el resto de la ficha.

1. **Pasos, 1:** tras «…llegaron nuevos o con cambios.» se añade:
   > Junto al botón, **Última lectura FLIT 2** muestra la hora de la última lectura que salió bien; si dice **lectura atrasada**, quedan trámites por leer y la lectura automática sigue donde quedó.
2. **Estados:** se añade un ítem después de «Error»:
   > Aviso de FLIT 2: si FLIT 2 lleva más de 30 minutos sin leerse, aparece un aviso sobre la tabla que dice desde cuándo y por qué (por ejemplo, acceso rechazado o bloqueado) y qué hacer. El aviso se quita solo cuando vuelve una lectura exitosa. Si algunos trámites llegaron sin los datos del comprador, el aviso lo dice: su SOAT e impuestos quedan en espera hasta que FLIT 2 habilite el permiso de datos personales. Si FLIT 2 aún no tiene acceso, verá **FLIT 2 sin configurar**.
3. **Para quién:** no cambia, salvo que el AC nombre un rol concreto con `sync.sync.ver_estado`.

---

## Notas para QA (≤10)

1. Sin `sync.sync.ver_estado` no están en el DOM ni la línea «Última lectura FLIT 2» ni la tarjeta, y
   no sale ningún GET a `/flit2/estado` en la red.
2. Los 4 estados de la cabecera: esqueleto al cargar; «No se pudo consultar» con [Reintentar] tras un
   500 del primer GET, y [Reintentar] vuelve a llamar; «Sin configurar»; y la fecha y hora de la
   última lectura exitosa. Con `atrasada: true` se ve «· lectura atrasada».
3. Con `configurado: false` y `alerta` forzada por datos viejos, **no** aparece la alerta: se ve la
   tarjeta «FLIT 2 sin configurar» con la variante de copy según `guardar_acceso`.
4. Rechazo con `ultimaExitosaEn` de hace más de 30 minutos: aparece la alerta **y** la frase de
   rechazo con la hora del intento. Tras una lectura exitosa (`alerta: false`, sin problema), la
   tarjeta desaparece en el siguiente refresco.
5. Un GET de polling que falla (red o 500) **no** quita una alerta que ya estaba ni pinta error.
6. Cada `codigo` de la tabla muestra su frase exacta. Ni `invalid_cursor`, `insufficient_scope`,
   `error_interno`, ningún `status` ni el `error` del API aparecen en el DOM. Un código desconocido
   cae en la frase genérica.
7. PII: con `tramites: 12` se ve el párrafo con «12 trámites…» y ninguna placa, nombre ni documento.
   Con 0 no hay párrafo. Ni en el DOM ni en la respuesta hay usuario de servicio, contraseña ni pase.
8. Tras pulsar «Sincronizar FLIT 2», tanto si acaba bien como si falla, sale un GET de estado. Con la
   pestaña oculta el polling se detiene, y al volver hay un GET inmediato.
9. La alerta tiene `role="alert"` y no se vuelve a anunciar en cada poll si el texto no cambió. No sale
   ningún toast por el estado.
10. A 375 px la cabecera envuelve sin desbordar, el bloque de FLIT 2 queda junto a su botón y la
    tarjeta ocupa el ancho completo. Se revisa en tema claro y oscuro (contraste del título y foco de
    [Reintentar]). Queda pendiente el delta de la ficha (`flit-ayuda-flito`).

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Saber si FLITO está leyendo FLIT 2 y, si no, por qué y qué hacer. |
| ¿Qué se ve primero y qué se calla? | La hora de la última lectura exitosa junto a su botón. La tarjeta solo aparece si hay algo que resolver. Se callan los códigos, cursores, motivos literales, secretos y PII. |
| ¿Primaria única? | Sigue siendo «Sincronizar FLIT». La tarjeta no tiene botones. |
| ¿Vacío y error con siguiente paso? | Sí. El vacío manda a Acceso a FLIT 2 o a un administrador, el error de consulta ofrece [Reintentar] y cada problema dice qué hacer o que no hace falta hacer nada. |
| ¿Efectos o patrón nuevo? | Ninguno. Es el calco del bloque «Última actualización» y del `Aviso` de `AccesoFlit2`. |
| ¿Móvil? | El par bloque + botón envuelve junto, el texto va a la izquierda por debajo de `sm` y la tarjeta ocupa el ancho completo. |
| ¿Feedback? | [Reintentar] con hover y foco. No hay más controles nuevos. |
| ¿Notificación? | Aviso de página (`alert` con los 30 minutos, `status` en los demás casos), nunca toast. |

## Decisiones y descartes

- **El estado no va dentro del panel «Acceso a FLIT 2»:** ese panel pide otro permiso, se abre a
  demanda y es para configurar. Un aviso que tiene que seguir visible no puede depender de abrir un
  modal.
- **La tarjeta no está siempre visible:** en un ambiente sano sería un banner que duplica la línea
  de la cabecera. Aparece solo cuando hay algo que resolver, por los principios: un lleno sin banners
  que compitan.
- **Sin botones en la tarjeta:** «Sincronizar FLIT 2» y «Acceso a FLIT 2» ya están en la cabecera.
  Repetirlos pondría dos controles para lo mismo y, con «Sincronizar», una segunda acción fuerte.
- **La alerta la calcula el servidor:** con el reloj del cliente, un equipo con la hora corrida
  mostraría u ocultaría la alerta mal.
- **Un polling de 2 minutos en vez de un botón «Actualizar estado»:** el AC pide que el aviso aparezca
  solo a los 30 minutos. Un botón manual obligaría a mirar.
- **«Última actualización» de FLIT 1 no se renombra:** el e2e existente la usa. El bloque nuevo se
  distingue con «FLIT 2» en el rótulo.

---

## Contrato propuesto (para `backend-agent`, HU #13097)

`GET /api/flito/sync/flit2/estado`:
- `authMiddleware` + `requireFuncion('sync.sync.ver_estado')`, sin parámetros.
- Tipo en `packages/shared-types/src/flito-flit2.ts`.

```ts
export type Flit2ProblemaTipo = 'rechazado' | 'bloqueado' | 'lectura';
export type Flit2RechazoMotivo = 'credenciales' | 'cambio_clave' | 'otro';

export interface Flit2EstadoConexion {
  /** false si no hay acceso guardado (o el servidor no tiene FLIT 2 configurado). */
  configurado: boolean;
  /** Solo con configurado=false. */
  motivoSinConfigurar: 'sin_acceso' | 'ambiente' | null;
  ultimaExitosaEn: string | null;   // ISO — flito_sync_flit2_lectura.ultima_exitosa_en
  ultimoIntentoEn: string | null;   // ISO — ultimo_intento_en
  atrasada: boolean;                // lectura.atrasada
  /**
   * Calculada EN EL SERVIDOR: configurado && ahora − (ultimaExitosaEn ?? acceso configurado desde) ≥ 30 min.
   * Siempre false con configurado=false. Sí true con rechazo o bloqueo.
   */
  alerta: boolean;
  /** Uno solo, con precedencia rechazado > bloqueado > lectura. null si la última lectura salió bien. */
  problema: null | {
    tipo: Flit2ProblemaTipo;
    /** Solo tipo 'lectura': ultimo_error_codigo tal cual (código de FLIT 2 o nuestro). La UI lo mapea, no lo pinta. */
    codigo: string | null;
    /** Solo tipo 'rechazado': rechazo_motivo normalizado a la lista cerrada. */
    motivo: Flit2RechazoMotivo | null;
    /** Hora del hecho: rechazado_en | inicio del bloqueo o ultimo_intento_en | ultimo_intento_en. */
    en: string | null;
    /** Solo tipo 'bloqueado': bloqueado_hasta. */
    hasta: string | null;
  };
  /** COUNT de flito_tramites con flit2_pii_enmascarada = true; desde = pii_enmascarada_desde. */
  piiEnmascarada: { tramites: number; desde: string | null };
}
```

- **Sin** `clientId`, contraseña, pase, `cursor_relectura`, `rechazo_motivo` ni `bloqueo_motivo` en
  crudo. No hay PII: el conteo es un número.
- `problema` de tipo `lectura` solo si `ultimo_error_codigo` no es null (una lectura exitosa lo pone
  a null) y el código no es `lectura_concurrente`.
- Un `bloqueado_hasta` que ya pasó no genera `problema` de tipo `bloqueado`.
- La ruta es liviana (dos filas únicas y un COUNT) porque la UI la consulta cada 2 minutos: nada de
  llamadas a FLIT 2 aquí. Sin `rateLimiter` especial más allá del general.
- Hay que comprobar que la función `sync.sync.ver_estado` existe en el catálogo sembrado. Si no, se
  añade una migración de siembra (R0).
