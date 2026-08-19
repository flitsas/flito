// Datos fiscales del cliente para poder existir como tercero en Siigo (HU #11292, Feature #11241).
//
// Siigo no acepta el modelo de cliente que FLITO tiene hoy: pide el tipo de persona, el tipo de
// identificación como CÓDIGO numérico suyo, las responsabilidades fiscales y los códigos de país,
// departamento y ciudad. Sin eso rechaza la creación del tercero, y sin tercero no hay factura.
//
// Todo lo de aquí es catálogo cerrado publicado por Siigo: vive en código, no en base de datos,
// porque no cambia por ambiente ni lo administra nadie desde una pantalla.
// Fuente: `docs/integraciones/siigo-api.md` §2 (Terceros).

/** `person_type` de Siigo. Decide, entre otras cosas, la forma del arreglo `name`. */
export const PERSONA_TIPOS = ['Person', 'Company'] as const;
export type PersonaTipo = (typeof PERSONA_TIPOS)[number];

export const PERSONA_TIPO_ETIQUETA: Record<PersonaTipo, string> = {
  Person: 'Persona natural',
  Company: 'Persona jurídica',
};

/**
 * `id_type` de Siigo. La clave es el código que viaja en el payload, no nuestro `document_type`.
 *
 * Colombia. `R-00-PN` está en la tabla de Siigo pese a no ser numérico, así que el tipo es cadena.
 */
export const SIIGO_ID_TIPOS = {
  '11': 'Registro civil',
  '12': 'Tarjeta de identidad',
  '13': 'Cédula de ciudadanía',
  '21': 'Tarjeta de extranjería',
  '22': 'Cédula de extranjería',
  '31': 'NIT',
  '41': 'Pasaporte',
  '42': 'Documento de identificación extranjero',
  '43': 'Sin identificación del exterior / uso DIAN',
  '47': 'Permiso especial de permanencia (PEP)',
  '48': 'Permiso por protección temporal (PPT)',
  '50': 'NIT de otro país',
  '89': 'Salvoconducto de permanencia',
  '91': 'NUIP',
  'R-00-PN': 'No obligado a registrarse en el RUT',
} as const;

export type SiigoIdTipo = keyof typeof SIIGO_ID_TIPOS;
export const SIIGO_ID_TIPOS_CODIGOS = Object.keys(SIIGO_ID_TIPOS) as SiigoIdTipo[];

/**
 * Equivalencia entre el `document_type` que FLITO ya usa y el `id_type` de Siigo.
 *
 * **Deliberadamente corta.** `clients.document_type` es un `varchar(5)` sin enumeración ni
 * validación cerrada: puede contener cualquier cosa que alguien haya escrito alguna vez. Aquí solo
 * están las cuatro equivalencias que el negocio confirmó. Un valor que no esté en este mapa NO se
 * adivina —«PA» podría ser pasaporte o un typo de «PAP»—: deja el tipo vacío y el cliente marcado
 * como no facturable, que es un problema visible y arreglable por una persona, en vez de una
 * factura emitida contra un tipo de documento equivocado, que es un problema fiscal.
 */
export const DOCUMENT_TYPE_A_SIIGO: Record<string, SiigoIdTipo> = {
  NIT: '31',
  CC: '13',
  CE: '22',
  TI: '12',
};

/** Qué tipo de persona implica cada `document_type` conocido. Misma regla de «no adivinar». */
export const DOCUMENT_TYPE_A_PERSONA_TIPO: Record<string, PersonaTipo> = {
  NIT: 'Company',
  CC: 'Person',
  CE: 'Person',
  TI: 'Person',
};

/**
 * Tipos de identificación cuya naturaleza NO admite duda.
 *
 * Sirve para detectar combinaciones imposibles —un NIT declarado como persona natural— sin inventar
 * reglas donde no las hay: `42` (documento extranjero), `43` (sin identificación del exterior) y
 * `R-00-PN` quedan fuera a propósito porque pueden ser de cualquiera de los dos.
 */
export const SIIGO_ID_TIPO_PERSONA_IMPLICITA: Partial<Record<SiigoIdTipo, PersonaTipo>> = {
  '31': 'Company',
  '50': 'Company',
  '11': 'Person',
  '12': 'Person',
  '13': 'Person',
  '21': 'Person',
  '22': 'Person',
  '41': 'Person',
  '47': 'Person',
  '48': 'Person',
  '89': 'Person',
  '91': 'Person',
};

/** `fiscal_responsibilities[].code`. Catálogo cerrado de Siigo. */
export const RESPONSABILIDADES_FISCALES = {
  'R-99-PN': 'No aplica – Otros',
  'O-13': 'Gran contribuyente',
  'O-15': 'Autorretenedor',
  'O-23': 'Agente de retención IVA',
  'O-47': 'Régimen simple de tributación',
} as const;

export type ResponsabilidadFiscal = keyof typeof RESPONSABILIDADES_FISCALES;
export const RESPONSABILIDADES_FISCALES_CODIGOS =
  Object.keys(RESPONSABILIDADES_FISCALES) as ResponsabilidadFiscal[];

/** Sucursal de Siigo: entero 0–999. Junto con la identificación forma la clave real del tercero. */
export const SUCURSAL_MINIMA = 0;
export const SUCURSAL_MAXIMA = 999;

/**
 * De dónde salió el `person_type` de una fila. Existe para poder auditar la derivación masiva de la
 * migración: sin esto, dentro de seis meses nadie puede distinguir un tipo que una persona
 * confirmó de uno que dedujo un `UPDATE` a partir del `document_type`.
 */
export const PERSONA_TIPO_ORIGENES = ['derivado', 'manual', 'sin_derivar'] as const;
export type PersonaTipoOrigen = (typeof PERSONA_TIPO_ORIGENES)[number];

/**
 * Motivos por los que un cliente no puede facturarse todavía, detectados al migrar.
 *
 * Es una lista de lo que la migración **encontró**, no el veredicto completo de facturabilidad: el
 * informe cliente por cliente es de otra historia y mira además la dirección, el contacto y los
 * códigos de ciudad. Estos tres son los que solo se pueden ver en el momento de migrar.
 */
export const BLOQUEOS_FISCALES = {
  tipo_persona_sin_derivar:
    'El tipo de documento no permite deducir si es persona natural o jurídica.',
  id_tipo_sin_equivalencia:
    'El tipo de documento no tiene equivalencia con ningún tipo de identificación de Siigo.',
  identificacion_duplicada:
    'Otro cliente tiene la misma identificación en la misma sucursal: en Siigo serían el mismo tercero.',
} as const;

export type BloqueoFiscal = keyof typeof BLOQUEOS_FISCALES;
export const BLOQUEOS_FISCALES_CODIGOS = Object.keys(BLOQUEOS_FISCALES) as BloqueoFiscal[];

/**
 * Columnas de `clients` que contienen datos personales y por tanto DEBEN anonimizarse cuando un
 * titular ejerce el derecho al olvido (Ley 1581).
 *
 * Vive aquí, y no como una lista suelta dentro de `privacy.routes.ts`, para que la prueba de
 * regresión pueda contrastarla contra el esquema real: así, añadir una columna de PII a `clients`
 * sin meterla en el borrado hace fallar un test en vez de pasar desapercibido.
 */
export const CLIENTS_COLUMNAS_PII = [
  'name', 'email', 'phone', 'address', 'document', 'notes',
  'commercialName', 'contactFirstName', 'contactLastName', 'contactEmail',
  'phoneIndicative', 'phoneNumber',
] as const;

/**
 * Columnas de `clients` que NO son datos personales y por tanto sobreviven al borrado.
 *
 * Es una lista explícita a propósito: junto con la anterior debe cubrir la tabla entera, de modo
 * que una columna nueva no pueda quedar clasificada por omisión. Los códigos fiscales están aquí
 * porque no identifican a nadie por sí solos y borrarlos rompería la trazabilidad contable de las
 * facturas ya emitidas.
 */
export const CLIENTS_COLUMNAS_SIN_PII = [
  'id', 'documentType', 'city', 'active', 'createdAt',
  'cityTextoOrigen', 'cityConfirmadaPor', 'cityConfirmadaEn',
  'soatAutogestionable', 'impuestosAutogestionable', 'logisticaAutogestionable',
  'logisticaPermiteParcial', 'flitoCarpetaStorage', 'flitoToleranciaValorImpuesto',
  'flitoProveedorSoatId',
  'personType', 'idType', 'checkDigit', 'fiscalResponsibilities',
  'countryCode', 'stateCode', 'cityCode', 'branchOffice',
  'personTypeOrigen', 'facturacionBloqueos',
] as const;
