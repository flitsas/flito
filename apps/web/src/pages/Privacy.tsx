import { useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import { flitInp, FlitCard, FlitField } from '../components/flit/flitPageKit';
import KpiCard from '../components/flit/KpiCard';

interface PreviewResponse {
  docNumber: string;
  affected: {
    clients: number;
    vehicles: number;
    soat_requests: number;
    tramites_digitales: number;
    laft_counterparties: number;
    laft_beneficial_owners: number;
  };
}

interface ForgetResponse {
  ok: boolean;
  docHash: string;
  summary: Record<string, number>;
  totalAffected: number;
  note: string;
}

export default function Privacy() {
  const { hasFuncion } = useAuth();
  const [docNumber, setDocNumber] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const isAdmin = hasFuncion('privacy.olvido.administrar');

  const handlePreview = async (e: FormEvent) => {
    e.preventDefault();
    if (loadingPreview) return;
    if (docNumber.trim().length < 3) { toast.error('Documento muy corto'); return; }
    setLoadingPreview(true);
    setPreview(null);
    try {
      const res = await api.post<PreviewResponse>('/privacy/preview', { docNumber: docNumber.trim() });
      setPreview(res);
      const total = Object.values(res.affected).reduce((a, b) => a + b, 0);
      if (total === 0) toast(`No hay registros con ese documento`, { icon: 'i' });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Privacidad y datos personales"
        subtitle="Derecho al olvido — Ley 1581 de 2012"
        icono="flito-privacidad"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'Privacidad' }]}
      />

      <div className="kit-alerta flex-col gap-2" data-tono="warn" data-kit="alerta">
        <p className="text-sm font-semibold text-[color:var(--kit-naranja-texto)]">Política de anonimización</p>
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-[color:var(--color-text-secondary)]">
          <li>La operación <b>anonimiza, no elimina</b>: nombres, emails, teléfonos y direcciones se reemplazan por marcadores; el documento se reemplaza por un hash determinístico.</li>
          <li>Los registros se preservan para cumplir auditoría LAFT (5 años) e ISO 27001 (audit logs append-only).</li>
          <li>Solo administradores pueden ejecutar la anonimización. Compliance puede consultar la previsualización.</li>
          <li>La operación queda registrada en el log de auditoría con el motivo declarado.</li>
        </ul>
      </div>

      <FlitCard>
        <form onSubmit={handlePreview}>
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-12">
            <div className="md:col-span-9">
              <FlitField label="Número de documento">
                <input
                  required
                  minLength={3}
                  maxLength={20}
                  value={docNumber}
                  onChange={(e) => setDocNumber(e.target.value)}
                  placeholder="Ej: 1036640908"
                  className={`${flitInp} font-mono`}
                />
              </FlitField>
            </div>
            <div className="md:col-span-3">
              <GradientButton type="submit" disabled={loadingPreview} className="w-full">
                {loadingPreview ? 'Buscando...' : 'Previsualizar'}
              </GradientButton>
            </div>
          </div>
        </form>
      </FlitCard>

      {preview && <PreviewResult preview={preview} isAdmin={isAdmin} onForget={() => setShowConfirm(true)} />}

      {showConfirm && preview && (
        <ForgetModal
          docNumber={preview.docNumber}
          affected={preview.affected}
          onClose={() => setShowConfirm(false)}
          onDone={(result) => {
            setShowConfirm(false);
            setPreview(null);
            setDocNumber('');
            toast.success(`Anonimización completada: ${result.totalAffected} registros`);
          }}
        />
      )}
    </div>
  );
}

function PreviewResult({ preview, isAdmin, onForget }: { preview: PreviewResponse; isAdmin: boolean; onForget: () => void }) {
  const total = Object.values(preview.affected).reduce((a, b) => a + b, 0);
  const TABLE_LABELS: Record<keyof PreviewResponse['affected'], string> = {
    clients: 'Clientes',
    vehicles: 'Vehículos',
    soat_requests: 'Solicitudes SOAT',
    tramites_digitales: 'Trámites digitales',
    laft_counterparties: 'Contrapartes LAFT',
    laft_beneficial_owners: 'Beneficiarios finales LAFT',
  };

  return (
    <FlitCard>
      <p className="mb-4 text-sm font-semibold text-[color:var(--color-text-primary)]">
        Documento <span className="font-mono text-[color:var(--color-action)]">{preview.docNumber}</span>
        {' '}— {total} registro{total === 1 ? '' : 's'} afectado{total === 1 ? '' : 's'}
      </p>

      {total === 0 ? (
        <p className="text-sm italic text-[color:var(--color-text-tertiary)]">No hay registros con este documento. Nada que anonimizar.</p>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            {(Object.entries(preview.affected) as [keyof PreviewResponse['affected'], number][]).map(([key, count]) => (
              <KpiCard key={key} label={TABLE_LABELS[key]} value={count} pendiente={count > 0} />
            ))}
          </div>

          {isAdmin ? (
            <GradientButton type="button" variant="alerta" onClick={onForget}>
              Anonimizar este documento
            </GradientButton>
          ) : (
            <p className="text-xs italic text-[color:var(--color-text-tertiary)]">Solo administradores pueden ejecutar la anonimización.</p>
          )}
        </>
      )}
    </FlitCard>
  );
}

function ForgetModal({
  docNumber, affected, onClose, onDone,
}: {
  docNumber: string;
  affected: PreviewResponse['affected'];
  onClose: () => void;
  onDone: (r: ForgetResponse) => void;
}) {
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const total = Object.values(affected).reduce((a, b) => a + b, 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (reason.trim().length < 10) { toast.error('Motivo muy corto (mínimo 10 caracteres)'); return; }
    if (confirmText !== docNumber) { toast.error('Debe escribir el documento exacto para confirmar'); return; }

    setSubmitting(true);
    try {
      const res = await api.post<ForgetResponse>('/privacy/forget', { docNumber, reason: reason.trim() });
      onDone(res);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FlitModal title="Confirmar anonimización" onClose={onClose} icono="alerta">
      <div className="kit-alerta mb-4" data-tono="danger" data-kit="alerta">
        <p className="text-xs font-semibold uppercase tracking-[0.03em] text-[color:var(--kit-rojo-texto)]">Acción crítica — no reversible</p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-[9px] border border-[color:var(--color-border)] bg-[var(--kit-hover)] p-4 text-xs">
          <p className="text-[color:var(--color-text-tertiary)]">Documento a anonimizar</p>
          <p className="mt-0.5 font-mono font-semibold text-[color:var(--color-text-primary)]">{docNumber}</p>
          <p className="mt-2 text-[color:var(--color-text-tertiary)]">
            Registros afectados: <b className="text-[color:var(--color-text-primary)]">{total}</b>
          </p>
        </div>

        <FlitField label="Motivo (queda registrado en auditoría)">
          <textarea
            required
            minLength={10}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Ej: Solicitud titular el 27/04/2026 — Ley 1581 art. 16"
            className={`${flitInp} resize-none`}
          />
        </FlitField>

        <FlitField label={`Para confirmar, escriba el documento exacto: ${docNumber}`}>
          <input
            required
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className={`${flitInp} font-mono`}
          />
        </FlitField>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</GradientButton>
          <GradientButton type="submit" variant="alerta" disabled={submitting || confirmText !== docNumber}>
            {submitting ? 'Anonimizando...' : 'Confirmar anonimización'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
