// FLITO — canal Cliente del SOAT: validación del formulario de la solicitud y frase de «lo que falta».
//
// Salió de `FlitoSoatSolicitud.tsx` (HU #14019): la página roza el techo de 800 líneas del lint y esto es
// lógica pura (más el chip del bloque 2). Se parametriza por TIPO de SOAT: en Inicial el bloque 1 es el VIN
// y la factura es obligatoria; en Renovación son placa + documento del propietario y la factura es
// opcional. El resto —propietario, correo, celular…— es idéntico.

import type { ReactNode } from 'react';
import { TipoSoat } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import {
  errorApellidos, errorCelular, errorCorreo, errorDepartamento, errorDireccion, errorMunicipio,
  errorNombreCompleto, errorNombres, errorNumeroDocumento, errorRazonSocial, errorTipoDocumento, errorVin, esNit,
} from '../../../lib/soatCliente';
import { errorDocumentoVehiculo, errorPlaca } from '../../../lib/mensajesTipoSoat';
import {
  CAMPOS_NOMBRE, ID_CAMPO, type CampoPropietario, type EstadoLectura, type Propietario,
} from './bloques';
import { ID_DOC_VEHICULO, ID_PLACA } from './BloqueVehiculoRenovacion';

export type CampoFormulario = 'vin' | 'placa' | 'documentoVehiculo' | CampoPropietario | 'archivo';
export type Errores = Partial<Record<CampoFormulario, string>>;

/** En qué punto está la consulta al RUNT (la declara la página; aquí solo redacta la frase). */
export type FaseConsulta = 'inicial' | 'cargando' | 'ok' | 'fallo' | 'sin-banda' | 'vigente' | 'invalidada';

/** Lo que identifica al vehículo en el bloque 1, según el tipo. */
export interface DatosVehiculo { vin: string; placa: string; documentoVehiculo: string }

/** El validador de un campo. **El tipo de documento decide cuál se aplica al nombre.** */
export function validador(campo: CampoFormulario, tipoDocumento: string): ((v: string) => string | null) | null {
  switch (campo) {
    case 'vin': return errorVin;
    case 'placa': return errorPlaca;
    case 'documentoVehiculo': return errorDocumentoVehiculo;
    case 'tipoDocumento': return errorTipoDocumento;
    case 'numeroDocumento': return errorNumeroDocumento;
    case 'nombres': return esNit(tipoDocumento) ? null : errorNombres;
    case 'apellidos': return esNit(tipoDocumento) ? null : errorApellidos;
    case 'razonSocial': return esNit(tipoDocumento) ? errorRazonSocial : null;
    case 'correo': return errorCorreo;
    case 'celular': return errorCelular;
    case 'direccion': return errorDireccion;
    case 'municipio': return errorMunicipio;
    case 'departamento': return errorDepartamento;
    default: return null;
  }
}

/** Lo que la CONSULTA necesita: el VIN (Inicial) o la placa y el documento (Renovación). */
export function validarVehiculo(tipo: TipoSoat, v: DatosVehiculo): Errores {
  const errs: Errores = {};
  if (tipo === TipoSoat.RENOVACION) {
    const placa = errorPlaca(v.placa);
    const doc = errorDocumentoVehiculo(v.documentoVehiculo);
    if (placa) errs.placa = placa;
    if (doc) errs.documentoVehiculo = doc;
    return errs;
  }
  const msg = errorVin(v.vin);
  if (msg) errs.vin = msg;
  return errs;
}

/** Todas las reglas a la vez, en el ORDEN VISUAL: el primero que falle es al que va el foco. */
export function validarTodo(tipo: TipoSoat, v: DatosVehiculo, p: Propietario, archivo: File | null): Errores {
  const errs = validarVehiculo(tipo, v);
  const poner = (c: CampoFormulario, m: string | null) => { if (m) errs[c] = m; };
  poner('tipoDocumento', errorTipoDocumento(p.tipoDocumento));
  poner('numeroDocumento', errorNumeroDocumento(p.numeroDocumento));
  const campoNombre = (c: 'nombres' | 'apellidos' | 'razonSocial') => poner(c, validador(c, p.tipoDocumento)?.(p[c]) ?? null);
  campoNombre('razonSocial');
  campoNombre('nombres');
  campoNombre('apellidos');
  // La cota del DERIVADO, la misma del borde (dos topes de 200 sobre una columna de 200).
  if (!esNit(p.tipoDocumento) && !errs.nombres && !errs.apellidos) {
    const msg = errorNombreCompleto(p.nombres, p.apellidos);
    if (msg) { errs.nombres = msg; errs.apellidos = msg; }
  }
  poner('correo', errorCorreo(p.correo));
  poner('celular', errorCelular(p.celular));
  poner('direccion', errorDireccion(p.direccion));
  poner('municipio', errorMunicipio(p.municipio));
  poner('departamento', errorDepartamento(p.departamento));
  // La factura es obligatoria en Inicial y OPCIONAL en Renovación (HU #14019, AC2).
  if (!archivo && tipo !== TipoSoat.RENOVACION) errs.archivo = 'Adjunte la factura de venta en PDF.';
  return errs;
}

// ─────────────────── Lo que falta para enviar, dicho por su nombre (HU #12079) ──────────────────

/** El orden VISUAL de los campos del propietario (`archivo` no está: la caja de subida no tiene id al que llevar el foco). */
export const ORDEN_FOCO_BASE: CampoFormulario[] = [
  'tipoDocumento', 'numeroDocumento',
  ...CAMPOS_NOMBRE, 'correo', 'celular', 'direccion', 'municipio', 'departamento',
];

const ordenFoco = (tipo: TipoSoat): CampoFormulario[] =>
  [...(tipo === TipoSoat.RENOVACION ? ['placa', 'documentoVehiculo'] as const : ['vin'] as const), ...ORDEN_FOCO_BASE];

/**
 * El nombre VISIBLE de cada campo: el mismo literal que su `<label>`. Etiquetas y nunca valores: esta
 * frase se lee en voz alta y un valor ahí sería PII en una superficie que no la necesita.
 */
export const ETIQUETA_CAMPO: Record<CampoFormulario, string> = {
  tipoDocumento: 'Tipo de documento',
  numeroDocumento: 'Número de documento',
  vin: 'VIN',
  placa: 'Placa',
  documentoVehiculo: 'Documento del propietario',
  razonSocial: 'Razón social',
  nombres: 'Nombre/s',
  apellidos: 'Apellido/s',
  correo: 'Correo electrónico',
  celular: 'Celular',
  direccion: 'Dirección',
  municipio: 'Municipio',
  departamento: 'Departamento',
  archivo: 'Factura de venta',
};

/** El orden de la enumeración: el del foco, con la factura en su sitio (entre el vehículo y el propietario). */
const ordenFaltantes = (tipo: TipoSoat): CampoFormulario[] => {
  const o = ordenFoco(tipo);
  return tipo === TipoSoat.RENOVACION ? o : [o[0], 'archivo', ...o.slice(1)];
};

/** El ítem del RUNT, redactado según la fase, y **siempre el primero** (calca el rótulo del botón). */
const ITEM_RUNT: Record<FaseConsulta, string | null> = {
  inicial: 'consultar el RUNT',
  cargando: 'consultar el RUNT',
  fallo: 'consultar el RUNT',
  'sin-banda': 'consultar el RUNT',
  // Cuenta para que el primario siga bloqueado; la frase que se ve es `AVISO_VIGENTE`.
  vigente: 'consultar el RUNT',
  invalidada: 'volver a consultar el RUNT',
  ok: null,
};

/**
 * Todo lo que impide enviar, en el orden del foco. Lista vacía = el botón está activo. **Se deriva de
 * `validarTodo`**, la función que ya bloquea el envío: nunca de un `campo === ''` paralelo.
 */
export function faltaParaEnviar(
  tipo: TipoSoat, fase: FaseConsulta, v: DatosVehiculo, p: Propietario, archivo: File | null, porRevisar: number,
): string[] {
  const errs = validarTodo(tipo, v, p, archivo);
  const runt = ITEM_RUNT[fase];
  return [
    ...(runt ? [runt] : []),
    ...(porRevisar > 0 ? [itemRevision(porRevisar)] : []),
    ...ordenFaltantes(tipo).filter((c) => errs[c]).map((c) => ETIQUETA_CAMPO[c]),
  ];
}

/**
 * El ítem de la revisión pendiente (HU #12094, AC3), **siempre el SEGUNDO**. Es la ÚNICA variante de
 * singular/plural de esta plantilla: `/revisar \d+ datos? leídos?/`.
 */
function itemRevision(n: number): string {
  return n === 1 ? 'revisar 1 dato leído' : `revisar ${n} datos leídos`;
}

/** Copia el mapa sin una clave. Un `= undefined` dejaría la clave presente ante `in` y `Object.keys`. */
export function sinClave<K extends string, V>(mapa: Partial<Record<K, V>>, clave: K): Partial<Record<K, V>> {
  const n = { ...mapa };
  delete n[clave];
  return n;
}

/** El chip del bloque 2, uno por estado de la LECTURA. La lectura vacía no lleva chip. */
export function chipLectura(lectura: EstadoLectura): ReactNode {
  switch (lectura.fase) {
    case 'leyendo': return <StatusChip tone="active">Leyendo la factura…</StatusChip>;
    case 'ok': return <StatusChip tone="success">✓ Factura leída</StatusChip>;
    case 'fallo': return <StatusChip tone="warning">No se pudo leer</StatusChip>;
    default: return undefined;
  }
}

/**
 * «Para enviar falta: A, B y C.» — **una sola plantilla**. Tope de tres segmentos: cuando sobran, los dos
 * primeros nombres y «y N datos más».
 */
export function frasePendientes(items: string[]): string | null {
  if (items.length === 0) return null;
  const segmentos = items.length <= 3
    ? items
    : [...items.slice(0, 2), `${items.length - 2} datos más`];
  const ultimo = segmentos[segmentos.length - 1];
  const previos = segmentos.slice(0, -1);
  return `Para enviar falta: ${previos.length ? `${previos.join(', ')} y ${ultimo}` : ultimo}.`;
}

const ID_VEHICULO: Partial<Record<CampoFormulario, string>> = { placa: ID_PLACA, documentoVehiculo: ID_DOC_VEHICULO };

/**
 * El id del primer control inválido, o `null` (también cuando es el tipo de documento: `FlitSelect` se
 * enfoca a sí mismo al recibir `error`).
 */
export function primerErrorEnfocable(tipo: TipoSoat, errores: Errores): string | null {
  const primero = ordenFoco(tipo).find((c) => errores[c]);
  if (!primero || primero === 'tipoDocumento') return null;
  return ID_VEHICULO[primero] ?? ID_CAMPO[primero as keyof typeof ID_CAMPO] ?? null;
}
