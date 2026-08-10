// Por qué un cliente no se puede facturar todavía (HU #11296, Feature #11241).
//
// Los motivos viven aquí y no dentro del servicio porque la pantalla de la HU #11299 los pinta y
// la Feature de emisión los va a mostrar en su mensaje de bloqueo. Un catálogo duplicado en tres
// sitios se desincroniza el día que alguien añada un campo obligatorio.
//
// **Nombrar el dato exacto que falta es el punto entero de la HU** (AC1): «datos incompletos» no le
// dice a nadie qué corregir, y termina en alguien intentando emitir para ver qué pasa.

/** Cada dato que Siigo exige para poder crear el tercero. Uno por motivo, sin agrupar. */
export const MOTIVOS_NO_FACTURABLE = {
  tipo_persona_sin_clasificar:
    'Falta clasificar si es empresa o persona natural.',
  id_tipo_faltante:
    'Falta el tipo de identificación de Siigo.',
  identificacion_faltante:
    'Falta el número de identificación.',
  identificacion_duplicada:
    'Otro cliente tiene la misma identificación en la misma sucursal: en Siigo serían el mismo tercero.',
  nombre_no_utilizable:
    'El nombre no se puede enviar a Siigo tal como está.',
  nombre_particion_sin_confirmar:
    'Falta confirmar dónde terminan los nombres y empiezan los apellidos.',
  responsabilidad_fiscal_faltante:
    'Falta la responsabilidad fiscal ante la DIAN.',
  direccion_faltante:
    'Falta la dirección.',
  ubicacion_faltante:
    'Falta el país, el departamento o la ciudad en códigos de Siigo.',
  telefono_faltante:
    'Falta el teléfono separado en indicativo y número.',
  contacto_faltante:
    'Falta el nombre de la persona de contacto.',
} as const;

export type MotivoNoFacturable = keyof typeof MOTIVOS_NO_FACTURABLE;
export const MOTIVOS_NO_FACTURABLE_CODIGOS =
  Object.keys(MOTIVOS_NO_FACTURABLE) as MotivoNoFacturable[];

/**
 * Los motivos que significan «nadie ha decidido todavía qué es este cliente», frente a los que
 * significan «falta capturar un dato».
 *
 * El AC3 pide separarlos porque se resuelven de forma distinta: los primeros necesitan que alguien
 * mire el cliente y decida; los segundos, que alguien teclee. Mezclarlos en una sola lista de 400
 * pendientes hace que nadie empiece por ninguno.
 */
export const MOTIVOS_PENDIENTE_CLASIFICACION: MotivoNoFacturable[] = [
  'tipo_persona_sin_clasificar',
  'identificacion_duplicada',
  'nombre_particion_sin_confirmar',
];

export interface FaltanteCliente {
  motivo: MotivoNoFacturable;
  detalle: string;
  /** Campo concreto al que apunta, cuando existe uno. Para que la pantalla lleve al sitio. */
  campo?: string;
}

export interface VeredictoCliente {
  clienteId: number;
  /** Enmascarado o no según quién pregunte; el servicio decide. */
  nombre: string;
  documento: string | null;
  facturable: boolean;
  /** true si lo que falta es una decisión humana, no un dato (AC3). */
  pendienteClasificacion: boolean;
  faltantes: FaltanteCliente[];
}

export interface ResumenValidacionClientes {
  total: number;
  facturables: number;
  noFacturables: number;
  pendientesClasificacion: number;
  /** Cuántos clientes arrastra cada motivo. Ordena el trabajo: por dónde empezar. */
  porMotivo: { motivo: MotivoNoFacturable; detalle: string; clientes: number }[];
}
