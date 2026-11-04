# Runbook — rotación de `PII_ENC_KEY`

Feature #13978, HU #13987. Diseño: [ADR-0034](../adr/ADR-0034-flito-rotacion-llave-pii-con-registro-de-llaves.md).
Script: `apps/api/src/scripts/flito-rotar-llave-pii.ts`. Módulo legacy `privacy` (`modules/privacy/rotacion/`), con columnas de módulos legacy y `flito-*`.

Este documento rota en un ambiente de una vez. Orden: DEV, luego QA, luego PDN solo con QA terminado y verificado.

## Antes de empezar: lo que no se puede deshacer

- **Destruir la llave anterior no tiene vuelta atrás.** Retirarla de la API no es destruirla: **`PII_ENC_KEY` se conserva en bóveda mientras exista un respaldo que la necesite** (cualquier `pg_dump` y cualquier objeto anterior de MinIO). La borra solo quien custodia, cuando expira el último de esos respaldos, y deja constancia.
- **Una imagen anterior a este Feature no conoce la V2.** Con filas en V2, esa imagen devuelve `null` con 200 en conductores, manifiestos y LAFT: datos invisibles sin aviso. Revertir a esa imagen está prohibido sin recifrar antes a V1 (ver [Rollback](#rollback)).
- **`pii_decrypt_failures_total` no sirve como verificación.** Drivers, manifiestos, LAFT y `acta-pdf` capturan el fallo y devuelven `null`, sin mover esa métrica. El gate es `--verificar`.
- **Dumps:** contienen lo mismo que los de biometría (`feature-14097-recifrado-biometria.md`). Se custodian con el control de acceso de la BD, no se copian a equipos personales y se borran de forma explícita al cerrar la ventana.

## Disponibilidad: cada rollout es una caída

La api corre con `replicas: 1` y `strategy: Recreate` en DEV, QA y PDN (`flit-gitops`, `services/flito-*/deployments.yaml`). El pod viejo se detiene antes de que arranque el nuevo, así que:

- **Cada fase con rollout (F1, F2 y el retiro de `PII_ENC_KEY` en F5) implica una caída breve de la API.** En PDN cada una necesita **ventana acordada**. Si el Job de F3 no exige reinicio de la API, no suma caída.
- **Una llave equivocada deja la API sin servicio.** Al arrancar, la comprobación de llaves termina en `log.fatal` y salida 1, y no queda un pod anterior sirviendo. **La recuperación es revertir el commit en `flit-gitops`** (en PDN, el cambio donde infraestructura confirme que vive su configuración; ver abajo). Tener ese revert preparado antes de cada rollout.
- **Solo hay un pod que revisar**, pero la comprobación de la línea de log `llaves PII comprobadas` se mantiene antes de pasar de fase: es lo que demuestra que tomó la configuración nueva. Un cambio de secreto o de ConfigMap no siempre reinicia el pod.

Si la api se escala en el futuro, revisar esta sección y las notas sobre réplicas del ADR-0034: hoy no aplican.

## Dato a confirmar con infraestructura antes de ejecutar

**Dónde vive la configuración de PDN.** `AGENTS.md` se contradice: la regla 5 ubica la configuración de PDN en el `.env` del VPS, y la regla 6 y la sección de ambientes dicen que PDN va por GitOps desde 2026-10-23. Este runbook no lo resuelve (ADR-0034, hallazgo 4). **Sin esta respuesta, no se ejecuta en PDN.** En DEV y QA es `flit-gitops` (`services/flito-<env>/sealed-secrets.yaml` y `configmaps.yaml`).

Campos obligatorios: infraestructura los rellena por ambiente. Sin ellos el procedimiento no arranca.

| Dato | DEV | QA | PDN |
|---|---|---|---|
| Dónde se configuran `PII_ENC_KEY_V<n>` y `PII_ENC_KEY_CURRENT_VERSION` | `flit-gitops` | `flit-gitops` | _pendiente de confirmar_ |
| Ventana de rollback: fecha y hora de cierre | _pendiente_ | _pendiente_ | _pendiente_ |
| Ubicación y cifrado del dump | _pendiente_ | _pendiente_ | _pendiente_ |
| Responsable del borrado del dump | _pendiente_ | _pendiente_ | _pendiente_ |
| Custodio de la llave en bóveda | _pendiente_ | _pendiente_ | _pendiente_ |
| Ventana para cada rollout (F1, F2, F5) | no aplica | _pendiente_ | _pendiente_ |

**Plazo de la ventana de rollback de objetos:** como máximo **30 días** desde F3, salvo que un compromiso de la llave exija cerrarla antes. El plazo es corto a propósito: mientras dure, los documentos existen dos veces en MinIO, una con la llave anterior. Es una propuesta de este runbook: el dato definitivo es la fila de arriba, y lo fija el responsable del ambiente.

## Inventario de lo cifrado

Fuente: `apps/api/src/shared/utils/pii-columnas.ts`. La prueba `__tests__/services/pii-columnas-cobertura.test.ts` falla si aparece una columna cifrada o un archivo que cifre sin declararse allí, y también si esta tabla pierde una entrada.

| Columna | Forma | Trampa |
|---|---|---|
| `driver_profile.cedula` | bundle bytea | `key_version` NULL se lee como 1 |
| `driver_profile.licencia_numero` | bundle bytea | igual |
| `driver_profile.runt_payload` | bundle bytea | igual |
| `manifiestos.titular_pago_cuenta` | bundle bytea | La clave de la AAD es `numero`, no `id`. El `updated_at` avanza al recifrar, por trigger |
| `laft_counterparties.doc_number_enc` | jsonb | La columna de la AAD no lleva `_enc` |
| `laft_counterparties.email_enc` | jsonb | igual |
| `laft_counterparties.phone_enc` | jsonb | igual |
| `flito_logistica_acta_firmas.documento_cifrado` | texto `v1:<ver>:…` | `v1` es el formato; la llave es el segundo campo |
| `flito_logistica_recogida_firmantes.documento_cifrado` | texto `v1:<ver>:…` | La AAD nombra `flito_logistica_acta_firmas` |
| `flito_bolsas_documentos.archivo` | objeto en MinIO | `pg_dump` no lo respalda. `storage_key` NULL = purgado |
| `tramites_validaciones.foto_rostro` | texto `v<ver>:…` | Biometría (#14097). Convive con formatos legados |
| `tramites_validaciones.foto_cedula_frontal` | texto `v<ver>:…` | igual |
| `tramites_validaciones.foto_cedula_reverso` | texto `v<ver>:…` | igual |

**Fuera:** los keyspaces de credenciales (`RNDC_ENC_KEY`, `SIIGO_ENC_KEY`, `COMPARENDOS_ENC_KEY`, `FLIT2_ENC_KEY`) y los HMAC. **Rotar no protege** las columnas en claro `laft_counterparties.doc_number`, `email` y `phone`: siguen en el esquema (ADR-0034, hallazgo 1), y hay que considerarlo si la rotación es por compromiso.

## El Job

Lo lanza infraestructura con `kubectl`, **fuera de la kustomization de Argo CD**. Misma imagen por digest y mismo `envFrom` que el Deployment de la api: sacarlos del Deployment vivo, no copiarlos de otro ambiente.

```bash
kubectl -n flito-<env> get deploy <deployment-api> \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}{.spec.template.spec.containers[0].envFrom}{"\n"}'
```

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: rotar-llave-pii-dry-run      # uno por modo y por corrida
  namespace: flito-<env>
spec:
  backoffLimit: 0                    # una salida 2 la revisa una persona
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: rotar
          image: <imagen de la api>@sha256:<digest del Deployment>
          command: ["node", "dist/scripts/flito-rotar-llave-pii.js", "--dry-run", "--target-version=2"]
          envFrom: []                # copiar el del Deployment de la api
          resources:
            requests: { memory: 512Mi }
            limits: { memory: 1Gi }  # fotos de varios MB y objetos de hasta 15 MB
```

En local: `npm run privacy:rotar-llave-pii -w apps/api -- --dry-run --target-version=2`.

| Modo | Efecto |
|---|---|
| `--dry-run --target-version=N` | Descifra, recifra en memoria y cuenta. Cero escrituras |
| `--commit --target-version=N` | Escribe. Reanudar es volver a correr |
| `--verificar --target-version=N` | Sale 0 solo si cada celda está en N, legible, y no quedan formatos de biometría que dependan de la llave retirada |
| `--solo-llaves` | Compara las llaves del Job con el registro |
| `--limpiar-objetos` | Borra los objetos anteriores de MinIO |

**Salidas:** `0` terminada · `2` quedan pendientes, revisar y volver a correr · `1` abortó con cero escrituras. La salida solo lleva conteos e ids de fila.

`--target-version` es una afirmación tuya: si no coincide con `PII_ENC_KEY_CURRENT_VERSION` del Job, aborta. El script no tiene origen ni destino: todo lo que no esté en la vigente se recifra a la vigente.

| `motivoAborto` | Qué significa | Qué hacer |
|---|---|---|
| `llave_no_coincide` | Una llave del Job no descifra su canario | El Job tiene una llave distinta a la de la API. **Parar** y revisar el secreto. No tocar `pii_key_registry` |
| `llave_sin_registro` | Una versión configurada no tiene fila | La API aún no arrancó con esa llave. Volver a F1 |
| `version_objetivo_no_vigente` | `--target-version` no es la vigente | Volver a F2, o corregir el argumento |
| `version_objetivo_sin_llave` | La versión pedida no está en el Job | Revisar el `envFrom` del Job |

## Fases

### F0. Imagen con este Feature, vigente 1

Sin cambios de configuración. Al arrancar, la API registra V1 en `pii_key_registry`.

**Comprobar en el pod** la línea de log `llaves PII comprobadas`: `versionVigente: 1` y `versionesConfiguradas: [1]`.

### F1. Agregar la llave nueva, vigente sigue en 1

1. Generar B y guardarla en bóveda **antes** de configurarla: `openssl rand -hex 32`. Nunca en un chat, un ticket ni un repositorio en claro.
2. Agregar `PII_ENC_KEY_V2` al secreto. **No** tocar `PII_ENC_KEY_CURRENT_VERSION`.
3. Forzar el rollout, en ventana: un cambio de secreto o de ConfigMap no siempre reinicia el pod.
4. **Comprobar en el pod:** `versionesConfiguradas: [1, 2]`, `versionVigente: 1`. Sin esto no se pasa de fase. Si el pod no arranca, revertir el commit.

**Prueba de custodia:** Job con `--solo-llaves`, con la B **sacada de la bóveda**, no del secreto del Deployment. Debe salir 0 con `ok` en la versión 2. Si sale `llave_no_coincide`, la bóveda y el secreto tienen llaves distintas: la del secreto es la que la API registró, y es la que cifraría.

### F2. La nueva pasa a vigente

1. `PII_ENC_KEY_CURRENT_VERSION=2`. Forzar el rollout, en ventana.
2. **Comprobar en el pod:** `versionVigente: 2`. Si el cambio no reinició el pod, sigue escribiendo en V1: no daña datos, y `--commit` y `--verificar` lo detectan, pero la línea de log es la que evita perder el tiempo.

F1 y F2 van separadas para que la llave nueva quede anclada y comprobada con la prueba de custodia antes de que algo se escriba con ella, y para que retroceder en F1 no tenga coste.

### F3. Recifrar

1. **Respaldo previo.** `pg_dump` de las tablas del inventario, y comprobar que el archivo se puede leer:

   ```bash
   pg_dump "$DATABASE_URL" -Fc -f pre-rotacion-pii-<ambiente>-<fecha>.dump \
     -t driver_profile -t manifiestos -t laft_counterparties \
     -t flito_logistica_acta_firmas -t flito_logistica_recogida_firmantes \
     -t flito_bolsas_documentos -t tramites_validaciones -t pii_key_registry
   pg_restore --list pre-rotacion-pii-<ambiente>-<fecha>.dump | head
   ```

   **`pg_dump` no respalda los objetos de MinIO.** El respaldo de esos objetos son los anteriores que el script conserva: por eso no se limpian hasta cerrar la ventana.
2. `--dry-run --target-version=2`. Debe salir 0, con `recifrable` razonable por columna y `fallo` en 0.
   - Salida 1: parar. Es la llave (tabla de arriba).
   - `canario: "fallo"` en una columna: casi siempre es un defecto del descriptor, no la llave. Esa columna no se escribe. **Parar y escalar** antes del commit.
   - `fallo` mayor que 0 con canario `ok`: celdas corruptas sueltas, listadas en `idsFallidos`. Deciden el dueño del dato y el líder técnico.
   - `formato_legado` mayor que 0 en biometría: resolver con `tramites:recifrar-biometria` (#14097) antes de F5; `--verificar` no pasa sin eso.
3. `--commit --target-version=2`.
4. `--commit --target-version=2` otra vez: `escrito` debe ser 0 en todas las columnas. Un `omitido_concurrente` se resuelve solo al volver a correr; si la salida es 2 por `fallo`, revisar `idsFallidos`.
5. `--verificar --target-version=2`: debe salir 0.

Rendimiento: sin datos de volumen de PDN no hay estimación. Medir la duración en QA, y correr en PDN en horario de baja carga; bolsas baja cada objeto, lo sube y lo relee.

### F4. Verificación post-rotación y ventana de rollback

- `--verificar` en 0, repetido al abrir y al cerrar la ventana.
- Recorrer en la aplicación, con un usuario real del ambiente, un conductor, un manifiesto con titular de pago, una contraparte LAFT, un acta firmada, un documento de bolsa y un trámite con fotos. **Que respondan 200 no basta:** el dato tiene que verse, porque un fallo en esas rutas se ve como «sin dato».
- `objetosPrevios` informa cuántos objetos anteriores siguen en MinIO.

### F5. Retirar la llave anterior

**V1 se retira solo tras `--verificar --target-version=2` en 0**, corrido justo antes de este paso, no el de días atrás: es la última comprobación de que nada quedó dependiendo de V1.

1. `--verificar --target-version=2`, salida 0.
2. Al cerrar la ventana: `--limpiar-objetos`, salida 0. Solo borra la previa de filas ya en la vigente; las demás salen en `omitido_otra_version` y dan salida 2. **Después de esto, restaurar un dump anterior no recupera los documentos de bolsa.**
3. Quitar `PII_ENC_KEY` del secreto. Forzar el rollout, en ventana. Comprobar en el pod `versionesConfiguradas: [2]`.
4. `--verificar --target-version=2` una vez más, ahora sin V1 en el Job.
5. **`PII_ENC_KEY` sigue en bóveda** (ver el inicio de este documento).
6. Borrar el dump al cerrar la ventana, dejando constancia de quién y cuándo.

Dos efectos de quitar V1: las fotos en formato `viejo` dejan de leerse (ya lo impide `--verificar`, que las bloquea), y fuera de producción el respaldo de RNDC que deriva de `PII_ENC_KEY` lanza en vez de concatenar `undefined`.

## Si un canario queda mal registrado

Riesgo residual declarado en ADR-0034 D4: si **la misma B errónea llega a toda la API en el primer registro**, se registra, y es coherente mientras esa B exista. Lo detecta la prueba de custodia: `--solo-llaves` con la B de bóveda sale `llave_no_coincide`.

**Nunca borrar ni editar una fila de `pii_key_registry` sin seguir esto:** el canario es lo único que detecta que una llave no corresponde. Antes de actuar, saber en qué fase se está.

| Situación | Qué hacer |
|---|---|
| Vigente sigue en 1, sin escrituras con B (F1) | 1. Quitar `PII_ENC_KEY_V2` del secreto y hacer rollout; comprobarlo en el pod. 2. Con autorización del líder técnico, borrar **solo** la fila de esa versión: `DELETE FROM pii_key_registry WHERE version = 2`. Esa fila no protege ningún dato. 3. Configurar la B correcta y repetir F1 con su prueba de custodia |
| Vigente ya en 2: hay datos escritos con la B errónea | **La B errónea es ahora una llave con datos: no se descarta.** 1. Guardarla en bóveda como la versión 2. 2. No borrar la fila. 3. Generar una llave nueva, V3, y rotar desde F1 con vigente 3: la versión 2 se lee con la B errónea y todo queda en V3 |
| Pod que no arranca con `canario_no_descifra` en una versión n ≥ 2 | La API está sin servicio. Revertir el commit en `flit-gitops`, comprobar qué llave ancló la fila con la prueba de custodia, y corregir el secreto antes de reintentar |
| Canario de V1 no descifra al arrancar | La `PII_ENC_KEY` del ambiente no es la que lo registró, y la API queda sin servicio. **Es un error de configuración, no del registro.** Revertir el commit y reponer la llave correcta desde bóveda. No borrar la fila: quitarla haría que el siguiente arranque volviera a anclar a partir de la muestra de datos |

El Job nunca escribe en `pii_key_registry`: solo lo hace la API al arrancar.

## Rollback

| Estado | Cómo volver | Pérdida |
|---|---|---|
| V2 agregada, vigente 1 | Quitar V2 del secreto. La fila del registro queda inerte | Ninguna |
| Vigente 2, recifrado parcial o completo | Vigente 1 y rollout, con su caída. Comprobar en el pod. Luego `--commit --target-version=1` con V2 aún configurada, y `--verificar --target-version=1` | Ninguna |
| V1 retirada, aún en bóveda | Reponer `PII_ENC_KEY` desde bóveda, y el caso anterior | Ninguna |
| Imagen anterior al Feature con filas en V2 | **Prohibido sin antes recifrar a V1.** Primero el caso de arriba; después revertir la imagen | Datos invisibles sin aviso, si se omite |
| Restaurar `pg_dump` | Último recurso. Requiere A y los objetos anteriores de MinIO; sin `--limpiar-objetos` previo siguen ahí. Si una fila se recifró dos veces, solo sobrevive el objeto inmediatamente anterior | Lo escrito tras el dump |
| A destruida | **No hay vuelta atrás** | Todo lo cifrado solo con A |

Un rollback a V1 recifra igual que la rotación: si la fila ya tenía objeto anterior, ese objeto se reemplaza.

**Rotación por compromiso de A:** los dumps y los objetos anteriores siguen cifrados con A y quedan expuestos mientras A exista fuera de control. La decisión sobre esos respaldos, y acortar la ventana, se toma al inicio; no al final. Rotar tampoco cubre el texto en claro de LAFT.

## `PII_HMAC_KEY`: no se rota

**Decisión confirmada por David Chica el 2026-11-03 (ADR-0034 D7): `PII_HMAC_KEY` no se rota con este procedimiento, ni se rota sin recalcular los índices.** Este script no la toca.

| Uso | ¿Se puede recalcular? |
|---|---|
| `driver_profile.cedula_hash`: índice único parcial, búsqueda de conductores y olvido del art. 15 | Sí, desde la cédula descifrada |
| `laft_counterparties.doc_number_hash`: índice | Sí, desde el documento |
| `pii_access_log.motivo`, tokens `v1:` de VIN y placa | **No.** La tabla es append-only por trigger (0059), con retención de 6 años |

**Motivo:** cambiarla sin más deja de encontrar cédulas y documentos existentes, y rotarla bien exige un cambio de código con su propio ADR (ADR-0012 §4), búsqueda con dos llaves y el recálculo de dos índices. Además obliga a conservar la llave vieja seis años, o a perder la correlación histórica del registro del art. 17. Y comprometerla **no expone datos cifrados**: un HMAC no descifra nada.

### Contingencia si `PII_HMAC_KEY` se compromete

El riesgo es que quien tenga la llave y una copia de la BD compruebe por fuerza bruta qué cédula, documento, VIN o placa corresponde a un hash: el espacio de valores es pequeño. No expone los datos cifrados.

1. Tratarlo como incidente de seguridad, y valorar con el oficial de datos personales si exige reporte (Ley 1581).
2. Revisar quién tuvo acceso a la llave y a las copias de la BD.
3. Abrir el trabajo como cambio de código: ADR nuevo que extienda ADR-0012 §4 con versión de la llave, búsqueda con ambas durante la transición y un script que recalcule `cedula_hash` y `doc_number_hash`.
4. **Nunca** sustituir la variable sola: la búsqueda de conductores y el olvido dejan de encontrar, y el índice único deja de impedir duplicados.
5. Conservar la llave vieja en bóveda mientras dure la retención de `pii_access_log`: sin ella se pierde la correlación de esos tokens, que no se pueden recalcular.

## Auditoría PII del Job

`logPiiAccess` exige un `Request` y el Job no lo tiene. Hoy el script **no** escribe en `pii_access_log`: no expone datos a ninguna persona, y su rastro es la salida del Job y este procedimiento. **Pendiente de decisión de `security-agent`** (ADR-0034, riesgo abierto 2). Guardar la salida de cada corrida en el registro del cambio.
