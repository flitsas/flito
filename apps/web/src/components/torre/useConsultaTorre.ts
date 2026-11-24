// Torre de Control (Épica #14590 B2) — una consulta de subvista con sus estados (cargando / error / listo) y reintento.
// Igual que `useTablero` (MoldeTablero): la última petición gana; una respuesta vieja nunca pisa a la nueva.
import { useEffect, useRef, useState } from 'react';

export type EstadoConsultaTorre<T> = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'listo'; datos: T };

/** `clave` resume lo que cambia la consulta (filtro + opciones): con otra clave se vuelve a pedir. */
export function useConsultaTorre<T>(clave: string, pedir: () => Promise<T>) {
  const [estado, setEstado] = useState<EstadoConsultaTorre<T>>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);
  const ultima = useRef(0);
  const pedirRef = useRef(pedir);
  pedirRef.current = pedir;
  useEffect(() => {
    const id = ++ultima.current;
    setEstado({ tipo: 'cargando' });
    pedirRef.current()
      .then((datos) => { if (id === ultima.current) setEstado({ tipo: 'listo', datos }); })
      .catch(() => { if (id === ultima.current) setEstado({ tipo: 'error' }); });
  }, [clave, intento]);
  return { estado, reintentar: () => setIntento((n) => n + 1) };
}
