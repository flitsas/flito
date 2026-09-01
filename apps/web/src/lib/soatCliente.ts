// FLITO — canal Cliente del SOAT: contrato, catálogo y validaciones del alta (HU #11914).
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
  CodigoErrorSolicitudSoat, TIPOS_DOCUMENTO_RUNT, type EstadoSoat, type TipoDocumentoRunt,
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
    vin: string | null;
    marca: string | null;
    linea: string | null;
    /** Año-modelo. Texto, no número: la fuente es texto y `"0"` es un valor con significado. */
    modelo: string | null;
    clase: string | null;
    cilindraje: string | null;
    tipoServicio: string | null;
  };
  /** Del catálogo de FLITO. Se enseña el NOMBRE; el código DIVIPOLA es la clave, no un dato legible. */
  organismo: { codigo: string; nombre: string | null };
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
   * El organismo que el RUNT reporta, en el `422 organismo_no_catalogado`. **Tres estados, y los
   * tres significan cosas distintas — no se colapsan:**
   *
   *   · `string` → el RUNT lo reporta y FLITO no lo tiene catalogado. Copy con el nombre.
   *   · `null`   → **el RUNT no reporta organismo.** La clave viaja igualmente para poder afirmarlo.
   *                Es la otra variante del copy, y es una afirmación sobre el RUNT, no sobre la API.
   *   · ausente  → el servidor no mandó la clave (una versión anterior a este contrato). No se sabe
   *                nada del RUNT, así que la pantalla no afirma nada: usa el `mensaje` del servidor.
   *
   * Sale como CAMPO y no de las comillas del mensaje. Sacarlo del texto ataba una redacción a una
   * expresión regular: el día que alguien corrigiera la frase, la pantalla dejaría de encontrarlo y
   * ningún test se enteraría. Ese parseo existió durante un PR y está borrado a propósito.
   */
  organismoNombre?: string | null;
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
  // `organismoNombre` la diferencia entre «la clave llegó valiendo null» y «la clave no llegó» ES el
  // contrato —una dice algo del RUNT y la otra no dice nada—, y `{ k: undefined }` las iguala ante
  // el operador `in` y ante cualquier comprobación de presencia.
  if (typeof cuerpo.fechaVencimiento === 'string' && cuerpo.fechaVencimiento.trim()) {
    fallo.fechaVencimiento = cuerpo.fechaVencimiento;
  }
  if ('organismoNombre' in cuerpo) {
    const n = cuerpo.organismoNombre;
    fallo.organismoNombre = typeof n === 'string' && n.trim() ? n : null;
  }
  return fallo;
}

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

export function errorVin(v: string): string | null {
  const t = v.trim();
  if (!t) return 'Escriba el VIN del vehículo.';
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

export function errorNombre(v: string): string | null {
  return v.trim() ? null : 'Escriba el nombre completo o la razón social del propietario.';
}

/** Opcional: vacío es válido. Solo se rechaza lo que está escrito y no parece un correo. */
export function errorCorreo(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  return CORREO.test(t) ? null : 'Ese correo no parece válido. Revíselo o déjelo vacío.';
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
