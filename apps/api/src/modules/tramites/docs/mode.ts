// ADR-OPS-001 F2 — modo generación PDF: local vs proxy CEA.

import { env } from '../../../config/env.js';

export type PdfMode = 'local' | 'cea-proxy';

export function pdfMode(): PdfMode {
  const m = env.PDF_MODE;
  if (m === 'local') return 'local';
  if (m === 'cea-proxy') return 'cea-proxy';
  // legacy: CEA_DOCS_PROXY_ENABLED=false → local
  if (!env.CEA_DOCS_PROXY_ENABLED) return 'local';
  return 'cea-proxy';
}

export function useLocalPdf(): boolean {
  return pdfMode() === 'local';
}
