// Lectura del PÍXEL REALMENTE PINTADO por el navegador (Bug #11720 · retrabajo).
//
// POR QUÉ NO BASTA getComputedStyle
// El defecto que motivó este archivo fue exactamente un error de MODELO: un gate estático que
// recomponía la cadena de superficies «a mano» se saltó una capa (la barra `.flit-shell-sunken`
// que aloja los `kbd`) y dio verde sobre una pantalla que incumplía. Cualquier medición que
// vuelva a reconstruir la cadena capa por capa —incluida una que camine los ancestros con
// getComputedStyle— puede repetir el mismo error: se equivoca de padre, se olvida un `border`,
// no ve un gradiente o un `backdrop-filter`, y miente con la misma seguridad.
//
// El píxel compuesto no tiene modelo que equivocar: es lo que el usuario ve. Por eso aquí se
// hace una captura recortada al elemento y se decodifica el PNG a mano con `node:zlib` — sin
// añadir dependencias al repo (`pngjs` sólo existe como dependencia transitiva de Playwright y
// apoyarse en ella sería construir sobre algo que nadie declaró).
import { inflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';

export type RGB = [number, number, number];

interface Imagen {
  ancho: number;
  alto: number;
  /** Píxeles RGBA sin filtrar, 4 bytes por píxel. */
  datos: Buffer;
}

/** Decodifica un PNG de 8 bits, color type 2 (RGB) o 6 (RGBA) — los que emite Chromium. */
export function decodificarPng(buffer: Buffer): Imagen {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('El buffer no es un PNG.');
  let offset = 8;
  let ancho = 0;
  let alto = 0;
  let canales = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const largo = buffer.readUInt32BE(offset);
    const tipo = buffer.toString('ascii', offset + 4, offset + 8);
    const cuerpo = buffer.subarray(offset + 8, offset + 8 + largo);
    if (tipo === 'IHDR') {
      ancho = cuerpo.readUInt32BE(0);
      alto = cuerpo.readUInt32BE(4);
      const profundidad = cuerpo.readUInt8(8);
      const tipoColor = cuerpo.readUInt8(9);
      const entrelazado = cuerpo.readUInt8(12);
      if (profundidad !== 8 || (tipoColor !== 2 && tipoColor !== 6) || entrelazado !== 0) {
        throw new Error(
          `PNG no soportado (profundidad ${profundidad}, color ${tipoColor}, entrelazado ${entrelazado}).`,
        );
      }
      canales = tipoColor === 6 ? 4 : 3;
    } else if (tipo === 'IDAT') {
      idat.push(cuerpo);
    } else if (tipo === 'IEND') {
      break;
    }
    offset += largo + 12; // largo + tipo(4) + datos + CRC(4)
  }

  const crudo = inflateSync(Buffer.concat(idat));
  const bpp = canales;
  const anchoLinea = ancho * bpp;
  const salida = Buffer.alloc(ancho * alto * 4);

  let previa = Buffer.alloc(anchoLinea);
  for (let y = 0; y < alto; y++) {
    const inicio = y * (anchoLinea + 1);
    const filtro = crudo[inicio];
    const linea = Buffer.from(crudo.subarray(inicio + 1, inicio + 1 + anchoLinea));
    for (let i = 0; i < anchoLinea; i++) {
      const a = i >= bpp ? linea[i - bpp] : 0; // izquierda
      const b = previa[i]; // arriba
      const c = i >= bpp ? previa[i - bpp] : 0; // arriba-izquierda
      let valor = linea[i];
      if (filtro === 1) valor += a;
      else if (filtro === 2) valor += b;
      else if (filtro === 3) valor += (a + b) >> 1;
      else if (filtro === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        valor += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filtro !== 0) {
        throw new Error(`Filtro PNG desconocido: ${filtro}.`);
      }
      linea[i] = valor & 0xff;
    }
    for (let x = 0; x < ancho; x++) {
      const o = (y * ancho + x) * 4;
      salida[o] = linea[x * bpp];
      salida[o + 1] = linea[x * bpp + 1];
      salida[o + 2] = linea[x * bpp + 2];
      salida[o + 3] = bpp === 4 ? linea[x * bpp + 3] : 255;
    }
    previa = linea;
  }

  return { ancho, alto, datos: salida };
}

/**
 * Color de FONDO tal y como se pintó: el más repetido dentro del recuadro del elemento.
 * En un `kbd` o una fila de texto el relleno ocupa mucha más área que los glifos, así que la
 * moda es el fondo. Devuelve además cuánto pesa, para que un empate sospechoso se note.
 */
export async function fondoPintado(
  page: Page,
  locator: Locator,
): Promise<{ color: RGB; cobertura: number }> {
  const caja = await locator.boundingBox();
  if (!caja) throw new Error('El elemento no tiene caja: ¿está oculto?');
  // 1px hacia dentro: el borde de la pastilla no es su fondo.
  const clip = {
    x: caja.x + 1,
    y: caja.y + 1,
    width: Math.max(1, caja.width - 2),
    height: Math.max(1, caja.height - 2),
  };
  const png = await page.screenshot({ clip, animations: 'disabled' });
  const { ancho, alto, datos } = decodificarPng(png);

  const cuenta = new Map<number, number>();
  for (let i = 0; i < ancho * alto; i++) {
    const clave = (datos[i * 4] << 16) | (datos[i * 4 + 1] << 8) | datos[i * 4 + 2];
    cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  }
  let mejor = 0;
  let veces = 0;
  for (const [clave, n] of cuenta) {
    if (n > veces) {
      veces = n;
      mejor = clave;
    }
  }
  return {
    color: [(mejor >> 16) & 0xff, (mejor >> 8) & 0xff, mejor & 0xff],
    cobertura: veces / (ancho * alto),
  };
}

/**
 * Tinta EFECTIVA de un elemento (o de un pseudo como `::placeholder`) ya compuesta sobre el
 * fondo que se le pasa.
 *
 * No interpreta el string a mano a propósito: `getComputedStyle` devuelve hoy espacios de color
 * modernos —el `::placeholder` del preflight de Tailwind sale como `oklab(… / 0.5)`— y un regex
 * de `rgb()` o los daría por no-parseables o, peor, se comería los números creyendo que son
 * canales. Se pinta el color en un canvas 1×1 sobre el fondo real y se lee el resultado: el
 * mismo trabajo que hace el compositor, hecho por el navegador y no por este archivo. Para una
 * tinta opaca el resultado es la tinta misma.
 */
export async function tintaEfectiva(
  locator: Locator,
  fondo: RGB,
  pseudo: string | null = null,
): Promise<RGB> {
  return locator.evaluate(
    (el, [fondoCss, pseudoSel]) => {
      const color = getComputedStyle(el, (pseudoSel as string) || undefined).color;
      const lienzo = document.createElement('canvas');
      lienzo.width = 1;
      lienzo.height = 1;
      const ctx = lienzo.getContext('2d');
      if (!ctx) throw new Error('Sin contexto 2d para resolver el color.');
      // Un `fillStyle` que el canvas no sepa parsear se IGNORA y conserva el valor anterior:
      // saldría el fondo, ratio 1,00 y un fallo incomprensible. Con un centinela improbable se
      // distingue «no lo entendí» de «la tinta es de verdad igual al fondo», que es justo el
      // síntoma del bug original y tiene que poder reportarse como 1,00 y no como error.
      const CENTINELA = '#010203';
      ctx.fillStyle = CENTINELA;
      ctx.fillStyle = color;
      if (ctx.fillStyle === CENTINELA) {
        throw new Error(`El navegador no resolvió el color "${color}" (¿espacio no soportado?).`);
      }
      const tinta = ctx.fillStyle;
      ctx.fillStyle = fondoCss as string;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = tinta;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]] as [number, number, number];
    },
    [aHex(fondo), pseudo] as [string, string | null],
  );
}

const canal = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminancia = ([r, g, b]: RGB): number =>
  0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);

/** Ratio de contraste WCAG 2.x entre dos colores opacos. */
export function contraste(a: RGB, b: RGB): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export const aHex = (c: RGB): string =>
  '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
