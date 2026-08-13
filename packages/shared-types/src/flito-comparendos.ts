// FLITO — Monitoreo de comparendos: catálogos de parametrización (Feature #11492 17a, HU #11497)
// y metadatos del token SIMIT (HU #11498).
//
// El resto de contratos del módulo —registros consolidados, corridas de sync y eventos del
// timeline— los añade la HU #11502 cuando exista lo que describen. Publicar hoy un tipo de algo que
// todavía no devuelve ningún endpoint invita a que la pantalla se escriba contra una forma que aún
// puede cambiar.
//
// Las fechas viajan como cadena ISO-8601 y no como `Date`: este paquete lo comparten el servidor y
// el navegador, y `JSON.parse` nunca devuelve un `Date`. Tiparlo como `Date` sería mentirle al
// compilador justo del lado que más lo necesita.

/**
 * NIT monitoreado (CF-01).
 *
 * `nit` es la llave con la que se le pregunta a los proveedores, así que se guarda ya normalizado
 * —sin puntos ni espacios— y no se edita: se desactiva. `alias` es solo para reconocerlo en pantalla
 * cuando el número no le dice nada a nadie.
 */
export interface ComparendosNit {
  id: string;
  nit: string;
  alias: string | null;
  activo: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Municipio fuente (CF-02).
 *
 * `codigoFuente` es el valor literal que viaja en `?fuente=` a UTS (mayúsculas sin tildes) y
 * `nombre` es lo que se le enseña a un humano. Son dos columnas y no una porque el proveedor espera
 * `ITAGUI`: corregir la ortografía a «Itagüí» sobre un único campo rompería la integración.
 */
export interface ComparendosMunicipio {
  id: string;
  codigoFuente: string;
  nombre: string;
  activo: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Causal de gestión (CF-04). El catálogo es de 17a; quien la asigna a un comparendo es 17b.
 *
 * `orden` existe para que la lista se presente en la secuencia natural de la gestión y no
 * alfabéticamente, que es lo que pasaría dejándolo al nombre.
 */
export interface ComparendosCausal {
  id: string;
  nombre: string;
  activo: boolean;
  orden: number;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Token SIMIT: lo ÚNICO que el API cuenta sobre él (CF-03, ADR-0002).
 *
 * Aquí no hay ni habrá un campo con el token, ni enmascarado ni con un prefijo: un fragmento sigue
 * siendo material de la credencial. El `PUT` lo recibe una vez, lo cifra y responde con esta misma
 * forma; el `GET` responde esto y nada más. Lo que la pantalla necesita saber es si está
 * configurado, quién lo tocó por última vez y cuándo — no cuál es.
 *
 * `actualizadoPor` es `null` cuando no hay token todavía y también cuando la fila no tiene autor
 * conocido (un token sembrado por operación, sin `updated_by`): la pantalla debe saber pintar «—»
 * sin dar por hecho que siempre hay un nombre. `keyVersion` viaja para que, cuando se rote
 * `COMPARENDOS_ENC_KEY`, se vea desde la propia pantalla si el token guardado ya está bajo la nueva.
 */
export interface ComparendosTokenSimitMeta {
  configurado: boolean;
  actualizadoEn: string | null;
  actualizadoPor: { id: number; nombre: string } | null;
  keyVersion: number | null;
}
