// Finanzas — Gastos diarios (HU #12624, Feature #12621). Cinco números —cuánto se pagó en el
// periodo por SOAT, impuestos, derechos, logística y servicios adicionales— y el total con GMF
// estimado. Pantalla de LECTURA: no liquida, no exporta, no abre trámites; sin acción primaria.
//
// Manda el día del pago/evento, no la aprobación del trámite ni la liquidación: por eso puede no
// coincidir con el Reporte de costos, y la ficha de Ayuda lo cuenta. La serie por día se pinta en
// la gráfica de evolución diaria (HU #12625), debajo del total, con los mismos filtros.
//
// Orquesta como `FinanzasReporteCostos`: el estado vive en `useGastosDiarios`, lo que se pinta en
// `components/finanzas/gastos-diarios/`.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { entradaAyudaPorClave, puedeVerEntradaAyuda } from '../lib/ayudaFlito';
import NoAccess from '../components/NoAccess';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import FiltrosGastosDiarios from '../components/finanzas/gastos-diarios/FiltrosGastosDiarios';
import TarjetaGasto from '../components/finanzas/gastos-diarios/TarjetaGasto';
import TotalPeriodo from '../components/finanzas/gastos-diarios/TotalPeriodo';
import GraficaGastosDiarios from '../components/finanzas/gastos-diarios/GraficaGastosDiarios';
import SkeletonGastos from '../components/finanzas/gastos-diarios/SkeletonGastos';
import { useGastosDiarios } from '../components/finanzas/gastos-diarios/useGastosDiarios';
import {
  CATEGORIAS, ROTULOS_TOTAL, sinGastos, textoRango, totalDelPeriodo,
} from '../components/finanzas/gastos-diarios/tiposGastosDiarios';

const SLUG = 'finanzas_gastos_diarios';
const ENTRADA_AYUDA = entradaAyudaPorClave(SLUG);

export default function FinanzasGastosDiarios() {
  const { user } = useAuth();
  const g = useGastosDiarios();
  const reintentarRef = useRef<HTMLButtonElement>(null);
  /** Lo que un lector no ve cambiar: datos cargados, tipo oculto, total con ocultas. */
  const [anuncio, setAnuncio] = useState('');

  const datos = g.data;
  const total = datos ? totalDelPeriodo(datos.totales, g.filtros.tipos) : null;
  const rango = datos ? textoRango(datos.desde, datos.hasta) : '';
  const vacio = datos !== null && sinGastos(datos.totales);
  /** Solo lo que consulta: con el rango y la empresa de entrada, el vacío no ofrece «Últimos 30 días». */
  const filtrosDeConsulta = Boolean(g.filtros.desde || g.filtros.hasta || g.filtros.empresas);
  const visibles = CATEGORIAS.filter((c) => g.filtros.tipos.includes(c.clave));

  useEffect(() => { if (g.data && !g.cargando) setAnuncio(`Gastos ${rango} cargados`); }, [g.data, g.cargando, rango]);
  useEffect(() => {
    if (!g.data) return;
    const ocultas = CATEGORIAS.filter((c) => !g.filtros.tipos.includes(c.clave));
    if (ocultas.length === 1) setAnuncio(`${ocultas[0].titulo} oculto. ${ROTULOS_TOTAL.incluyeTodas}`);
    else if (ocultas.length > 1) setAnuncio(`${ocultas.length} tipos ocultos. ${ROTULOS_TOTAL.incluyeTodas}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.filtros.tipos.length]);

  const reintentar = () => { g.reintentar(); setTimeout(() => reintentarRef.current?.focus(), 0); };

  // También si la página se revoca con la pantalla abierta: el 403 del API manda (AC6).
  if (g.sinPermiso) return <NoAccess page={SLUG} />;

  const puedeVerAyuda = ENTRADA_AYUDA !== undefined && puedeVerEntradaAyuda(user, ENTRADA_AYUDA);
  const enlaceAyuda = puedeVerAyuda && (
    <Link to={`/flito/ayuda/${SLUG}`} className="flit-focus text-sm underline" style={{ color: 'var(--flit-blue-text)' }}>
      ¿Qué cuenta cada categoría?
    </Link>
  );

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Gastos diarios"
        subtitle="Cuánto se pagó cada día por SOAT, impuestos, derechos, logística y servicios adicionales."
        actions={enlaceAyuda || undefined} />

      <FiltrosGastosDiarios filtros={g.filtros} rangoVisible={g.rangoVisible} errorRango={g.errorRango}
        empresas={g.empresas} empresasCargando={g.empresasCargando} hayFiltros={g.hayFiltros}
        onEmpresa={g.cambiarEmpresa} onRango={g.cambiarRango} onTipo={g.alternarTipo} onLimpiar={g.limpiar} />

      <p className="sr-only" role="status" aria-live="polite">{anuncio}</p>

      {g.cargando && <SkeletonGastos />}

      {!g.cargando && g.error && (
        <FlitCard>
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger)' }}>No se pudo cargar el gasto diario.</p>
            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{g.error}</p>
            <button ref={reintentarRef} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={reintentar}>
              Reintentar
            </button>
          </div>
        </FlitCard>
      )}

      {!g.cargando && !g.error && datos && vacio && (
        <FlitEmpty>
          {filtrosDeConsulta
            ? (
              <div className="flex flex-col items-center gap-3">
                <p>Sin gastos {rango} para <strong>{g.nombreEmpresa}</strong>.</p>
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={g.ultimos30}>Últimos 30 días</button>
              </div>
            )
            : <p>Sin gastos en los últimos 30 días. Cambia el rango o la empresa arriba.</p>}
        </FlitEmpty>
      )}

      {!g.cargando && !g.error && datos && !vacio && total && (
        <>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Gastos {rango} · {g.nombreEmpresa}
          </p>
          {visibles.length === 0
            ? (
              <FlitEmpty>
                <div className="flex flex-col items-center gap-3">
                  <p>Ningún tipo de gasto marcado.</p>
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={g.verLosCinco}>Ver los cinco</button>
                </div>
              </FlitEmpty>
            )
            : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {visibles.map((c) => <TarjetaGasto key={c.clave} categoria={c} celda={datos.totales[c.clave]} />)}
              </div>
            )}
          <TotalPeriodo datos={total} />
        </>
      )}

      {/* La gráfica: skeleton con la carga (arriba), nada en error, «Sin gastos en el rango» en vacío. */}
      {!g.cargando && !g.error && datos && (
        <GraficaGastosDiarios datos={datos} tipos={g.filtros.tipos} onTipo={g.alternarTipo} vacio={vacio} />
      )}
    </div>
  );
}
