// EPIC TRAM-INNOV · A3 — invitar participantes externos (magic link) desde el wizard.
//
// El gestor agrega comprador/vendedor/mandatario (con email y opt-in WhatsApp para
// A4) y genera enlaces por rol para copiar. Estilos FLIT.

import { useState, useEffect } from 'react';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';

type Rol = 'comprador' | 'vendedor' | 'mandatario';
interface Link { rol: string; email: string | null; url: string; expires: string }
// TRAM-COMMS-02: participantes pendientes + último recordatorio.
interface Pendiente {
  id: number; rol: string; tieneEmail: boolean; whatsappOptIn: boolean; tieneTelefono: boolean;
  expiresAt: string; vencido: boolean; lastReminderAt: string | null; createdAt: string;
}

function fmtRel(iso: string | null): string {
  if (!iso) return 'sin recordatorio';
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'hace <1h';
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

const ROLES: { key: Rol; label: string }[] = [
  { key: 'comprador', label: 'Comprador' },
  { key: 'vendedor', label: 'Vendedor' },
  { key: 'mandatario', label: 'Mandatario' },
];
const CARD = 'bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-5';
const inp = 'flit-focus w-full rounded-[10px] border bg-white px-3 py-2 text-sm outline-none';

export default function InvitarParticipantes({ tramiteId }: { tramiteId: number }) {
  const [rol, setRol] = useState<Rol>('comprador');
  const [email, setEmail] = useState('');
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  const [telefono, setTelefono] = useState('');
  const [loading, setLoading] = useState(false);
  const [links, setLinks] = useState<Link[]>([]);
  // A4: capacidades de notificación (degradación elegante en la UI).
  const [notif, setNotif] = useState<{ whatsapp: boolean; email: boolean } | null>(null);
  // TRAM-COMMS-02: pendientes (no completados) + último recordatorio.
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);

  const cargarPendientes = () => {
    api.get<{ participantes: Pendiente[] }>(`/tramites/${tramiteId}/participantes-pendientes`)
      .then((r) => setPendientes(r.participantes ?? [])).catch(() => setPendientes([]));
  };

  useEffect(() => {
    api.get<{ whatsapp: boolean; email: boolean }>('/tramites/notif-config').then(setNotif).catch(() => setNotif({ whatsapp: false, email: false }));
    cargarPendientes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tramiteId]);

  const invitar = async () => {
    setLoading(true);
    try {
      const r = await api.post<{ links: Link[] }>(`/tramites/${tramiteId}/invitar`, {
        participantes: [{ rol, email: email || undefined, telefono: telefono || undefined, whatsappOptIn }],
      });
      setLinks((prev) => [...r.links, ...prev]);
      toast.success('Enlace generado (válido 24h)');
      setEmail(''); setTelefono('');
      cargarPendientes();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className={`${CARD} mt-4`}>
      <h4 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Invitar comprador / vendedor</h4>
      <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Genera un enlace para que completen sus pasos sin cuenta FLIT (acepta datos Ley 1581 y sube documentos).</p>

      {notif && !notif.whatsapp && (
        <p className="mb-3 rounded-[10px] p-2.5 text-[11px]" style={{ background: 'rgba(240,90,53,0.10)', color: 'var(--flit-warning)' }}>
          Notificaciones por WhatsApp no configuradas — se usará {notif.email ? 'email' : 'el enlace manual'} para avisar el estado.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <select value={rol} onChange={(e) => setRol(e.target.value as Rol)} className={inp} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
          {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (opcional)" type="email" className={inp} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
        <input value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="WhatsApp (opcional)" className={inp} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          <input type="checkbox" checked={whatsappOptIn} onChange={(e) => setWhatsappOptIn(e.target.checked)} className="h-4 w-4 accent-[color:var(--flit-blue)]" />
          Autoriza notificaciones por WhatsApp
        </label>
      </div>
      <button type="button" onClick={invitar} disabled={loading}
        className="flit-focus mt-3 inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-60"
        style={{ background: 'var(--flit-gradient-primary)' }}>
        {loading ? 'Generando…' : 'Generar enlace'}
      </button>

      {links.length > 0 && (
        <ul className="mt-4 space-y-2">
          {links.map((l, i) => (
            <li key={i} className="rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold capitalize" style={{ color: 'var(--flit-text-primary)' }}>{l.rol}{l.email ? ` · ${l.email}` : ''}</span>
                <button type="button" onClick={() => { navigator.clipboard?.writeText(l.url); toast.success('Enlace copiado'); }}
                  className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                  Copiar enlace
                </button>
              </div>
              <p className="mt-1 break-all text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{l.url}</p>
            </li>
          ))}
        </ul>
      )}

      {/* TRAM-COMMS-02: pendientes + último recordatorio (el cron reenvía a diario). */}
      {pendientes.length > 0 && (
        <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="mb-2 flex items-center gap-2">
            <h5 className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Pendientes</h5>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(240,90,53,0.12)', color: 'var(--flit-warning)' }}>{pendientes.length}</span>
          </div>
          <ul className="space-y-1.5">
            {pendientes.map((p) => {
              const sinCanal = !p.tieneEmail && !(p.whatsappOptIn && p.tieneTelefono);
              return (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold capitalize" style={{ color: 'var(--flit-text-primary)' }}>{p.rol}</span>
                      {p.tieneEmail && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>email</span>}
                      {p.whatsappOptIn && p.tieneTelefono && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(112,207,58,0.15)', color: 'var(--flit-success)' }}>whatsapp</span>}
                      {sinCanal && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(240,90,53,0.12)', color: 'var(--flit-warning)' }}>sin canal · copia el link</span>}
                      {p.vencido && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(228,61,48,0.12)', color: 'var(--flit-danger)' }}>enlace vencido</span>}
                    </div>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Último recordatorio: {fmtRel(p.lastReminderAt)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
