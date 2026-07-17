// TRAM-TRASPASO-F2.2 — subida de documentos con OCR (reuso del wizard matrícula).

import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import type { ArchivoData, OcrResult } from './wizard/types';

const OCR_TIPOS = ['impronta', 'soat'] as const;

export function useTramiteDocUpload(tramiteId: number, opts?: { vin?: string }) {
  const [archivos, setArchivos] = useState<ArchivoData[]>([]);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [ocrResults, setOcrResults] = useState<Record<string, OcrResult>>({});

  const cargarDocs = useCallback(async () => {
    try { setArchivos(await api.get<ArchivoData[]>(`/tramites/${tramiteId}/documentos`)); }
    catch { setArchivos([]); }
  }, [tramiteId]);

  const subirDoc = async (tipo: string, fileOrig: File) => {
    let file: File = fileOrig;
    setOcrResults((p) => { const n = { ...p }; delete n[tipo]; return n; });
    setUploading((p) => ({ ...p, [tipo]: true }));
    const token = localStorage.getItem('token');
    try {
      if ((OCR_TIPOS as readonly string[]).includes(tipo)) {
        toast.loading(`Analizando ${tipo}...`, { id: `ocr-${tipo}` });
        const ocrForm = new FormData();
        ocrForm.append('file', file);
        const ocrRes = await fetch(`/api/tramites/ocr/${tipo}`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: ocrForm,
        });
        if (ocrRes.ok) {
          const ocrData = await ocrRes.json();
          if (ocrData.ok && ocrData.data) {
            const d = ocrData.data;
            const esValido = d.es_factura_valida ?? d.es_valido ?? false;
            if (!esValido) {
              toast.error(`El documento NO es un ${tipo} válido.`, { id: `ocr-${tipo}`, duration: 6000 });
              d._rechazado = true;
              d._motivo = 'Tipo de documento incorrecto';
            }
            const vinTramite = (opts?.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            const vinDoc = (d.vehiculo_vin || d.vehiculo_chasis || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (!d._rechazado && vinTramite && vinDoc && vinDoc !== vinTramite) {
              toast.error(`VIN no coincide con el trámite.`, { id: `ocr-${tipo}`, duration: 8000 });
              d._rechazado = true;
              d._motivo = `VIN documento=${vinDoc}, trámite=${vinTramite}`;
            }
            if (d._extracted_filename) {
              try {
                const extRes = await fetch(`/api/tramites/ocr-extracted/${d._extracted_filename}`, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (extRes.ok) {
                  const blob = await extRes.blob();
                  file = new File([blob], `${tipo}_extraido.pdf`, { type: 'application/pdf' });
                }
              } catch { /* usar original */ }
            }
            setOcrResults((p) => ({ ...p, [tipo]: d }));
            if (d._rechazado) {
              toast.dismiss(`ocr-${tipo}`);
              return;
            }
            toast.success(`${tipo} verificado`, { id: `ocr-${tipo}` });
          } else {
            toast.error(ocrData.message || 'No se pudo analizar', { id: `ocr-${tipo}` });
            return;
          }
        } else {
          toast.error('Error analizando documento.', { id: `ocr-${tipo}` });
          return;
        }
      }
      const form = new FormData();
      form.append('file', file);
      form.append('tipo', tipo);
      const res = await fetch(`/api/tramites/${tramiteId}/documentos`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) throw new Error('Error subiendo archivo');
      const doc = await res.json();
      setArchivos((prev) => [...prev.filter((a) => a.tipo !== tipo), doc]);
      toast.success(`${tipo} cargado`);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setUploading((p) => ({ ...p, [tipo]: false })); }
  };

  return { archivos, uploading, ocrResults, cargarDocs, subirDoc, setArchivos };
}
