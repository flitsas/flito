// FLITO — canal Cliente del SOAT: contrato, catálogo y validaciones del alta (HU #11914, #11967).
//
// Vive en `lib/` y no dentro de la página porque lo comparten la página del formulario, los dos
// modales de bloqueo y la cola: si el catálogo de tipos de documento o la lectura del código de
// error se duplicaran, la próxima vez que el backend añada un código habría dos sitios que
// actualizar y solo uno se acordaría.
//
// ── Lo que NO hay aquí: ni un `fetch`, ni una URL ────────────────────────────────────────────────
//
// Las dos llamadas del canal las hace la página con `api.post` (`lib/api.ts`). Este módulo solo
// sabe LEER lo que vuelve, y por eso se puede probar y reusar sin montar nada.

import { ApiError } from './api';
import {
  CODIGOS_REVISE_LOS_DATOS, CodigoErrorSolicitudSoat, TIPOS_DOCUMENTO_RUNT,
  type EstadoSoat, type TipoDocumentoRunt,
} from '@operaciones/shared-types';

// ───────────────────────────── Verificación RUNT post-alta (HU #11935 / #11936) ──────────────────

/**
 * Lo que `GET /flito/soat/:id` proyecta en `solicitud` para pintar la ficha de revisión.
 * «vigente» no es un valor de `verificacionEstado`: es `ok` y `soatVigente === true`.
 */
export type VerificacionEstadoRunt = 'pendiente' | 'caido' | 'sin_registro' | 'no_cuadra' | 'ok';

export interface VerificacionRunt {
  verificacionEstado: VerificacionEstadoRunt;
  soatVigente: boolean | null;
  soatVigenteHasta: string | null;
  verificacionCodigo: string | null;
}

/**
 * Fecha de calendario en español largo («1 de febrero de 2027»).
 *
 * Se parte por componentes: `new Date('yyyy-mm-dd')` es medianoche UTC y en Colombia resta un día.
 */
export function fechaLarga(iso: string): string {
  const [anio, mes, dia] = iso.split('-').map(Number);
  return new Date(anio, mes - 1, dia)
    .toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ───────────────────────────── Lo que devuelve la preconsulta ────────────────────────────────────

/**
 * Respuesta de `POST /flito/soat/cliente/preconsulta`, con la MISMA forma que
 * `flito-soat-cliente.service.ts` (`interface Preconsulta`).
 *
 * El body de la petición es `{ placa, vin, tipoDocumento, numeroDocumento }` (PII en cuerpo,
 * nunca en query). La ficha no pinta placa ni VIN: son los normalizados de la petición, no un
 * dato que el RUNT confirme. La pasarela devuelve el identificador con el que se consultó aunque
 * no reconozca el vehículo, así que enseñarlos bajo el rótulo «Datos del RUNT» sería presentar el
 * eco de lo que el usuario tecleó como una confirmación. Se quedan arriba, en el bloque 1, que es
 * donde él los escribió — junto con el documento, que la pasarela exige cuando va la placa.
 */
export interface PreconsultaRunt {
  vehiculo: {
    placa: string | null;
    /**
     * **El VIN del RUNT**, no el eco de lo tecleado (HU #11966 §2.1): es la única fuente posible
     * cuando el Cliente no escribe VIN, y es el que se persiste. Aun así **no se pinta en el alta**
     * —ver el comentario de arriba y `FichaRunt`—: enseñarlo convertiría la pantalla en un lector
     * de VIN por placa para quien sondee placas ajenas.
     */
    vin: string | null;
    marca: string | null;
    linea: string | null;
    /** Año-modelo. Texto, no número: la fuente es texto y `"0"` es un valor con significado. */
    modelo: string | null;
    clase: string | null;
    cilindraje: string | null;
    tipoServicio: string | null;
    /** HU #11966: ayuda a reconocer el vehículo, y por eso SÍ entra a la ficha. */
    carroceria: string | null;
    /**
     * Los dos llegan en la respuesta y la ficha **no los pinta** (HU #11967, decisión 10): son datos
     * del archivo de Operaciones y no responden a la pregunta «¿es mi vehículo?».
     */
    pasajerosSentados: string | null;
    puertas: string | null;
  };
  /**
   * Del catálogo de FLITO. Se enseña el NOMBRE; el código DIVIPOLA es la clave, no un dato legible.
   *
   * `codigo` es `string | null` desde la HU #11966: el organismo dejó de ser compuerta (AC5) y el
   * `422 organismo_no_catalogado` desapareció de los dos endpoints. Si no cruza catálogo la ficha
   * pinta «—» y **la solicitud se puede enviar igual**.
   */
  organismo: { codigo: string | null; nombre: string | null };
  /** `null` es el caso NORMAL: el RUNT casi nunca trae propietario. No es un fallo y no se avisa. */
  propietario: { nombreCompleto: string } | null;
}

/** Lo que la pantalla necesita saber de un error del canal, ya separado del `ApiError` genérico. */
export interface FalloCanal {
  status: number;
  /** El discriminador estable. `null` cuando el error no viene del canal (red, 500 pelado, proxy). */
  codigo: CodigoErrorSolicitudSoat | null;
  /** El mensaje del servidor, escrito para una persona. Se usa como respaldo, no como discriminador. */
  mensaje: string;
  /** Solo en el 409 de RN-01. `false` (o ausente) significa que la fila NO es de su compañía. */
  propia?: boolean;
  /** Solo cuando `propia === true`: el servidor los recorta a propósito para no filtrar entre compañías. */
  id?: string;
  estado?: EstadoSoat;
  /**
   * Fecha de vencimiento del SOAT vigente (AC3), en `yyyy-mm-dd`. Solo en el `409 soat_vigente`.
   *
   * **AUSENTE, nunca `null` ni cadena vacía.** El servidor la omite cuando el RUNT reporta la
   * vigencia por estado y no por fecha, que es un caso frecuente y legítimo y no un fallo. Por eso
   * el modal tiene dos redacciones enteras y no una con un hueco: sin fecha se cambia la frase, no
   * se escribe «—» en medio de una oración.
   *
   * Ya llega normalizada por el servidor (`fechaVencimientoSoatRunt`), que traduce el `dd/MM/yyyy`
   * de la pasarela: la pantalla NO parsea formatos de la pasarela, solo rotula una fecha de
   * calendario.
   */
  fechaVencimiento?: string;
  /**
   * Qué campo señala el desenlace, en el `422 runt_no_cuadra` (HU #11966 §2.3). Hoy solo `'vin'`:
   * lo que no cuadra es el VIN que el Cliente tecleó, no la placa ni el documento.
   *
   * **Y nunca trae el VIN que el RUNT tiene.** El servidor lo omite a propósito: un Cliente puede
   * sondear placas ajenas, y un desenlace que respondiera «el bueno es este» convertiría el
   * endpoint en un lector de VIN por placa. Si alguien «mejora» el copy con ese dato, abre la fuga.
   */
  campo?: 'vin';
}

const CODIGOS: ReadonlySet<string> = new Set(Object.values(CodigoErrorSolicitudSoat));

/**
 * Traduce cualquier error de `api.post` a lo que la pantalla puede decidir.
 *
 * **Por el `codigo` y jamás por el texto.** Cinco desenlaces comparten `409`/`422`/`400`, y
 * separarlos comparando el mensaje se rompe la próxima vez que alguien corrija una tilde. El
 * servidor lo pone en el cuerpo justo para esto (`flito-soat-cliente.routes.ts:manejarError`), y
 * `ApiError.rawDetails` conserva el cuerpo entero.
 *
 * Un error que no traiga `codigo` conocido sale con `codigo: null`: un fallo de red, un 502 del
 * proxy o un 500 sin envolver son eso, y la pantalla los trata como «el servicio no respondió».
 */
export function leerFallo(e: unknown): FalloCanal {
  if (!(e instanceof ApiError)) {
    return { status: 0, codigo: null, mensaje: e instanceof Error ? e.message : 'Error desconocido' };
  }
  const cuerpo = (e.rawDetails ?? {}) as Record<string, unknown>;
  const codigo = typeof cuerpo.codigo === 'string' && CODIGOS.has(cuerpo.codigo)
    ? cuerpo.codigo as CodigoErrorSolicitudSoat
    : null;
  const fallo: FalloCanal = {
    status: e.status,
    codigo,
    mensaje: e.message,
    propia: typeof cuerpo.propia === 'boolean' ? cuerpo.propia : undefined,
    // `id` y `estado` SOLO se leen cuando el servidor dice `propia: true`. Es una segunda cerradura
    // sobre la del backend: si un día alguien ampliara el payload por error, la pantalla no
    // ofrecería abrir —ni nombraría el estado de— una solicitud de otra compañía.
    id: cuerpo.propia === true && typeof cuerpo.id === 'string' ? cuerpo.id : undefined,
    estado: cuerpo.propia === true && typeof cuerpo.estado === 'string'
      ? cuerpo.estado as EstadoSoat : undefined,
  };

  // Los dos campos de abajo se AÑADEN solo si vienen, en vez de asignarles `undefined`: para
  // `fechaVencimiento` la diferencia entre «vino» y «no vino» ES el contrato del modal —son dos
  // redacciones enteras, no una con un hueco—, y `{ k: undefined }` iguala las dos situaciones ante
  // el operador `in` y ante cualquier comprobación de presencia.
  if (typeof cuerpo.fechaVencimiento === 'string' && cuerpo.fechaVencimiento.trim()) {
    fallo.fechaVencimiento = cuerpo.fechaVencimiento;
  }
  // Solo se reconoce `'vin'`: es el único valor del contrato, y un valor nuevo servido por una API
  // desfasada no debe marcar como inválido un campo que la pantalla no sabe cuál es.
  if (cuerpo.campo === 'vin') fallo.campo = 'vin';
  return fallo;
}

// ───────────────────────────── Cómo reacciona la pantalla a un fallo (HU #11967) ─────────────────

/**
 * Lo que el Cliente lee cuando el RUNT resuelve que NO, en cualquiera de los dos endpoints.
 *
 * `tono` no es decoración: `danger` dice «hay algo suyo que corregir» y `warning` dice «el servicio
 * falló». Colapsarlos manda al Cliente a revisar una placa que está bien —o a esperar por un dato
 * que nunca se va a arreglar solo—, que es literalmente lo que el AC3 prohíbe.
 */
export interface DesenlaceRunt {
  tono: 'danger' | 'warning';
  /** Primera línea de la banda. Es la frase que el AC pide poder leer. */
  titulo: string;
  /** Segunda línea: qué puede hacer. */
  detalle: string;
  /** A dónde va el foco cuando se pinta la banda. */
  foco: 'vin' | 'boton';
}

/**
 * La reacción de la pantalla ante un error del canal, **decidida por `codigo` y jamás por el texto**.
 *
 * Un solo `switch` para los dos endpoints porque el backend los sirve desde una sola función
 * (`verificarRuntCompuerta`): dos copias de esta decisión divergen y la pantalla acaba bloqueando
 * lo que la API acepta. Dónde se PINTA cada reacción sí es cosa de cada superficie.
 */
export type ReaccionCanal =
  /** `403` del canal: el formulario entero se sustituye por la tarjeta del canal apagado. */
  | { tipo: 'canal' }
  /** `409` RN-01: modal de VIN en cola. Puede llegar también en la CONSULTA, no solo en el envío. */
  | { tipo: 'vin-en-cola' }
  /** `409` del RUNT: modal de SOAT vigente. No se envía y no se compra. */
  | { tipo: 'soat-vigente' }
  /** `400` del adjunto: la caja de subida queda rechazada con el motivo. */
  | { tipo: 'archivo' }
  /** Los cuatro desenlaces del RUNT: banda en el bloque 1 y la compuerta vuelve a cerrarse. */
  | { tipo: 'runt'; desenlace: DesenlaceRunt }
  /** `status === 0`: ni respondió ni se sabe si llegó. Cada superficie lo dice a su manera. */
  | { tipo: 'incierto' }
  /** Todo lo demás, **incluido un código desconocido o retirado**. Ver `reaccionA`. */
  | { tipo: 'otro'; mensaje: string };

/**
 * Los cuatro desenlaces del RUNT, con su copy.
 *
 * Las redacciones son distintas **a propósito** y el AC3 lo exige con estas palabras: «son dos
 * estados distintos y no se pueden ver iguales». Ninguna menciona el VIN que trajo el RUNT.
 */
const DESENLACE: Record<(typeof CODIGOS_REVISE_LOS_DATOS)[number] | typeof CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE, DesenlaceRunt> = {
  [CodigoErrorSolicitudSoat.RUNT_NO_CUADRA]: {
    tono: 'danger',
    titulo: 'Revise los datos: el RUNT no encuentra ese vehículo a nombre de ese documento.',
    detalle: 'Compruebe la placa y el documento del propietario en la tarjeta de propiedad, y vuelva a consultar.',
    foco: 'boton',
  },
  [CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO]: {
    tono: 'danger',
    titulo: 'Revise los datos: el RUNT no tiene ningún vehículo registrado con esa placa.',
    detalle: 'Compruebe la placa en la tarjeta de propiedad. Si el vehículo es nuevo, puede que el RUNT todavía no lo haya indexado.',
    foco: 'boton',
  },
  [CodigoErrorSolicitudSoat.RUNT_SIN_VIN]: {
    tono: 'danger',
    titulo: 'El RUNT no publica el número de chasis (VIN) de este vehículo, y sin ese dato FLITO no puede radicar la solicitud.',
    // Sin promesa de que reintentar sirva: no hay nada que el Cliente pueda corregir aquí.
    detalle: 'No es un error suyo. Escríbale a su contacto en FLIT con la placa del vehículo.',
    foco: 'boton',
  },
  [CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE]: {
    tono: 'warning',
    titulo: 'El RUNT no está disponible, vuelva a consultar.',
    detalle: 'No es un problema de sus datos: el servicio del RUNT no respondió. Espere un momento y pulse Volver a consultar.',
    foco: 'boton',
  },
};

/** El `422 runt_no_cuadra` con `campo: 'vin'`: misma familia, otra frase y el foco al campo VIN. */
const DESENLACE_VIN: DesenlaceRunt = {
  tono: 'danger',
  titulo: 'Revise los datos: el VIN que escribió no es el que el RUNT tiene para esa placa.',
  detalle: 'Compruébelo en la tarjeta de propiedad, o déjelo vacío para que FLITO use el del registro.',
  foco: 'vin',
};

/**
 * La banda de la **rama por defecto**: un código que esta pantalla no conoce.
 *
 * No es defensivo por gusto. En DEV el merge ES el deploy, así que la API puede ir por delante o por
 * detrás del bundle servido; un `organismo_no_catalogado` de una API vieja —código retirado en la
 * HU #11966— llegaría aquí. Sin esta rama la pantalla se queda MUDA con el envío bloqueado, que es
 * el peor de los estados posibles: el Cliente no sabe ni qué pasó ni qué hacer.
 *
 * Se enseña el `mensaje` del servidor, que está escrito para una persona, y se ofrece reintentar.
 */
export const desenlaceGenerico = (mensaje: string): DesenlaceRunt => ({
  tono: 'warning',
  titulo: mensaje.trim() || 'No pudimos consultar el RUNT en este momento.',
  detalle: 'Vuelva a consultar. Si sigue pasando, escríbale a su contacto en FLIT.',
  foco: 'boton',
});

/** Ni respondió ni se sabe si llegó, en una CONSULTA: no se creó nada, así que reintentar es seguro. */
export const DESENLACE_SIN_RED: DesenlaceRunt = {
  tono: 'warning',
  titulo: 'No pudimos comunicarnos con FLITO para consultar el RUNT.',
  detalle: 'Compruebe su conexión y pulse Volver a consultar.',
  foco: 'boton',
};

/**
 * Traduce un `FalloCanal` a lo que la pantalla hace con él.
 *
 * **Por `codigo`, y para la familia «revise los datos» por `CODIGOS_REVISE_LOS_DATOS`** —que
 * shared-types exporta justo para que aquí no se re-liste ni se deduzca del estado HTTP: los tres
 * son `422`, pero `422` no es sinónimo de la familia—. Nada compara `mensaje`: un
 * `if (/revise/i.test(mensaje))` se rompe con la primera corrección de una tilde y clasifica al
 * revés un 503 cuyo texto hable de datos.
 */
export function reaccionA(f: FalloCanal): ReaccionCanal {
  if (f.status === 0) return { tipo: 'incierto' };
  switch (f.codigo) {
    case CodigoErrorSolicitudSoat.CANAL_DESACTIVADO:
    case CodigoErrorSolicitudSoat.SIN_COMPANIA:
      return { tipo: 'canal' };
    case CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT:
      return { tipo: 'vin-en-cola' };
    case CodigoErrorSolicitudSoat.SOAT_VIGENTE:
      return { tipo: 'soat-vigente' };
    case CodigoErrorSolicitudSoat.ARCHIVO_NO_PDF:
      return { tipo: 'archivo' };
    default:
      break;
  }
  // El VIN tecleado que no cuadra es el MISMO código con una clave más, así que se mira antes de
  // repartir por familia: cambia la frase y, sobre todo, a dónde va el foco.
  if (f.codigo === CodigoErrorSolicitudSoat.RUNT_NO_CUADRA && f.campo === 'vin') {
    return { tipo: 'runt', desenlace: DESENLACE_VIN };
  }
  if (esReviseLosDatos(f.codigo) || f.codigo === CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE) {
    return { tipo: 'runt', desenlace: DESENLACE[f.codigo] };
  }
  // La rama por defecto. Todo lo que esta pantalla no conoce —incluido un código retirado— sale por
  // aquí con el mensaje del servidor; nunca en silencio.
  return { tipo: 'otro', mensaje: f.mensaje };
}

/**
 * La familia «revise los datos», leída de shared-types y no re-listada aquí.
 *
 * Es un type guard para que el mapa de copy se indexe sin castos: si mañana el backend añade un
 * cuarto miembro a la familia, `DESENLACE` deja de compilar y alguien tiene que escribir su frase
 * —en vez de que el código nuevo caiga callado en la rama por defecto.
 */
export const esReviseLosDatos = (
  c: CodigoErrorSolicitudSoat | null,
): c is (typeof CODIGOS_REVISE_LOS_DATOS)[number] =>
  c !== null && (CODIGOS_REVISE_LOS_DATOS as readonly CodigoErrorSolicitudSoat[]).includes(c);

// ───────────────────────────── Catálogo de tipo de documento ─────────────────────────────────────

/**
 * Los ocho del catálogo RUNT (AC1), con el rótulo que el producto YA usa.
 *
 * Los cinco primeros son literalmente los de `siigo-terceros.ts` y `CounterpartyForm.tsx`: un mismo
 * documento no puede llamarse de dos maneras en dos pantallas del mismo sistema.
 *
 * El ORDEN sale de `TIPOS_DOCUMENTO_RUNT` y no se reescribe aquí: shared-types es la fuente —lo dice
 * en su propio comentario— y una segunda lista ordenada a mano se desincroniza a la primera adición.
 * El catálogo es estático: no viaja por red, así que el selector no tiene «cargando» ni «error de
 * carga» y nadie debe inventarle un `onReintentar` que no reintentaría nada.
 */
const ETIQUETA_TIPO_DOC: Record<TipoDocumentoRunt, string> = {
  CC: 'Cédula de ciudadanía',
  CE: 'Cédula de extranjería',
  TI: 'Tarjeta de identidad',
  PAS: 'Pasaporte',
  PPT: 'Permiso por protección temporal (PPT)',
  NIT: 'NIT',
  RC: 'Registro civil',
  PT: 'Permiso temporal',
};

export const OPCIONES_TIPO_DOC = [
  { valor: '', etiqueta: 'Seleccione el tipo…' },
  ...TIPOS_DOCUMENTO_RUNT.map((t) => ({ valor: t, etiqueta: ETIQUETA_TIPO_DOC[t] })),
];

/**
 * El rótulo del tipo elegido, para la línea «Documento: …» del bloque 2 (HU #11967).
 *
 * Cadena vacía si todavía no eligió, y el propio valor si llegara uno que no está en el catálogo
 * —una fila vieja, un tipo retirado—: enseñar `CC` crudo es peor que enseñar su etiqueta, pero es
 * mucho mejor que enseñar un hueco.
 */
export const etiquetaTipoDoc = (t: string): string =>
  ETIQUETA_TIPO_DOC[t as TipoDocumentoRunt] ?? t;

/** `NIT` ⇒ razón social; el resto del catálogo ⇒ nombre/s y apellido/s. Misma regla que el backend. */
export const esNit = (tipoDocumento: string): boolean => tipoDocumento === 'NIT';

// ───────────────────────────── Normalización y validación ────────────────────────────────────────

/**
 * La placa se sube a mayúsculas **y nada más**.
 *
 * No se le quitan los guiones al vuelo a propósito: el producto tiene copy para «la placa se
 * escribe sin espacios ni guiones», y una normalización silenciosa dejaría ese mensaje muerto y al
 * usuario sin enterarse de cómo se escribe. El VIN sí se limpia entero (abajo) porque para él no
 * hay ningún mensaje equivalente y un carácter raro solo sería ruido.
 */
export const normalizarPlaca = (v: string): string => v.toUpperCase();

/** El VIN se limpia entero: mayúsculas y solo alfanuméricos, como `normalizarId` del servidor. */
export const normalizarVin = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

const ALFANUMERICO = /^[A-Z0-9]+$/;
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Longitud canónica de un VIN. Se AVISA al desviarse, nunca se bloquea: hay chasis más cortos. */
export const VIN_LARGO = 17;

export const MAX_MB_FACTURA = 15;

/**
 * Error de un campo del bloque 1. `null` = válido.
 *
 * Se ejecuta al salir del campo y otra vez en el envío; el servidor las repite todas y la suya es
 * la que manda.
 */
export function errorPlaca(v: string): string | null {
  const t = v.trim();
  if (!t) return 'Escriba la placa del vehículo.';
  if (!ALFANUMERICO.test(t)) return 'La placa se escribe con letras y números, sin espacios ni guiones. Ejemplo: ABC123.';
  return null;
}

/**
 * **El VIN es OPCIONAL desde la HU #11966** (AC1): vacío es válido y ya no hay «Escriba el VIN».
 *
 * Lo que se escribe sí se valida, porque un VIN a medias frena la solicitud en el servidor con un
 * 400 que el Cliente no sabe leer. Las dos reglas de forma se quedan tal cual.
 */
export function errorVin(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (t.length > VIN_LARGO) return `El VIN no puede tener más de ${VIN_LARGO} caracteres.`;
  if (/[IOQ]/.test(t)) return 'El VIN no lleva las letras I, O ni Q. Revise si son unos o ceros.';
  return null;
}

/** Aviso NO bloqueante: un VIN corto puede ser legítimo (motos y chasis antiguos). */
export function avisoVin(v: string): string | null {
  const t = v.trim();
  if (!t || t.length === VIN_LARGO || errorVin(t)) return null;
  return `El VIN suele tener 17 caracteres y este tiene ${t.length}. Revíselo en la tarjeta de propiedad.`;
}

export function errorTipoDocumento(v: string): string | null {
  return v ? null : 'Elija el tipo de documento del propietario.';
}

export function errorNumeroDocumento(v: string): string | null {
  const t = v.trim();
  if (!t) return 'Escriba el número de documento del propietario.';
  // Alfanumérico y NO solo dígitos: pasaporte, cédula de extranjería y PPT llevan letras.
  if (!/^[A-Za-z0-9]+$/.test(t)) return 'El número de documento solo lleva letras y números, sin puntos ni espacios.';
  return null;
}

/**
 * El nombre del propietario, **partido** (HU #11966, AC5).
 *
 * Tres campos y no uno: el tipo de documento decide cuáles se piden, y el que no toca no se valida
 * aunque conserve lo que el Cliente escribió antes de conmutar (§5 del UX). El derivado
 * `nombreCompleto` ya no viaja: lo compone el servidor.
 */
export function errorNombres(v: string): string | null {
  return v.trim() ? null : 'Escriba el nombre o los nombres del propietario.';
}

export function errorApellidos(v: string): string | null {
  return v.trim() ? null : 'Escriba el apellido o los apellidos del propietario.';
}

export function errorRazonSocial(v: string): string | null {
  return v.trim() ? null : 'Escriba la razón social del propietario.';
}

/**
 * **Obligatorio desde la HU #11966** (AC5), igual que celular, dirección, municipio y departamento:
 * el gestor los necesita para expedir la póliza, y hasta ahora podían llegar vacíos.
 *
 * El mensaje de formato se conserva **sin la coletilla «o déjelo vacío»**, que dejó de ser cierta.
 */
export function errorCorreo(v: string): string | null {
  const t = v.trim();
  if (!t) return 'Escriba el correo del propietario.';
  return CORREO.test(t) ? null : 'Ese correo no parece válido. Revíselo.';
}

export function errorCelular(v: string): string | null {
  return v.trim() ? null : 'Escriba el celular del propietario.';
}

export function errorDireccion(v: string): string | null {
  return v.trim() ? null : 'Escriba la dirección del propietario.';
}

/**
 * Municipio y departamento son **texto libre**: el AC solo pide que sean obligatorios y el producto
 * no tiene catálogo DIVIPOLA. Dos altas de la misma ciudad podrán escribir «Bogotá» y «BOGOTA D.C.»
 * —es lo que ya pasa con `flito_tramites.ciudad`—; un catálogo es otra HU, no una improvisación de
 * esta pantalla.
 */
export function errorMunicipio(v: string): string | null {
  return v.trim() ? null : 'Escriba el municipio del propietario.';
}

export function errorDepartamento(v: string): string | null {
  return v.trim() ? null : 'Escriba el departamento del propietario.';
}

/**
 * El adjunto, mirado por lo que el navegador puede mirar: extensión y tamaño.
 *
 * Quien decide de verdad es el servidor, que olfatea los BYTES (`%PDF-`): un ejecutable renombrado
 * a `.pdf` pasa por aquí y lo para allí. Esta comprobación existe para no gastar una subida de 15 MB
 * en algo que ya se sabe que no vale, no para dar por bueno lo que pase.
 */
export function errorArchivo(f: File): string | null {
  const punto = f.name.lastIndexOf('.');
  const ext = punto >= 0 ? f.name.slice(punto + 1).toLowerCase() : '';
  if (ext !== 'pdf') return `El archivo debe ser un PDF y este es un ${ext || 'archivo sin extensión'}.`;
  const mb = f.size / (1024 * 1024);
  if (mb > MAX_MB_FACTURA) return `El archivo pesa ${mb.toFixed(1)} MB y el máximo es ${MAX_MB_FACTURA} MB.`;
  return null;
}

/** «1,2 MB» para el rótulo del archivo ya elegido. */
export const tamanoMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
