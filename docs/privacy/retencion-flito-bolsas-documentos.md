# Retención — expediente documental de la compañía (bolsas de documentos)

HU #13891 · HU #13964 (retiro) · Feature #13888 · ADR-0028 §9, §14 y adenda HU #13964 · módulo `apps/api/src/modules/flito-bolsas-documentos/`

## Qué datos

`flito_bolsas_documentos`: una fila por **versión** de cada documento de vinculación de la compañía
(Cámara de Comercio, RUT, cédula del representante legal, certificación bancaria, adicionales). El
archivo vive cifrado (AES-256-GCM) en MinIO bajo `storage_key`. La cédula del representante y los
soportes de la compañía son datos personales o cuasi-personales (Ley 1581 de 2012).

## Política

| Versión | Plazo | Qué se borra | Qué se conserva |
|---|---|---|---|
| **Vigente** | Mientras sea la vigente | Nada | Todo |
| **Reemplazada** | **5 años** desde `reemplazado_en` (frontera inclusiva) | El objeto en MinIO y `storage_key` (queda `NULL`); se marca `purgado_en` | La fila como constancia: tipo, versión, fechas, OCR y quién cargó |
| **Retirada** (HU #13964) | **5 años** desde `retirado_en` (= `reemplazado_en`, mismo instante; frontera inclusiva) | Lo mismo que en una reemplazada (objeto, `storage_key`, `purgado_en`) **y además `motivo_retiro`** (queda `NULL`) | La fila como constancia, con `retirado_en` y `retirado_por` |

**Motivo del retiro.** `motivo_retiro` es texto libre opcional (≤ 300 caracteres) y puede traer datos
personales (p. ej. un nombre). No va a la Bitácora ni a los logs: solo vive en la fila y se muestra en el
historial. La purga lo anula junto con el archivo, para que no quede para siempre en la constancia.

## Base legal

- Ley 1581 de 2012, art. 4 lit. b (finalidad) y Decreto 1377 de 2013, art. 11: los datos se conservan
  solo el tiempo necesario para la finalidad. La finalidad de una versión reemplazada ya no es operar la
  bolsa (para eso está la vigente) sino la **trazabilidad de la debida diligencia** de vinculación frente a
  reclamos, auditorías o controversias contractuales.
- 5 años cubre ese horizonte. No aplican los 10 años del Código de Comercio art. 60 / Ley 962 de 2005
  art. 28: una versión sustituida no es soporte contable.
- **Pendiente de confirmar por legal/security:** si FLIT es sujeto obligado de SAGRILAFT/SARLAFT con otro
  plazo de conservación de soportes de conocimiento de la contraparte, N se ajusta a ese plazo.

## Dónde vive N

Un solo lugar: `BOLSAS_DOCUMENTOS_RETENCION_ANIOS` en `apps/api/src/config/env.ts` (entero 1–20,
**5 por defecto**), expuesto como `ANIOS_RETENCION_VERSIONES` en
`flito-bolsas-documentos-purga.service.ts`. No vive en la base.

## Mecánica

- Cron diario 03:00–03:59 `America/Bogota` (`flito-bolsas-documentos-purga.cron.ts`), con candado
  distribuido `flito-bolsas-docs-purga` (30 min) y lote de 200 versiones por corrida.
- **Puerta positiva:** sin `BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED=1` no arranca (y lo dice en el log).
- Elegibles: `NOT vigente AND purgado_en IS NULL AND storage_key IS NOT NULL AND reemplazado_en <= ahora − N`.
  Una retirada entra por la misma regla: el retiro escribe `reemplazado_en = retirado_en`.
- Por compañía, en una transacción: `storage_key = NULL` + `purgado_en = now()` + `motivo_retiro = NULL`, encolado del objeto en
  `flito_storage_borrados_pendientes` (origen `bolsas-documentos`) y una entrada de Bitácora
  `bolsas.documentos.versiones_purgadas` (id opaco de la compañía, cantidad y bytes; fecha del registro).
- Después se intenta borrar el objeto una vez. Si el almacenamiento falla, el pendiente queda abierto y
  lo reintenta el barrido horario de borrados pendientes, que no filtra por origen.
  **Ese barrido exige `SOAT_BORRADOS_PENDIENTES_CRON_ENABLED=1`**: sin él, los objetos cuyo primer
  intento falló siguen en la cola hasta que se encienda.

## Auditoría y logs

- Bitácora (`audit_logs`): una entrada por compañía y corrida, sin NIT, nombres, claves ni nombres de
  archivo.
- Logs: conteos por corrida; ante un fallo de storage, el uuid de la versión, la huella de la clave
  (`claveHash`, sha256 truncado) y el código del error. Nunca la clave ni el mensaje del error.
