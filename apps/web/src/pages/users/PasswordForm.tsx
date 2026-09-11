// FLITO — cambio de contraseña desde la pantalla de usuarios (propia o restablecida por el admin).
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// **Esto NO es kit.** Props tipadas, sin estado global, un único consumidor: la página de usuarios.

import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import type { User } from './types';
import { Field, Footer, formatErrors, inputCls, PASSWORD_PATTERN, PASSWORD_TITLE } from './UserFormShared';

export default function PasswordForm({ user, isSelf, onClose, onSaved }: { user: User; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (f.newPassword !== f.confirmPassword) { toast.error('Las contraseñas no coinciden'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, string> = { newPassword: f.newPassword };
      if (isSelf) body.currentPassword = f.currentPassword;
      else body.currentPassword = 'admin-override';
      await api.patch(`/users/${user.id}/password`, body);
      toast.success('Contraseña actualizada');
      onSaved();
      onClose();
    } catch (err) { toast.error(formatErrors(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title={`Contraseña — ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {isSelf && (
          <Field label="Contraseña actual">
            <input required type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} className={inputCls} />
          </Field>
        )}
        {!isSelf && (
          <p className="rounded-xl p-3 text-xs" style={{ color: 'var(--flit-warning)', background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.30)' }}>
            Como administrador, está restableciendo la contraseña de otro usuario. Quedará registrado en auditoría.
          </p>
        )}
        <Field label="Contraseña nueva">
          <input required type="password" minLength={8} pattern={PASSWORD_PATTERN} title={PASSWORD_TITLE}
            value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} className={inputCls} />
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{PASSWORD_TITLE}</p>
        </Field>
        <Field label="Confirmar nueva">
          <input required type="password" minLength={8} value={f.confirmPassword} onChange={(e) => setF({ ...f, confirmPassword: e.target.value })} className={inputCls} />
        </Field>
        <Footer onClose={onClose} submitting={submitting} label="Cambiar contraseña" />
      </form>
    </FlitModal>
  );
}
