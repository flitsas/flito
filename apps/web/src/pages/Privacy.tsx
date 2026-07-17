import { useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import { flitInp, FlitCard, FlitField, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';

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
  const { user } = useAuth();
  const [docNumber, setDocNumber] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const isAdmin = user?.role === 'admin';

  const handlePreview = async (e: FormEvent) => {
    e.preventDefault();
    if (loadingPreview) return;
    if (docNumber.trim().length < 3) { toast.error('Documento muy corto'); return; }
    setLoadingPreview(true);
    setPreview(null);
    try {
      const res = await api.get<PreviewResponse>(`/privacy/preview/${encodeURIComponent(docNumber.trim())}`);
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
      />

      <div
        className="rounded-[12px] px-4 py-4"
        style={{ background: 'rgba(240, 90, 53, 0.10)', border: '1px solid rgba(240, 90, 53, 0.25)' }}
      >
        <p className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-warning)' }}>Política de anonimización</p>
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
          <li>La operación <b>anonimiza, no elimina</b>: nombres, emails, teléfonos y direcciones se reemplazan por marcadores; el documento se reemplaza por un hash determinístico.</li>
          <li>Los registros se preservan para cumplir auditoría LAFT (5 años) e ISO 27001 (audit logs append-only).</li>
          <li>Solo administradores pueden ejecutar la anonimización. Compliance puede consultar la previsualización.</li>
          <li>La operación queda registrada en el log de auditoría con el motivo declarado.</li>
        </ul>
      </div>

      <FlitCard>
        <form onSubmit={handlePreview}>
          <div className="grid grid-cols-12 items-end gap-3">
            <div className="col-span-12 md:col-span-9">
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
            <div className="col-span-12 md:col-span-3">
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
      <p className="mb-4 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Documento <span className="font-mono" style={{ color: 'var(--flit-blue)' }}>{preview.docNumber}</span>
        {' '}— {total} registro{total === 1 ? '' : 's'} afectado{total === 1 ? '' : 's'}
      </p>

      {total === 0 ? (
        <p className="text-sm italic" style={{ color: 'var(--flit-text-muted)' }}>No hay registros con este documento. Nada que anonimizar.</p>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
            {(Object.entries(preview.affected) as [keyof PreviewResponse['affected'], number][]).map(([key, count]) => (
              <div
                key={key}
                className="rounded-[10px] px-4 py-3"
                style={count > 0
                  ? { background: 'rgba(240, 90, 53, 0.10)', border: '1px solid rgba(240, 90, 53, 0.25)' }
                  : { background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{TABLE_LABELS[key]}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums" style={{ color: count > 0 ? 'var(--flit-warning)' : 'var(--flit-text-muted)' }}>{count}</p>
              </div>
            ))}
          </div>

          {isAdmin ? (
            <button
              type="button"
              onClick={onForget}
              className="flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white"
              style={{ background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
            >
              Anonimizar este documento
            </button>
          ) : (
            <p className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Solo administradores pueden ejecutar la anonimización.</p>
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
    <FlitModal title="Confirmar anonimización" onClose={onClose}>
      <div
        className="mb-4 rounded-[10px] px-4 py-3"
        style={{ background: 'rgba(228, 61, 48, 0.12)', border: '1px solid rgba(228, 61, 48, 0.25)' }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--flit-danger)' }}>Acción crítica — no reversible</p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-[10px] p-4 text-xs" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
          <p style={{ color: 'var(--flit-text-muted)' }}>Documento a anonimizar</p>
          <p className="mt-0.5 font-mono font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{docNumber}</p>
          <p className="mt-2" style={{ color: 'var(--flit-text-muted)' }}>
            Registros afectados: <b style={{ color: 'var(--flit-text-primary)' }}>{total}</b>
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

        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} disabled={submitting} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
          <button
            type="submit"
            disabled={submitting || confirmText !== docNumber}
            className="flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
          >
            {submitting ? 'Anonimizando...' : 'Confirmar anonimización'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
