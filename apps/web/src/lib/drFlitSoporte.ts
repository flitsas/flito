// Dr. Flit — «Necesito soporte»: almacén EN MEMORIA del asistente (HU #13806, Feature #13695;
// anexo UX F5.10, P9-6).
//
// Vive a nivel de módulo, por encima del panel: `DrFlitPanel` es `lazy` y se desmonta al cerrarse, y el
// borrador, el paso, la clave de idempotencia y la petición en vuelo tienen que sobrevivir a cerrar el
// panel y a navegar. NUNCA toca `sessionStorage` ni `localStorage` y nunca se envía a un servicio de IA:
// sale del navegador una sola vez, en `POST /casos-soporte`, al pulsar «Confirmar» o «Reintentar».
// Los `File` adjuntos (HU #13807) viven aquí también, solo en memoria, para que «Reintentar» reenvíe los
// mismos sin volver a elegirlos; su nombre nunca va a logs ni a la consola. Se borra al radicar, con «Terminar chat» y en las 4 salidas de sesión (`alLimpiarDrFlit`); recargar la
// página lo pierde (memoria).

import { useSyncExternalStore } from 'react';
import {
  PARTE_ADJUNTOS_MULTIPART, PARTE_CASO_MULTIPART,
  type CasoRadicadoDrFlit, type EstadoAutorizacionDrFlit, type AutorizacionAceptadaDrFlit, type ErrorAdjuntoDrFlit,
} from '@operaciones/shared-types';
import { api, ApiError } from './api';
import { alLimpiarDrFlit } from './drFlitAlmacen';
import {
  LIMITES_ADJUNTOS_POR_DEFECTO, PASOS_SOPORTE, campoDeRutaServidor, cuerpoDelCaso, errorDeArchivos,
  fechaDelReporte, nuevaClaveIdempotencia, pasoDeCampo, primerError, validarSeleccion,
  type AdjuntoSoporte, type CampoSoporte, type CamposSoporte, type LimitesAdjuntos, type PasoSoporte,
} from './drFlitSoporteModelo';

export type PantallaSoporte = 'preparando' | 'errorPreparar' | 'noDisponible' | 'autorizacion' | 'paso';
/** `archivos` = el selector de archivos; `quitar` = el «Quitar» de la fila `foco.i` (F5.14). */
export type FocoSoporte = 'h3' | 'primerError' | 'primerCampo' | 'primaria' | 'volver' | 'caja' | 'abridor'
  | 'archivos' | 'quitar';
type PasoConCampos = Exclude<PasoSoporte, 'resumen'>;

export interface BorradorSoporte {
  campos: CamposSoporte;
  paso: PasoSoporte;
  /** Se llegó al paso con «Corregir»: la primaria dice «Volver al resumen». */
  desdeResumen: boolean;
  /** UUID del caso: se reutiliza en cada reintento hasta que quede radicado. */
  clave: string;
  /** Fecha del resumen, tomada al entrar a él. */
  fecha: string | null;
  /** Pasos ya validados una vez: sus errores se muestran y se actualizan al escribir. */
  validados: ReadonlySet<PasoConCampos>;
  /** Campos que el servidor rechazó (400) y el usuario aún no ha editado. */
  rechazados: ReadonlySet<CampoSoporte>;
  /** «¿Quiere adjuntar…?»: empieza en «No» (F5.16). Con «No» la lista se oculta pero no se borra. */
  adjuntar: boolean;
  /** Los `File` elegidos, en memoria y en el orden en que se envían (el `indice` del servidor). */
  adjuntos: readonly AdjuntoSoporte[];
  /** Una línea por archivo descartado en la última selección (F5.7); o el tope del servidor (413). */
  avisosAdjuntos: readonly string[];
}

export interface EstadoSoporteDrFlit {
  userId: number | null;
  /** `GET /autorizacion?finalidad=soporte` (al montar el panel y al reintentar). */
  consulta: { fase: 'cargando' | 'error' | 'listo'; datos: EstadoAutorizacionDrFlit | null };
  vista: 'chat' | 'soporte';
  pantalla: PantallaSoporte;
  borrador: BorradorSoporte | null;
  autorizacion: {
    fase: 'inactivo' | 'enviando' | 'error';
    /** «El texto de la autorización cambió…» (409 al aceptar o 403 al radicar). */
    aviso: boolean;
    /** Tras «Acepto»: el paso del borrador o, si venía de un 403 al radicar, el resumen. */
    destino: 'paso' | 'resumen';
  };
  envio: { fase: 'inactivo' | 'enviando' | 'error'; tope: boolean };
  /** Número recién radicado que el panel aún no ha puesto en la conversación. */
  radicado: number | null;
  /** Qué abrió el asistente («saludo» o el id del mensaje «sin resultados»), para «Ahora no». */
  abridor: string | null;
  foco: { a: FocoSoporte; n: number; i?: number };
}

const INICIAL: EstadoSoporteDrFlit = Object.freeze({
  userId: null,
  consulta: { fase: 'cargando', datos: null },
  vista: 'chat',
  pantalla: 'preparando',
  borrador: null,
  autorizacion: { fase: 'inactivo', aviso: false, destino: 'paso' },
  envio: { fase: 'inactivo', tope: false },
  radicado: null,
  abridor: null,
  foco: { a: 'h3', n: 0 },
}) as EstadoSoporteDrFlit;

let estado: EstadoSoporteDrFlit = INICIAL;
/** Sube con cada limpieza: una respuesta de antes de limpiar ya no escribe. */
let generacion = 0;
let consultaEnVuelo = 0;
let prellenado: CamposSoporte | null = null;
const oyentes = new Set<() => void>();

function fijar(cambio: Partial<EstadoSoporteDrFlit>): void {
  estado = { ...estado, ...cambio };
  for (const oyente of oyentes) oyente();
}

function enfocar(a: FocoSoporte, i?: number): Pick<EstadoSoporteDrFlit, 'foco'> {
  return { foco: { a, n: estado.foco.n + 1, i } };
}

/** Límites del servidor (`GET /autorizacion` → `soporte.adjuntos`). */
export function limitesAdjuntos(): LimitesAdjuntos {
  return estado.consulta.datos?.soporte.adjuntos ?? LIMITES_ADJUNTOS_POR_DEFECTO;
}

let siguienteIdAdjunto = 1;

export function leerSoporteDrFlit(): EstadoSoporteDrFlit {
  return estado;
}

function suscribir(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => oyentes.delete(oyente);
}

export function useSoporteDrFlit(): EstadoSoporteDrFlit {
  return useSyncExternalStore(suscribir, leerSoporteDrFlit, leerSoporteDrFlit);
}

/**
 * Borra el borrador, la vista y lo que esté en vuelo. Lo llama el barrido de Dr. Flit («Terminar chat» y
 * las salidas de sesión). Conserva el usuario y el estado de soporte consultado (no es dato del caso):
 * así «Necesito soporte» no desaparece tras terminar el chat.
 */
export function limpiarSoporteDrFlit(): void {
  generacion += 1;
  prellenado = null;
  fijar({ ...INICIAL, userId: estado.userId, consulta: estado.consulta, foco: estado.foco });
}
alLimpiarDrFlit(limpiarSoporteDrFlit);

/** Al montar el panel: otro usuario en la pestaña nunca ve el borrador del anterior. */
export function asegurarUsuarioSoporte(userId: number | undefined): void {
  const id = userId ?? null;
  if (estado.userId === id) return;
  generacion += 1;
  prellenado = null;
  fijar({ ...INICIAL, userId: id, foco: estado.foco });
}

const codigoDe = (e: unknown): string | undefined => {
  const raw = e instanceof ApiError ? (e.rawDetails as { codigo?: unknown } | null) : null;
  return typeof raw?.codigo === 'string' ? raw.codigo : undefined;
};

/** `GET` del estado de soporte. Al terminar, si el asistente esperaba, decide la pantalla. */
export function consultarEstadoSoporte(): void {
  const gen = generacion;
  consultaEnVuelo += 1;
  const turno = consultaEnVuelo;
  fijar({ consulta: { fase: 'cargando', datos: estado.consulta.datos } });
  api.get<EstadoAutorizacionDrFlit>('/flito/dr-flit/autorizacion?finalidad=soporte').then(
    (datos) => {
      if (gen !== generacion || turno !== consultaEnVuelo) return;
      fijar({ consulta: { fase: 'listo', datos } });
      if (estado.vista === 'soporte' && estado.pantalla === 'preparando') decidir();
      else if (estado.vista === 'soporte' && estado.pantalla === 'autorizacion') fijar(enfocar('h3'));
    },
    () => {
      if (gen !== generacion || turno !== consultaEnVuelo) return;
      fijar({ consulta: { fase: 'error', datos: null } });
      if (estado.vista === 'soporte' && estado.pantalla === 'preparando') {
        fijar({ pantalla: 'errorPreparar', ...enfocar('primaria') });
      }
    },
  );
}

function asegurarBorrador(): BorradorSoporte {
  return estado.borrador ?? {
    campos: prellenado ?? camposVacios(),
    paso: PASOS_SOPORTE[0],
    desdeResumen: false,
    clave: nuevaClaveIdempotencia(),
    fecha: null,
    validados: new Set(),
    rechazados: new Set(),
    adjuntar: false,
    adjuntos: [],
    avisosAdjuntos: [],
  };
}

function camposVacios(): CamposSoporte {
  return {
    nombre: '', correo: '', telefono: '', area: '', titulo: '', detalle: '', resultadoEsperado: '',
    frecuencia: '', prioridad: '',
  };
}

/** Con el estado conocido: no disponible, autorización o el paso del borrador. */
function decidir(): void {
  const datos = estado.consulta.datos;
  if (!datos) return;
  if (!datos.soporte.disponible) {
    fijar({ pantalla: 'noDisponible', ...enfocar('volver') });
    return;
  }
  if (!datos.autorizado) {
    fijar({ pantalla: 'autorizacion', autorizacion: { ...estado.autorizacion, fase: 'inactivo' }, ...enfocar('h3') });
    return;
  }
  const nuevo = estado.borrador === null;
  fijar({ pantalla: 'paso', borrador: asegurarBorrador(), ...enfocar('h3') });
  if (nuevo) prellenarCorreo();
}

/**
 * `/auth/me` ya no trae el correo (HU #13431): sale de `/auth/perfil`, el mismo dato de la sesión que
 * «Ver mis datos». Solo rellena un correo VACÍO y sin tocar; si falla, el campo queda vacío y editable.
 */
function prellenarCorreo(): void {
  const gen = generacion;
  const clave = estado.borrador?.clave;
  if (!clave || estado.borrador?.campos.correo) return;
  api.get<{ email?: string | null }>('/auth/perfil').then(
    (perfil) => {
      const b = estado.borrador;
      const correo = typeof perfil?.email === 'string' ? perfil.email.trim() : '';
      if (gen !== generacion || !b || b.clave !== clave || b.campos.correo || !correo) return;
      cambiarBorrador({ campos: { ...b.campos, correo } });
    },
    () => { /* sin correo de la sesión: el usuario lo escribe */ },
  );
}

/** «Necesito soporte». `campos` = prellenado de la sesión (solo se usa si no hay borrador). */
export function abrirSoporte(abridor: string, campos: CamposSoporte): void {
  prellenado = campos;
  fijar({ vista: 'soporte', abridor, autorizacion: { fase: 'inactivo', aviso: false, destino: 'paso' } });
  if (estado.consulta.fase === 'listo') {
    decidir();
    return;
  }
  fijar({ pantalla: 'preparando', ...enfocar('volver') });
  consultarEstadoSoporte();
}

/** «Reintentar» del error de preparación. */
export function reintentarPreparar(): void {
  fijar({ pantalla: 'preparando', ...enfocar('volver') });
  consultarEstadoSoporte();
}

/** «Volver al chat» (y Esc): el borrador se queda en memoria. */
export function volverAlChat(): void {
  fijar({ vista: 'chat', ...enfocar('caja') });
}

/** «Ahora no»: vuelve al chat sin registrar nada. */
export function ahoraNo(): void {
  fijar({ vista: 'chat', autorizacion: { fase: 'inactivo', aviso: false, destino: 'paso' }, ...enfocar('abridor') });
}

/** «Acepto»: un solo `POST`; 409 = la versión cambió → recarga el texto con aviso. */
export function aceptarAutorizacion(): void {
  const datos = estado.consulta.datos;
  if (!datos || estado.autorizacion.fase === 'enviando') return;
  const gen = generacion;
  fijar({ autorizacion: { ...estado.autorizacion, fase: 'enviando' } });
  api.post<AutorizacionAceptadaDrFlit>('/flito/dr-flit/autorizacion', {
    finalidad: 'soporte', version: datos.versionVigente,
  }).then(
    (r) => {
      if (gen !== generacion) return;
      const consulta = { fase: 'listo' as const, datos: { ...datos, autorizado: true, aceptadaEn: r.aceptadaEn } };
      const nuevo = estado.borrador === null;
      const borrador = asegurarBorrador();
      const destino = estado.autorizacion.destino;
      fijar({
        consulta,
        pantalla: 'paso',
        borrador: destino === 'resumen' ? { ...borrador, paso: 'resumen', desdeResumen: false } : borrador,
        autorizacion: { fase: 'inactivo', aviso: false, destino: 'paso' },
        ...enfocar('h3'),
      });
      if (nuevo) prellenarCorreo();
    },
    (e) => {
      if (gen !== generacion) return;
      if (e instanceof ApiError && e.status === 409) {
        fijar({ autorizacion: { ...estado.autorizacion, fase: 'inactivo', aviso: true } });
        consultarEstadoSoporte();
        return;
      }
      fijar({ autorizacion: { ...estado.autorizacion, fase: 'error' } });
    },
  );
}

function cambiarBorrador(cambio: Partial<BorradorSoporte>, extra: Partial<EstadoSoporteDrFlit> = {}): void {
  const b = estado.borrador;
  if (!b) return;
  fijar({ borrador: { ...b, ...cambio }, ...extra });
}

/** Escribir en un campo: quita su rechazo del servidor y, tras un error de envío, vuelve a «Confirmar». */
export function editarCampo<K extends CampoSoporte>(campo: K, valor: CamposSoporte[K]): void {
  const b = estado.borrador;
  if (!b || estado.envio.fase === 'enviando') return;
  const rechazados = new Set(b.rechazados);
  rechazados.delete(campo);
  cambiarBorrador(
    { campos: { ...b.campos, [campo]: valor }, rechazados },
    estado.envio.fase === 'error' ? { envio: { fase: 'inactivo', tope: false } } : {},
  );
}

function irAResumen(): void {
  cambiarBorrador({ paso: 'resumen', desdeResumen: false, fecha: fechaDelReporte() }, enfocar('h3'));
}

/** «Siguiente» / «Volver al resumen»: valida SOLO este paso. */
export function siguientePaso(): void {
  const b = estado.borrador;
  if (!b || b.paso === 'resumen') return;
  const paso = b.paso;
  const validados = new Set(b.validados).add(paso);
  if (paso === 'archivos' && errorDeArchivos(b.adjuntar, b.adjuntos, limitesAdjuntos())) {
    cambiarBorrador({ validados }, enfocar('primerError'));
    return;
  }
  if (primerError(paso, b.campos, b.rechazados)) {
    cambiarBorrador({ validados }, enfocar('primerError'));
    return;
  }
  cambiarBorrador({ validados });
  const siguiente = PASOS_SOPORTE[PASOS_SOPORTE.indexOf(paso) + 1];
  if (b.desdeResumen || siguiente === 'resumen') {
    irAResumen();
    return;
  }
  cambiarBorrador({ paso: siguiente }, enfocar('h3'));
}

/** «Atrás»: retrocede sin validar ni borrar. */
export function pasoAnterior(): void {
  const b = estado.borrador;
  if (!b) return;
  const i = PASOS_SOPORTE.indexOf(b.paso);
  if (i > 0) cambiarBorrador({ paso: PASOS_SOPORTE[i - 1] }, enfocar('h3'));
}

/** «Corregir» de un bloque del resumen. */
export function corregir(paso: PasoConCampos): void {
  if (estado.envio.fase === 'enviando') return;
  cambiarBorrador({ paso, desdeResumen: true }, enfocar('primerCampo'));
}

/** «Confirmar» y «Reintentar»: la ÚNICA llamada que saca el caso del navegador. Misma clave siempre. */
export function confirmarCaso(): void {
  const b = estado.borrador;
  if (!b || estado.envio.fase === 'enviando') return;
  for (const paso of ['contacto', 'caso'] as const) {
    if (primerError(paso, b.campos, b.rechazados)) {
      cambiarBorrador({ paso, desdeResumen: true, validados: new Set(b.validados).add(paso) }, enfocar('primerError'));
      return;
    }
  }
  if (errorDeArchivos(b.adjuntar, b.adjuntos, limitesAdjuntos())) {
    cambiarBorrador(
      { paso: 'archivos', desdeResumen: true, validados: new Set(b.validados).add('archivos') }, enfocar('primerError'),
    );
    return;
  }
  const gen = generacion;
  // Con «No» los archivos elegidos NO se envían (F5.4 F). `enviados` fija el orden de las partes: el
  // `adjunto.indice` de un rechazo apunta a esta lista, no a la que haya en pantalla después.
  const enviados = b.adjuntar ? b.adjuntos.map((a) => a.id) : [];
  const caso = cuerpoDelCaso(b.campos, b.clave);
  let cuerpo: unknown = caso;
  if (enviados.length > 0) {
    const form = new FormData();
    form.append(PARTE_CASO_MULTIPART, JSON.stringify(caso));
    for (const a of b.adjuntos) form.append(PARTE_ADJUNTOS_MULTIPART, a.file, a.file.name);
    cuerpo = form;
  }
  fijar({ envio: { fase: 'enviando', tope: false } });
  api.post<CasoRadicadoDrFlit>('/flito/dr-flit/casos-soporte', cuerpo).then(
    (r) => {
      if (gen !== generacion) return;
      fijar({
        radicado: r.numero,
        borrador: null,
        vista: 'chat',
        pantalla: 'preparando',
        envio: { fase: 'inactivo', tope: false },
        ...enfocar('caja'),
      });
    },
    (e) => {
      if (gen !== generacion) return;
      if (tratarErrorDeAdjunto(e, enviados)) return;
      tratarErrorDeEnvio(e);
    },
  );
}

/**
 * 400 `adjunto-invalido` / 413 `adjunto-muy-grande` | `adjuntos-limite` (F5.9): lleva al paso «Archivos»
 * con el motivo en la fila de ESE archivo (`indice` → posición en lo enviado). `true` si lo trató.
 */
function tratarErrorDeAdjunto(e: unknown, enviados: readonly number[]): boolean {
  if (!(e instanceof ApiError) || (e.status !== 400 && e.status !== 413)) return false;
  const raw = e.rawDetails as Partial<ErrorAdjuntoDrFlit> | null;
  const codigo = raw?.codigo;
  if (codigo !== 'adjunto-invalido' && codigo !== 'adjunto-muy-grande' && codigo !== 'adjuntos-limite') return false;
  const b = estado.borrador;
  if (!b) return false;
  const indice = raw?.adjunto?.indice;
  const id = typeof indice === 'number' ? enviados[indice] : undefined;
  const motivo = codigo === 'adjunto-muy-grande' ? 'muy-grande' : (raw?.adjunto?.motivo ?? 'contenido-no-coincide');
  const tope = raw?.limite?.maxArchivos ?? limitesAdjuntos().maxArchivos;
  const adjuntos = id === undefined ? b.adjuntos : b.adjuntos.map((a) => (a.id === id ? { ...a, rechazo: motivo } : a));
  const avisosAdjuntos = codigo === 'adjuntos-limite'
    ? [`Puede adjuntar hasta ${tope} archivos. Quite uno para continuar.`]
    : b.avisosAdjuntos;
  cambiarBorrador(
    { paso: 'archivos', desdeResumen: true, validados: new Set(b.validados).add('archivos'), adjuntos, avisosAdjuntos },
    { envio: { fase: 'inactivo', tope: false }, ...enfocar('primerError') },
  );
  return true;
}

/** Cambiar algo de los archivos tras un error de envío vuelve el pie a «Confirmar» (como un campo). */
function cambiarAdjuntos(cambio: Partial<BorradorSoporte>, extra: Partial<EstadoSoporteDrFlit> = {}): void {
  if (!estado.borrador || estado.envio.fase === 'enviando') return;
  cambiarBorrador(cambio, { ...(estado.envio.fase === 'error' ? { envio: { fase: 'inactivo', tope: false } } : {}), ...extra });
}

/** Sí / No de «¿Quiere adjuntar capturas o documentos?». «No» oculta la lista sin borrarla. */
export function elegirAdjuntar(adjuntar: boolean): void {
  cambiarAdjuntos({ adjuntar });
}

/** Archivos elegidos en el selector: se validan contra los límites del servidor y se suman a la lista. */
export function agregarArchivos(nuevos: readonly File[]): void {
  const b = estado.borrador;
  if (!b) return;
  const { aceptados, avisos } = validarSeleccion(b.adjuntos.length, nuevos, limitesAdjuntos());
  const agregados = aceptados.map((file) => ({ id: siguienteIdAdjunto++, file, rechazo: null }));
  cambiarAdjuntos({ adjuntos: [...b.adjuntos, ...agregados], avisosAdjuntos: avisos });
}

/** «Quitar»: el foco va al «Quitar» siguiente, al anterior o, si no quedan, al selector (F5.14). */
export function quitarArchivo(id: number): void {
  const b = estado.borrador;
  if (!b) return;
  const i = b.adjuntos.findIndex((a) => a.id === id);
  if (i < 0) return;
  const adjuntos = b.adjuntos.filter((a) => a.id !== id);
  const tope = limitesAdjuntos().maxArchivos;
  const avisosAdjuntos = adjuntos.length <= tope && b.avisosAdjuntos.some((t) => t.startsWith('Puede adjuntar hasta'))
    ? [] : b.avisosAdjuntos;
  const foco = adjuntos.length === 0 ? enfocar('archivos') : enfocar('quitar', Math.min(i, adjuntos.length - 1));
  cambiarAdjuntos({ adjuntos, avisosAdjuntos }, foco);
}

function tratarErrorDeEnvio(e: unknown): void {
  const codigo = codigoDe(e);
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403 && codigo === 'autorizacion-requerida') {
    const datos = estado.consulta.datos;
    fijar({
      envio: { fase: 'inactivo', tope: false },
      pantalla: 'autorizacion',
      consulta: { fase: estado.consulta.fase, datos: datos ? { ...datos, autorizado: false } : datos },
      autorizacion: { fase: 'inactivo', aviso: true, destino: 'resumen' },
      ...enfocar('h3'),
    });
    consultarEstadoSoporte();
    return;
  }
  if (status === 400 && codigo === 'campo-invalido') {
    const raw = (e as ApiError).rawDetails as { campo?: unknown } | null;
    const campo = campoDeRutaServidor(raw?.campo);
    const b = estado.borrador;
    if (campo && b) {
      const paso = pasoDeCampo(campo);
      cambiarBorrador(
        {
          paso, desdeResumen: true,
          validados: new Set(b.validados).add(paso),
          rechazados: new Set(b.rechazados).add(campo),
        },
        { envio: { fase: 'inactivo', tope: false }, ...enfocar('primerError') },
      );
      return;
    }
  }
  fijar({ envio: { fase: 'error', tope: status === 429 }, ...enfocar('primaria') });
}

/** El panel pone el número en la conversación y lo consume. */
export function consumirRadicado(): number | null {
  const n = estado.radicado;
  if (n !== null) fijar({ radicado: null });
  return n;
}

/** Al reabrir el panel con el asistente a la vista: foco al `h3` del paso (F5.6). */
export function pedirFocoSoporte(a: FocoSoporte): void {
  fijar(enfocar(a));
}
