// Texto impreso de un PDF de pdf-lib: infla cada flujo y decodifica los `Tj` hexadecimales.
import zlib from 'zlib';

export function textoDelPdf(pdf: Buffer): string {
  const trozos: string[] = [];
  let i = 0;
  for (;;) {
    const marca = pdf.indexOf(Buffer.from('stream'), i);
    if (marca === -1) break;
    let ini = marca + 6;
    if (pdf[ini] === 0x0d) ini++;
    if (pdf[ini] === 0x0a) ini++;
    const fin = pdf.indexOf(Buffer.from('endstream'), ini);
    if (fin === -1) break;
    const bruto = pdf.subarray(ini, fin);
    let c: string;
    try { c = zlib.inflateSync(bruto).toString('latin1'); } catch { c = bruto.toString('latin1'); }
    for (const [, hex] of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) trozos.push(Buffer.from(hex, 'hex').toString('latin1'));
    i = fin + 9;
  }
  return trozos.join('\n');
}
