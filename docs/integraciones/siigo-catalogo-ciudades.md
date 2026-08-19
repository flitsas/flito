# Catálogo de ubicaciones de Siigo — cómo se regenera

**HU #11293 (Feature #11241).** Procedimiento escrito porque el listado no se puede pedir a la API:
Siigo lo publica como un archivo Excel. Sin este documento, actualizarlo dependería de que alguien
recordara cómo se hizo la primera vez.

## Por qué este catálogo no se sincroniza como los otros seis

Los catálogos de la HU #11281 —comprobantes, vendedores, formas de pago, impuestos, grupos de
inventario y centros de costo— se traen llamando a la API de Siigo. **Las ubicaciones no existen
como servicio.** Por eso:

- viven en su propia tabla `siigo_ciudades` y no en `siigo_catalogos`;
- **no tienen ambiente**: el listado es el mismo en pruebas y en producción porque no depende de la
  cuenta, a diferencia de todo lo demás del módulo;
- su carga **no gasta cuota** de las 100 peticiones por minuto ni pasa por el cortacircuitos;
- decir «sincronizado» sobre ellas sería mentira, así que la columna se llama `cargado_en`.

## Cuándo hay que regenerarlo

Cuando Siigo publique una versión nueva del listado. No hay aviso automático: en la práctica se
revisa cuando una ciudad que existe no aparece en la lista, o de forma periódica junto con la
revisión de la integración.

## El procedimiento

1. **Descargar el listado oficial.** La URL está en `docs/integraciones/siigo-api.md` §2 y también
   en el propio archivo generado, en el campo `origen`:

   ```bash
   curl -sSL -o /tmp/Lista-de-ciudades.xlsx \
     https://saprodcentralassets.blob.core.windows.net/siigoapi/documentation/Lista-de-ciudades.xlsx
   ```

   Alternativa sin internet hacia Azure: en Siigo Nube, *Reportes → Cartera/Proveedores → Reportes
   de sistema → Países-Departamentos-Ciudades*.

2. **Comprobar si cambió.** El archivo generado guarda el `sha256` del `.xlsx` del que salió. Si
   coincide, no hay nada que hacer:

   ```bash
   sha256sum /tmp/Lista-de-ciudades.xlsx
   grep sha256Origen apps/api/src/db/data/siigo-ciudades.json
   ```

3. **Convertirlo.** El `.xlsx` es un zip de XML; el script no necesita dependencias externas:

   ```bash
   node apps/api/src/scripts/convertir-ciudades-siigo.mjs /tmp/Lista-de-ciudades.xlsx
   ```

   Escribe `apps/api/src/db/data/siigo-ciudades.json` con la cabecera (`version`, `origen`,
   `descargadoEn`, `sha256Origen`, `total`) y las ciudades ordenadas por país, departamento y
   ciudad. El orden es estable a propósito: así el diff de git muestra lo que cambió de verdad y no
   una reordenación completa.

4. **Revisar el diff.** Debe ser pequeño. Un diff que reemplaza el archivo entero significa que el
   orden o el formato cambiaron, no el contenido — revisar antes de commitear.

5. **Cargar en cada ambiente.** `POST /api/siigo/ciudades/cargar` con un usuario `admin`. La
   respuesta dice cuántas se insertaron, cuántas se actualizaron y **cuántas se inactivaron**.

## Qué mirar en el resultado

- **`inactivadas` distinto de cero merece una mirada.** Significa que ciudades que estaban dejaron
  de venir en el listado. No se borran —un cliente antiguo puede referenciarlas y borrarlas dejaría
  su ficha apuntando a la nada—, pero si el número es grande, lo más probable es que el archivo esté
  truncado y no que Siigo haya retirado media Colombia.
- **`total` tiene que cuadrar** con el `total` declarado en la cabecera. El servicio se niega a
  cargar si no cuadra: cargar medio catálogo es peor que no cargar nada, porque marcaría como
  inactivas ciudades que sí existen.

## Detalles del listado que sorprenden

- **El código de país viene como `Co`, no `CO`.** La tabla de ejemplo de `siigo-api.md` §2 lo
  escribe en mayúsculas; el archivo oficial no. Se guarda **tal como lo publica Siigo**, porque es
  lo que hay que enviarle de vuelta.
- **El código de ciudad se repite entre países.** `05001` es Medellín en Colombia y Chachapollas en
  Perú. Por eso la clave única es la terna (país, departamento, ciudad) y no el código de ciudad.
- Al momento de escribir esto el listado trae **4.605 ciudades de 200 y pico países**, de las cuales
  1.123 son colombianas.
