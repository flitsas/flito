// FLITO OCR — parser determinístico de la factura de venta que emite FLIT (HU #12826, Épica #12809,
// Feature #12821). Funciones PURAS sobre el texto de `pdftotext -layout`: ni E/S, ni logs, ni OCR.
//
// La factura FLIT trae los datos del vehículo en el bloque «Notas Finales», como pares `Clave:valor`
// separados por barras, y la dirección del comprador en la columna derecha del bloque «Datos del
// Adquiriente». Leerlos de ahí cuesta cero llamadas al motor OCR y no saca la factura del perímetro;
// el OCR solo entra cuando el bloque no está (PDF escaneado, otra plantilla) — ver
// `flito-impuestos.extraccion.ts`.
//
// Minimización (Ley 1581): la tabla de claves es CERRADA. Lo que no está en ella —en particular
// `Numerodecontacto1`, un teléfono— se descarta y nunca sale de este archivo. Del adquiriente solo se
// leen dirección, ciudad y departamento; ni nombre, ni documento, ni correo, ni teléfono.

import type { CampoExtraido, ExtraccionFacturaVentaImpuestoCampos } from '@operaciones/shared-types';

/** Los 7 campos vehiculares que persiste el análisis post-envío (AC1). */
export const CAMPOS_VEHICULO_FACTURA = ['vin', 'marca', 'linea', 'anioVehiculo', 'color', 'cilindrada', 'clase'] as const;
export type CampoVehiculoFactura = (typeof CAMPOS_VEHICULO_FACTURA)[number];
export type ExtraccionVehiculoFactura = Record<CampoVehiculoFactura, CampoExtraido>;

/** Los 3 campos de dirección del adquiriente. */
export const CAMPOS_DIRECCION_FACTURA = ['direccion', 'municipio', 'departamento'] as const;
export type CampoDireccionFactura = (typeof CAMPOS_DIRECCION_FACTURA)[number];
export type DireccionAdquiriente = Record<CampoDireccionFactura, CampoExtraido>;

export const AUSENTE: CampoExtraido = Object.freeze({ valor: null, confianza: 0, confiable: false }) as CampoExtraido;
const ausente = (): CampoExtraido => ({ ...AUSENTE });
const valido = (valor: string, confianza = 1): CampoExtraido => ({ valor, confianza, confiable: true });
const dudoso = (crudo: string): CampoExtraido => ({ valor: crudo.slice(0, 100), confianza: 0.5, confiable: false });

/** NFD, sin diacríticos, minúsculas, solo alfanuméricos: «AñoVehículo» → `anovehiculo`. */
export function normalizarClave(clave: string): string {
  return clave.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─────────────────────────────── Normalizadores (también del fallback OCR) ───────────────────────────────

/** VIN: sin espacios (un salto de línea lo parte), mayúsculas, 17 caracteres sin I/O/Q. */
export function vinFacturaN(v: string): string | null {
  const s = v.replace(/\s/g, '').toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s : null;
}

/** Año del vehículo: 4 dígitos entre 1950 y el año en curso + 2. */
export function anioVehiculoN(v: string, ahora: Date = new Date()): string | null {
  const s = v.trim();
  if (!/^\d{4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1950 && n <= ahora.getUTCFullYear() + 2 ? s : null;
}

/** Cilindrada: solo los dígitos («1.598», «1598 cc» → `1598`). `0` es válido (eléctrico). */
export function cilindradaN(v: string): string | null {
  const s = v.replace(/\D/g, '');
  return /^\d{1,5}$/.test(s) ? String(Number(s)) : null;
}

const textoN = (max: number) => (v: string): string | null => {
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= max ? s : null;
};

/** Línea: 1–100 caracteres; un valor que parece un año («Modelo:2026») no es una línea. */
export function lineaN(v: string): string | null {
  const s = textoN(100)(v);
  return s && !/^\d{4}$/.test(s) ? s : null;
}

// ─────────────────────────────── Notas Finales ───────────────────────────────

/** Clave normalizada → campo. Cualquier otra clave se descarta (tabla cerrada). */
const CLAVES: Readonly<Record<string, CampoVehiculoFactura>> = {
  vin: 'vin',
  marca: 'marca',
  modelo: 'linea',
  linea: 'linea',
  anovehiculo: 'anioVehiculo',
  aniovehiculo: 'anioVehiculo',
  color: 'color',
  cilindrada: 'cilindrada',
  clase: 'clase',
};

const VALIDAR: Readonly<Record<CampoVehiculoFactura, (v: string) => string | null>> = {
  vin: vinFacturaN,
  marca: textoN(60),
  linea: lineaN,
  anioVehiculo: (v) => anioVehiculoN(v),
  color: textoN(60),
  cilindrada: cilindradaN,
  clase: textoN(60),
};

/** Líneas del bloque: desde `Notas Finales` hasta `Datos Totales` (o el final). `null` sin cabecera. */
function bloqueNotasFinales(texto: string): string[] | null {
  const lineas = texto.split(/\r?\n/);
  const ini = lineas.findIndex((l) => /^\s*Notas Finales\s*$/i.test(l));
  if (ini < 0) return null;
  const resto = lineas.slice(ini + 1);
  const fin = resto.findIndex((l) => /^\s*Datos Totales\b/i.test(l));
  return fin < 0 ? resto : resto.slice(0, fin);
}

/**
 * Parser del bloque «Notas Finales». `null` = sin bloque reconocible (sin cabecera, o ninguna de las
 * claves de la tabla): quien llama cae al OCR. Un bloque incompleto NO es `null`: los faltantes
 * quedan `confiable:false`.
 *
 * Confianza: valor válido → 1 / `confiable`; presente pero inválido o repetido con valores distintos
 * → 0.5 / no confiable; ausente → 0 / no confiable.
 */
export function parsearNotasFinales(texto: string): ExtraccionVehiculoFactura | null {
  const bloque = bloqueNotasFinales(texto);
  if (!bloque) return null;
  const unido = bloque.join(' ').replace(/\s+/g, ' ');

  const crudos = new Map<CampoVehiculoFactura, string[]>();
  for (const segmento of unido.split('|')) {
    const i = segmento.indexOf(':');
    if (i < 0) continue;
    const campo = CLAVES[normalizarClave(segmento.slice(0, i))];
    if (!campo) continue;
    const valor = segmento.slice(i + 1).trim();
    crudos.set(campo, [...(crudos.get(campo) ?? []), valor]);
  }
  if (crudos.size === 0) return null;

  const salida = {} as ExtraccionVehiculoFactura;
  for (const campo of CAMPOS_VEHICULO_FACTURA) {
    const vals = crudos.get(campo);
    if (!vals || vals.length === 0) { salida[campo] = ausente(); continue; }
    const normalizados = vals.map((v) => VALIDAR[campo](v));
    const distintos = new Set(normalizados.map((n, k) => n ?? `\u0000${vals[k]}`));
    const unico = normalizados[0];
    salida[campo] = distintos.size === 1 && unico !== null ? valido(unico) : dudoso(vals[0]);
  }
  return salida;
}

// ─────────────────────────────── Línea desde «Descripción» del producto ───────────────────────────────

/** Etiquetas que cortan el valor de la línea dentro de la descripción del producto. */
const CORTES_DESCRIPCION = /\b(?:MODELO|COLOR|MOTOR|CHASIS|VIN|SERIE|CILINDRADA|CLASE|MARCA|A[NÑ]O|TIPO|CARROCER[IÍ]A|COMBUSTIBLE|PLACA)\b/i;

/**
 * Fila de producto en el texto de `pdftotext -raw`: `No. Código Descripción U/M Cantidad Precio…`,
 * separados por UN espacio. La descripción es lo que queda entre el código y el par «U/M cantidad»
 * seguido de un importe (ancla: token + número + token con dígitos).
 *
 * Por qué `-raw` y no `-layout`: en la plantilla FLIT, `-layout` parte las palabras de la columna
 * «Descripción» con espacios espurios por el interletrado (medido en las 6 muestras: 12 letras
 * salen como 4 «palabras»); `-raw` las conserva enteras. Notas Finales y Adquiriente siguen en
 * `-layout`, que es el que respeta las dos columnas del adquiriente.
 */
const FILA_PRODUCTO = /^(\d{1,3})\s+\S+\s+(.+?)\s+\S+\s+\d+(?:[.,]\d+)?\s+\S*\d/;

/**
 * Descripción del producto de «Detalles de Productos» (decisión del humano, 2026-09-23: la línea
 * del vehículo viene ahí, no en Notas Finales), sobre el texto `-raw`. `unica` es `true` solo si la
 * factura tiene UNA fila de producto y es la `1`: con varias (accesorios, servicios) no se sabe
 * cuál es el vehículo y la regla no adivina.
 */
export function descripcionProducto(textoRaw: string): { descripcion: string; unica: boolean } | null {
  const filas = textoRaw.split(/\r?\n/).map((l) => FILA_PRODUCTO.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null);
  if (filas.length === 0) return null;
  const descripcion = filas[0][2].replace(/\s+/g, ' ').trim();
  return { descripcion, unica: filas.length === 1 && filas[0][1] === '1' };
}

/**
 * Regla ACOTADA para la línea desde la descripción del producto. Da `confiable: true` solo con un
 * patrón inequívoco:
 *   1. La etiqueta explícita `LINEA`/`LÍNEA` (con o sin `:`) → el valor que la sigue, hasta la
 *      siguiente etiqueta conocida (`MODELO`, `COLOR`, `MOTOR`…), una coma o el final.
 *   2. Sin etiqueta: la factura tiene UNA sola fila de producto y su descripción no trae ninguna
 *      etiqueta conocida → la descripción entera ES la línea (formato de las facturas FLIT de
 *      vehículo: la celda trae solo la línea). Si empieza por la marca de Notas Finales, se le quita.
 *
 * Todo lo demás (varias filas de producto, etiquetas de otros datos sin `LINEA`, valor vacío o que
 * parece un año) es DUDOSO y devuelve el campo ausente —`valor: null`, `confiable: false`— sin
 * fallar el paso ni llamar al OCR. Un campo no confiable no cuenta como diferencia en el semáforo
 * de la HU 12827 (ver `ExtraccionFacturaVentaImpuesto`).
 */
export function lineaDesdeDescripcion(
  producto: { descripcion: string; unica: boolean } | null, marca: string | null = null,
): CampoExtraido {
  if (!producto) return ausente();
  const { descripcion } = producto;
  const etiquetada = /\bL[IÍ]NEA\b\s*:?\s*(.+)$/i.exec(descripcion);
  if (etiquetada) {
    const v = lineaN(etiquetada[1].split(CORTES_DESCRIPCION)[0].split(/[,;|]/)[0].replace(/[-:.\s]+$/, ''));
    return v ? valido(v) : ausente();
  }
  if (!producto.unica || CORTES_DESCRIPCION.test(descripcion) || !/\p{L}/u.test(descripcion)) return ausente();
  let v = descripcion;
  if (marca && v.toUpperCase().startsWith(`${marca.toUpperCase()} `)) {
    v = v.slice(marca.length);
  }
  const linea = lineaN(v);
  return linea ? valido(linea) : ausente();
}

// ─────────────────────────────── Adquiriente ───────────────────────────────

const ETIQUETAS_ADQUIRIENTE: ReadonlyArray<[CampoDireccionFactura, RegExp, number]> = [
  ['direccion', /(?:^|\s{2,})Direcci[oó]n\s+(.+?)\s*$/, 300],
  ['municipio', /(?:^|\s{2,})Ciudad\s+(.+?)\s*$/, 100],
  ['departamento', /(?:^|\s{2,})Departamento\s+(.+?)\s*$/, 100],
];

/**
 * Dirección, ciudad y departamento del COMPRADOR: región desde `Datos del Adquiriente` hasta
 * `Detalles de Productos` (el Emisor, que va antes, usa las mismas etiquetas). Gana la primera
 * coincidencia de la región. Confianza 0.9: heurística de columnas, no una etiqueta con `:`. El
 * departamento se guarda como venga (puede ser un código); normalizarlo es de la HU 12833.
 */
export function parsearAdquiriente(texto: string): DireccionAdquiriente {
  const salida: DireccionAdquiriente = { direccion: ausente(), municipio: ausente(), departamento: ausente() };
  const lineas = texto.split(/\r?\n/);
  const ini = lineas.findIndex((l) => /Datos del Adquiriente/i.test(l));
  if (ini < 0) return salida;
  const region: string[] = [];
  for (const l of lineas.slice(ini)) {
    if (/Detalles de Productos/i.test(l)) break;
    region.push(l);
  }
  for (const [campo, re, max] of ETIQUETAS_ADQUIRIENTE) {
    for (const l of region) {
      const m = re.exec(l);
      if (!m) continue;
      const v = textoN(max)(m[1]);
      if (v) salida[campo] = valido(v, 0.9);
      break;
    }
  }
  return salida;
}

/** Las 10 claves que persiste el análisis, en el orden del jsonb. */
export function extraccionCompleta(
  vehiculo: Partial<ExtraccionVehiculoFactura>, direccion: Partial<DireccionAdquiriente>,
): ExtraccionFacturaVentaImpuestoCampos {
  const salida: ExtraccionFacturaVentaImpuestoCampos = {};
  for (const c of CAMPOS_VEHICULO_FACTURA) salida[c] = vehiculo[c] ?? ausente();
  for (const c of CAMPOS_DIRECCION_FACTURA) salida[c] = direccion[c] ?? ausente();
  return salida;
}
