// FLITO Logística — pestaña Trámites (HU #14353): filtros, cuatro estados, tabla desde `lg` y tarjetas por debajo.
// Al proveedor no le llega el propietario en la lista (H2): la columna no se pinta. Los datos los pide la página.
import { ESTADO_LOGISTICA_SIMPLE_LABEL, type EstadoLogisticaSimple, type ListadoTramitesLogistica, type TramiteFilaLogistica } from '@operaciones/shared-types';
import {
  FlitCard, FlitEmpty, FlitField, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import StatusChip from '../../flit/StatusChip';
import { AvisoNoActualizado, BarraEsqueleto, BotonFila, BotonTarjetaPeligro, EsqueletoTarjetas, TONO_SIMPLE, TarjetaError, useDesdeLg } from './consolaLogistica';

const ESTADOS_SIMPLE: EstadoLogisticaSimple[] = ['pendiente', 'registrada', 'en_flit', 'despachada', 'entregada', 'novedad'];

interface Props {
  data: ListadoTramitesLogistica | null;
  fallo: boolean;
  refrescando: boolean;
  desactualizado: boolean;
  onReintentar: () => void;
  buscar: string;
  onBuscar: (v: string) => void;
  estados: string[];
  onEstado: (e: string) => void;
  empresa: string;
  onEmpresa: (v: string) => void;
  empresas: Array<{ nit: string; nombre: string | null }>;
  mostrarEmpresa: boolean;
  conFiltro: boolean;
  onLimpiar: () => void;
  vacio: string;
  verPropietario: boolean;
  verDetalle: boolean;
  puedeNovedad: boolean;
  onDetalle: (f: TramiteFilaLogistica) => void;
  onNovedad: (docId: string) => void;
}

const COLUMNAS = ['w-20', 'w-40', 'w-48', 'w-28', 'w-24', 'w-16'];

export default function TabTramites(p: Props) {
  const desdeLg = useDesdeLg();
  const filas = p.data?.items ?? [];
  const cargando = !p.data && !p.fallo;
  return (
    <>
      <FlitCard>
        <div className="grid grid-cols-1 gap-3 lg:flex lg:flex-wrap">
          <div className="min-w-0 lg:w-80">
            <FlitField label="Buscar">
              <input className={flitInp} placeholder="Placa, VIN o trámite FLIT…" autoComplete="off" value={p.buscar} onChange={(e) => p.onBuscar(e.target.value)} />
            </FlitField>
          </div>
          {p.mostrarEmpresa && (
            <div className="min-w-0 lg:w-80">
              <FlitField label="Empresa">
                <select className={flitInp} value={p.empresa} onChange={(e) => p.onEmpresa(e.target.value)}>
                  <option value="">Todas las empresas</option>
                  {p.empresas.map((e) => <option key={e.nit} value={e.nit}>{e.nombre ?? e.nit}</option>)}
                </select>
              </FlitField>
            </div>
          )}
        </div>
        <div className="mt-3">
          <FlitPillGroup>
            {ESTADOS_SIMPLE.map((e) => (
              <FlitPillButton key={e} active={p.estados.includes(e)} onClick={() => p.onEstado(e)}>
                {e === 'en_flit' ? <span className="normal-case">{ESTADO_LOGISTICA_SIMPLE_LABEL[e]}</span> : ESTADO_LOGISTICA_SIMPLE_LABEL[e]}
              </FlitPillButton>
            ))}
          </FlitPillGroup>
        </div>
      </FlitCard>

      {p.desactualizado && <AvisoNoActualizado onReintentar={p.onReintentar} />}

      {p.fallo && !p.data && <TarjetaError texto="No se pudieron cargar los trámites. Inténtelo de nuevo." onReintentar={p.onReintentar} />}

      {cargando && (
        <div role="status" aria-busy="true" aria-label="Cargando trámites…">
          {desdeLg ? (
            <FlitCard>
              <FlitTable>
                <thead><FlitTr><FlitTh>Placa</FlitTh><FlitTh>Empresa</FlitTh><FlitTh>Secretaría</FlitTh><FlitTh>N.º LT</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Acciones</FlitTh></FlitTr></thead>
                <tbody>{[0, 1, 2].map((i) => <FlitTr key={i}>{COLUMNAS.map((w) => <td key={w} className="px-4 py-3"><BarraEsqueleto w={w} /></td>)}</FlitTr>)}</tbody>
              </FlitTable>
            </FlitCard>
          ) : <EsqueletoTarjetas />}
        </div>
      )}

      {p.data && filas.length === 0 && !p.conFiltro && <FlitCard><FlitEmpty>{p.vacio}</FlitEmpty></FlitCard>}

      {p.data && filas.length === 0 && p.conFiltro && (
        <FlitCard>
          <FlitEmpty>
            <p>Ningún trámite coincide con estos filtros. Pruebe otra placa o VIN, o quite un filtro.</p>
            <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={p.onLimpiar}>Limpiar filtros</button>
          </FlitEmpty>
        </FlitCard>
      )}

      {filas.length > 0 && (
        <div aria-busy={p.refrescando || undefined}>
          {desdeLg ? <Tabla {...p} filas={filas} /> : <Tarjetas {...p} filas={filas} />}
        </div>
      )}
    </>
  );
}

const hayNovedad = (f: TramiteFilaLogistica, puede: boolean) => puede && !!f.docId && f.estadoSimple === 'registrada';

function Tabla({ filas, verPropietario, verDetalle, puedeNovedad, onDetalle, onNovedad }: Props & { filas: TramiteFilaLogistica[] }) {
  return (
    <FlitCard>
      <FlitTable label="Trámites">
        <thead>
          <FlitTr>
            <FlitTh>Placa</FlitTh>{verPropietario && <FlitTh>Propietario</FlitTh>}<FlitTh>Empresa</FlitTh>
            <FlitTh>Secretaría</FlitTh><FlitTh>N.º LT</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Acciones</FlitTh>
          </FlitTr>
        </thead>
        <tbody>
          {filas.map((f) => {
            const placa = f.placa ?? f.idFlit;
            return (
              <FlitTr key={f.tramiteId}>
                <td className="px-4 py-2">
                  <div className="text-sm font-medium tabular-nums">{f.placa ?? '—'}</div>
                  <div className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</div>
                </td>
                {verPropietario && <td className="px-4 py-2 text-sm">{f.propietario ?? '—'}</td>}
                <td className="px-4 py-2 text-sm">{f.companiaNombre ?? f.companiaNit ?? '—'}</td>
                <td className="px-4 py-2 text-sm">{f.organismoNombre ?? f.organismoCodigo ?? '—'}</td>
                <td className="px-4 py-2 text-sm tabular-nums">{f.numeroLt ?? '—'}</td>
                <td className="px-4 py-2">
                  <StatusChip tone={TONO_SIMPLE[f.estadoSimple]}>{f.estadoSimpleLabel}</StatusChip>
                  {f.motivo && <div className="mt-1 text-xs" style={{ color: 'var(--flit-danger-text)' }}>{f.motivo}</div>}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {verDetalle && <BotonFila aria={`Detalle de ${placa}`} onClick={() => onDetalle(f)}>Detalle</BotonFila>}
                    {hayNovedad(f, puedeNovedad) && <BotonFila peligro aria={`Novedad de ${placa}`} onClick={() => onNovedad(f.docId!)}>Novedad</BotonFila>}
                  </div>
                </td>
              </FlitTr>
            );
          })}
        </tbody>
      </FlitTable>
    </FlitCard>
  );
}

function Tarjetas({ filas, verPropietario, verDetalle, puedeNovedad, onDetalle, onNovedad }: Props & { filas: TramiteFilaLogistica[] }) {
  return (
    <ul className="space-y-3">
      {filas.map((f) => {
        const placa = f.placa ?? f.idFlit;
        return (
          <li key={f.tramiteId}>
            <article className="rounded-xl border bg-flit-card p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{f.placa ?? '—'}</span>
                <StatusChip tone={TONO_SIMPLE[f.estadoSimple]}>{f.estadoSimpleLabel}</StatusChip>
              </div>
              <div className="mt-1 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit} · {f.numeroLt ?? '—'}</div>
              <div className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{f.companiaNombre ?? f.companiaNit ?? '—'}</div>
              {verPropietario && f.propietario && <div className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{f.propietario}</div>}
              {f.motivo && <div className="mt-1 text-xs" style={{ color: 'var(--flit-danger-text)' }}>{f.motivo}</div>}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {verDetalle && <button type="button" className={`${flitBtnSecondary} min-h-11`} style={flitBtnSecondaryStyle} aria-label={`Detalle de ${placa}`} onClick={() => onDetalle(f)}>Detalle</button>}
                {hayNovedad(f, puedeNovedad) && <BotonTarjetaPeligro aria={`Novedad de ${placa}`} onClick={() => onNovedad(f.docId!)}>Novedad</BotonTarjetaPeligro>}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
