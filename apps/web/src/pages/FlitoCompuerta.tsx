// FLITO Compuerta de entrega (Fase 6). Porta paginas/compuerta.tsx al kit flit/ + api.
// La compuerta HABILITA, no entrega: el paso a Entregado lo ejecuta Operaciones (revalidado en backend).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle,
} from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';

interface CompuertaDto {
  tramiteId: string; idFlit: string; placa: string | null; companiaNombre: string; estadoTramite: string;
  soatResuelto: boolean; soatDetalle: string; impuestosResueltos: boolean; impuestosDetalle: string;
  valorSoat: number | null; valorImpuesto: number | null; habilitado: boolean;
}

const pesos = (v: number | null) => v === null ? null
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);

function Condicion({ resuelto, detalle, valor }: { resuelto: boolean; detalle: string; valor: number | null }) {
  return (
    <div className="flex items-start gap-1.5">
      <span aria-hidden className={resuelto ? 'text-green-600' : 'text-gray-400'}>{resuelto ? '✓' : '○'}</span>
      <div className="min-w-0">
        <span className="text-xs" style={{ color: resuelto ? 'var(--flit-text-secondary)' : 'var(--flit-text-muted)' }}>{detalle}</span>
        {valor !== null && <p className="text-sm font-semibold tabular-nums">{pesos(valor)}</p>}
      </div>
    </div>
  );
}

export default function FlitoCompuerta() {
  const { user } = useAuth();
  const [soloHabilitados, setSoloHabilitados] = useState(false);
  const [data, setData] = useState<CompuertaDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entregando, setEntregando] = useState<string | null>(null);

  const esOperaciones = user?.role === 'operaciones';

  const cargar = () => {
    setError(null);
    setData(null);
    api.get<CompuertaDto[]>(`/flito/compuerta?soloHabilitados=${soloHabilitados}`).then(setData).catch((e) => setError(errorMessage(e)));
  };
  useEffect(cargar, [soloHabilitados]);

  const entregar = async (tramiteId: string) => {
    setEntregando(tramiteId);
    setError(null);
    try {
      await api.post(`/flito/compuerta/${tramiteId}/entregar`);
      cargar();
    } catch (e) { setError(errorMessage(e)); }
    finally { setEntregando(null); }
  };

  const filas = data ?? [];

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Compuerta de entrega"
        subtitle="Evalúa si un trámite ya puede pasar a Entregado."
        actions={
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={soloHabilitados} onChange={(e) => setSoloHabilitados(e.target.checked)} />
            Solo habilitados
          </label>
        }
      />

      <FlitCard>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          <strong style={{ color: 'var(--flit-blue-text)' }}>La compuerta habilita; no entrega.</strong>{' '}
          Que SOAT e impuestos estén resueltos es condición necesaria, no suficiente: el paso a «Entregado» sigue siendo una decisión que ejecuta Operaciones.
        </p>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {data && filas.length === 0 && (
        <FlitCard>
          <FlitEmpty>
            {soloHabilitados
              ? 'Ningún trámite está habilitado todavía. Quita el filtro para ver qué le falta a cada uno.'
              : 'No hay trámites asignados. Sincroniza desde FLIT para traer trámites en estado Asignado.'}
          </FlitEmpty>
        </FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Placa</FlitTh><FlitTh>Trámite FLIT</FlitTh><FlitTh>Compañía</FlitTh>
                <FlitTh>SOAT</FlitTh><FlitTh>Impuestos</FlitTh><FlitTh>Estado</FlitTh><FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.tramiteId}>
                  <td className="px-3 py-2 font-medium">{f.placa}</td>
                  <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</td>
                  <td className="px-3 py-2 text-sm">{f.companiaNombre}</td>
                  <td className="max-w-[240px] px-3 py-2"><Condicion resuelto={f.soatResuelto} detalle={f.soatDetalle} valor={f.valorSoat} /></td>
                  <td className="max-w-[240px] px-3 py-2"><Condicion resuelto={f.impuestosResueltos} detalle={f.impuestosDetalle} valor={f.valorImpuesto} /></td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone="neutral">{f.estadoTramite}</StatusChip>
                      {f.habilitado && f.estadoTramite === 'asignado' && <StatusChip tone="success">Habilitado</StatusChip>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {esOperaciones && f.habilitado && f.estadoTramite === 'asignado' && (
                      <button onClick={() => entregar(f.tramiteId)} disabled={entregando === f.tramiteId}
                        className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
                        {entregando === f.tramiteId ? 'Entregando…' : 'Entregar'}
                      </button>
                    )}
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </FlitCard>
      )}
    </div>
  );
}
