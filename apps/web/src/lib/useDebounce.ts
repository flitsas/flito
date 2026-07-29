// Retarda un valor: útil para que un buscador consulte al servidor cuando el usuario deja de
// escribir, no en cada tecla.
//
// Vivía dentro de FlitoTramites.tsx. Se extrae porque las colas de SOAT e impuestos disparaban una
// consulta por pulsación (HU #10984) y hacen falta las tres en el mismo sitio.

import { useEffect, useState } from 'react';

export function useDebounce<T>(valor: T, ms: number): T {
  const [diferido, setDiferido] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setDiferido(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return diferido;
}

export default useDebounce;
