// FLITO Compuerta de entrega (Fase 6). Porta paginas/compuerta.tsx al kit flit/ + api.
// La compuerta HABILITA, no entrega: el paso a Entregado lo ejecuta Operaciones (revalidado en backend).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard } from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';
import GradientButton from '../components/flit/GradientButton';
import InlineAlert from '../components/flit/InlineAlert';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { type EstadoUi } from '../components/flit/Cargador';

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
      <span aria-hidden className={resuelto ? 'font-semibold text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--color-text-tertiary)]'}>{resuelto ? '✓' : '○'}</span>
      <div className="min-w-0">
        <span className={`text-xs ${resuelto ? 'text-[color:var(--color-text-secondary)]' : 'text-[color:var(--color-text-tertiary)]'}`}>{detalle}</span>
        {valor !== null && <p className="text-sm font-semibold tabular-nums">{pesos(valor)}</p>}
      </div>
    </div>
  );
}
export default function FlitoCompuerta() {
  const { hasFuncion } = useAuth();
  const [soloHabilitados, setSoloHabilitados] = useState(false);
  const [data, setData] = useState<CompuertaDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entregando, setEntregando] = useState<string | null>(null);

  // HU 12170
  const esOperaciones = hasFuncion('compuerta.tramite.entregar');

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
  // Sin datos: el fallo de la lectura es el estado de error; con datos, un fallo al entregar es un
  // aviso en la página y la tabla sigue a la vista (mismo comportamiento que antes).
  const status: EstadoUi = data === null ? (error ? 'error' : 'loading') : filas.length === 0 ? 'empty' : 'ready';

  const columnas: ColumnaTabla<CompuertaDto>[] = [
    { key: 'placa', header: 'Placa', etiqueta: 'Placa', render: (f) => <span className="font-medium">{f.placa}</span> },
    { key: 'idFlit', header: 'Trámite FLIT', etiqueta: 'Trámite FLIT', render: (f) => <span className="text-xs tabular-nums text-[color:var(--color-text-tertiary)]">{f.idFlit}</span> },
    { key: 'compania', header: 'Compañía', etiqueta: 'Compañía', render: (f) => <span className="text-sm">{f.companiaNombre}</span> },
    { key: 'soat', header: 'SOAT', etiqueta: 'SOAT', className: 'max-w-[240px]', render: (f) => <Condicion resuelto={f.soatResuelto} detalle={f.soatDetalle} valor={f.valorSoat} /> },
    { key: 'impuestos', header: 'Impuestos', etiqueta: 'Impuestos', className: 'max-w-[240px]', render: (f) => <Condicion resuelto={f.impuestosResueltos} detalle={f.impuestosDetalle} valor={f.valorImpuesto} /> },
    {
      key: 'estado', header: 'Estado', etiqueta: 'Estado',
      render: (f) => (
        <div className="flex flex-col items-start gap-1">
          <StatusChip tone="neutral">{f.estadoTramite}</StatusChip>
          {f.habilitado && f.estadoTramite === 'asignado' && <StatusChip tone="success">Habilitado</StatusChip>}
        </div>
      ),
    },
    {
      key: 'accion', header: '', acciones: true,
      render: (f) => esOperaciones && f.habilitado && f.estadoTramite === 'asignado' ? (
        <GradientButton type="button" variant="success" size="sm" onClick={() => entregar(f.tramiteId)} disabled={entregando === f.tramiteId}>
          {entregando === f.tramiteId ? 'Entregando…' : 'Entregar'}
        </GradientButton>
      ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Compuerta de entrega"
        subtitle="Evalúa si un trámite ya puede pasar a Entregado."
        actions={
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
            <input type="checkbox" className="size-4 accent-[color:var(--kit-azul)]" checked={soloHabilitados} onChange={(e) => setSoloHabilitados(e.target.checked)} />
            Solo habilitados
          </label>
        }
      />

      <InlineAlert tono="info" titulo="La compuerta habilita; no entrega.">
        <p className="m-0 text-sm">Que SOAT e impuestos estén resueltos es condición necesaria, no suficiente: el paso a «Entregado» sigue siendo una decisión que ejecuta Operaciones.</p>
      </InlineAlert>

      {error && data !== null && <InlineAlert tono="danger">{error}</InlineAlert>}

      <FlitCard>
        <DataTable
          ariaLabel="Trámites en la compuerta de entrega"
          columnas={columnas}
          filas={filas}
          getKey={(f) => f.tramiteId}
          status={status}
          onRetry={cargar}
          errorMessage={error ?? undefined}
          emptyMessage={soloHabilitados
            ? 'Ningún trámite está habilitado todavía. Quita el filtro para ver qué le falta a cada uno.'
            : 'No hay trámites asignados. Sincroniza desde FLIT para traer trámites en estado Asignado.'}
        />
      </FlitCard>
    </div>
  );
}
