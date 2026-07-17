import { useState, useRef } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from './flit/flitPageKit';

interface OcrMeta {
  totalPages: number; extracted: number; sonnetAttempted: number;
  sonnetErrors: number; sonnetErrorTypes: Record<string, number>; haikuOnlyPages: number;
}

interface OcrVehicle {
  placa: string;
  marca: string;
  linea: string;
  modelo: string;
  clase: string;
  carroceria: string;
  cilindraje: string;
  propietarioNombre: string;
  propietarioDocumento: string;
  tipoDocumento: string;
  celular: string;
  email: string;
  direccion: string;
  municipioResidencia: string;
  departamentoResidencia: string;
  municipioMatricula: string;
  departamentoMatricula: string;
  avaluoComercial: number;
  impuesto: number;
  totalPagar: number;
  formularioNo: string;
  _confidence?: number;
  _math_check?: 'ok' | 'mismatch' | 'skipped';
  _warnings?: string[];
  _model?: string;
  _page_rotated?: boolean;
}

export default function OcrUpload() {
  const [vehicles, setVehicles] = useState<OcrVehicle[]>([]);
  const [meta, setMeta] = useState<OcrMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfName, setPdfName] = useState('');
  const [importing, setImporting] = useState(false);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setLoading(true);
    setVehicles([]);
    setMeta(null);
    setPdfName(file.name.replace(/\.pdf$/i, ''));
    try {
      const res = await api.upload<{ ok: boolean; vehicles?: OcrVehicle[]; message?: string; meta?: OcrMeta }>('/vehicles/ocr', file);
      if (res.ok && res.vehicles) {
        setVehicles(res.vehicles);
        setMeta(res.meta ?? null);
        toast.success(`${res.vehicles.length} vehículos extraídos del PDF`);
      } else {
        toast.error(res.message || 'No se pudieron extraer datos');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error procesando PDF';
      toast.error(msg);
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleExport = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/vehicles/ocr-export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ vehicles }),
      });
      if (!res.ok) throw new Error('Error generando Excel');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Impuestos_${pdfName || 'lectura'}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Excel descargado');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      toast.error(msg);
    }
  };

  const handleImportToVehicles = async () => {
    if (vehicles.length === 0) return;
    setImporting(true);
    try {
      const res = await api.post<{ ok: boolean; total: number; created: number; updated: number; skipped: number }>(
        '/vehicles/ocr-import',
        { vehicles: vehicles.map((v) => ({
          placa: v.placa,
          marca: v.marca,
          linea: v.linea,
          modelo: v.modelo,
          clase: v.clase,
          propietarioNombre: v.propietarioNombre,
          propietarioDocumento: v.propietarioDocumento,
          avaluoComercial: v.avaluoComercial,
          impuesto: v.impuesto,
          totalPagar: v.totalPagar,
          formularioNo: v.formularioNo,
        })) }
      );
      if (res.ok) {
        toast.success(`${res.created} creados, ${res.updated} actualizados${res.skipped ? `, ${res.skipped} omitidos` : ''}`);
        setVehicles([]);
        setPdfName('');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudieron importar los vehículos';
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  };

  const handleClear = () => {
    setVehicles([]);
    setMeta(null);
    setPdfName('');
  };

  const fmt = (n: number | string | null | undefined) => {
    const num = Number(n);
    return num ? `$${num.toLocaleString('es-CO')}` : '-';
  };

  const totalAvaluo = vehicles.reduce((s, v) => s + (Number(v.avaluoComercial) || 0), 0);
  const totalImpuesto = vehicles.reduce((s, v) => s + (Number(v.impuesto) || 0), 0);
  const totalPagar = vehicles.reduce((s, v) => s + (Number(v.totalPagar) || 0), 0);

  return (
    <div>
      <FlitCard className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Cargar declaraciones de impuesto</h3>
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sube el PDF de impuesto vehicular. El sistema extrae los datos automáticamente.</p>
          </div>
          <label className={loading ? 'pointer-events-none opacity-50' : 'cursor-pointer'}>
            <span className={`${flitBtnPrimary} inline-flex items-center gap-2`} style={flitBtnPrimaryStyle}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              {loading ? 'Procesando...' : 'Subir PDF'}
            </span>
            <input ref={fileRef} type="file" accept=".pdf" className="hidden" onChange={handleUpload} disabled={loading} />
          </label>
        </div>

        {loading && (
          <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
            <svg className="animate-spin motion-reduce:animate-none h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Extrayendo datos del PDF...
          </div>
        )}
      </FlitCard>

      {vehicles.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat label="Vehículos encontrados" value={vehicles.length} tone="accent" />
            <Stat label="Total avalúo comercial" value={fmt(totalAvaluo)} />
            <Stat label="Total impuesto" value={fmt(totalImpuesto)} tone="warning" />
            <Stat label="Total a pagar" value={fmt(totalPagar)} tone="danger" />
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] p-4" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue)' }}>{vehicles.length} vehículos listos</p>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Impórtalos al pipeline o descarga el Excel</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={handleClear} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Limpiar</button>
              <button type="button" onClick={handleExport} className={`${flitBtnSecondary} inline-flex items-center gap-2`} style={flitBtnSecondaryStyle}>
                <svg className="w-4 h-4 flit-tone-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Descargar Excel
              </button>
              <button type="button" onClick={handleImportToVehicles} disabled={importing}
                className={`${flitBtnPrimary} inline-flex items-center gap-2 disabled:opacity-50`} style={{ ...flitBtnPrimaryStyle, background: 'var(--flit-gradient-success)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
                {importing ? 'Importando...' : `Importar ${vehicles.length} a vehículos`}
              </button>
            </div>
          </div>

          {(() => {
            const pagesWithWarnings = vehicles.filter((v) => v._warnings && v._warnings.length > 0);
            if (pagesWithWarnings.length === 0) return null;
            const uniqueWarnings = Array.from(new Set(pagesWithWarnings.flatMap((v) => v._warnings ?? [])));
            return (
              <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 mb-4" role="status" aria-live="polite">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-[color:var(--flit-warning)] flex-none mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold flit-tone-primary">
                      {pagesWithWarnings.length} {pagesWithWarnings.length === 1 ? 'página requiere' : 'páginas requieren'} revisión manual
                    </p>
                    <ul className="mt-2 space-y-1 text-xs flit-tone-secondary">
                      {uniqueWarnings.map((w, i) => (<li key={i}>· {w}</li>))}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* FLOTA-03 (post INC-OCR): banner honesto cuando la 2ª verificación IA falló. */}
          {meta && meta.sonnetErrors > 0 && (
            <div className="rounded-xl border p-4 mb-4" style={{ borderColor: 'rgba(240,90,53,0.30)', background: 'rgba(240,90,53,0.08)' }} role="status" aria-live="polite">
              <p className="text-sm font-semibold" style={{ color: 'var(--flit-warning)' }}>
                Segunda verificación IA no disponible en {meta.sonnetErrors} {meta.sonnetErrors === 1 ? 'página' : 'páginas'}
              </p>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-warning)' }}>
                Revisa manualmente el año-modelo y los totales de esas filas. Se usó solo la primera lectura (Haiku).
                {Object.keys(meta.sonnetErrorTypes).length > 0 && ` Motivo: ${Object.keys(meta.sonnetErrorTypes).join(', ')}.`}
              </p>
            </div>
          )}

          <FlitCard className="overflow-hidden p-0">
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0">
                  <tr>
                    <Th>Placa</Th>
                    <Th>Propietario</Th>
                    <Th>Documento</Th>
                    <Th>Marca</Th>
                    <Th>Línea</Th>
                    <Th>Modelo</Th>
                    <Th>Clase</Th>
                    <Th>Celular</Th>
                    <ThRight>Avalúo</ThRight>
                    <ThRight>Impuesto</ThRight>
                    <ThRight>Total a pagar</ThRight>
                    <Th>Verificación</Th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map((v, i) => (
                    <tr key={i} className="border-t border-[color:var(--flit-border-soft)] hover:bg-[color:var(--flit-bg-app)]/50 transition-colors">
                      <td className="px-3 py-2 font-semibold flit-tone-primary">{v.placa}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary truncate max-w-[150px]">{v.propietarioNombre}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{v.tipoDocumento} {v.propietarioDocumento}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{v.marca}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{v.linea}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{v.modelo}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{v.clase}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{v.celular || '-'}</td>
                      <td className="px-3 py-2 text-xs text-right flit-tone-primary">{fmt(v.avaluoComercial)}</td>
                      <td className="px-3 py-2 text-xs text-right text-[color:var(--flit-warning)] font-medium">{fmt(v.impuesto)}</td>
                      <td className="px-3 py-2 text-xs text-right text-[color:var(--flit-danger)] font-semibold">{fmt(v.totalPagar)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase"
                            style={v._model?.includes('sonnet')
                              ? { background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }
                              : { background: 'rgba(125,135,152,0.12)', color: 'var(--flit-text-muted)' }}>
                            {v._model?.includes('sonnet') ? 'Haiku+Sonnet' : 'Haiku'}
                          </span>
                          {v._math_check === 'mismatch' && (
                            <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(228,61,48,0.15)', color: 'var(--flit-danger)' }}>Revisar totales</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-[color:var(--flit-bg-app)] border-t border-[color:var(--flit-border-soft)]">
                  <tr>
                    <td colSpan={8} className="px-3 py-3 text-xs font-semibold flit-tone-secondary text-right">Totales</td>
                    <td className="px-3 py-3 text-xs text-right font-semibold flit-tone-primary">{fmt(totalAvaluo)}</td>
                    <td className="px-3 py-3 text-xs text-right font-semibold text-[color:var(--flit-warning)]">{fmt(totalImpuesto)}</td>
                    <td className="px-3 py-3 text-xs text-right font-semibold text-[color:var(--flit-danger)]">{fmt(totalPagar)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </FlitCard>
        </>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
function ThRight({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'accent' | 'warning' | 'danger' }) {
  const color = tone === 'accent' ? 'var(--flit-blue)' : tone === 'warning' ? '#d97706' : tone === 'danger' ? '#dc2626' : 'var(--flit-text-primary)';
  return (
    <FlitCard>
      <p className={`${tone === 'accent' ? 'text-2xl' : 'text-lg'} font-semibold`} style={{ color }}>{value}</p>
      <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
    </FlitCard>
  );
}
