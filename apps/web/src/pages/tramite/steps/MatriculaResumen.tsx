// Resumen consolidado de la matrícula (paso 5): muestra el estado final de un
// vistazo (placa, SOAT, vehículo, comprador, identidad, documentos, organismo)
// sin tener que entrar a cada pestaña del expediente. El detalle por pestañas
// sigue debajo (ExpedienteVisor) para quien quiera profundizar.

interface RuntSoat {
  numSoat?: string | null;
  noPoliza?: string | null;
  fechaVencimSoat?: string | null;
  estado?: string | null;
  razonSocialAsegur?: string | null;
  aseguradora?: string | null;
}

interface Props {
  estado: string;
  vehiculo: Record<string, any> | null;
  comprador: { nombre?: string; documento?: string; tipoDoc?: string } | null;
  vin: string;
  archivosCount: number;
  identidadAprobada: boolean;
  orgTransito: { nombre?: string; ciudad?: string };
}

const ESTADO_LABEL: Record<string, string> = {
  borrador: 'Borrador (en preparación)',
  radicado: 'Radicado',
  en_validacion: 'En validación',
  documentos: 'Documentos',
  identidad: 'Identidad',
  aprobado: 'Aprobado',
  rechazado: 'Devuelto con observación',
  enviado_transito: 'Enviado a tránsito',
  recibido_transito: 'Recibido por tránsito',
  placa_preasignada: 'Placa preasignada',
  solicitud_soat: 'Placa asignada — pendiente SOAT',
  soat_comprado: 'SOAT comprado',
  soat_verificado: 'Matrícula lista — SOAT vigente',
  completado: 'Completada',
};

const ESTADOS_OK = ['soat_verificado', 'completado'];
const ESTADOS_TRANSITO = ['enviado_transito', 'recibido_transito', 'placa_preasignada', 'solicitud_soat', 'soat_comprado', 'soat_verificado', 'completado'];

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{value || '—'}</p>
    </div>
  );
}

export default function MatriculaResumen({ estado, vehiculo, comprador, vin, archivosCount, identidadAprobada, orgTransito }: Props) {
  const v = (vehiculo || {}) as Record<string, any>;
  const placa = (v.placa as string) || null;
  const soat = (Array.isArray(v.soat) ? v.soat[0] : v.soat) as RuntSoat | undefined;
  const ok = ESTADOS_OK.includes(estado);
  const enTransito = ESTADOS_TRANSITO.includes(estado);
  const soatTxt = ok
    ? `Vigente${soat?.fechaVencimSoat ? ` · vence ${String(soat.fechaVencimSoat).split('T')[0]}` : ''}`
    : enTransito ? 'Pendiente de póliza' : '—';
  const tone = ok ? 'var(--flit-success)' : enTransito ? 'var(--flit-blue)' : 'var(--flit-text-muted)';

  return (
    <section aria-label="Resumen de la matrícula" className="mb-4 rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-5 w-1.5 rounded-full" style={{ background: tone }} />
          <h3 className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--flit-text-primary)' }}>Resumen de la matrícula</h3>
        </div>
        <span className="rounded-full px-3 py-1 text-[11px] font-semibold" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}>
          {ESTADO_LABEL[estado] || estado}
        </span>
      </div>

      {placa && (
        <div className="mb-3 flex items-center gap-3">
          <span className="font-mono text-2xl font-bold tracking-widest" style={{ color: tone }}>{placa}</span>
          <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>SOAT: {soatTxt}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Field label="Vehículo" value={[v.marca, v.linea, v.modelo].filter(Boolean).join(' ')} />
        <Field label="VIN" value={vin} />
        <Field label="Comprador" value={comprador?.nombre} />
        <Field label="Documento" value={comprador?.documento ? `${comprador?.tipoDoc || 'CC'} ${comprador.documento}` : null} />
        <Field label="Identidad" value={identidadAprobada ? 'Verificada' : 'Pendiente'} />
        <Field label="Documentos" value={`${archivosCount} cargado${archivosCount === 1 ? '' : 's'}`} />
        <Field label="Organismo de tránsito" value={[orgTransito?.nombre, orgTransito?.ciudad].filter(Boolean).join(' · ')} />
        {soat?.numSoat || soat?.noPoliza ? <Field label="N.º SOAT" value={soat.numSoat || soat.noPoliza} /> : null}
        {soat?.razonSocialAsegur || soat?.aseguradora ? <Field label="Aseguradora" value={soat.razonSocialAsegur || soat.aseguradora} /> : null}
      </div>

      <p className="mt-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
        El detalle completo (documentos, fotos de identidad, FUR, certificación) está en el expediente, abajo.
      </p>
    </section>
  );
}
