// FLITO Logística — lector PDF417 de respaldo para navegadores SIN BarcodeDetector (Safari iOS).
// Se importa SOLO con import() dinámico desde Escaner.tsx y únicamente cuando falta el detector nativo,
// así ni el JS ni el wasm (~0,9 MB) entran en ningún chunk inicial. El wasm lo empaqueta Vite como asset
// del mismo origen (`?url`): sin CDN ni URL externa.
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export interface DeteccionPdf417 { rawValue: string; boundingBox?: DOMRectReadOnly }
export interface DetectorPdf417 { detect(video: HTMLVideoElement): Promise<DeteccionPdf417[]> }

export async function crearDetectorPdf417(): Promise<DetectorPdf417> {
  await prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  const canvas = document.createElement('canvas');
  return {
    async detect(video) {
      const W = video.videoWidth; const H = video.videoHeight;
      if (!W || !H) return [];
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(video, 0, 0, W, H);
      const res = await readBarcodes(ctx.getImageData(0, 0, W, H), { formats: ['PDF417'], maxNumberOfSymbols: 1, tryHarder: true });
      return res.filter((r) => r.isValid && r.text).map((r) => {
        const p = r.position;
        const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
        const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
        const x = Math.min(...xs); const y = Math.min(...ys);
        return { rawValue: r.text, boundingBox: new DOMRectReadOnly(x, y, Math.max(...xs) - x, Math.max(...ys) - y) };
      });
    },
  };
}
