# Diseño slim — HU #13633: respaldo configurable de FLIT 2 y alerta por respaldos fallidos o firmas rechazadas

Feature #13613 · Épica #13576 · BACKEND · apilada sobre la HU #13632 (PR #517, `f7540495`).
Módulo **FLITO** `flito-sync` (no el legacy). Sin migración: las columnas `ultimo_aviso_en` y
`rechazos_firma_seguidos` las crea la 0244 (HU #13632).

## Patrón reutilizado

- Variable de entorno: mismo patrón que `FLIT2_AVISOS_LIMITE_MIN` en `apps/api/src/config/env.ts`
  (`z.preprocess(vacioComoAusente, z.coerce.number().int()…default(…))`).
- Pulso: `marcarProgramaEncendido(intervalo, ahora)` de `flit2-programa.ts` ya publica `intervaloMs`;
  no cambia.
- Estado: `componerEstado` (pura, reloj inyectado) + `obtenerEstadoConexion` en
  `apps/api/src/modules/flito-sync/flit2-estado.service.ts`. Se extiende igual que en la HU #13237
  (campo opcional en `EntradaEstado` con default, así los llamadores y tests previos no cambian).

## Decisiones

**(a) Dónde está «lectura exitosa» (AC4).** Ya existe: `flito_sync_flit2_lectura.ultima_exitosa_en`
(fila única `id=1`), que escribe `leerIncremental` al terminar bien (`anotar({ ultimaExitosaEn … })`,
`flit2-lectura.service.ts` ~l.582). Las tres procedencias (`'cron' | 'acceso' | 'aviso'`) pasan por
`leerConCandado` → `leerIncremental`. El `origen` solo va al log, así que la lectura disparada por un
aviso la renueva igual que el respaldo. **No** se crea marca nueva. La referencia sigue siendo
`ultimaExitosaEn ?? acceso.createdAt`. `ultimo_aviso_en` **no** cuenta como lectura exitosa: recibir
un aviso válido no trae datos. Lo que trae datos es la lectura que el aviso agenda.

**Umbral.** `UMBRAL_ALERTA_MS` (constante de 30 min) se sustituye por
`umbralAlertaMs(respaldoMs) = 2·respaldoMs + 5 min`. R=5 da 15 min y R=60 da 125 min. Con un solo
respaldo fallido, la última exitosa tiene como mucho R + tope de la corrida (4 min, `LIMITE_CRON_MS`)
< 2R + 5, así que no hay alerta (AC4). El estado toma R de `env.FLIT2_RESPALDO_MIN`, **no** de
`programa.intervaloMs`: el pulso es por proceso, pero el env es igual en todos. Además, con el programa
apagado `intervaloMs` es null, y ese caso ya lo cubre RN-07 (alerta=false).

**(b) Origen de `rechazosFirmaSeguidos` y `ultimoAvisoEn`: la base.** Se suman al `select` de la fila
de lectura que ya hace `obtenerEstadoConexion` (la misma consulta, sin viaje extra; RN-01 intacta).
No se leen de memoria por tres motivos. Las marcas en memoria (`flit2-avisos.service.ts`, C2) son de
**ese** proceso y solo guardan el delta pendiente, no el total. El aviso puede entrar por un proceso
distinto del que atiende `GET /estado`. Y un reinicio las pierde. El desfase máximo es
`VOLCADO_MS` = 5 s, despreciable frente al sondeo de la UI (2 min). AC5 («un aviso válido deja el
contador en 0 y retira la alerta») se cumple en ≤ 5 s + el siguiente sondeo. Los tests de AC5 se
escriben contra la fila (o `componerEstado` con la entrada), no contra el timer de volcado.

**(c) Intervalo en el pulso «automatica».** El contrato no cambia. `startFlitSync` arma el
`setInterval` con `intervaloFlit2Ms()` (= `env.FLIT2_RESPALDO_MIN * 60_000`, leído al armar, no al
importar el módulo, para que el test de AC1 no dependa del orden de import) y pasa ese mismo valor a
`marcarProgramaEncendido` y al log `cadaMs`. Así `automatica.intervaloMs` publica 3 600 000 con R=60
(AC1) y 300 000 sin la variable (AC2). La web ya pinta «cada N min» desde `intervaloMs`.

**AC3.** En `env.ts`:
`FLIT2_RESPALDO_MIN: z.preprocess(vacioComoAusente, z.coerce.number(<msg>).int(<msg>).min(1, <msg>).max(120, <msg>).default(5))`,
con `<msg>` = `'FLIT2_RESPALDO_MIN debe ser un entero de 1 a 120 (minutos)'` en **cada** refinamiento.
Así `abc`, `0`, `1.5` y `121` fallan nombrando la variable, y la cadena vacía equivale a ausente (5).
Mismo estilo que el mensaje de `FLIT2_ENC_KEY`.

**Problema `avisos_firma` y precedencia: rechazado > bloqueado > avisos_firma > lectura (confirmada).**
- `rechazado` y `bloqueado` cortan el **respaldo** (no hay pase, no entra nada) y además ya fuerzan
  `alerta`. Son lo más grave y lo primero que hay que arreglar, porque sin acceso no hay ni respaldo
  ni lectura por aviso que funcione.
- `avisos_firma` va por encima de `lectura` porque es **persistente y de seguridad**: el contador
  solo vuelve a 0 con un aviso válido (secreto desalineado o intentos con firma falsa). El
  `ultimo_error_codigo` de `lectura`, en cambio, se borra con la siguiente lectura buena
  (`ultimoErrorCodigo: null`) y la mayoría de sus códigos se curan solos. Si `lectura` ganara, un
  fallo transitorio taparía cada 5 min una señal que exige acción humana (rotar o alinear el secreto).
- Costo aceptado: con `avisos_firma` visible se oculta un `lectura` simultáneo. Si ese fallo de
  lectura es persistente, la alerta igual se enciende por el umbral 2R + 5. Y al corregir la firma,
  el problema de lectura aflora en el siguiente sondeo.
- Forma: `{ tipo: 'avisos_firma', codigo: null, motivo: null, en: null, hasta: null }`. La 0244 no
  guarda la hora del último rechazo, y `en` se deja en null para no inventarla con `ultimoAvisoEn`,
  que es la hora del último aviso **válido**.
- `alerta = … || problema?.tipo === 'avisos_firma'`. RN-07 sigue ganando al final (apagado → false, AC7).
- **Solo cuenta con `env.FLIT2_AVISOS_HABILITADO = true`.** Decisión del diseño: con el canal
  apagado no llega ningún aviso que pueda poner el contador en 0, así que un contador viejo en la base
  dejaría la alerta encendida para siempre.

## Contrato delta (`packages/shared-types/src/flito-flit2.ts`)

```ts
export type Flit2ProblemaTipo = 'rechazado' | 'bloqueado' | 'avisos_firma' | 'lectura';
// Flit2EstadoConexion
  /** HU #13633: último aviso válido de FLIT 2 (ISO) o null. */
  ultimoAvisoEn: string | null;
  // `alerta`: doc → «≥ 2·respaldo + 5 min sin lectura exitosa, o acceso rechazado/bloqueado, o ≥ 3 firmas rechazadas seguidas».
  // `problema`: doc → «precedencia rechazado > bloqueado > avisos_firma > lectura».
```
`ultimaExitosaEn` ya existe (AC6 solo exige mantenerlo). El contador **no** se expone; basta con el tipo.
`GET /api/flito/sync/flit2/estado` no cambia de ruta ni de auth.

**Grep obligatorio en `apps/web` (hecho):** los únicos consumidores son
`components/flito/tramites/EstadoFlit2.tsx` y `IndicadorFlit2.tsx`. Ninguno tiene
`Record<Flit2ProblemaTipo, …>` ni un `never` exhaustivo. Usan cadenas `if (p.tipo === …)` y un
`switch (p.codigo)` con `default`. **El typecheck de la web no se rompe** con el tipo nuevo ni con el
campo nuevo (solo lectura). Esta HU no toca la web. Comportamiento interino hasta la HU #13634:
- `IndicadorFlit2.casoDe` cae en `'alerta'` (alerta=true). Es correcto, aunque genérico.
- `EstadoFlit2.fraseProblema` cae en el `default` del `switch (p.codigo)`: «La lectura … falló en
  FLITO. Se reintenta sola…». Esa copia de reserva **es engañosa** para `avisos_firma`. Se acepta solo
  en DEV y obliga a promover la #13633 **junto con** la #13634 (ver Riesgos).
- `EstadoFlit2.tsx` tiene `MEDIA_HORA_MS` (30 min) para el título de «alerta sin problema». Con el
  umbral nuevo, el copy de la web y el servidor dejan de coincidir. El ajuste le toca a la #13634.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/config/env.ts` | `FLIT2_RESPALDO_MIN` (AC3) |
| `apps/api/src/modules/flito-sync/flito-sync.cron.ts` | `INTERVALO_FLIT2_MS` (5 min) pasa a ser el valor por defecto; la nueva `intervaloFlit2Ms()` lo lee de env al armar (setInterval, `marcarProgramaEncendido`, log). Actualizar el comentario de cabecera («cada 5 min») |
| `apps/api/src/modules/flito-sync/flit2-estado.service.ts` | `umbralAlertaMs(respaldoMs)` reemplaza `UMBRAL_ALERTA_MS`; `LecturaParaEstado` + `rechazosFirmaSeguidos`, `ultimoAvisoEn`; `EntradaEstado` + `respaldoMs?` (default 5 min) y `avisosHabilitados?` (default false); `problemaDe` con `avisos_firma`; `select` + 2 columnas; salida + `ultimoAvisoEn`; cabecera RN-03/RN-04 reescritas y RN-08 (umbral) y RN-09 (avisos_firma) nuevas |
| `packages/shared-types/src/flito-flit2.ts` | Contrato delta |
| `apps/api/__tests__/services/flito-sync.flit2-estado.test.ts` | Hoy fija `UMBRAL_ALERTA_MS = 30 min`: se cambia por `umbralAlertaMs`. Casos AC4–AC7 |
| `apps/api/__tests__/services/flito-sync.flit2-cron.test.ts` | Hoy fija `INTERVALO_FLIT2_MS = 5 min`: se mantiene para AC2 y se añade AC1 con env mockeado a 60 |
| Test de env (el que ya cubra `env.ts`, o uno nuevo `config.env-flit2-respaldo.test.ts`) | AC3 |
| `.env.example` / plantilla de despliegue de DEV, si el repo la versiona | `FLIT2_RESPALDO_MIN=60` solo en DEV; QA y PDN sin la variable |

## ADR: no aplica

Es una extensión del módulo existente: sin tabla, sin endpoint y sin dependencia nuevos.

## Notas operativas (backend)

- P1: `npm test -w apps/api -- __tests__/services/flito-sync.flit2-estado.test.ts __tests__/services/flito-sync.flit2-cron.test.ts <test de env>`
  + `npm run build -w packages/shared-types` + `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`
  + `npm run typecheck -w apps/web` (es la prueba del grep: debe quedar verde sin tocar la web).
- Mantener `componerEstado` pura: R y el flag de avisos entran por `EntradaEstado`, no se leen de
  `env` dentro de ella.
- No volver a declarar las columnas de la 0244 en `schema.ts`: ya están en la rama base.
- Gates: `db-review-agent` no aplica (no se toca `schema.ts` ni `migrations/`). `security-agent` no
  aplica según P5 (ni rutas, ni PII, ni auth, ni multer). Ojo: `alerta` refleja ahora un indicio de
  firma falsa, pero no expone el contador ni el secreto. Frontend: no aplica (la consume la #13634).

## Riesgos

1. **Copy engañoso en la web hasta la #13634.** `avisos_firma` se muestra como «la lectura falló».
   Mitigación: la #13633 no llega a `staging` sin la #13634. Como van en el mismo Feature, la
   promoción conjunta es lo natural.
2. **PDN alerta antes que hoy**: 15 min (R=5) en vez de 30. Es lo que piden AC2 y AC4, y conviene que
   el PO lo tenga presente al promover.
3. **AC5 tiene hasta 5 s de desfase** por el volcado C2. Es aceptado y los tests no deben esperar
   inmediatez.
