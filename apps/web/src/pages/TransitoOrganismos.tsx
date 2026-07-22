import { useCallback, useEffect, useMemo, useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import {
  TRAMITE_TIPOLOGIAS,
  getTipologia,
  MODALIDAD_ORGANISMO_LABEL,
  type ChecklistOverride,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import { useAuth } from '../lib/auth';
import { puedeOperar } from '../lib/permissions';
import { PanelGestionOrganismo, MODALIDAD_TONO, type Organismo } from '../components/flito/autogestionPanels';

interface OrganismoConfig {
  codigo: string;
  nombre: string;
  ciudad: string;
  alias: string | null;
  /** Src resuelto: ruta API del logo subido, o URL externa legacy. */
  logoUrl: string | null;
  /** TRAM-MT-02 Fase 2b: URL externa cruda (editable). */
  logoUrlExterno: string | null;
  /** Presente si hay logo subido a MinIO. */
  logoStorageKey: string | null;
  activo: boolean;
  userCount: number;
  updatedAt: string | null;
}

// Fila = config de la secretaría (alias/logo/checklist) + su modalidad FLITO (autogestión),
// fusionadas por código para mostrarse en UNA sola tabla (§correcciones-UX).
type Fila = OrganismoConfig & { modalidad: Organismo | null };

const LOGO_MAX_BYTES = 512 * 1024; // 512 KB — alineado con el límite del backend.
const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

/**
 * Logo de organismo. Si `logoUrl` apunta a la API (logo subido) lo trae como
 * blob con el Bearer token (un `<img src>` directo no enviaría auth → 401);
 * si es una URL externa la usa tal cual.
 */
function LogoThumb({ logoUrl, fallback, className, style }: {
  logoUrl: string | null;
  fallback: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!logoUrl) { setSrc(null); return; }
    if (!logoUrl.startsWith('/api/')) { setSrc(logoUrl); return; }
    let objectUrl: string | null = null;
    let cancelled = false;
    setSrc(null);
    api.get<Blob>(logoUrl)
      .then((blob) => { if (!cancelled) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [logoUrl]);

  if (logoUrl && src && !failed) {
    return <img src={src} alt="" className={className} style={style} onError={() => setFailed(true)} />;
  }
  return (
    <span
      className={`flex items-center justify-center text-[10px] font-bold ${className ?? ''}`}
      style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)', ...style }}
    >
      {fallback.slice(0, 2).toUpperCase()}
    </span>
  );
}

const inputCls =
  'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none';

export default function TransitoOrganismos() {
  const { user } = useAuth();
  const editable = puedeOperar(user?.role);
  const [rows, setRows] = useState<Fila[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Fila | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [config, modalidades] = await Promise.all([
        api.get<OrganismoConfig[]>('/transito/organismos-config'),
        api.get<Organismo[]>('/flito/parametrizacion/organismos').catch(() => [] as Organismo[]),
      ]);
      const porCodigo = new Map((modalidades ?? []).map((m) => [m.codigo, m]));
      setRows((Array.isArray(config) ? config : []).map((r) => ({ ...r, modalidad: porCodigo.get(r.codigo) ?? null })));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.ciudad.toLowerCase().includes(q) ||
        r.nombre.toLowerCase().includes(q) ||
        r.codigo.includes(q) ||
        (r.alias?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, filter]);

  const configuredCount = rows.filter((r) => r.alias || r.logoUrl || r.logoStorageKey).length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Organismos de tránsito"
        subtitle={`Configuración FLIT por secretaría · ${configuredCount} con personalización`}
      />

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Buscar por ciudad, nombre o código…"
        className={inputCls}
        aria-label="Búsqueda de organismos"
      />

      <div
        className="overflow-hidden bg-white"
        style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Municipio</Th>
                <Th>Código</Th>
                <Th>Alias</Th>
                <Th>Modalidad FLITO</Th>
                <Th>Usuarios</Th>
                <Th>Estado</Th>
                <ThRight>Acciones</ThRight>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>Sin resultados</td></tr>
              )}
              {!loading && filtered.map((r) => (
                <tr key={r.codigo} className="border-t hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <LogoThumb
                        logoUrl={r.logoUrl}
                        fallback={r.ciudad}
                        className="h-8 w-8 rounded-lg object-contain"
                        style={{ border: '1px solid var(--flit-border-soft)' }}
                      />
                      <div>
                        <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{r.alias || r.ciudad}</p>
                        <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{r.nombre}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.codigo}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{r.alias || '—'}</td>
                  <td className="px-4 py-3">
                    {r.modalidad ? (
                      <StatusChip tone={MODALIDAD_TONO[r.modalidad.modalidadVigente]}>{MODALIDAD_ORGANISMO_LABEL[r.modalidad.modalidadVigente]}</StatusChip>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.userCount}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={r.activo ? 'success' : 'neutral'}>{r.activo ? 'Activo' : 'Inactivo'}</StatusChip>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(r)}
                      className="flit-focus rounded-[999px] px-2.5 py-1 text-xs font-semibold"
                      style={{ color: 'var(--flit-blue)', background: 'rgba(79, 116, 201, 0.12)' }}
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EditModal
          row={editing}
          editable={editable}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); setEditing(null); }}
          onReload={load}
        />
      )}
    </div>
  );
}

type EditTab = 'general' | 'plantilla' | 'autogestion';

function EditModal({ row, editable, onClose, onSaved, onReload }: { row: Fila; editable: boolean; onClose: () => void; onSaved: () => void; onReload: () => void }) {
  const [tab, setTab] = useState<EditTab>('general');
  const [cfg, setCfg] = useState<OrganismoConfig>(row);
  const [alias, setAlias] = useState(row.alias ?? '');
  // logoUrlExterno: URL legacy editable; el logo subido vive aparte (cfg.logoStorageKey).
  const [logoUrlExterno, setLogoUrlExterno] = useState(row.logoUrlExterno ?? '');
  const [activo, setActivo] = useState(row.activo);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const submitGeneral = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.put(`/transito/organismos-config/${row.codigo}`, {
        alias: alias.trim() || null,
        logoUrl: logoUrlExterno.trim() || null,
        activo,
      });
      toast.success('Organismo actualizado');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onPickLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite re-seleccionar el mismo archivo
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      toast.error('El logo supera el máximo de 512 KB');
      return;
    }
    setUploading(true);
    try {
      const updated = await api.upload<OrganismoConfig>(`/transito/organismos-config/${row.codigo}/logo`, file);
      setCfg(updated);
      toast.success('Logo subido');
      onReload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const removeLogo = async () => {
    if (uploading) return;
    setUploading(true);
    try {
      const updated = await api.delete<OrganismoConfig>(`/transito/organismos-config/${row.codigo}/logo`);
      setCfg(updated);
      toast.success('Logo eliminado');
      onReload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const tabBtn = (id: EditTab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold transition-colors"
      style={tab === id
        ? { background: 'var(--flit-gradient-primary)', color: 'white' }
        : { background: 'rgba(79,116,201,0.1)', color: 'var(--flit-blue)' }}
    >
      {label}
    </button>
  );

  return (
    <FlitModal title={`Editar — ${row.ciudad}`} onClose={onClose}>
      <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        {row.nombre} · Código {row.codigo}
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        {tabBtn('general', 'General')}
        {tabBtn('autogestion', 'Autogestión')}
        {tabBtn('plantilla', 'Plantilla documentos')}
      </div>

      {tab === 'autogestion' && (
        row.modalidad
          ? <PanelGestionOrganismo organismo={row.modalidad} editable={editable} onCambio={onReload} />
          : <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Este organismo aún no tiene datos de modalidad FLITO.</p>
      )}

      {tab === 'general' && (
        <form onSubmit={submitGeneral} className="space-y-4">
          <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            Alias (nombre corto en bandeja)
            <input className={`${inputCls} mt-1`} maxLength={120} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={row.ciudad} />
          </label>
          <div className="rounded-xl border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Logo subido</p>
            <div className="flex items-center gap-3">
              <LogoThumb
                logoUrl={cfg.logoStorageKey ? cfg.logoUrl : null}
                fallback={cfg.ciudad}
                className="h-14 w-14 rounded-lg object-contain"
                style={{ border: '1px solid var(--flit-border-soft)' }}
              />
              <div className="flex flex-col gap-1.5">
                <label
                  className="flit-focus inline-flex w-fit cursor-pointer items-center rounded-[999px] px-3 py-1.5 text-xs font-semibold"
                  style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)', opacity: uploading ? 0.6 : 1 }}
                >
                  {uploading ? 'Procesando…' : cfg.logoStorageKey ? 'Reemplazar logo' : 'Subir logo'}
                  <input type="file" accept={LOGO_ACCEPT} className="sr-only" onChange={onPickLogo} disabled={uploading} />
                </label>
                {cfg.logoStorageKey && (
                  <button
                    type="button"
                    onClick={removeLogo}
                    disabled={uploading}
                    className="flit-focus w-fit text-[11px] font-semibold"
                    style={{ color: 'var(--flit-warning)' }}
                  >
                    Quitar logo subido
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
              PNG, JPEG, WEBP o SVG · máx. 512 KB. El logo subido tiene prioridad sobre la URL externa.
            </p>
          </div>

          <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            URL del logo externo (https o /ruta) — opcional
            <input className={`${inputCls} mt-1`} maxLength={500} value={logoUrlExterno} onChange={(e) => setLogoUrlExterno(e.target.value)} placeholder="https://…" />
          </label>
          {logoUrlExterno.trim() && !cfg.logoStorageKey && (
            <div className="flex items-center gap-3 rounded-xl border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <img src={logoUrlExterno.trim()} alt="" className="h-12 w-12 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Vista previa (URL externa)</span>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} className="flit-focus h-4 w-4 rounded" />
            Organismo activo en FLIT
          </label>
          <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
            Usuarios tránsito asignados: {row.userCount}. Asignar más en Usuarios → Rol Tránsito.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="flit-focus rounded-[999px] px-4 py-2 text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              Cancelar
            </button>
            <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Guardar'}</GradientButton>
          </div>
        </form>
      )}

      {tab === 'plantilla' && (
        <PlantillaDocumentosTab organismoCodigo={row.codigo} onClose={onClose} />
      )}
    </FlitModal>
  );
}

function PlantillaDocumentosTab({ organismoCodigo, onClose }: { organismoCodigo: string; onClose: () => void }) {
  const [tipologia, setTipologia] = useState('traspaso_standard');
  const [override, setOverride] = useState<ChecklistOverride>({ hide: [], require: [], add: [] });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [addId, setAddId] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addObligatorio, setAddObligatorio] = useState(true);

  const base = useMemo(() => getTipologia(tipologia)?.checklist ?? [], [tipologia]);
  const hidden = useMemo(() => new Set(override.hide ?? []), [override.hide]);
  const required = useMemo(() => new Set(override.require ?? []), [override.require]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<{ override: ChecklistOverride }>(`/transito/organismos-config/${organismoCodigo}/checklist/${tipologia}`)
      .then((d) => {
        if (!cancelled) {
          setOverride({
            hide: d.override?.hide ?? [],
            require: d.override?.require ?? [],
            add: d.override?.add ?? [],
          });
        }
      })
      .catch(() => { if (!cancelled) setOverride({ hide: [], require: [], add: [] }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [organismoCodigo, tipologia]);

  const toggleHide = (id: string) => {
    const next = new Set(override.hide ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOverride({ ...override, hide: [...next] });
  };

  const toggleRequire = (id: string) => {
    const next = new Set(override.require ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOverride({ ...override, require: [...next] });
  };

  const addItem = () => {
    const id = addId.trim();
    const label = addLabel.trim();
    if (!id || !label) return;
    if (base.some((i) => i.id === id) || (override.add ?? []).some((i) => i.id === id)) {
      toast.error('ID ya existe en catálogo o anexos');
      return;
    }
    setOverride({
      ...override,
      add: [...(override.add ?? []), { id, label, obligatorio: addObligatorio }],
    });
    setAddId('');
    setAddLabel('');
  };

  const removeAdd = (id: string) => {
    setOverride({ ...override, add: (override.add ?? []).filter((i) => i.id !== id) });
  };

  const save = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.put(`/transito/organismos-config/${organismoCodigo}/checklist/${tipologia}`, override);
      toast.success('Plantilla guardada');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
        Tipología
        <select className={`${inputCls} mt-1`} value={tipologia} onChange={(e) => setTipologia(e.target.value)}>
          {TRAMITE_TIPOLOGIAS.map((t) => (
            <option key={t.codigo} value={t.codigo}>{t.nombre}</option>
          ))}
        </select>
      </label>

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando plantilla…</p>
      ) : (
        <>
          <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
            Ajusta el checklist nacional para este STT. Los cambios aplican al wizard y al gate de envío a tránsito.
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
            {base.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs" style={{ background: 'var(--flit-bg-app)' }}>
                <span className="min-w-0 flex-1 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{item.label}</span>
                <label className="flex items-center gap-1" style={{ color: 'var(--flit-text-muted)' }}>
                  <input type="checkbox" checked={hidden.has(item.id)} onChange={() => toggleHide(item.id)} className="flit-focus h-3.5 w-3.5" />
                  Ocultar
                </label>
                {!item.obligatorio && (
                  <label className="flex items-center gap-1" style={{ color: 'var(--flit-text-muted)' }}>
                    <input type="checkbox" checked={required.has(item.id)} onChange={() => toggleRequire(item.id)} className="flit-focus h-3.5 w-3.5" />
                    Obligatorio
                  </label>
                )}
              </li>
            ))}
          </ul>

          {(override.add ?? []).length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Anexos adicionales STT</p>
              <ul className="space-y-1">
                {(override.add ?? []).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <span style={{ color: 'var(--flit-text-primary)' }}>{item.label} <span style={{ color: 'var(--flit-text-muted)' }}>({item.id})</span></span>
                    <button type="button" onClick={() => removeAdd(item.id)} className="text-[10px] font-semibold" style={{ color: 'var(--flit-warning)' }}>Quitar</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Agregar anexo STT</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={inputCls} placeholder="id_estable" value={addId} onChange={(e) => setAddId(e.target.value)} maxLength={80} />
              <input className={inputCls} placeholder="Etiqueta visible" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} maxLength={200} />
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
              <input type="checkbox" checked={addObligatorio} onChange={(e) => setAddObligatorio(e.target.checked)} className="flit-focus h-3.5 w-3.5" />
              Obligatorio para enviar a tránsito
            </label>
            <button type="button" onClick={addItem} className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>Agregar a la lista</button>
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="flit-focus rounded-[999px] px-4 py-2 text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Cerrar
        </button>
        <GradientButton type="button" onClick={save} disabled={submitting || loading}>
          {submitting ? 'Guardando…' : 'Guardar plantilla'}
        </GradientButton>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
      {children}
    </th>
  );
}

function ThRight({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
      {children}
    </th>
  );
}
