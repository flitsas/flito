// Dr. Flit — «Necesito soporte»: modelo puro del caso (HU #13806, Feature #13695; anexo UX F5).
// Sin React ni `api`: validación del cliente (los mismos topes que el servidor, `LIMITES_CASO_SOPORTE`),
// copy de errores de campo y armado del cuerpo `CasoSoporteDrFlit`. Nada de esto toca almacenamiento.

import {
  AREA_SOPORTE_POR_ROL, LIMITES_CASO_SOPORTE as L,
  type AreaSoporte, type CasoSoporteDrFlit, type FrecuenciaSoporte, type PrioridadSoporte, type UserRole,
} from '@operaciones/shared-types';

/**
 * Pasos del asistente. HU #13806 entrega Contacto → Caso → Resumen; el paso «Archivos» del anexo (F5.4 F)
 * lo añade la HU #13807 con los adjuntos (multipart, #13805). Insertarlo aquí actualiza «Paso N de M».
 */
export const PASOS_SOPORTE = ['contacto', 'caso', 'resumen'] as const;
export type PasoSoporte = (typeof PASOS_SOPORTE)[number];

export const TITULOS_PASO: Readonly<Record<PasoSoporte, string>> = Object.freeze({
  contacto: 'Sus datos de contacto',
  caso: 'Su caso',
  resumen: 'Revise y confirme',
});

export interface CamposSoporte {
  nombre: string;
  correo: string;
  telefono: string;
  area: AreaSoporte | '';
  titulo: string;
  detalle: string;
  resultadoEsperado: string;
  frecuencia: FrecuenciaSoporte | '';
  prioridad: PrioridadSoporte | '';
}
export type CampoSoporte = keyof CamposSoporte;

/** Orden de los campos en pantalla: el primero con error recibe el foco. */
export const CAMPOS_POR_PASO: Readonly<Record<Exclude<PasoSoporte, 'resumen'>, readonly CampoSoporte[]>> = Object.freeze({
  contacto: ['nombre', 'correo', 'telefono'],
  caso: ['area', 'titulo', 'detalle', 'resultadoEsperado', 'frecuencia', 'prioridad'],
});

export function pasoDeCampo(campo: CampoSoporte): Exclude<PasoSoporte, 'resumen'> {
  return CAMPOS_POR_PASO.contacto.includes(campo) ? 'contacto' : 'caso';
}

/** Topes visibles (`maxLength` y contador) por campo de texto. */
export const MAXIMOS: Readonly<Partial<Record<CampoSoporte, number>>> = Object.freeze({
  nombre: L.nombre.max,
  correo: L.correo.max,
  telefono: L.telefono.max,
  titulo: L.titulo.max,
  detalle: L.detalle.max,
  resultadoEsperado: L.resultadoEsperado.max,
});

/** Desde cuántos caracteres se muestra el contador «N/máx» (F5.7). */
export const CONTADOR_DESDE: Readonly<Partial<Record<CampoSoporte, number>>> = Object.freeze({
  titulo: 100,
  detalle: 1800,
  resultadoEsperado: 900,
});

/** Prellenado (F5.8): nombre y correo de la sesión (editables), área por rol; el resto vacío. */
export function camposIniciales(user: { name?: string; username?: string; role?: UserRole } | null): CamposSoporte {
  const usuario = user?.username ?? '';
  return {
    nombre: (user?.name ?? '').slice(0, L.nombre.max),
    // La sesión no trae un correo propio: si el usuario entra con su correo, se ofrece; si no, vacío.
    correo: CORREO.test(usuario) ? usuario.slice(0, L.correo.max) : '',
    telefono: '',
    area: (user?.role && AREA_SOPORTE_POR_ROL[user.role]) || '',
    titulo: '',
    detalle: '',
    resultadoEsperado: '',
    frecuencia: '',
    prioridad: '',
  };
}

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO = /^\+?[0-9 ]+$/;

/** Error del cliente (copy de F5.7), o `null` si el campo es válido. Siempre con `trim`. */
export function errorDeCampo(campo: CampoSoporte, c: CamposSoporte): string | null {
  const v = String(c[campo]).trim();
  switch (campo) {
    case 'nombre':
      return v ? null : 'Escriba su nombre.';
    case 'correo':
      if (!v) return 'Escriba su correo.';
      return CORREO.test(v) && v.length >= L.correo.min ? null : 'Revise el correo; debe ser como nombre@empresa.co.';
    case 'telefono': {
      if (!v) return null;
      const digitos = v.replace(/\D/g, '').length;
      return TELEFONO.test(v) && digitos >= 7 && digitos <= 15 ? null : 'Revise el teléfono: escriba de 7 a 15 números.';
    }
    case 'area':
      return v ? null : 'Elija el área.';
    case 'titulo':
      if (!v) return 'Escriba un título para su caso.';
      return v.length >= L.titulo.min ? null : `Escriba un título de al menos ${L.titulo.min} caracteres.`;
    case 'detalle':
      if (!v) return 'Describa qué pasó.';
      return v.length >= L.detalle.min ? null : `Describa qué pasó con al menos ${L.detalle.min} caracteres.`;
    case 'resultadoEsperado':
      return v ? null : 'Escriba qué esperaba que pasara.';
    case 'frecuencia':
      return v ? null : 'Elija con qué frecuencia pasa.';
    case 'prioridad':
      return v ? null : 'Elija la prioridad.';
    default:
      return null;
  }
}

/**
 * Copy del cliente cuando el SERVIDOR rechaza un campo que el cliente daba por bueno (400 por campo,
 * F5.9). Nunca se pinta el mensaje del servidor.
 */
const REVISAR: Readonly<Record<CampoSoporte, string>> = Object.freeze({
  nombre: 'Revise su nombre.',
  correo: 'Revise el correo; debe ser como nombre@empresa.co.',
  telefono: 'Revise el teléfono: escriba de 7 a 15 números.',
  area: 'Elija el área.',
  titulo: 'Revise el título de su caso.',
  detalle: 'Revise la descripción de lo que pasó.',
  resultadoEsperado: 'Revise qué esperaba que pasara.',
  frecuencia: 'Elija con qué frecuencia pasa.',
  prioridad: 'Elija la prioridad.',
});

export function errorMostrado(campo: CampoSoporte, c: CamposSoporte, rechazados: ReadonlySet<CampoSoporte>): string | null {
  return errorDeCampo(campo, c) ?? (rechazados.has(campo) ? REVISAR[campo] : null);
}

/** Primer campo inválido del paso (orden de pantalla), o `null` si el paso es válido. */
export function primerError(
  paso: Exclude<PasoSoporte, 'resumen'>, c: CamposSoporte, rechazados: ReadonlySet<CampoSoporte>,
): CampoSoporte | null {
  return CAMPOS_POR_PASO[paso].find((campo) => errorMostrado(campo, c, rechazados) !== null) ?? null;
}

/** Ruta de campo del 400 del servidor (`contacto.correo`, `titulo`…) → campo del asistente. */
export function campoDeRutaServidor(ruta: unknown): CampoSoporte | null {
  if (typeof ruta !== 'string') return null;
  const ultimo = ruta.split('.').pop() ?? '';
  return ultimo in REVISAR ? (ultimo as CampoSoporte) : null;
}

/** Cuerpo de `POST /casos-soporte`. Se arma SOLO al pulsar «Confirmar» o «Reintentar». */
export function cuerpoDelCaso(c: CamposSoporte, claveIdempotencia: string): CasoSoporteDrFlit {
  const telefono = c.telefono.trim();
  return {
    claveIdempotencia,
    contacto: { nombre: c.nombre.trim(), correo: c.correo.trim(), ...(telefono ? { telefono } : {}) },
    area: c.area as AreaSoporte,
    titulo: c.titulo.trim(),
    detalle: c.detalle.trim(),
    resultadoEsperado: c.resultadoEsperado.trim(),
    frecuencia: c.frecuencia as FrecuenciaSoporte,
    prioridad: c.prioridad as PrioridadSoporte,
  };
}

/** UUID v4 por caso (idempotencia, P9-11). `randomUUID` exige contexto seguro; si no, se arma a mano. */
export function nuevaClaveIdempotencia(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fecha del resumen, formato `es-CO` (la definitiva la sella el servidor). */
export function fechaDelReporte(ahora = new Date()): string {
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(ahora);
}
