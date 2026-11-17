import { useCallback, useEffect, useMemo, useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import {
  TRAMITE_TIPOLOGIAS,
  getTipologia,
  MODALIDAD_ORGANISMO_LABEL,
  ModalidadOrganismo,
  type ChecklistOverride,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { flitInp } from '../components/flit/flitPageKit';
import { Icono } from '../components/flit/kit/Icono';
import { Girador } from '../components/flit/Cargador';
import { useAuth } from '../lib/auth';
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

// Modalidad efectiva de una secretaría para la UI: si aún no tiene vigencia, el default del dominio es
// AUTOGESTIONADO (igual que el backend, flito-parametrizacion.service → modalidadVigente). Así TODAS las
// secretarías se ven clasificadas y son editables (nunca queda el aviso "no tiene datos de modalidad").
function organismoParaPanel(r: Fila): Organismo {
  return r.modalidad ?? {
    codigo: r.codigo, nombre: r.alias ?? r.nombre ?? r.codigo, alias: r.alias, activo: r.activo,
    modalidadVigente: ModalidadOrganismo.AUTOGESTIONADO,
    umbralOcr: null, slaHoras: null, diferenciaValorActiva: false, tramitesRetenidos: 0,
  };
}

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
      className={`flex items-center justify-center bg-[var(--kit-hover)] text-xs font-bold text-[var(--color-action)] ${className ?? ''}`}
      style={style}
    >
      {fallback.slice(0, 2).toUpperCase()}
    </span>
  );
}

const inputCls = flitInp;
const LOGO_CLS = 'rounded-[9px] border border-[var(--color-border)] object-contain';
const ETIQUETA = 'block text-sm font-semibold text-[var(--color-text-secondary)]';
const BLOQUE = 'rounded-[9px] border border-[var(--color-border)] p-3';

export default function TransitoOrganismos() {
  const { hasFuncion } = useAuth();
  // HU #12170
  const editable = hasFuncion('transito.config.editar');
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

  // Molde #organismos: lista con logo/nombre (columna «personas»), código, etiqueta de modalidad y acción por fila.
  const columnas: ColumnaTabla<Fila>[] = [
    {
      key: 'municipio', header: 'Municipio', render: (r) => (
        <div className="flex items-center gap-3">
          <LogoThumb logoUrl={r.logoUrl} fallback={r.ciudad} className={`h-10 w-10 shrink-0 ${LOGO_CLS}`} />
          <div className="min-w-0">
            <p className="font-semibold text-[var(--color-text-primary)]">{r.alias || r.ciudad}</p>
            <p className="text-xs text-[var(--color-text-tertiary)]">{r.nombre}</p>
          </div>
        </div>
      ),
    },
    { key: 'codigo', header: 'Código', render: (r) => <span className="mono text-xs text-[var(--color-text-secondary)]">{r.codigo}</span> },
    { key: 'alias', header: 'Alias', render: (r) => r.alias || '—' },
    {
      key: 'modalidad', header: 'Modalidad FLITO', render: (r) => (
        <StatusChip tone={MODALIDAD_TONO[organismoParaPanel(r).modalidadVigente]}>
          {MODALIDAD_ORGANISMO_LABEL[organismoParaPanel(r).modalidadVigente]}
        </StatusChip>
      ),
    },
    { key: 'usuarios', header: 'Usuarios', render: (r) => <span className="tabular-nums">{r.userCount}</span> },
    { key: 'estado', header: 'Estado', render: (r) => <StatusChip tone={r.activo ? 'success' : 'neutral'}>{r.activo ? 'Activo' : 'Inactivo'}</StatusChip> },
    {
      key: 'acciones', header: 'Acciones', acciones: true, align: 'right', render: (r) => (
        <GradientButton type="button" size="sm" variant="secondary" onClick={() => setEditing(r)}>
          <Icono nombre="lapiz" size={16} />
          Editar
        </GradientButton>
      ),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Organismos de tránsito"
        subtitle={`Configuración FLIT por secretaría · ${configuredCount} con personalización`}
        icono="flito-transito"
        miga={[]}
      />

      <div className="relative max-w-xl">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" aria-hidden="true">
          <Icono nombre="buscar" size={18} />
        </span>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Buscar por ciudad, nombre o código…"
          className={`${inputCls} !pl-10`}
          aria-label="Búsqueda de organismos"
        />
      </div>

      <DataTable
        ariaLabel="Organismos de tránsito"
        columnas={columnas}
        filas={filtered}
        getKey={(r) => r.codigo}
        status={loading ? 'loading' : undefined}
        emptyMessage="Sin resultados"
      />

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
      className={`kit-pestana${tab === id ? ' kit-pestana--activa' : ''}`}
    >
      {label}
    </button>
  );

  return (
    <FlitModal title={`Editar — ${row.ciudad}`} onClose={onClose} icono="ajustes" wide>
      <p className="mb-3 text-center text-sm text-[var(--color-text-tertiary)]">
        {row.nombre} · Código {row.codigo}
      </p>
      <div className="kit-pestanas">
        {tabBtn('general', 'General')}
        {tabBtn('autogestion', 'Autogestión')}
        {tabBtn('plantilla', 'Plantilla documentos')}
      </div>

      {tab === 'autogestion' && (
        <PanelGestionOrganismo organismo={organismoParaPanel(row)} editable={editable} onCambio={onReload} />
      )}

      {tab === 'general' && (
        <form onSubmit={submitGeneral} className="space-y-4">
          <label className={ETIQUETA}>
            Alias (nombre corto en bandeja)
            <input className={`${inputCls} mt-1`} maxLength={120} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={row.ciudad} />
          </label>
          <div className={BLOQUE}>
            <p className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Logo subido</p>
            <div className="flex items-center gap-3">
              <LogoThumb
                logoUrl={cfg.logoStorageKey ? cfg.logoUrl : null}
                fallback={cfg.ciudad}
                className={`h-14 w-14 ${LOGO_CLS}`}
              />
              <div className="flex flex-col gap-1.5">
                <label className={`btn secondary sm w-fit cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-[var(--kit-azul)]${uploading ? ' opacity-60' : ''}`}>
                  <Icono nombre="nube-subir" size={16} />
                  {uploading ? 'Procesando…' : cfg.logoStorageKey ? 'Reemplazar logo' : 'Subir logo'}
                  <input type="file" accept={LOGO_ACCEPT} className="sr-only" onChange={onPickLogo} disabled={uploading} />
                </label>
                {cfg.logoStorageKey && (
                  <button
                    type="button"
                    onClick={removeLogo}
                    disabled={uploading}
                    className="w-fit text-xs font-semibold text-[var(--kit-naranja-texto)] underline-offset-2 transition-colors hover:underline disabled:opacity-60"
                  >
                    Quitar logo subido
                  </button>
                )}
              </div>
            </div>
            <p className="nota mt-2 text-[var(--color-text-tertiary)]">
              PNG, JPEG, WEBP o SVG · máx. 512 KB. El logo subido tiene prioridad sobre la URL externa.
            </p>
          </div>

          <label className={ETIQUETA}>
            URL del logo externo (https o /ruta) — opcional
            <input className={`${inputCls} mt-1`} maxLength={500} value={logoUrlExterno} onChange={(e) => setLogoUrlExterno(e.target.value)} placeholder="https://…" />
          </label>
          {logoUrlExterno.trim() && !cfg.logoStorageKey && (
            <div className={`flex items-center gap-3 ${BLOQUE}`}>
              <img src={logoUrlExterno.trim()} alt="" className="h-12 w-12 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              <span className="nota text-[var(--color-text-tertiary)]">Vista previa (URL externa)</span>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
            <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} className="h-4 w-4 accent-[var(--kit-azul)]" />
            Organismo activo en FLIT
          </label>
          <p className="nota text-[var(--color-text-tertiary)]">
            Usuarios tránsito asignados: {row.userCount}. Asignar más en Usuarios → Rol Tránsito.
          </p>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <GradientButton type="button" variant="alerta" onClick={onClose}>
              Cancelar
            </GradientButton>
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
      <label className={ETIQUETA}>
        Tipología
        <select className={`${inputCls} mt-1`} value={tipologia} onChange={(e) => setTipologia(e.target.value)}>
          {TRAMITE_TIPOLOGIAS.map((t) => (
            <option key={t.codigo} value={t.codigo}>{t.nombre}</option>
          ))}
        </select>
      </label>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]" role="status"><Girador />Cargando plantilla…</p>
      ) : (
        <>
          <p className="nota text-[var(--color-text-tertiary)]">
            Ajusta el checklist nacional para este STT. Los cambios aplican al wizard y al gate de envío a tránsito.
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-[9px] border border-[var(--color-border)] p-2">
            {base.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-[9px] px-2 py-1.5 text-sm transition-colors hover:bg-[var(--kit-hover)]">
                <span className="min-w-0 flex-1 font-medium text-[var(--color-text-primary)]">{item.label}</span>
                <label className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
                  <input type="checkbox" checked={hidden.has(item.id)} onChange={() => toggleHide(item.id)} className="h-4 w-4 accent-[var(--kit-azul)]" />
                  Ocultar
                </label>
                {!item.obligatorio && (
                  <label className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
                    <input type="checkbox" checked={required.has(item.id)} onChange={() => toggleRequire(item.id)} className="h-4 w-4 accent-[var(--kit-azul)]" />
                    Obligatorio
                  </label>
                )}
              </li>
            ))}
          </ul>

          {(override.add ?? []).length > 0 && (
            <div>
              <p className="mb-1 text-sm font-semibold text-[var(--color-text-secondary)]">Anexos adicionales STT</p>
              <ul className="space-y-1">
                {(override.add ?? []).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 rounded-[9px] border border-[var(--color-border)] px-2 py-1.5 text-sm">
                    <span className="text-[var(--color-text-primary)]">{item.label} <span className="text-[var(--color-text-tertiary)]">({item.id})</span></span>
                    <button type="button" onClick={() => removeAdd(item.id)} className="text-xs font-semibold text-[var(--kit-naranja-texto)] underline-offset-2 transition-colors hover:underline">Quitar</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={BLOQUE}>
            <p className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Agregar anexo STT</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={inputCls} placeholder="id_estable" value={addId} onChange={(e) => setAddId(e.target.value)} maxLength={80} />
              <input className={inputCls} placeholder="Etiqueta visible" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} maxLength={200} />
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
              <input type="checkbox" checked={addObligatorio} onChange={(e) => setAddObligatorio(e.target.checked)} className="h-4 w-4 accent-[var(--kit-azul)]" />
              Obligatorio para enviar a tránsito
            </label>
            <GradientButton type="button" size="sm" variant="secondary" onClick={addItem} className="mt-2">Agregar a la lista</GradientButton>
          </div>
        </>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <GradientButton type="button" variant="secondary" onClick={onClose}>
          Cerrar
        </GradientButton>
        <GradientButton type="button" onClick={save} disabled={submitting || loading}>
          {submitting ? 'Guardando…' : 'Guardar plantilla'}
        </GradientButton>
      </div>
    </div>
  );
}
