// Finanzas — Gastos diarios (HU #12624). URL ↔ filtros, validación local, la consulta y su reintento,
// y la faceta de empresas. La página solo pinta lo que sale de aquí.
//
// La URL es la fuente de verdad de los filtros (`useSearchParams`, `replace`): un enlace compartido
// abre la misma vista. Lo único local es el rango a medias del calendario («18 ago → …»), que no
// se consulta ni se comparte hasta que tiene fin.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GastosDiariosRespuesta } from '@operaciones/shared-types';
import { api, ApiError, errorMessage } from '../../../lib/api';
import type { Rango } from '../../flit/RangoFechas';
import type { Facetas } from '../tiposReporteCostos';
import {
  CATEGORIAS, FILTROS_INICIALES, claveDeConsulta, escribirFiltros, hayFiltros, leerFiltros,
  rangoPorDefecto, validarRango, type FiltrosGastos, type GastosDiariosCategoria,
} from './tiposGastosDiarios';

/** Opción del selector de empresas: la faceta del reporte de costos (R1 del doc UX). */
export type OpcionEmpresa = Facetas['empresas'][number];

export function useGastosDiarios() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filtros = leerFiltros(searchParams);
  const errorRango = validarRango(filtros.desde, filtros.hasta);

  const escribir = (parche: Partial<FiltrosGastos>) =>
    setSearchParams(escribirFiltros({ ...filtros, ...parche }), { replace: true });

  // El calendario a medias vive aquí; la URL solo recibe rangos completos (o ninguno).
  const [rangoCampo, setRangoCampo] = useState<Rango>(() => ({ desde: filtros.desde, hasta: filtros.hasta }));
  useEffect(() => { setRangoCampo({ desde: filtros.desde, hasta: filtros.hasta }); }, [filtros.desde, filtros.hasta]);
  const cambiarRango = (r: Rango) => {
    setRangoCampo(r);
    if ((r.desde && r.hasta) || (!r.desde && !r.hasta)) escribir({ desde: r.desde, hasta: r.hasta });
  };
  /** Lo que enseña el campo: el de la URL o, sin él, los últimos 30 días (AC5). */
  const rangoVisible: Rango = rangoCampo.desde || rangoCampo.hasta ? rangoCampo : rangoPorDefecto();

  const alternarTipo = (c: GastosDiariosCategoria) => escribir({
    tipos: filtros.tipos.includes(c)
      ? filtros.tipos.filter((t) => t !== c)
      : CATEGORIAS.map((x) => x.clave).filter((x) => x === c || filtros.tipos.includes(x)),
  });

  const [data, setData] = useState<GastosDiariosRespuesta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Un 400 del API (URL a mano) se pinta como validación bajo Periodo, no como alerta. */
  const [errorApiRango, setErrorApiRango] = useState<string | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);
  const [reintento, setReintento] = useState(0);

  const clave = claveDeConsulta(filtros);
  // Sin `tipos`: desmarcar una categoría no consulta (AC5). Con rango inválido tampoco: se conserva
  // el último resultado válido (doc UX).
  useEffect(() => {
    if (errorRango) return;
    let vivo = true;
    setCargando(true); setError(null); setErrorApiRango(null);
    const p = new URLSearchParams();
    if (filtros.desde) p.set('desde', filtros.desde);
    if (filtros.hasta) p.set('hasta', filtros.hasta);
    if (filtros.empresas) p.set('empresas', filtros.empresas);
    const q = p.toString();
    api.get<GastosDiariosRespuesta>(`/finanzas/gastos-diarios${q ? `?${q}` : ''}`)
      .then((r) => { if (vivo) setData(r); })
      .catch((e) => {
        if (!vivo) return;
        if (e instanceof ApiError && e.status === 403) { setSinPermiso(true); return; }
        if (e instanceof ApiError && e.status === 400) { setErrorApiRango(errorMessage(e)); return; }
        setError(errorMessage(e));
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, reintento, errorRango]);

  const [empresas, setEmpresas] = useState<OpcionEmpresa[]>([]);
  const [empresasCargando, setEmpresasCargando] = useState(true);
  // Si la faceta falla (403 por rol, R1) el selector se queda en «Todas las empresas» sin romper.
  useEffect(() => {
    api.get<Facetas>('/finanzas/reporte-costos/facetas')
      .then((f) => setEmpresas(Array.isArray(f?.empresas) ? f.empresas : []))
      .catch(() => setEmpresas([]))
      .finally(() => setEmpresasCargando(false));
  }, []);

  return {
    filtros, rangoVisible, errorRango: errorRango ?? errorApiRango,
    hayFiltros: hayFiltros(filtros),
    cambiarRango,
    cambiarEmpresa: (empresas: string) => escribir({ empresas }),
    alternarTipo,
    verLosCinco: () => escribir({ tipos: FILTROS_INICIALES.tipos }),
    limpiar: () => setSearchParams(new URLSearchParams(), { replace: true }),
    /** El botón del vacío: quita `desde/hasta/empresas` y deja los tipos como estén. */
    ultimos30: () => escribir({ desde: '', hasta: '', empresas: '' }),
    data, cargando: cargando && !errorRango, error, sinPermiso,
    reintentar: () => setReintento((n) => n + 1),
    empresas, empresasCargando,
    /** Nombre visible de la empresa filtrada; sin faceta, el valor tal cual (NITs, no PII). */
    nombreEmpresa: filtros.empresas
      ? (empresas.find((e) => e.valor === filtros.empresas)?.nombre ?? filtros.empresas)
      : 'Todas las empresas',
  };
}
