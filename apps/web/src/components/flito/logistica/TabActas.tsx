// FLITO Logística — pestaña Actas (HU #14353): cuatro estados, tabla desde `lg` y tarjetas por debajo, también para
// Operaciones. Un 500 ya no se ve como «Aún no hay actas». Sin aviso ni filtro por fecha de corte: la pantalla calla
// (ADR-0039 §6.5), y el vacío es el mismo con o sin actas anteriores.
import type { ActaFilaLogistica } from '@operaciones/shared-types';
import { FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import StatusChip from '../../flit/StatusChip';
import { AvisoNoActualizado, BarraEsqueleto, BotonFila, BotonTarjetaPeligro, EsqueletoTarjetas, TONO_ACTA, TarjetaError, fecha, useDesdeLg } from './consolaLogistica';

export interface PermisosActas {
  ver: boolean;
  despachar: boolean;
  devolver: boolean;
  firmarLlegada: boolean;
}

interface Props {
  actas: ActaFilaLogistica[] | null;
  fallo: boolean;
  desactualizado: boolean;
  onReintentar: () => void;
  esProveedor: boolean;
  vacio: string;
  permisos: PermisosActas;
  onVer: (a: ActaFilaLogistica) => void;
  onDespachar: (a: ActaFilaLogistica) => void;
  onDevolver: (a: ActaFilaLogistica) => void;
  onFirmarLlegada: (a: ActaFilaLogistica) => void;
}

const TITULO = <h2 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Actas</h2>;
const COLUMNAS = ['w-48', 'w-10', 'w-28', 'w-20', 'w-32'];

const nombreDe = (a: ActaFilaLogistica) => a.companiaNombre ?? 'sin compañía';
const accionesDe = (a: ActaFilaLogistica, p: PermisosActas) => ({
  despachar: p.despachar && a.estado === 'generada',
  llegada: p.firmarLlegada && a.punto === 'flit' && a.estado === 'despachada' && !!a.trasladoId,
  devolver: p.devolver && a.estado === 'despachada',
});

export default function TabActas(p: Props) {
  const desdeLg = useDesdeLg();
  if (!p.actas && p.fallo) return <TarjetaError texto="No se pudieron cargar las actas. Inténtelo de nuevo." onReintentar={p.onReintentar} />;
  if (!p.actas) {
    return (
      <div role="status" aria-busy="true" aria-label="Cargando actas…">
        {desdeLg ? (
          <FlitCard>
            {TITULO}
            <FlitTable>
              <thead><FlitTr><FlitTh>Empresa</FlitTh><FlitTh>Licencias</FlitTh><FlitTh>Mensajero</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Acciones</FlitTh></FlitTr></thead>
              <tbody>{[0, 1, 2].map((i) => <FlitTr key={i}>{COLUMNAS.map((w) => <td key={w} className="px-4 py-3"><BarraEsqueleto w={w} /></td>)}</FlitTr>)}</tbody>
            </FlitTable>
          </FlitCard>
        ) : <EsqueletoTarjetas />}
      </div>
    );
  }
  return (
    <>
      {p.desactualizado && <AvisoNoActualizado onReintentar={p.onReintentar} />}
      {p.actas.length === 0 ? (
        <FlitCard>{TITULO}<FlitEmpty>{p.vacio}</FlitEmpty></FlitCard>
      ) : desdeLg ? <Tabla {...p} actas={p.actas} /> : <Tarjetas {...p} actas={p.actas} />}
    </>
  );
}

function Tabla({ actas, esProveedor, permisos, onVer, onDespachar, onDevolver, onFirmarLlegada }: Props & { actas: ActaFilaLogistica[] }) {
  return (
    <FlitCard>
      {TITULO}
      <FlitTable label="Actas">
        <thead>
          <FlitTr>
            <FlitTh>Empresa</FlitTh><FlitTh>Licencias</FlitTh><FlitTh>Mensajero</FlitTh><FlitTh>Estado</FlitTh>
            {!esProveedor && <FlitTh>Receptor</FlitTh>}<FlitTh>Acciones</FlitTh>
          </FlitTr>
        </thead>
        <tbody>
          {actas.map((a) => {
            const puede = accionesDe(a, permisos);
            const nombre = nombreDe(a);
            return (
              <FlitTr key={a.id}>
                <td className="px-4 py-2 text-sm">
                  {a.companiaNombre ?? '—'}
                  {a.punto === 'flit' && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{esProveedor ? 'A FLIT. Operaciones de FLITO firma la llegada.' : 'A FLIT'}</div>}
                </td>
                <td className="px-4 py-2 text-sm tabular-nums">{a.documentos}</td>
                <td className="px-4 py-2 text-sm">{a.mensajeroNombre ?? '—'}</td>
                <td className="px-4 py-2"><StatusChip tone={TONO_ACTA[a.estado] ?? 'neutral'}>{a.estadoLabel}</StatusChip></td>
                {!esProveedor && <td className="px-4 py-2 text-sm">{a.receptorNombre ? `${a.receptorNombre} · ${fecha(a.entregadoEn)}` : '—'}</td>}
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {permisos.ver && <BotonFila aria={`Ver acta de ${nombre}`} onClick={() => onVer(a)}>Ver</BotonFila>}
                    {puede.despachar && <BotonFila aria={`Firmar y despachar acta de ${nombre}`} onClick={() => onDespachar(a)}>Firmar y despachar</BotonFila>}
                    {puede.llegada && <BotonFila aria={`Firmar llegada de ${nombre}`} onClick={() => onFirmarLlegada(a)}>Firmar llegada</BotonFila>}
                    {puede.devolver && <BotonFila peligro aria={`Devolver acta de ${nombre}`} onClick={() => onDevolver(a)}>Devolver</BotonFila>}
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

function Tarjetas({ actas, esProveedor, permisos, onVer, onDespachar, onDevolver, onFirmarLlegada }: Props & { actas: ActaFilaLogistica[] }) {
  const sec = { color: 'var(--flit-text-secondary)' } as const;
  return (
    <ul className="space-y-3">
      {actas.map((a) => {
        const puede = accionesDe(a, permisos);
        const nombre = nombreDe(a);
        const flit = a.punto === 'flit';
        return (
          <li key={a.id}>
            <article className="rounded-xl border bg-flit-card p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <div className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{a.companiaNombre ?? '—'}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm" style={sec}>
                <StatusChip tone={TONO_ACTA[a.estado] ?? 'neutral'}>{a.estadoLabel}</StatusChip>
                <span className="tabular-nums">{a.documentos} {a.documentos === 1 ? 'licencia' : 'licencias'}{flit ? ' · A FLIT' : ''}</span>
              </div>
              <div className="mt-1 text-sm" style={sec}>{a.mensajeroNombre ? `Mensajero: ${a.mensajeroNombre}` : a.estado === 'generada' ? 'Sin mensajero' : 'Mensajero: —'}</div>
              {!esProveedor && a.receptorNombre && <div className="mt-1 text-sm" style={sec}>Receptor: {a.receptorNombre} · {fecha(a.entregadoEn)}</div>}
              {flit && esProveedor && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Operaciones de FLITO firma la llegada.</p>}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {puede.despachar && <button type="button" className={`${flitBtnPrimary} min-h-11 w-full justify-center`} style={flitBtnPrimaryStyle} onClick={() => onDespachar(a)}>Firmar y despachar</button>}
                {puede.llegada && <button type="button" className={`${flitBtnPrimary} min-h-11 w-full justify-center`} style={flitBtnPrimaryStyle} onClick={() => onFirmarLlegada(a)}>Firmar llegada</button>}
                {permisos.ver && <button type="button" className={`${flitBtnSecondary} min-h-11`} style={flitBtnSecondaryStyle} aria-label={`Ver acta de ${nombre}`} onClick={() => onVer(a)}>Ver</button>}
                {puede.devolver && <BotonTarjetaPeligro aria={`Devolver acta de ${nombre}`} onClick={() => onDevolver(a)}>Devolver</BotonTarjetaPeligro>}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
