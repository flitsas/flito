// Siigo — qué correcciones admite una factura (HU #11343, AC1).
//
// **Función pura, en archivo propio y sin un solo import de `db`.** La pureza aquí no es una
// preferencia de estilo: esta decisión se toma en tres sitios —la pantalla, el registro de la
// corrección y el mensaje de `reversar`— y si se pudiera responder distinto en cada uno, el sistema
// diría dos cosas a la vez sobre un documento ante la DIAN. Que el archivo no pueda tocar la base ni
// la red lo garantiza estructuralmente, no por convención.
//
// ============================================================================
// SOBRE QUÉ SE APOYA CADA DECISIÓN, Y QUÉ SE NIEGA A SUPONER
// ============================================================================
//
// Solo hay DOS hechos documentados, y los dos salen de `docs/integraciones/siigo-api.md` §3:
//
//   1. Siigo expone `DELETE /v1/invoices/{id}` = **borrar** y `POST /v1/invoices/{id}/annul` =
//      **anular**. Son operaciones DISTINTAS; una versión anterior del diseño las citaba como si
//      fueran la misma y era un error.
//   2. **Ninguna de las dos aplica** a una factura que esté en proceso de envío a la DIAN o ya
//      aceptada (que tenga CUFE).
//
// Todo lo demás es incógnita. En particular: **no se sabe** si corregir una factura aceptada es una
// nota crédito — ese grupo de la API nunca se ha leído (pregunta 8, §6 del diseño). Por eso, para
// una factura con CUFE, esta función NO nombra la operación: dice que la vía es registrar lo que se
// haya hecho por fuera, y deja el «qué» en manos de quien lo hizo. Es menos vistoso y es lo único
// honesto que se puede afirmar hoy.
//
// **La ventana de tiempo es un parámetro, no una constante.** La pregunta 8 dice que «la anulación
// aplica en ventanas y estados DIAN que la nota crédito no cubre», pero nadie ha establecido cuál es
// esa ventana. Escribir aquí «5 días» sería inventarse una norma. Así que entra como parámetro con
// valor `null` = *no establecida*, y con `null` la evaluación no excluye por tiempo — lo dice en el
// motivo, en vez de callárselo. El día que se establezca, es un número, no un despliegue de lógica.

import {
  SIIGO_CORRECCION_TIPOS,
  type SiigoCorreccionOpcion,
  type SiigoCorreccionTipo,
  type SiigoEvaluacionCorreccion,
  type SiigoFacturaEstado,
} from '@operaciones/shared-types';

/**
 * Los hechos observables de una factura, y nada más.
 *
 * **No recibe un «estado ante la DIAN».** Ese eje lo aporta la HU #11330 (Feature #11243) y todavía
 * no existe; inventarle aquí un enum obligaría a migrarlo cuando llegue el de verdad. Lo que se pide
 * son hechos —¿hay identificador?, ¿hay CUFE?— que la HU #11330 sabrá rellenar sin que esta función
 * cambie.
 */
export interface SituacionFactura {
  /** Estado de la fila en FLITO: `en_proceso` | `emitida` | `fallida` (Feature #11242). */
  estado: SiigoFacturaEstado;
  /** Identificador que devolvió Siigo. Sin él no hay documento que corregir. */
  siigoInvoiceId: string | null;
  /** CUFE. Que exista es el hecho que la documentación de Siigo usa como frontera. */
  cufe: string | null;
  /**
   * ¿Está en proceso de envío a la DIAN? La documentación excluye ese caso igual que el aceptado.
   * Hoy nadie lo sabe rellenar y por eso vale `false`; la HU #11330 lo sabrá.
   */
  enTransitoAnteDian?: boolean;
  /** Cuándo se emitió, para la antigüedad. `null` si nunca se emitió. */
  emitidaEn?: Date | null;
  /** ¿Ya tiene alguna corrección registrada? */
  yaCorregida?: boolean;
}

export interface OpcionesEvaluacion {
  ahora?: Date;
  /**
   * Horas dentro de las cuales la anulación seguiría siendo aplicable.
   *
   * `null`/ausente = **no establecida** (pregunta 8). Con `null` no se excluye nada por tiempo y el
   * motivo lo dice: es mejor que la persona confirme en Siigo a que el sistema se invente un plazo.
   */
  ventanaAnulacionHoras?: number | null;
}

const MS_HORA = 3_600_000;

/** Las dos operaciones que Siigo documenta sobre una factura. `otra` no es una de ellas. */
const OPERACIONES_SIIGO: readonly SiigoCorreccionTipo[] = ['anulacion', 'borrado'];

const TEXTO_VIA_REINTENTO =
  'No hay documento que corregir: la vía es reintentar la emisión o marcarla como fallida definitiva.';
const TEXTO_VIA_EXTERNA =
  'La corrección se hace en Siigo Nube y se registra en FLITO con su número: hoy no hay ningún '
  + 'ejecutor automático (HU #11344, bloqueada).';

/** Antigüedad en horas, con un decimal. `null` si la factura no llegó a existir. */
function antiguedadEnHoras(emitidaEn: Date | null | undefined, ahora: Date): number | null {
  if (!emitidaEn) return null;
  const h = (ahora.getTime() - emitidaEn.getTime()) / MS_HORA;
  // Negativa significa reloj torcido o fecha futura: no es una antigüedad, y devolver un número
  // negativo haría que una comparación con la ventana pasara por accidente.
  return h < 0 ? 0 : Math.round(h * 10) / 10;
}

/** El caso «no hay documento»: ningún tipo es admisible, y el motivo es el mismo para todos (AC6). */
function sinDocumento(estado: SiigoFacturaEstado): SiigoCorreccionOpcion[] {
  const motivo = estado === 'fallida'
    ? 'La emisión falló: no llegó a existir ningún documento en Siigo que corregir.'
    : 'La emisión todavía no ha devuelto un documento de Siigo: no hay nada que corregir.';
  return SIIGO_CORRECCION_TIPOS.map((tipo) => ({
    tipo, admisible: false, automatizable: false, ejecutores: [], motivo,
  }));
}

/**
 * Motivo por el que una operación documentada por Siigo queda fuera cuando la factura ya llegó a la
 * DIAN. Se nombra el hecho —el CUFE, el envío en curso— y no una interpretación.
 */
function motivoBloqueoDian(situacion: SituacionFactura): string {
  const razon = situacion.cufe
    ? 'la factura ya tiene CUFE (la DIAN la aceptó)'
    : 'la factura está en proceso de envío a la DIAN';
  return `Siigo no permite editar, borrar ni anular una factura cuando ${razon} `
    + '(docs/integraciones/siigo-api.md §3).';
}

/** Opción para una operación de Siigo cuando la factura NO ha llegado a la DIAN. */
function operacionDisponible(
  tipo: SiigoCorreccionTipo, antiguedad: number | null, ventana: number | null | undefined,
): SiigoCorreccionOpcion {
  const base = tipo === 'anulacion'
    ? 'Siigo documenta POST /v1/invoices/{id}/annul y la factura aún no ha llegado a la DIAN.'
    : 'Siigo documenta DELETE /v1/invoices/{id} y la factura aún no ha llegado a la DIAN.';

  // La ventana solo se aplica a la anulación: es de la que habla la pregunta 8. El borrado no
  // tiene ventana documentada, y suponerle una sería inventar la segunda norma del día.
  if (tipo === 'anulacion' && typeof ventana === 'number' && antiguedad !== null && antiguedad > ventana) {
    return {
      tipo, admisible: false, automatizable: false, ejecutores: [],
      motivo: `Fuera de la ventana de anulación: ${antiguedad} h desde la emisión, con un máximo de ${ventana} h.`,
    };
  }

  const nota = tipo === 'anulacion' && (ventana === null || ventana === undefined)
    ? ' No hay ventana de anulación establecida (pregunta 8, abierta): confírmalo en Siigo antes de actuar.'
    : '';

  return {
    tipo,
    admisible: true,
    // Automatizable ≠ ejecutable hoy: lo que falta es el ejecutor (HU #11344), no el permiso de Siigo.
    automatizable: true,
    ejecutores: ['manual'],
    motivo: `${base}${nota}`,
  };
}

/**
 * Qué correcciones admite una factura, y por qué las demás no.
 *
 * Función del estado y del tiempo transcurrido. **No llama a Siigo ni a la base de datos**, y esa es
 * media historia: la otra media es que tampoco necesita hacerlo, porque las dos únicas reglas
 * documentadas se deciden con datos que FLITO ya tiene guardados.
 */
export function evaluarCorreccion(
  situacion: SituacionFactura, opciones: OpcionesEvaluacion = {},
): SiigoEvaluacionCorreccion {
  const ahora = opciones.ahora ?? new Date();
  const yaCorregida = situacion.yaCorregida === true;
  const antiguedadHoras = antiguedadEnHoras(situacion.emitidaEn, ahora);

  // Un documento existe cuando Siigo devolvió su identificador. El estado `fallida` lo niega aunque
  // hubiera identificador de un intento anterior: la fila representa un intento que no cuajó.
  const hayDocumento = situacion.estado !== 'fallida' && !!situacion.siigoInvoiceId;

  if (!hayDocumento) {
    return {
      puedeCorregirse: false,
      via: 'reintento',
      viaTexto: TEXTO_VIA_REINTENTO,
      antiguedadHoras,
      opciones: sinDocumento(situacion.estado),
      yaCorregida,
    };
  }

  const llegoALaDian = !!situacion.cufe || situacion.enTransitoAnteDian === true;

  const lista: SiigoCorreccionOpcion[] = OPERACIONES_SIIGO.map((tipo) => (
    llegoALaDian
      ? {
        tipo, admisible: false, automatizable: false, ejecutores: [],
        motivo: motivoBloqueoDian(situacion),
      }
      : operacionDisponible(tipo, antiguedadHoras, opciones.ventanaAnulacionHoras)
  ));

  // `otra` siempre es admisible mientras exista el documento, y su motivo cambia según el caso.
  //
  // Cuando la factura ya llegó a la DIAN, `otra` es lo ÚNICO que queda, y a propósito no se dice
  // cuál es la operación: no lo sabemos. Lo que sí se puede afirmar es que sea lo que sea que se
  // haga en Siigo Nube, tiene que quedar registrado aquí — que es exactamente para lo que existe
  // esta historia.
  lista.push({
    tipo: 'otra',
    admisible: true,
    // Nunca automatizable: no se puede automatizar una operación que no se sabe cuál es.
    automatizable: false,
    ejecutores: ['manual'],
    motivo: llegoALaDian
      ? 'Ninguna de las operaciones que Siigo documenta aplica a esta factura. Cuál corresponde no '
        + 'está establecido (pregunta 8, abierta): haz la corrección en Siigo Nube y regístrala aquí '
        + 'con su número y su motivo.'
      : 'Para cualquier otra operación hecha en Siigo Nube. El motivo es obligatorio: es lo único '
        + 'que explicará después qué se hizo.',
  });

  return {
    puedeCorregirse: true,
    via: 'registro_externo',
    viaTexto: TEXTO_VIA_EXTERNA,
    antiguedadHoras,
    opciones: lista,
    yaCorregida,
  };
}

/** La opción de un tipo concreto dentro de una evaluación ya calculada. */
export function opcionDe(
  evaluacion: SiigoEvaluacionCorreccion, tipo: SiigoCorreccionTipo,
): SiigoCorreccionOpcion | undefined {
  return evaluacion.opciones.find((o) => o.tipo === tipo);
}

/**
 * La evaluación en una frase, para el mensaje de `reversar` y para la bandeja (AC5).
 *
 * Se nombran los tipos admisibles cuando los hay; cuando no queda ninguna operación documentada, se
 * dice que la vía es registrar lo hecho por fuera. En ningún caso se nombra una operación que no
 * conste en `docs/integraciones/siigo-api.md`.
 */
export function resumirVia(evaluacion: SiigoEvaluacionCorreccion): string {
  if (!evaluacion.puedeCorregirse) return evaluacion.viaTexto;
  const documentadas = evaluacion.opciones
    .filter((o) => o.admisible && o.automatizable)
    .map((o) => o.tipo);
  const cabecera = documentadas.length
    ? `Correcciones admisibles según Siigo: ${documentadas.join(', ')}.`
    : 'Ninguna operación de la API de Siigo aplica a esta factura.';
  return `${cabecera} ${evaluacion.viaTexto}`;
}
