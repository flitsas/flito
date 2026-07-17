import { describe, it, expect } from 'vitest';
import {
  registry,
  pesvEvidenciaUploadTotal,
  pesvEvidenciaUploadSizeBytes,
  pesvDiagnosticoCerradoTotal,
  pesvEvidenciaUploadInflight,
} from '../../src/shared/metrics.js';

describe('PESV-07 · métricas Prometheus', () => {
  it('registra y expone las 4 métricas PESV + default metrics', async () => {
    pesvEvidenciaUploadTotal.inc({ result: 'success', mime: 'application/pdf' });
    pesvEvidenciaUploadSizeBytes.observe(123456);
    pesvDiagnosticoCerradoTotal.inc();
    pesvEvidenciaUploadInflight.inc();

    const out = await registry.metrics();
    expect(out).toContain('pesv_evidencia_upload_total');
    expect(out).toContain('pesv_evidencia_upload_size_bytes');
    expect(out).toContain('pesv_diagnostico_cerrado_total');
    expect(out).toContain('pesv_evidencia_upload_inflight');
    // Default metrics de runtime con el prefijo configurado.
    expect(out).toContain('operaciones_');
    // El counter etiquetado refleja el incremento.
    expect(out).toMatch(/pesv_evidencia_upload_total\{result="success",mime="application\/pdf"\}\s+\d/);

    pesvEvidenciaUploadInflight.dec();
  });

  it('Content-Type del registro es el formato de exposición Prometheus', () => {
    expect(registry.contentType).toMatch(/text\/plain/);
  });
});
