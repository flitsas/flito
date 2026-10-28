// HU #14134 — diccionario de copy de la carga masiva por tipo de plantilla
// (docs/ux/flito-soat-carga-masiva-renovaciones.md, «Copy por tipo de plantilla»).
//
// El texto se elige por `tipo` (el de la vista) y por `codigo` del error; NUNCA se muestra el `mensaje`
// crudo del API para errores de la petición. Los `motivo.mensaje` de las FILAS sí vienen redactados.
import { ApiError } from '../../../../lib/api';
import type { TipoMasivo } from './tiposMasivo';

export interface CopyMasivo {
  tituloSeccion: string;
  etiquetaCaja: string;
  hintCaja: string;
  botonCargar: string;
  paso1: string;
  /** Línea de ayuda bajo el paso 1 (vacía si no hay). */
  notaPaso1: string;
  paso2: string;
  toastRecibido: string;
  columnaClave: string;
  archivoVacio: string;
  plantillaEquivocada: string;
  noEncontrada: string;
  nombrePlantilla: string;
  nombreRechazadas: string;
}

export const COPY_MASIVO: Record<TipoMasivo, CopyMasivo> = {
  renovacion: {
    tituloSeccion: 'Renovaciones en masa',
    etiquetaCaja: 'Elegir archivo de renovaciones',
    hintCaja: 'Excel .xlsx · hasta 200 filas',
    botonCargar: 'Cargar renovaciones',
    paso1: 'Descargue la plantilla y llene una fila por vehículo.',
    notaPaso1: '',
    paso2: 'Suba el archivo con las renovaciones.',
    toastRecibido: 'Archivo recibido. Estamos procesando las renovaciones.',
    columnaClave: 'Placa',
    archivoVacio: 'El archivo no tiene renovaciones. Llene al menos una fila de la plantilla.',
    plantillaEquivocada: 'Este archivo es de la plantilla Inicial. Elija Inicial o descargue la plantilla de Renovación.',
    noEncontrada: 'No encontramos esta carga. Cargue el archivo de nuevo si no ve sus renovaciones en la lista.',
    nombrePlantilla: 'plantilla-renovaciones.xlsx',
    nombreRechazadas: 'rechazadas-soat-renovacion.xlsx',
  },
  // HU #14137: la plantilla Inicial lleva solo el VIN; la factura se carga después, en Por validar.
  inicial: {
    tituloSeccion: 'SOAT inicial en masa',
    etiquetaCaja: 'Elegir archivo de vehículos',
    hintCaja: 'Excel .xlsx · hasta 200 filas',
    botonCargar: 'Cargar vehículos',
    paso1: 'Descargue la plantilla y escriba el VIN de cada vehículo, una fila por vehículo.',
    notaPaso1: 'La factura de venta se carga después, en Por validar.',
    paso2: 'Suba el archivo con los vehículos.',
    toastRecibido: 'Archivo recibido. Estamos procesando los vehículos.',
    columnaClave: 'VIN',
    archivoVacio: 'El archivo no tiene vehículos. Llene al menos una fila de la plantilla.',
    plantillaEquivocada: 'Este archivo es de la plantilla de Renovación. Elija Renovación o descargue la plantilla Inicial.',
    noEncontrada: 'No encontramos esta carga. Cargue el archivo de nuevo si no ve sus solicitudes en la lista.',
    nombrePlantilla: 'plantilla-inicial.xlsx',
    nombreRechazadas: 'rechazadas-soat-inicial.xlsx',
  },
};

/** Textos que no cambian con el tipo. */
export const COPY_COMUN = {
  soloXlsx: 'El archivo debe ser un Excel .xlsx. Descargue la plantilla y úsela.',
  elijaArchivo: 'Elija un archivo para continuar.',
  elijaCompania: 'Elija la compañía para continuar.',
  recibiendo: 'Recibiendo el archivo…',
  falloAvance: 'No pudimos actualizar el avance. El proceso continúa en FLITO.',
  falloDescarga: 'No pudimos descargar el archivo. Intente de nuevo.',
  rechazadasEnProceso: 'La carga aún se está procesando. Descargue las rechazadas cuando termine.',
  rechazadasVencidas: 'El archivo de rechazadas ya no está disponible. Los motivos siguen en la tabla.',
  rechazadasNoDisponibles: 'El archivo de rechazadas ya no está disponible. Los motivos están en la tabla.',
} as const;

export interface ErrorSubida { texto: string; accion: 'elegir' | 'plantilla' | 'reintentar' }

const GENERICO: ErrorSubida = {
  texto: 'No pudimos cargar el archivo. Revise su conexión e intente de nuevo.', accion: 'reintentar',
};

/** Lee el `codigo` del cuerpo de error del API (`ApiError.rawDetails`). */
export function codigoDe(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const c = (e.rawDetails as { codigo?: unknown } | null | undefined)?.codigo;
  return typeof c === 'string' ? c : null;
}

/** Traduce el error del POST al copy de la vista. Nunca devuelve el mensaje del API. */
export function errorDeSubida(e: unknown, tipo: TipoMasivo): ErrorSubida {
  const copy = COPY_MASIVO[tipo];
  switch (codigoDe(e)) {
    case 'archivo_requerido':
    case 'formato_invalido':
      return { texto: COPY_COMUN.soloXlsx, accion: 'elegir' };
    case 'encabezados_invalidos':
    case 'tipo_invalido':
      return { texto: 'El archivo no tiene el formato de la plantilla. Descárguela de nuevo y vuelva a llenarla.', accion: 'plantilla' };
    case 'archivo_vacio':
      return { texto: copy.archivoVacio, accion: 'elegir' };
    case 'plantilla_equivocada':
      return { texto: copy.plantillaEquivocada, accion: 'plantilla' };
    case 'demasiadas_filas':
      return { texto: 'El archivo tiene más de 200 filas. Divídalo en archivos de hasta 200 y cárguelos uno a uno.', accion: 'elegir' };
    case 'archivo_muy_grande':
      return { texto: 'El archivo pesa demasiado. Divídalo en archivos más pequeños y cárguelos uno a uno.', accion: 'elegir' };
    case 'lote_activo':
      return { texto: 'Su compañía ya tiene una carga en curso. Espere a que termine para subir otro archivo.', accion: 'elegir' };
    case 'carga_masiva_no_disponible':
      return { texto: 'La carga masiva no está disponible por ahora. Intente de nuevo más tarde.', accion: 'reintentar' };
    default:
      return GENERICO;
  }
}
