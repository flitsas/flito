// Datos de las pastillas «Por validar» / «Descartadas» y de la cabeza de «Todos» (HU #12997).
//
// `POST /flito/soat/cliente/incompletas/buscar`: POST y no GET porque `texto` puede ser un VIN o un
// documento, y eso no va en la query (AGENTS.md §14). Solo por `api.ts`.
//
// `activo = false` no llama a nada: es lo que deja la vista del gestor exactamente como estaba
// (sin la función, ni una petición).

import { useEffect, useState } from 'react';
import type { RespuestaBuscarIncompletas } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import type { PastillaIncompleta } from './tipos';

export interface ConsultaIncompletas {
  activo: boolean; estados: PastillaIncompleta[]; texto: string;
  pagina: number; porPagina: number; recarga: number;
}

export default function useIncompletasSoat({ activo, estados, texto, pagina, porPagina, recarga }: ConsultaIncompletas) {
  const [resp, setResp] = useState<RespuestaBuscarIncompletas | null>(null);
  const [error, setError] = useState(false);
  const clave = estados.join(',');

  useEffect(() => {
    setResp(null); setError(false);
    if (!activo) return;
    let vigente = true;
    const cuerpo = {
      estados: clave.split(',') as PastillaIncompleta[],
      ...(texto ? { texto: texto.slice(0, 40) } : {}),
      pagina, porPagina,
    };
    api.post<RespuestaBuscarIncompletas>('/flito/soat/cliente/incompletas/buscar', cuerpo)
      .then((r) => { if (vigente) setResp(r); })
      .catch(() => { if (vigente) setError(true); });
    return () => { vigente = false; };
  }, [activo, clave, texto, pagina, porPagina, recarga]);

  return { resp: activo ? resp : null, error: activo && error };
}
