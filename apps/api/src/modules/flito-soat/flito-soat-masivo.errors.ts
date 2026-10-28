// HU #14131 (Feature #14013) — errores de dominio de la carga masiva de SOAT. Mensajes cortos y sin PII:
// nunca el texto crudo de exceljs/Postgres, ni un valor de celda.

export type CodigoErrorMasivo =
  | 'archivo_requerido' | 'formato_invalido' | 'encabezados_invalidos' | 'archivo_vacio'
  | 'archivo_muy_grande' | 'demasiadas_filas' | 'lote_activo' | 'tipo_invalido' | 'carga_masiva_no_disponible'
  | 'lote_en_proceso' | 'descarga_no_disponible';

export class ErrorLoteMasivo extends Error {
  constructor(
    readonly status: number,
    readonly codigo: CodigoErrorMasivo,
    message: string,
    /** Lo que la pantalla necesita además del código: nombres de columna o el id (opaco) del lote activo. Nunca datos de filas. */
    readonly datos?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ErrorLoteMasivo';
  }
}

export const falloMasivo = (status: number, codigo: CodigoErrorMasivo, mensaje: string, datos?: Record<string, unknown>) =>
  new ErrorLoteMasivo(status, codigo, mensaje, datos);
