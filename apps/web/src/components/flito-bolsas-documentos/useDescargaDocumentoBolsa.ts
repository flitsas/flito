// Descarga de una versión del expediente (HU #13892). Blob por `lib/api.ts` con el nombre del servidor
// (ADR-0028 D6). Candado por id contra el doble clic, como `DocumentosAdicionalesLista`; sin toast de
// éxito (la descarga del navegador es el resultado) y con toast de error cerrable.
import { useCallback, useRef, useState } from 'react';
import type { DocumentoBolsaDto } from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { errorBolsa } from '../../lib/bolsas';
import { nombreDocumento, nombreRespaldo } from '../../lib/bolsasDocumentos';
import { toastError } from '../flit/ToastFlito';

export function useDescargaDocumentoBolsa() {
  const candado = useRef(new Set<string>());
  const [enCurso, setEnCurso] = useState<ReadonlySet<string>>(new Set());

  const descargar = useCallback(async (doc: Pick<DocumentoBolsaDto, 'id' | 'tipo' | 'version' | 'mime'>) => {
    if (candado.current.has(doc.id)) return;
    candado.current.add(doc.id);
    setEnCurso(new Set(candado.current));
    try {
      await bolsasDocumentosApi.descargar(doc.id, nombreRespaldo(doc.tipo, doc.version, doc.mime));
    } catch (e) {
      if (errorBolsa(e).status === 404) {
        toastError('Ese archivo ya no está disponible.', undefined, { id: `bolsa-doc-descarga-${doc.id}` });
      } else {
        toastError(`No pudimos descargar ${nombreDocumento(doc.tipo)}. Intenta de nuevo.`,
          () => { void descargar(doc); }, { id: `bolsa-doc-descarga-${doc.id}` });
      }
    } finally {
      candado.current.delete(doc.id);
      setEnCurso(new Set(candado.current));
    }
  }, []);

  return { descargar, enCurso };
}

export const BOTON_ICONO =
  'flit-focus grid h-10 w-10 shrink-0 place-items-center rounded-[999px] border bg-flit-card transition-colors hover:bg-[var(--flit-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
