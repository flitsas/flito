# Retención de la cédula en las actas de logística (traslados)

HU #14113 · Feature #14091 · Épica #13758 · módulo `flito-logistica` (FLITO).
ADR-0030 C8b / Q6 / N6. Regla `RN-RET1` en la cabecera de
`apps/api/src/modules/flito-logistica/flito-logistica-retencion.cron.ts`.

## Base legal

Ley 1581 de 2012 (Habeas Data), art. 4 lit. d (finalidad) y art. 11 (supresión); Decreto 1377
de 2013, art. 11: los datos personales se conservan solo el tiempo necesario para la finalidad que
justificó su tratamiento.

La cédula del firmante (receptor, contacto de entrega u organismo de tránsito) se trata para
identificar a quien firma el acta de traslado o de recogida. Cumplidos **10 años** desde la
entrega (`firmado_en`), esa finalidad de identificación ya no justifica conservar el dato. El
nombre y la imagen de la firma sí se conservan: son la constancia de que el acta se firmó.

## Política

| Qué | Regla |
|---|---|
| Plazo | **10 años** desde la entrega: `firmado_en <= ahora − 10 años`, frontera inclusiva (exactamente 10 años sí se purga) |
| Tablas | `flito_logistica_acta_firmas` (receptor y contacto de entrega) y `flito_logistica_recogida_firmantes` (organismo de tránsito). Ambas tienen cédula |
| Se borra | `documento_cifrado` y `documento_ultimos` → NULL. Solo la cédula |
| Se conserva | La fila, `nombre` y `firma_storage_key`. El PDF del acta pinta «—» cuando la cédula ya no está (C1.5) |
| Nunca se toca | Firmas con menos de 10 años; filas cuya cédula ya está en NULL |
| Traza | Logs de la corrida con conteos, host y cutoff. Sin cédula, sin nombre, sin id de persona |
| Consulta | El PDF y las lecturas del acta ya tratan `documento_cifrado` NULL como cédula ausente |

## Garantías de la ejecución

- **Idempotencia**: el UPDATE filtra `documento_cifrado IS NOT NULL OR documento_ultimos IS NOT NULL`.
  Una fila ya purgada no vuelve a cambiarse. La segunda corrida reporta 0 filas.
- **Un solo servidor**: candado `flito-logistica-retencion` (`withLock`).
- **Encendido**: `LOGISTICA_RETENCION_CRON_ENABLED=1`. Sin él la purga no arranca y lo dice en el log.
- **Horario**: una vez al día, 03:00–03:59 de Colombia (`America/Bogota`), en lotes acotados.
- **Logs**: solo conteos, host y cutoff. Nunca cédula ni nombre.
