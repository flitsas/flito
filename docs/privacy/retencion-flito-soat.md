# Retención de documentos del SOAT sin trámite (solicitudes descartadas)

HU #13409 · Feature #13408 · Épica #13201 · módulo `flito-soat` (FLITO, no el legacy `soat`).
Regla `RN-RET1` en la cabecera de `apps/api/src/modules/flito-soat/flito-soat-retencion.cron.ts`.

## Base legal

Ley 1581 de 2012 (Habeas Data), art. 4 lit. d (finalidad) y art. 11 (supresión); Decreto 1377
de 2013, art. 11: los datos personales se conservan solo el tiempo necesario para la finalidad que
justificó su tratamiento.

Una solicitud de SOAT por validar (`flito_soat_incompletas`) que se **descarta** no llega a ser un
SOAT. Su factura de venta y sus documentos adicionales —que contienen datos del comprador y del
vehículo— pierden la finalidad con el descarte.

## Política

| Qué | Regla |
|---|---|
| Plazo | **30 días** (30 × 24 h) desde el descarte: `resuelta_en <= ahora − 30 días`, frontera inclusiva |
| Se borra del almacenamiento | El objeto de la factura de venta (`factura_storage_key`) y los objetos de los documentos adicionales de la solicitud (`flito_soportes` con `soat_incompleta_id`, `soat_id` NULL, tipo `documento_adicional_soat`) |
| Se borra de la base | Las filas de esos documentos adicionales |
| Se conserva | La fila de la solicitud: estado `descartada`, motivo, cuándo y quién descartó. `factura_storage_key` queda como dato histórico (el objeto ya no existe). `archivos_purgados_en` registra cuándo se purgó |
| Nunca se toca | Solicitudes en estado `incompleta` o `completada`; documentos adicionales de un SOAT creado (`soat_id` no nulo) |
| Traza | Una entrada en la Bitácora (`audit_logs`, resource `soat.incompleta.archivos_purgados`, acción `delete`, usuario `sistema`) con el id de la solicitud, la cantidad de archivos y los bytes eliminados. Sin VIN, nombres, nombres de archivo ni claves del almacenamiento |
| Consulta | `GET /api/flito/soat/cliente/incompletas/:id` devuelve `archivosPurgadosEn` (ISO o `null`) |

## Garantías de la ejecución

- **Fallo del almacenamiento**: nada se da por borrado. El adicional cuyo objeto no se borró conserva
  su fila; `archivos_purgados_en` sigue NULL; la corrida siguiente reintenta solo lo que falta.
  «El objeto no existe» cuenta como borrado.
- **Idempotencia**: una solicitud ya purgada no vuelve a leerse ni a dejar Bitácora.
- **Un solo servidor**: candado `flito-soat-retencion` (`withLock`).
- **Encendido**: `SOAT_RETENCION_CRON_ENABLED=1`. Sin él la purga no arranca y lo dice en el log.
- **Horario**: una vez al día, 03:00–03:59 de Colombia (`America/Bogota`), en lotes acotados.
- **Logs**: solo conteos e ids opacos; una clave de almacenamiento solo como huella sha256 de 16 hex.
