# Retención de los intentos de radicación de Dr. Flit soporte

HU #13804 · Feature #13695 · módulo `flito-dr-flit` (FLITO). Reglas `RN-DRF1..4` en la cabecera de
`apps/api/src/modules/flito-dr-flit/dr-flit.cron.ts` y `dr-flit-purga.service.ts`. Diseño:
`docs/diseno/feature-13695-dr-flit-soporte.md` (D6) y ADR-0026.

## Base legal

Ley 1581 de 2012 (Habeas Data), art. 4 lit. d (finalidad) y art. 11 (supresión); Decreto 1377 de
2013, art. 11: los datos se conservan solo el tiempo necesario para la finalidad que justificó su
tratamiento. El envío a Azure DevOps exige la autorización de finalidad `soporte` vigente (HU #13803).

## Qué se guarda en FLITO (D6: solo metadatos)

Tabla `flito_drflit_casos_soporte` (migración 0246): usuario, autorización que amparó el envío, clave
de idempotencia (UUID del cliente), estado (`pendiente` / `creado` / `fallido`), número del caso en
FLIT - SOPORTE, ambiente, cantidad de adjuntos, reintentos, clase de error (`timeout`, `ado-auth`,
`tag-rechazado`…) y fechas.

**No se guarda** el texto del caso: ni título, detalle, resultado esperado, área, prioridad, frecuencia,
nombre, correo ni teléfono. Esos datos viajan una sola vez a Azure DevOps (destinatario registrado en
`registro-terceros-destinatarios.md`) y no quedan en la base, en los logs ni en la auditoría (que guarda
solo los **nombres** de los campos enviados, `pii_access_log` con `resource_tipo = drflit_caso_soporte`).

## Política

| Qué | Regla |
|---|---|
| Plazo | **12 meses** desde `creado_en`: se borran las filas con `creado_en < ahora − 12 meses` |
| Cómo | Cron diario a las 03:00 `America/Bogota`, con candado `flito-drflit-purga` (un solo servidor), en lotes de 1000 y como máximo 50 lotes por corrida |
| Encendido | Puerta positiva `DRFLIT_PURGA_CRON_ENABLED=1`. Sin ella el cron lo dice en el log y no borra nada |
| Nunca se toca | `flito_drflit_autorizaciones` (prueba del consentimiento; su retención es otra HU, P9-10) |
| Traza | Log con conteo, corte, día y host. Ningún identificador de persona |

## Adjuntos del caso (HU #13805)

**Contenido.** El usuario puede adjuntar hasta `DRFLIT_ADJUNTOS_MAX` archivos PNG, JPG o PDF. Son
capturas de pantalla o documentos y **pueden contener PII**: cédulas, placas, datos de terceros o
cualquier otra cosa visible en la pantalla o en el documento. Se tratan como datos personales.

**Dónde viven.** Solo en FLIT - SOPORTE (Azure DevOps), como adjuntos del Bug. Su vida es la del Bug y
los depura el equipo de soporte, con la misma política del caso (sección siguiente).

**Qué guarda FLITO.** Nada del archivo: ni el contenido, ni el nombre, ni la url de ADO. Viajan en
memoria en la misma petición (`memoryStorage`, sin disco ni MinIO), se suben con un nombre genérico
(`adjunto-<n>.<ext>`) y se sueltan al terminar. La tabla solo registra `adjuntos_cantidad`; los logs y
`pii_access_log` registran la cantidad y el nombre del campo `adjuntos`, nunca el nombre del archivo.

### Adjuntos huérfanos

**Cuándo se producen.** Los adjuntos se suben a ADO uno por uno **antes** de crear el Bug. Si una de las
subidas o el create del Bug fallan después de haber subido alguno, esos adjuntos quedan en ADO sin Bug
que los vincule. Cuando el usuario reintenta con la misma clave, se suben de nuevo, así que los del
intento fallido quedan huérfanos.

**Permanencia: indeterminada.** FLITO no puede borrarlos: Azure DevOps no expone un DELETE de attachments
y FLITO no guarda las urls (AC4 de la HU #13805: nada queda en FLITO). No hay fuente que establezca
que ADO los depure ni en qué plazo.

**Quién puede verlos.** Cualquiera con permiso de lectura sobre el proyecto FLIT - SOPORTE puede
descargarlos si conoce su GUID.

**Mitigación vigente.** El acceso está limitado a quienes leen FLIT - SOPORTE (equipo de soporte), y el
GUID no se publica en ningún lado: FLITO no lo guarda ni lo devuelve al usuario.

**Pendiente** (fuera de esta HU): acordar con soporte un procedimiento de depuración o retiro de los
adjuntos huérfanos en Azure DevOps.

## Lo que queda en Azure DevOps

El Bug radicado en FLIT - SOPORTE vive bajo la política de ese proyecto y la gestiona el equipo de
soporte. **Pendiente** (fuera de esta HU): acordar con soporte el plazo de retención de los casos y el
procedimiento de supresión a pedido del titular en Azure DevOps.
