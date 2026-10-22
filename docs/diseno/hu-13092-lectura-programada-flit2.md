# HU #13092 — Lectura programada de FLIT 2 con candado y esperas (delta de diseño)

- **Feature:** #13059 · **Épica:** #12736 · **Architecture:** slim (extiende la #13091)
- **Base:** `docs/diseno/hu-13091-lectura-incremental-flit2.md` (§«Puntos de extensión», fila #13092)
- **Contrato:** `docs/integraciones/flit2-api.md` v3.1
- **Módulo:** `flito-sync` (FLITO, montado bajo `/api/flito/sync`). Sin migración: la fila
  `flito_sync_flit2_lectura` de la 0215 ya trae `atrasada` y `ultimo_error_codigo`.

## 1. Qué cambia

| Pieza | Cambio |
|---|---|
| `flito-sync.cron.ts` | `startFlitSync()` arma un `setInterval` de 5 min para FLIT 2 si `FLIT2_SYNC_CRON` está encendida (por defecto). FLIT 1 sigue sin corrida automática. |
| `flit2-candado.ts` (nuevo) | `conCandadoLectura(fn)`: advisory lock de sesión de Postgres, sin espera. |
| `flit2-lectura.service.ts` | `leerConCandado(origen)`, topes de tiempo, esperas del 429, `atrasada`, código de FLIT 2 en `ultimo_error_codigo`, auditoría de la corrida programada. Sustituye `MAX_PAGINAS = 10`. |
| `flit2-lectura.routes.ts` | El botón pasa por `leerConCandado('boton')` y solo audita si `leidos > 0`. |
| `flit2-pase.service.ts` | El 423 del token respeta `Retry-After` (tope 900 s; 15 min si falta). |
| `flit2-sync-http.adapter.ts` / `flit2.errors.ts` | El 429 del feed lleva sus segundos de `Retry-After`; errores nuevos `Flit2LecturaEnCursoError` (409) y `Flit2EsperaFeedError` (503 `espera`). |
| `env.ts` / `.env.example` | `FLIT2_SYNC_CRON` (en blanco = encendida; `false`/`0` la apaga). |

## 2. Candado

**Elegido:** `pg_try_advisory_lock(13092, 2)` —forma de dos `int4`— sobre una conexión **reservada**
del pool de postgres-js (`db.$client.reserve()`), tomado al inicio de la corrida y soltado en `finally`
con `pg_advisory_unlock(13092, 2)` y `release()`.

- **Por qué de sesión y no de transacción:** la corrida hace una transacción por página (RN-02 de la
  #13091) y dura hasta 4 min; un `pg_advisory_xact_lock` obligaría a una transacción envolvente, que
  rompe la atomicidad por página y deja una transacción larga abierta.
- **Por qué conexión reservada:** el lock de sesión pertenece a la conexión que lo pidió. Con el pool
  normal, el `unlock` podría salir por otra conexión y no soltar nada. La conexión reservada solo
  sostiene el candado; la lectura usa el pool como siempre (una conexión más durante la corrida).
- **Por qué dos claves:** Postgres guarda la forma de dos claves en otro espacio (`objsubid = 2`)
  que la de una (`objsubid = 1`). Los `pg_advisory_xact_lock(hashtext(...))` del repo (LAFT, PESV,
  RNDC) caen en cualquier `int4` de una clave y no pueden chocar con este par.
- **Varios procesos:** el candado vive en el servidor de base, así que vale entre PM2 en cluster y
  entre réplicas. Si el proceso muere, Postgres cierra la sesión y lo suelta: no hay huérfanos.
  Si el `unlock` falla (la conexión se cayó), se registra y no tapa el resultado de la corrida.
- **Sin espera:** si el candado está tomado, `leerConCandado` lanza `Flit2LecturaEnCursoError`
  (409, `codigo: 'lectura_concurrente'`, el mismo que el 409 optimista, para que la pantalla no
  necesite un caso nuevo; el mensaje dice «Ya hay una lectura de FLIT 2 en marcha»).
- **Dentro del proceso**, el cron además no encima un tick con el anterior (`enCurso`): así no reserva
  una conexión solo para descubrir que el candado está tomado.
- **Segunda defensa:** la guarda optimista del cursor (`IS NOT DISTINCT FROM`) de la #13091 se queda.

Verificado contra la Postgres local (dos clientes `postgres()` distintos = dos procesos): A toma →
B no puede → `pg_locks` muestra `(classid 13092, objid 2, objsubid 2)` → A suelta → B toma.

## 3. Topes

| Tope | Valor | Dónde corta |
|---|---|---|
| Corrida del cron | 4 min (`LIMITE_CRON_MS`) | Tras **guardar** la página en curso; nunca a mitad. |
| Corrida del botón | 60 s (`LIMITE_BOTON_MS`) | Igual; responde 200 con los totales parciales y `hasMore: true`. |
| Cinturón de páginas | 200 (`MAX_PAGINAS_SEGURIDAD`, 100 000 ítems) | Solo por si el reloj falla; no es el tope real. |
| Intervalo del cron | 5 min | La primera corrida sale a los 5 min del arranque, nunca en el tick del boot. |
| Espera máxima de un 429 | 60 s (`ESPERA_429_MAX_S`) | Por encima, la corrida termina sin avanzar. |
| 429 seguidos sobre la misma página | 3 esperas | A la cuarta, termina sin avanzar. |

Límites de FLIT 2 que justifican los números: **120/min por clientId** en `/tramites/sync` y
**10/min por IP** en el token. Con el pase en caché (RN-01 del pase), una corrida pide el token a lo
sumo una vez (dos con el 401 de RN-04) y una página por respuesta; los 120/min solo se alcanzan con
respuestas casi instantáneas, y entonces el 429 frena la corrida. El intervalo de 5 min con tope de
4 min deja 1 min de holgura: dos corridas del cron no se pisan ni aunque faltara el candado.

`atrasada` = la corrida terminó con `hasMore` (queda feed por leer). Se escribe al terminar bien, y al
fallar solo si se sabe algo: `true` con `Flit2EsperaFeedError`, el `hasMore` de la última página
guardada si hubo alguna, y sin tocar si el fallo fue antes de la primera página.

## 4. Mapa de errores → pausa

| Respuesta de FLIT 2 | Dónde | Qué pasa | Pausa |
|---|---|---|---|
| 423 `client_locked` | token | `marcarBloqueo` en la fila del acceso hasta `ahora + Retry-After` (tope 900 s; 15 min si falta o no se entiende). El `Retry-After` va en segundos; el cuerpo RFC 7807 (`code`) no decide nada. | Sí: `obtenerPase` falla sin llamar mientras dure (RN-03 del pase). |
| 401 `invalid_client` / 403 `secret_rotation_required` | token | `marcarRechazo` (marca de la 0214, reutilizada). | Sí: hasta que se guarde un acceso nuevo (la fila nueva nace sin marcas). |
| 429 | token | `marcarBloqueo('rate_limited')` según `Retry-After` (sin cambio). | Sí, corta. |
| 401 | `/tramites/sync` | `conPase` renueva el pase **una** vez (RN-04). | No. |
| 429 con `Retry-After` ≤ 60 s (60 si falta) | `/tramites/sync` | Espera y repite la **misma** página con el mismo cursor, si la espera cabe en el tope. | No. |
| 429 con > 60 s, o que no cabe en el tope | `/tramites/sync` | `Flit2EsperaFeedError`: termina sin avanzar, `ultimo_error_codigo = 'espera'`, `atrasada = true`. | No (la siguiente retoma). |
| 400 (`invalid_cursor` u otro) / 403 `insufficient_scope` | `/tramites/sync` | La posición no avanza; el código de FLIT 2 va a `ultimo_error_codigo`; no se reintenta en la corrida. La posición **nunca** se reinicia sola. | No: la siguiente corrida programada vuelve a intentar. |
| 5xx, timeout, red | cualquiera | Como en la #13091: termina, se anota, la siguiente reintenta. | No. |

`ultimo_error_codigo` guarda el código RFC 7807 de FLIT 2 si tenía forma de código (`^[a-z_]{1,40}$`,
cabe en el `varchar(40)`); si no, el nuestro (`flit2_respuesta`, `espera`, `error_interno`…).

Sin acceso vigente, o con el acceso rechazado o en pausa, `verificarAcceso` lanza **antes** de fijar
posición o anotar nada: la corrida «no corre». El cron lo registra en `debug`, sin ruido.

## 5. Auditoría

Solo las corridas que **terminan bien y trajeron ítems** (`leidos > 0`), con totales y sin PII
(`detalleAuditoria`). Las vacías o fallidas solo quedan en la fila de lectura (`ultima_exitosa_en`,
`ultimo_intento_en`, `ultimo_error_codigo`, `atrasada`).

- Botón: `audit(req, …)` como antes, pero condicionado.
- Cron: no hay `req`; inserta en `audit_logs` como los demás procesos del sistema (`userId: null`,
  `userEmail: 'sistema'`, mismo patrón que `flito-soat-vigencia.service.ts`). Un fallo al auditar se
  registra y no tumba el cron.

## 6. Acceso nuevo con otro usuario de servicio

`guardarAcceso` no toca `flito_sync_flit2_lectura` (verificado con test): el cursor es del feed, no del
usuario de servicio, así que la posición se conserva.

## 7. Decisiones del backend-agent (no del AC)

1. 429 sin `Retry-After` en el feed → se asume 60 s (mismo criterio que el pase).
2. Tope de 3 esperas por la misma página, además del tope de tiempo.
3. Una corrida que termina por 429 largo **lanza** (`503 espera` en el botón, con `parcial` si guardó
   páginas) y por tanto no se audita, aunque haya guardado páginas antes: el AC dice «las fallidas no
   se auditan».
4. El 409 del candado reutiliza `codigo: 'lectura_concurrente'` con otro mensaje.
5. El copy de «Probar conexión» ante un 423 sigue diciendo «se libera solo en 15 minutos»; la hora
   exacta ya viaja en `bloqueadoHasta`. Ajustar el texto es de la pantalla, fuera de esta HU.
