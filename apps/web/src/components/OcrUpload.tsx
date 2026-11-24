import { useState, useRef } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { FlitCard } from './flit/flitPageKit';
import GradientButton from './flit/GradientButton';
import { Girador } from './flit/Cargador';
import { Icono } from './flit/kit/Icono';
import { etiquetaKit, ETIQUETA_PUNTO_CLS } from './flit/kit/tonos';

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
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Cargar declaraciones de impuesto</h3>
            <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">Sube el PDF de impuesto vehicular. El sistema extrae los datos automáticamente.</p>
          </div>
        </div>
        <label
          className={`carga kit-carga mt-4 flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-[9px] p-4 text-center transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--kit-azul)] ${vehicles.length > 0 ? 'carga--lista' : ''} ${loading ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
        >
          <Icono nombre="archivo-subir" size={28} />
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            {loading ? 'Procesando...' : 'Subir PDF'}
          </span>
          <input ref={fileRef} type="file" accept=".pdf" className="hidden" onChange={handleUpload} disabled={loading} />
        </label>

        {loading && (
          <div className="mt-4 flex items-center gap-2 text-sm text-[color:var(--color-text-tertiary)]">
            <Girador />
            Extrayendo datos del PDF...
          </div>
        )}
      </FlitCard>

      {vehicles.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-4">
            <Stat label="Vehículos encontrados" value={vehicles.length} tone="accent" />
            <Stat label="Total avalúo comercial" value={fmt(totalAvaluo)} />
            <Stat label="Total impuesto" value={fmt(totalImpuesto)} tone="warning" />
            <Stat label="Total a pagar" value={fmt(totalPagar)} tone="danger" />
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[color:var(--color-action)]">{vehicles.length} vehículos listos</p>
              <p className="mt-0.5 text-xs text-[color:var(--color-text-secondary)]">Impórtalos al pipeline o descarga el Excel</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <GradientButton type="button" variant="secondary" onClick={handleClear}>Limpiar</GradientButton>
              <GradientButton type="button" variant="secondary" onClick={handleExport}>
                <Icono nombre="nube-bajar" size={16} />
                Descargar Excel
              </GradientButton>
              <GradientButton type="button" variant="success" onClick={handleImportToVehicles} disabled={importing}>
                <Icono nombre="escudo" size={16} />
                {importing ? 'Importando...' : `Importar ${vehicles.length} a vehículos`}
              </GradientButton>
            </div>
          </div>

          {(() => {
            const pagesWithWarnings = vehicles.filter((v) => v._warnings && v._warnings.length > 0);
            if (pagesWithWarnings.length === 0) return null;
            const uniqueWarnings = Array.from(new Set(pagesWithWarnings.flatMap((v) => v._warnings ?? [])));
            return (
              <div className="kit-alerta mb-4" data-tono="warn" data-kit="alerta" role="status" aria-live="polite">
                <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="m-0 font-semibold">
                    {pagesWithWarnings.length} {pagesWithWarnings.length === 1 ? 'página requiere' : 'páginas requieren'} revisión manual
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-[color:var(--color-text-secondary)]">
                    {uniqueWarnings.map((w, i) => (<li key={i}>· {w}</li>))}
                  </ul>
                </div>
              </div>
            );
          })()}

          {/* FLOTA-03 (post INC-OCR): banner honesto cuando la 2ª verificación IA falló. */}
          {meta && meta.sonnetErrors > 0 && (
            <div className="kit-alerta mb-4" data-tono="warn" data-kit="alerta" role="status" aria-live="polite">
              <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="m-0 font-semibold">
                  Segunda verificación IA no disponible en {meta.sonnetErrors} {meta.sonnetErrors === 1 ? 'página' : 'páginas'}
                </p>
                <p className="mt-0.5 text-xs text-[color:var(--color-text-secondary)]">
                  Revisa manualmente el año-modelo y los totales de esas filas. Se usó solo la primera lectura (Haiku).
                  {Object.keys(meta.sonnetErrorTypes).length > 0 && ` Motivo: ${Object.keys(meta.sonnetErrorTypes).join(', ')}.`}
                </p>
              </div>
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
                    <tr key={i} className="border-t border-[color:var(--color-divider)] transition-colors hover:bg-[var(--kit-hover)]">
                      <td className="px-3 py-2 font-semibold text-[color:var(--color-text-primary)]">{v.placa}</td>
                      <td className="max-w-[150px] truncate px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.propietarioNombre}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.tipoDocumento} {v.propietarioDocumento}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.marca}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.linea}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.modelo}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.clase}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">{v.celular || '-'}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-[color:var(--color-text-primary)]">{fmt(v.avaluoComercial)}</td>
                      <td className="px-3 py-2 text-right text-xs font-medium tabular-nums text-[color:var(--kit-naranja-texto)]">{fmt(v.impuesto)}</td>
                      <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-[color:var(--kit-rojo-texto)]">{fmt(v.totalPagar)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1">
                          <span {...etiquetaKit(v._model?.includes('sonnet') ? 'info' : 'neutro')}>
                            <span className={ETIQUETA_PUNTO_CLS} aria-hidden />
                            {v._model?.includes('sonnet') ? 'Haiku+Sonnet' : 'Haiku'}
                          </span>
                          {v._math_check === 'mismatch' && (
                            <span {...etiquetaKit('danger')}>
                              <span className={ETIQUETA_PUNTO_CLS} aria-hidden />
                              Revisar totales
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-[color:var(--color-border)] bg-[var(--color-surface)]">
                  <tr>
                    <td colSpan={8} className="px-3 py-3 text-right text-xs font-semibold text-[color:var(--color-text-secondary)]">Totales</td>
                    <td className="px-3 py-3 text-right text-xs font-semibold tabular-nums text-[color:var(--color-text-primary)]">{fmt(totalAvaluo)}</td>
                    <td className="px-3 py-3 text-right text-xs font-semibold tabular-nums text-[color:var(--kit-naranja-texto)]">{fmt(totalImpuesto)}</td>
                    <td className="px-3 py-3 text-right text-xs font-semibold tabular-nums text-[color:var(--kit-rojo-texto)]">{fmt(totalPagar)}</td>
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

const TH_CLS = 'bg-[var(--color-surface)] px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]';

function Th({ children }: { children: React.ReactNode }) {
  return <th className={`${TH_CLS} text-left`}>{children}</th>;
}
function ThRight({ children }: { children: React.ReactNode }) {
  return <th className={`${TH_CLS} text-right`}>{children}</th>;
}

const COLOR_STAT = {
  default: 'text-[color:var(--color-text-primary)]',
  accent: 'text-[color:var(--color-action)]',
  warning: 'text-[color:var(--kit-naranja-texto)]',
  danger: 'text-[color:var(--kit-rojo-texto)]',
} as const;

function Stat({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: keyof typeof COLOR_STAT }) {
  return (
    <div className="rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4">
      <p className={`${tone === 'accent' ? 'text-2xl' : 'text-lg'} font-semibold tabular-nums ${COLOR_STAT[tone]}`}>{value}</p>
      <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">{label}</p>
    </div>
  );
}
