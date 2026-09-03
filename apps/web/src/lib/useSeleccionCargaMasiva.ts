// FLITO — el estado de «lo que se eligió» en los dos modales de carga masiva (HU #12056).
//
// Los modales siguen sin unificarse (Impuestos tiene el checkbox de marca de agua), pero elegir
// archivos es idéntico en los dos y ahora tiene una arista que no se puede duplicar a mano: al
// elegir un ZIP hay una espera, y durante esa espera el picker sigue vivo. Si el operador elige
// otra cosa mientras tanto, la lectura anterior NO puede pintar su resultado tarde y dejar en
// pantalla el conteo de un ZIP que ya nadie va a subir.

import { useRef, useState } from 'react';
import {
  SELECCION_CARGA_VACIA, esZipCargaMasiva, seleccionCargaMasiva, type SeleccionCarga,
} from './carga-masiva';

export default function useSeleccionCargaMasiva() {
  const [seleccion, setSeleccion] = useState<SeleccionCarga>(SELECCION_CARGA_VACIA);
  /** Nombres de los ZIP que se están leyendo; `null` = no se está leyendo nada. */
  const [abriendo, setAbriendo] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lectura = useRef(0);

  const elegir = async (elegidos: File[]) => {
    const mia = ++lectura.current;
    setError(null);
    setSeleccion(SELECCION_CARGA_VACIA);
    const zips = elegidos.filter(esZipCargaMasiva).map((z) => z.name);
    setAbriendo(zips.length > 0 ? zips : null);
    const { seleccion: s, error: err } = await seleccionCargaMasiva(elegidos);
    if (lectura.current !== mia) return; // llegó tarde: manda la elección de después
    setSeleccion(s);
    setError(err);
    setAbriendo(null);
  };

  return { seleccion, abriendo, error, setError, elegir };
}
