// FLITO Impuestos — comparación PURA factura de venta vs RUNT y cálculo del semáforo (HU #12827,
// Épica #12809, Feature #12822). Sin red ni base: el paso (`flito-impuestos.comparacion.ts`) consulta
// el RUNT y persiste; aquí solo se decide.
//
// Campos (AC1), en este orden: vin, marca, linea (línea de la factura vs línea del RUNT), anio
// (`anioVehiculo` de la factura vs AÑO MODELO del RUNT, `modelo`), color y cilindrada. La placa NO se
// compara contra la factura.
//
// Resultado por campo: `coincide` | `difiere` | `no_verificable`. Es `no_verificable` si la factura
// trae el campo con `confiable:false` o sin valor (origen `factura`), o si el RUNT no lo publica
// (origen `runt`). `no_verificable` NO cuenta como diferencia.
//
// Reglas de «coincide»:
//   vin         identificador normalizado (`normalizarIdentificador`), exacto.
//   marca       texto normalizado igual tras un mapa CERRADO de sinónimos (VW → VOLKSWAGEN…), o
//               inclusión por tokens.
//   linea       texto normalizado igual o inclusión por tokens.
//   anio        primer grupo de 4 dígitos, exacto.
//   color       texto normalizado con género/sinónimo por token (BLANCA → BLANCO, PLATEADO → PLATA),
//               igual o inclusión por tokens (BLANCO PERLA vs BLANCO).
//   cilindrada  solo dígitos → entero. Tolerancia de 1 % o 10 cc, lo que sea mayor (decisión del
//               humano, 2026-09-23: 1598 vs 1600 coincide; 1598 vs 1800 difiere). AC3 eléctricos:
//               factura 0 y RUNT 0 o vacío → coincide con `nota: 'electrico'`; factura 0 y RUNT > 0
//               → difiere.
//
// Inclusión por tokens: coincide si todos los tokens del valor más corto están en el más largo,
// siempre que el corto tenga al menos un token «alfabético»: empieza por letra y tiene ≥ 2
// caracteres. Ejemplos inventados: `K3` vs `K3 CROSS` coincide; `4X4` o `2.0` solos no alcanzan.
// Normalizar texto: sin tildes, mayúsculas, sin paréntesis ni su contenido (`GRIS (V)` → `GRIS`),
// puntuación → espacio.
//
// Semáforo (decisión del humano, 2026-09-23):
//   naranja  algún campo `difiere`, o el VIN no `coincide` (distinto o no verificable), o ningún
//            campo se pudo verificar.
//   verde    el VIN coincide y ningún otro campo verificable difiere.
// Preferimos un falso naranja (lo revisa una persona) a un falso verde.
//
// Factura ilegible (AC2): ningún campo comparable de la factura es fiable → el paso da rojo
// `error_lectura_factura` sin consultar el RUNT. Lo decide `facturaIlegible`.

import {
  CAMPOS_COMPARACION_FACTURA_RUNT,
  type CampoComparacionFacturaRunt,
  type CampoExtraido,
  type ComparacionCampoFacturaRunt,
  type ComparacionFacturaRunt,
  type ExtraccionFacturaVentaImpuesto,
} from '@operaciones/shared-types';
import { normalizarIdentificador, normalizarTexto } from './certificacion-runt.js';

/** Lo que se usa del RUNT. `modelo` es el año modelo. */
export interface DatosComparablesRunt {
  vin: string | null;
  marca: string | null;
  linea: string | null;
  modelo: string | null;
  color: string | null;
  cilindraje: string | null;
}

/** Campo del contrato → clave de la extracción de la factura (HU #12826). */
const CLAVE_FACTURA: Record<CampoComparacionFacturaRunt, keyof ExtraccionFacturaVentaImpuesto> = {
  vin: 'vin', marca: 'marca', linea: 'linea', anio: 'anioVehiculo', color: 'color', cilindrada: 'cilindrada',
};

const CLAVE_RUNT: Record<CampoComparacionFacturaRunt, keyof DatosComparablesRunt> = {
  vin: 'vin', marca: 'marca', linea: 'linea', anio: 'modelo', color: 'color', cilindrada: 'cilindraje',
};

/** Cerrado a propósito: ampliarlo es un cambio de código revisado, no configuración. */
const SINONIMOS_MARCA: Readonly<Record<string, string>> = {
  VW: 'VOLKSWAGEN',
  MERCEDES: 'MERCEDES BENZ',
  'GM CHEVROLET': 'CHEVROLET',
};

const SINONIMOS_COLOR: Readonly<Record<string, string>> = {
  BLANCA: 'BLANCO', NEGRA: 'NEGRO', ROJA: 'ROJO', PLATEADO: 'PLATA', PLATEADA: 'PLATA',
};

/** Tolerancia de cilindrada: 1 % o 10 cc, lo que sea mayor. */
export const TOLERANCIA_CILINDRADA_CC = 10;
export const TOLERANCIA_CILINDRADA_PCT = 0.01;

/** Texto comparable: `normalizarTexto` + sin paréntesis y su contenido + puntuación → espacio. */
export function textoComparable(v: unknown): string | null {
  const base = normalizarTexto(v);
  if (!base) return null;
  const s = base.replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();
  return s.length > 0 ? s : null;
}

const tokens = (s: string): string[] => s.split(' ').filter(Boolean);
const esAlfabetico = (t: string): boolean => /^[A-Z][A-Z0-9]+$/.test(t);

/** Todos los tokens del más corto están en el más largo, y el corto trae al menos un token alfabético. */
export function inclusionPorTokens(a: string, b: string): boolean {
  const [corto, largo] = tokens(a).length <= tokens(b).length ? [tokens(a), tokens(b)] : [tokens(b), tokens(a)];
  if (!corto.some(esAlfabetico)) return false;
  const set = new Set(largo);
  return corto.every((t) => set.has(t));
}

const conSinonimo = (s: string, mapa: Readonly<Record<string, string>>): string => mapa[s] ?? s;
const colorCanonico = (s: string): string => tokens(s).map((t) => conSinonimo(t, SINONIMOS_COLOR)).join(' ');

function textoCoincide(f: string, r: string): boolean {
  return f === r || inclusionPorTokens(f, r);
}

const anio = (v: string): number | null => {
  const m = /\d{4}/.exec(v);
  return m ? Number(m[0]) : null;
};

const entero = (v: string): number | null => {
  const d = v.replace(/\D/g, '');
  return d.length > 0 ? Number(d) : null;
};

/** 1598 vs 1600 coincide; 1598 vs 1800 no. */
export function cilindradaDentroDeTolerancia(a: number, b: number): boolean {
  const tope = Math.max(TOLERANCIA_CILINDRADA_CC, Math.max(a, b) * TOLERANCIA_CILINDRADA_PCT);
  return Math.abs(a - b) <= tope;
}

/** Valor de la factura solo si el parser/OCR lo dio por fiable. */
function valorFiable(c: CampoExtraido | undefined): string | null {
  if (!c?.confiable) return null;
  const v = c.valor?.trim();
  return v ? v : null;
}

type Resultado = Pick<ComparacionCampoFacturaRunt, 'resultado' | 'origenNoVerificable' | 'nota'>;
const NO_FACTURA: Resultado = { resultado: 'no_verificable', origenNoVerificable: 'factura' };
const NO_RUNT: Resultado = { resultado: 'no_verificable', origenNoVerificable: 'runt' };
const decidir = (coincide: boolean): Resultado => ({ resultado: coincide ? 'coincide' : 'difiere' });

function compararCampo(campo: CampoComparacionFacturaRunt, f: string | null, r: string | null): Resultado {
  if (campo === 'cilindrada') {
    const cf = f === null ? null : entero(f);
    if (cf === null) return NO_FACTURA;
    const cr = r === null ? null : entero(r);
    // AC3: un eléctrico no tiene cilindrada; el RUNT puede publicar 0 o nada.
    if (cf === 0 && (cr === null || cr === 0)) return { resultado: 'coincide', nota: 'electrico' };
    if (cr === null) return NO_RUNT;
    return decidir(cilindradaDentroDeTolerancia(cf, cr));
  }
  if (campo === 'vin') {
    const vf = normalizarIdentificador(f);
    if (!vf) return NO_FACTURA;
    const vr = normalizarIdentificador(r);
    return vr ? decidir(vf === vr) : NO_RUNT;
  }
  if (campo === 'anio') {
    const af = f === null ? null : anio(f);
    if (af === null) return NO_FACTURA;
    const ar = r === null ? null : anio(r);
    return ar === null ? NO_RUNT : decidir(af === ar);
  }
  let tf = textoComparable(f);
  if (!tf) return NO_FACTURA;
  let tr = textoComparable(r);
  if (!tr) return NO_RUNT;
  if (campo === 'marca') { tf = conSinonimo(tf, SINONIMOS_MARCA); tr = conSinonimo(tr, SINONIMOS_MARCA); }
  if (campo === 'color') { tf = colorCanonico(tf); tr = colorCanonico(tr); }
  return decidir(textoCoincide(tf, tr));
}

/** AC2: ningún campo comparable de la factura tiene un valor fiable. */
export function facturaIlegible(e: ExtraccionFacturaVentaImpuesto): boolean {
  return CAMPOS_COMPARACION_FACTURA_RUNT.every((c) => valorFiable(e[CLAVE_FACTURA[c]] as CampoExtraido | undefined) === null);
}

export function resumir(campos: ComparacionCampoFacturaRunt[]): ComparacionFacturaRunt['resumen'] {
  const n = (r: ComparacionCampoFacturaRunt['resultado']) => campos.filter((c) => c.resultado === r).length;
  return { coinciden: n('coincide'), difieren: n('difiere'), noVerificables: n('no_verificable') };
}

/** Verde solo con el VIN coincidente y ninguna diferencia (decisión del humano, 2026-09-23). */
export function semaforoDeCampos(campos: ComparacionCampoFacturaRunt[]): 'verde' | 'naranja' {
  const vin = campos.find((c) => c.campo === 'vin');
  if (vin?.resultado !== 'coincide') return 'naranja';
  return campos.some((c) => c.resultado === 'difiere') ? 'naranja' : 'verde';
}

export function compararFacturaConRunt(
  e: ExtraccionFacturaVentaImpuesto, r: DatosComparablesRunt, ahora: Date = new Date(),
): { semaforo: 'verde' | 'naranja'; comparacion: ComparacionFacturaRunt } {
  const campos = CAMPOS_COMPARACION_FACTURA_RUNT.map((campo): ComparacionCampoFacturaRunt => {
    const valorFactura = valorFiable(e[CLAVE_FACTURA[campo]] as CampoExtraido | undefined);
    const valorRunt = r[CLAVE_RUNT[campo]]?.trim() || null;
    return { campo, ...compararCampo(campo, valorFactura, valorRunt), valorFactura, valorRunt };
  });
  return {
    semaforo: semaforoDeCampos(campos),
    comparacion: { version: 1, motivo: null, campos, resumen: resumir(campos), calculadoEn: ahora.toISOString() },
  };
}
