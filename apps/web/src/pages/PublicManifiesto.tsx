import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import LayoutPublico from '../components/flit/LayoutPublico';
import InlineAlert from '../components/flit/InlineAlert';
import { Cargador } from '../components/flit/Cargador';
import { Icono } from '../components/flit/kit/Icono';

interface PublicData {
  valido: boolean;
  numero?: string;
  consecutivoRndc?: string | null;
  estado?: string;
  fechaExpedicion?: string;
  placa?: string | null;
  origen?: string | null;
  destino?: string | null;
  razonSocialEmpresa?: string;
}

export default function PublicManifiesto() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setError('Token inválido'); setLoading(false); return; }
    fetch(`/api/rndc/public/manifiestos/qr/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) { setData({ valido: false }); return; }
        if (!r.ok) throw new Error('No disponible');
        const json = await r.json();
        setData(json);
      })
      .catch(() => setError('No se pudo verificar'))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <LayoutPublico ancho={640}>
        <Cargador texto="Verificando..." className="mx-auto my-12" />
      </LayoutPublico>
    );
  }

  return (
    <LayoutPublico ancho={640}>
      <section className="card seg">
        <div className="seg__cab">
          <span aria-hidden="true"><Icono nombre="documento" disco size={48} /></span>
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">Verificación pública</div>
            <h1 className="mt-1 text-xl font-bold text-[var(--color-action)]">Manifiesto electrónico de carga</h1>
            <div className="mt-1 text-xs text-[var(--color-text-tertiary)]">FLIT SAS — Sistema de Operaciones</div>
          </div>
        </div>

        <div>
          {error && <InlineAlert tono="danger">{error}</InlineAlert>}

          {!error && data && !data.valido && (
            <InlineAlert tono="danger" titulo="Manifiesto no válido">
              El documento no existe, fue anulado o ha sido eliminado.
            </InlineAlert>
          )}

          {!error && data && data.valido && (
            <>
              <div className="mb-5">
                <InlineAlert tono="ok" titulo="Manifiesto vigente">Estado: {data.estado}</InlineAlert>
              </div>

              <dl className="space-y-3 text-sm">
                <Row label="Número interno" value={data.numero ?? '—'} />
                <Row label="Consecutivo RNDC" value={data.consecutivoRndc ?? 'En proceso de radicación'} />
                {data.razonSocialEmpresa && <Row label="Empresa transportadora" value={data.razonSocialEmpresa} />}
                <Row label="Fecha expedición" value={data.fechaExpedicion ?? '—'} />
                <Row label="Placa cabezote" value={data.placa ?? '—'} mono />
                <Row label="Origen" value={data.origen ?? '—'} />
                <Row label="Destino" value={data.destino ?? '—'} />
              </dl>
            </>
          )}
        </div>

        <div className="nota flex flex-wrap justify-between gap-2 border-t border-[var(--color-border)] pt-3 text-[var(--color-text-tertiary)]">
          <span>Verificación pública · sin datos personales</span>
          <span>operaciones.flitsas.com</span>
        </div>
      </section>
    </LayoutPublico>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border)] pb-2">
      <dt className="text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className={`font-medium text-[var(--color-text-primary)] ${mono ? 'mono' : ''}`}>{value}</dd>
    </div>
  );
}
