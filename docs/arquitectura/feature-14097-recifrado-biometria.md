# Feature #14097 — Recifrado de biometría de trámites (runbook)

Lleva las fotos de `tramites_validaciones` guardadas en BD al formato común `encryptPiiText`
(`v1:<iv>:<tag>:<data>`, AAD `tabla|columna|id`). Módulo legacy `tramites`, no `flito-tramites`.

HUs: #14098 (helper y recifrado), #14099 (fallo visible al descifrar).

## Qué hace el script por clase

| Clase | Cómo se reconoce | Script | Lectura en la API |
|---|---|---|---|
| `vacio` | null o `''` | no toca | `null` |
| `storage_key` | empieza por `validaciones/` | no toca | `getPhoto` |
| `nuevo` | `^v\d+:[0-9a-f]{24}:[0-9a-f]{32}:` | salta | `decryptPiiText` |
| `viejo` | `^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:` | **descifra y cifra** | `decryptLegacyBiometric` (`@deprecated`) |
| `data_uri` | empieza por `data:image/` | **cifra** | tal cual + aviso + `pii_legacy_plaintext_total` |
| `base64_plano` | más de 100 caracteres y alfabeto base64 | **cifra** | tal cual + aviso + `pii_legacy_plaintext_total` |
| `desconocido` | el resto | **nunca toca** | tal cual + aviso + `pii_legacy_plaintext_total` |

Un valor `nuevo` o `viejo` que no descifra es **error, no legado**: 500 genérico y
`pii_decrypt_failures_total`.

## Rollback asimétrico: leer antes de ejecutar

Una imagen anterior a este Feature **no entiende `v1:…`**: su descifrado falla en silencio y devuelve
el cifrado crudo con 200. Por tanto:

- El Job solo corre con la promoción **ya estabilizada**: todos los pods de la api con la imagen nueva.
- Revertir la imagen en GitOps **después** de recifrar no basta: volver atrás exige además **restaurar
  el dump** de las filas afectadas.
- Antes de recifrar, el rollback de imagen es el normal: el formato viejo se sigue leyendo en ambas.

## Orden de ejecución

QA primero; PDN solo con QA terminado y verificado.

1. Comprobar que el rollout de la imagen con este Feature terminó en el ambiente.
2. **Solo PDN:** `pg_dump` previo de la tabla. **Ese dump contiene biometría:** se custodia con el mismo
   control de acceso que la BD, no se copia a equipos personales y se **borra de forma explícita** al
   cerrar la ventana de rollback, dejando constancia de quién y cuándo.

   ```bash
   pg_dump "$DATABASE_URL" -t tramites_validaciones -Fc -f tramites_validaciones-pre-14097.dump
   ```
3. Job con `--dry-run`. Revisar conteos. `viejo_indescifrable` mayor que 0 **con muchas filas** apunta
   a una llave equivocada: parar y no pasar al paso 4.
4. Job con `--commit`.
5. Job con `--commit` otra vez: `escrito` debe ser 0 en las tres columnas. Si la salida fue 2, revisar
   `idsFallidos` y `omitido_concurrente`; este último se resuelve solo al volver a correr.
6. Recorrer en la aplicación un trámite con fotos en BD (documentos y certificado) y comprobar que
   `pii_decrypt_failures_total` sigue en 0.

Códigos de salida: `0` sin pendientes o dry-run · `2` quedan pendientes (se puede volver a correr) ·
`1` abortó (sin bandera, o error). La salida solo lleva conteos por columna y clase, e ids de fallos.

## Job de una sola vez

Lo lanza infraestructura con `kubectl`. **Va fuera de la kustomization de Argo CD**: es una ejecución
puntual, no estado deseado. Debe usar la **misma imagen por digest** y el **mismo `envFrom`** que el
Deployment de la api, porque una llave distinta es justo lo que el dry-run tiene que poder detectar.

Sacar ambos valores del Deployment vivo, no copiarlos de otro ambiente:

```bash
kubectl -n flito-<env> get deploy <deployment-api> \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}{.spec.template.spec.containers[0].envFrom}{"\n"}'
```

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: recifrar-biometria-dry-run   # recifrar-biometria-commit en la corrida real
  namespace: flito-<env>
spec:
  backoffLimit: 0                    # sin reintento automático: una salida 2 la revisa una persona
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: recifrar
          image: <imagen de la api>@sha256:<digest del Deployment>
          command: ["node", "dist/scripts/flito-recifrar-biometria.js", "--dry-run"]   # o --commit
          envFrom: []                # copiar el del Deployment de la api
          resources:
            requests: { memory: 512Mi }
            limits: { memory: 1Gi }  # lotes de 50 filas, con hasta 3 fotos de varios MB cada una
```

En local: `npm run tramites:recifrar-biometria -w apps/api -- --dry-run`.

## Observabilidad

| Métrica | Significado | ¿Alerta? |
|---|---|---|
| `pii_decrypt_failures_total{table,column}` | formato cifrado que no descifra: llave equivocada o dato alterado | **Sí** |
| `pii_legacy_plaintext_total{table,column}` | lectura de un valor sin cifrar: esperada hasta terminar el recifrado | No |

Expresión de la alerta:

```promql
sum by (table,column) (increase(pii_decrypt_failures_total[5m])) > 0
```

La regla vive en otro repositorio. **Dependencia de infraestructura en `flit-gitops`:** `METRICS_TOKEN`
configurado en la api (sin él `/metrics` responde 404), job de scrape con ese token, la regla de arriba
y un destino de notificación. Hasta que eso exista, la métrica se publica pero nadie recibe el aviso.

## Brecha declarada

Decisión del humano en este Feature: **las capturas nuevas siguen sin cifrado de aplicación en MinIO**.
`uploadPhoto` y `getPhoto` no cambian; el valor `validaciones/…` es una clave y el objeto queda con la
protección que dé el bucket.

## Trabajo posterior

Tras el recifrado en PDN, un PR aparte retira `decryptLegacyBiometric` y la sal `kyverum-pii-salt`.
No antes: mientras exista una fila `viejo` esa lógica es la única forma de leerla.

## Inventario AC4 (#14098)

Columnas de `tramites_validaciones`: `foto_rostro`, `foto_cedula_frontal`, `foto_cedula_reverso`.

| Archivo | Uso de esas columnas | Estado |
|---|---|---|
| `apps/api/src/modules/tramites/identidad.routes.ts` | `GET /documentos`, `POST /certificado` leían con `decryptPII` | Migrado a `resolverFotoBiometrica`; `encryptPII` y `decryptPII` eliminados |
| `apps/api/src/modules/tramites/identidad.routes.ts` | Captura nueva: escribe la clave de `uploadPhoto` | Sin cambio (brecha declarada) |
| `apps/api/src/modules/tramites/identidad.fotos.ts` | Clasificador y lectura | Nuevo |
| `apps/api/src/scripts/backfill-fotos-s3.ts` | Tenía su propio clasificador y descifrado, y registraba un prefijo del valor | Usa los compartidos; salta `nuevo`; ya no registra el prefijo |
| `apps/api/src/scripts/flito-recifrar-biometria.ts` | Único escritor del formato nuevo | Nuevo |
| `apps/api/src/modules/privacy/privacy.routes.ts` | Olvido: pasa los valores a `deletePhoto` | Sin cambio: su filtro `/^[a-z]+\//` y sin `:` ya excluye `v1:…` |
| `apps/api/src/modules/privacy/retention.cron.ts` | Retención: borra objetos y anula columnas | Sin cambio: filtra por `validaciones/` |
| `apps/api/src/modules/tramites/validacion-recovery.ts` | Solo `foto_rostro IS NULL` en una condición | Sin cambio: no lee el contenido |
