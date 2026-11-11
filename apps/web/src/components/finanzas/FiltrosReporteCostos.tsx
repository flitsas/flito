// La tarjeta de filtros del reporte de costos (rediseño, Épica #13763, spec §3.4).
//
// UNA barra, todo a 40 px y con `flex-wrap`: las pastillas de etapa (el filtro principal), el
// Periodo —un solo control: Mes/Trimestre y el «Rango personalizado», que es el mismo rango de
// aprobación que antes estaba duplicado a la vista—, la búsqueda y «Más filtros». Debajo, los chips
// de lo puesto y «Limpiar filtros». Ningún filtro de antes se pierde: Empresa, Tipo, Estado, OT,
// Creación, «Solo con soportes completos» y «Con diferencias» viven en «Más filtros», junto con el
// nuevo «Costo de proveedor sin configurar». Sin «Aplicar»: cada cambio filtra al momento.
//
// Los paneles de Periodo y Más filtros se posicionan contra la TARJETA (`relative` en ella, el
// `<details>` estático): ocupan su ancho y nunca desbordan la página a 375 px.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import RangoFechas from '../flit/RangoFechas';
import { FlitCard, flitInp, FlitPillGroup, flitPillBtn, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import FiltroMulti from './FiltroMulti';
import SelectorPeriodo, { periodoDe, textoPeriodo } from './SelectorPeriodo';
import { ALTO_CONTROL, ETAPAS, type Facetas, type FiltrosDetalle, type Resumen } from './tiposReporteCostos';
import { AYUDA_CON_DIFERENCIAS, ROTULO_CON_DIFERENCIAS } from '../../lib/diferenciaDocumental';

export const ROTULO_COSTO_SIN_CONFIGURAR = 'Costo de proveedor sin configurar';
const AYUDA_COSTO_SIN_CONFIGURAR = 'Trámites con al menos un costo de proveedor sin configurar. No impide liquidar.';

const SUMMARY = 'flit-focus inline-flex h-10 w-full cursor-pointer list-none items-center gap-2 rounded-[10px] border bg-flit-card px-3 text-sm transition-colors hover:bg-[var(--flit-bg-hover)] sm:w-auto';
const SUMMARY_STYLE = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' } as const;
const PANEL = 'absolute inset-x-3 z-30 mt-1 rounded-lg border bg-flit-card p-3';
const PANEL_STYLE = { borderColor: 'var(--flit-border-input)', boxShadow: 'var(--flit-shadow-card)' } as const;

/** «1 oct – 15 oct 2026»; las fechas son `yyyy-mm-dd` y se leen sin zona horaria. */
function textoRango(desde: string, hasta: string): string {
  const f = (v: string, conAnio: boolean) => new Date(`${v}T12:00:00Z`).toLocaleDateString('es-CO', {
    day: 'numeric', month: 'short', ...(conAnio ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).replace('.', '');
  if (desde && hasta) return `${f(desde, false)} – ${f(hasta, true)}`;
  if (desde) return `desde ${f(desde, true)}`;
  if (hasta) return `hasta ${f(hasta, true)}`;
  return 'Sin periodo';
}

/** Esc cierra el `<details>` y devuelve el foco a su summary, como `FiltrosInteligentes`. */
function cerrarConEsc(e: KeyboardEvent<HTMLDetailsElement>) {
  const d = e.currentTarget;
  if (e.key !== 'Escape' || !d.open) return;
  e.stopPropagation();
  d.open = false;
  d.querySelector('summary')?.focus();
}

interface Chip { clave: string; texto: string; quitar: Partial<FiltrosDetalle> }

export default function FiltrosReporteCostos({ filtros, onCambio, facetas, facetasCargando, resumen, hayFiltros, onLimpiar }: {
  filtros: FiltrosDetalle;
  onCambio: (parche: Partial<FiltrosDetalle>) => void;
  facetas: Facetas | null;
  facetasCargando: boolean;
  /** Los contadores de las etapas. Cuentan con los demás filtros puestos, no sobre todo. */
  resumen: Resumen | null;
  hayFiltros: boolean;
  onLimpiar: () => void;
}) {
  const masRef = useRef<HTMLDetailsElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const aprobacion = { desde: filtros.aprobadoDesde, hasta: filtros.aprobadoHasta };
  const resumenPeriodo = periodoDe(filtros.tipoPeriodo, aprobacion)
    ? textoPeriodo(filtros.tipoPeriodo, aprobacion)
    : textoRango(filtros.aprobadoDesde, filtros.aprobadoHasta);

  const nombreEmpresa = facetas?.empresas.find((e) => e.valor === filtros.empresa)?.nombre ?? filtros.empresa;
  const nombreOt = (v: string) => facetas?.organismos.find((o) => o.valor === v)?.nombre ?? v;

  // Uno por filtro con valor. La etapa y el periodo no: ya se leen en su control. «Estado: Aprobado»
  // sí, aunque sea el valor por defecto: un filtro oculto no puede recortar la tabla sin que se note.
  const chips: Chip[] = [
    ...(filtros.estados.length ? [{ clave: 'estado', texto: `Estado: ${filtros.estados.join(', ')}`, quitar: { estados: [] } }] : []),
    ...(filtros.empresa ? [{ clave: 'empresa', texto: `Empresa: ${nombreEmpresa}`, quitar: { empresa: '' } }] : []),
    ...(filtros.tipo ? [{ clave: 'tipo', texto: `Tipo: ${filtros.tipo}`, quitar: { tipo: '' } }] : []),
    ...(filtros.organismos.length ? [{ clave: 'ot', texto: `OT: ${filtros.organismos.map(nombreOt).join(', ')}`, quitar: { organismos: [] } }] : []),
    ...(filtros.desde || filtros.hasta ? [{ clave: 'creacion', texto: `Creación: ${textoRango(filtros.desde, filtros.hasta)}`, quitar: { desde: '', hasta: '' } }] : []),
    ...(filtros.docCompleta ? [{ clave: 'soportes', texto: 'Solo con soportes completos', quitar: { docCompleta: false } }] : []),
    ...(filtros.conDiferencias ? [{ clave: 'diferencias', texto: ROTULO_CON_DIFERENCIAS, quitar: { conDiferencias: false } }] : []),
    ...(filtros.costoProveedorSinConfigurar ? [{ clave: 'costo', texto: ROTULO_COSTO_SIN_CONFIGURAR, quitar: { costoProveedorSinConfigurar: false } }] : []),
  ];
  const dentro = chips.length;

  const quitar = (i: number, c: Chip) => {
    onCambio(c.quitar);
    // El foco pasa al chip siguiente (que, tras quitar este, ocupa su sitio) o a «Limpiar filtros».
    setTimeout(() => {
      const botones = chipsRef.current?.querySelectorAll<HTMLButtonElement>('button');
      if (!botones?.length) return;
      (botones[Math.min(i, botones.length - 1)] ?? botones[botones.length - 1]).focus();
    }, 0);
  };

  return (
    <FlitCard className="relative !p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FlitPillGroup label="Etapa del cobro" desplazable>
          {ETAPAS.map((e) => (
            <button key={e.v} type="button" title={e.ayuda} onClick={() => onCambio({ etapa: e.v })}
              aria-pressed={filtros.etapa === e.v}
              className="flit-focus inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[999px] px-3 text-xs font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={flitPillBtn(filtros.etapa === e.v)}>
              {e.label}
              {resumen && e.cuenta && (
                <span className="rounded-[999px] px-1.5 py-0.5 text-[10px] tabular-nums"
                  style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
                  {e.cuenta(resumen).toLocaleString('es-CO')}
                </span>
              )}
            </button>
          ))}
        </FlitPillGroup>

        <details className="w-full sm:w-auto" onKeyDown={cerrarConEsc}>
          <summary className={SUMMARY} style={SUMMARY_STYLE} aria-label={`Periodo: ${resumenPeriodo}`}>
            <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Periodo</span>
            <span>{resumenPeriodo}</span>
          </summary>
          <div className={`${PANEL} sm:right-auto sm:w-[26rem]`} style={PANEL_STYLE}>
            <SelectorPeriodo tipo={filtros.tipoPeriodo} onTipo={(tipoPeriodo) => onCambio({ tipoPeriodo })}
              valor={aprobacion} onCambio={(r) => onCambio({ aprobadoDesde: r.desde, aprobadoHasta: r.hasta })} />
            <div className="mt-3">
              <RangoFechas etiqueta="Rango personalizado" valor={aprobacion}
                onCambio={(r) => onCambio({ aprobadoDesde: r.desde, aprobadoHasta: r.hasta })} />
            </div>
          </div>
        </details>

        <input className={`${flitInp} sm:!w-72`} style={ALTO_CONTROL} placeholder="Placa, VIN o trámite FLIT…"
          aria-label="Buscar" value={filtros.buscar} onChange={(e) => onCambio({ buscar: e.target.value })} />

        <details ref={masRef} className="w-full sm:w-auto" onKeyDown={cerrarConEsc}>
          <summary className={SUMMARY} style={SUMMARY_STYLE}>
            {dentro ? `Más filtros · ${dentro}` : 'Más filtros'}
          </summary>
          <div className={PANEL} style={PANEL_STYLE}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <select className={flitInp} style={ALTO_CONTROL} aria-label="Empresa" value={filtros.empresa}
                onChange={(e) => onCambio({ empresa: e.target.value })}>
                <option value="">Todas las empresas</option>
                {facetas?.empresas.map((e) => <option key={e.valor} value={e.valor}>{e.nombre}</option>)}
              </select>
              <select className={flitInp} style={ALTO_CONTROL} aria-label="Tipo de trámite" value={filtros.tipo}
                onChange={(e) => onCambio({ tipo: e.target.value })}>
                <option value="">Todos los tipos</option>
                {facetas?.tipos.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <FiltroMulti rotulo="Estado" ariaLabel="Estado del trámite"
                opciones={(facetas?.estados ?? []).map((e) => ({ valor: e, nombre: e }))}
                seleccion={filtros.estados} onCambio={(estados) => onCambio({ estados })}
                cargando={facetasCargando} textoVacio="Sin estados que ofrecer" textoCualquiera="Cualquier estado" />
              <FiltroMulti rotulo="OT" ariaLabel="Organismo de tránsito"
                opciones={facetas?.organismos ?? []}
                seleccion={filtros.organismos} onCambio={(organismos) => onCambio({ organismos })}
                cargando={facetasCargando} plural="organismos"
                textoVacio="Sin organismos que ofrecer" textoCualquiera="Cualquier organismo" />
              <RangoFechas etiqueta="Creación" valor={{ desde: filtros.desde, hasta: filtros.hasta }}
                onCambio={(r) => onCambio({ desde: r.desde, hasta: r.hasta })} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Casilla title="Con soporte cargado de SOAT, impuesto, derecho y logística — saltando los que la compañía autogestiona."
                checked={filtros.docCompleta} onChange={(v) => onCambio({ docCompleta: v })}>Solo con soportes completos</Casilla>
              <Casilla title={AYUDA_CON_DIFERENCIAS} checked={filtros.conDiferencias}
                onChange={(v) => onCambio({ conDiferencias: v })}>{ROTULO_CON_DIFERENCIAS}</Casilla>
              <Casilla title={AYUDA_COSTO_SIN_CONFIGURAR} checked={filtros.costoProveedorSinConfigurar}
                onChange={(v) => onCambio({ costoProveedorSinConfigurar: v })}>{ROTULO_COSTO_SIN_CONFIGURAR}</Casilla>
              <button type="button" className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle}
                onClick={() => { if (masRef.current) masRef.current.open = false; masRef.current?.querySelector('summary')?.focus(); }}>
                Cerrar
              </button>
            </div>
          </div>
        </details>
      </div>

      {(chips.length > 0 || hayFiltros) && (
        <div ref={chipsRef} className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Filtros:</span>
          {chips.map((c, i) => (
            <button key={c.clave} type="button" aria-label={`Quitar filtro ${c.texto}`} onClick={() => quitar(i, c)}
              className="flit-focus inline-flex items-center gap-1.5 rounded-[999px] border bg-flit-card px-3 py-1 text-xs transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
              {c.texto}
              <span aria-hidden="true" style={{ color: 'var(--flit-text-muted)' }}>✕</span>
            </button>
          ))}
          {hayFiltros && (
            <button type="button" onClick={onLimpiar}
              className="flit-focus ml-auto rounded px-1 text-xs font-semibold underline transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={{ color: 'var(--flit-blue-text)' }}>
              Limpiar filtros
            </button>
          )}
        </div>
      )}
    </FlitCard>
  );
}

function Casilla({ title, checked, onChange, children }: {
  title: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
