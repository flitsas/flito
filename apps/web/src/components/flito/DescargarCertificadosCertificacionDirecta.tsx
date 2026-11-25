// FLITO — «Certificar sin trámite»: descarga masiva de certificados RUNT en ZIP (HU #14665, AC8).
// Endpoint HERMANO del de la cola CON trámite (HU #13205/#13206, `DescargarCertificadosZip.tsx`):
// se reutilizan de allí, SIN tocarlas, el botón (`DescargarCertificadosZip`), la banda de aviso
// (`AvisoCertificadosZip`) y las funciones de copy (`avisoDeCertificados`, `avisoDeExitoCertificados`)
// — son agnósticas de la ruta. Lo único propio de esta pantalla es la ruta del endpoint y el estado
// de la descarga, que es lo que vive aquí.
//
// Sin tope cliente del lote: el listado de esta pantalla ya limita a 100 filas (`TOPE_LISTA` en el
// backend), el mismo máximo que acepta `idsLoteSchema`, así que una selección «todas» nunca lo supera.
import { useCallback, useRef, useState } from 'react';
import { CABECERA_CERTIFICADOS_OMITIDOS } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { esNombreDeExport } from './ExportarCola';
import {
  avisoDeCertificados, avisoDeExitoCertificados,
  type AvisoCertificados, type EstadoDescargaCertificados, type PlacaDe,
} from './DescargarCertificadosZip';

const RUTA = '/flito/impuestos/certificacion-directa/certificados/zip';
const PREFIJO_ZIP = 'certificados-runt';
const NOMBRE_RESPALDO = 'certificados-runt.zip';

/** Un entero no negativo de una cabecera, o `null`. Mismo guardia que el hermano. */
function cifraDeCabecera(bruto: string | null): number | null {
  const n = bruto === null || bruto.trim() === '' ? Number.NaN : Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Mismo hook que `useDescargaCertificados` de la cola, apuntando al ZIP de «Certificar sin trámite». */
export function useDescargaCertificadosDirecta(): EstadoDescargaCertificados {
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoCertificados | null>(null);
  const [marcadas, setMarcadas] = useState(0);
  const enVuelo = useRef(false);
  const ultima = useRef<{ ids: string[]; placaDe: PlacaDe } | null>(null);

  const descargar = useCallback((ids: string[], placaDe: PlacaDe) => {
    if (enVuelo.current || ids.length === 0) return;
    setMarcadas(ids.length);
    enVuelo.current = true;
    ultima.current = { ids, placaDe };
    setOcupado(true);
    setAviso(null);

    let omitidos: number | null = null;
    api.downloadPostNamed(
      RUTA,
      NOMBRE_RESPALDO,
      { ids },
      (n) => esNombreDeExport(PREFIJO_ZIP, n, 'zip'),
      (leer) => { omitidos = cifraDeCabecera(leer(CABECERA_CERTIFICADOS_OMITIDOS)); },
    )
      .then((nombre) => setAviso(avisoDeExitoCertificados(nombre, omitidos, ids.length)))
      .catch((e) => setAviso(avisoDeCertificados(e, ids.length, placaDe)))
      .finally(() => {
        enVuelo.current = false;
        setOcupado(false);
      });
  }, []);

  const reintentar = useCallback(() => {
    const previa = ultima.current;
    if (previa) descargar(previa.ids, previa.placaDe);
  }, [descargar]);

  const descartar = useCallback(() => setAviso(null), []);

  return { ocupado, aviso, marcadas, descargar, reintentar, descartar };
}
