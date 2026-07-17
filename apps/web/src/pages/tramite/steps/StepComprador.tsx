// TRAM-ARCH-01c · Paso 3 — Datos del comprador (consulta RUNT + cédula + contacto).
//
// Presentacional: el shell posee el estado y pasa callbacks. Misma UX/markup
// que el bloque inline previo.

import type { Dispatch, SetStateAction } from 'react';
import type { CompradorData, VendedorData, RuntPersonaResponse } from '../wizard/types';
import TipologiaContextBanner from '../TipologiaContextBanner';

export interface StepCompradorProps {
  comprador: CompradorData;
  setComprador: Dispatch<SetStateAction<CompradorData>>;
  onConsultarComprador: () => void;
  compradorLoading: boolean;
  onLeerCedula: () => void;
  cedulaOverlayOpen: boolean;
  compradorRunt: RuntPersonaResponse | null;
  showCiudades: boolean;
  setShowCiudades: (v: boolean) => void;
  setCiudadFilter: (v: string) => void;
  filteredCiudades: string[];
  onAtras: () => void;
  onGuardar: () => void;
  // TRAM-TIPO-01: journey diferenciado por tipología.
  /** Etiqueta del adquirente según la tipología (Comprador / Heredero / Adjudicatario / Representante legal). */
  adquirenteLabel: string;
  tipologiaCodigo: string | null;
  /** Si la tipología exige al vendedor (parte saliente) — hoy solo `traspaso_standard`. */
  vendedorRequerido: boolean;
  vendedor: VendedorData;
  setVendedor: Dispatch<SetStateAction<VendedorData>>;
  onConsultarVendedor: () => void;
  vendedorLoading: boolean;
  vendedorRunt: RuntPersonaResponse | null;
}

export default function StepComprador({
  comprador, setComprador, onConsultarComprador, compradorLoading, onLeerCedula, cedulaOverlayOpen,
  compradorRunt, showCiudades, setShowCiudades, setCiudadFilter, filteredCiudades, onAtras, onGuardar,
  adquirenteLabel, tipologiaCodigo, vendedorRequerido, vendedor, setVendedor, onConsultarVendedor, vendedorLoading, vendedorRunt,
}: StepCompradorProps) {
  const adqLower = adquirenteLabel.toLowerCase();
  return (
    <div className="bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-6">
      <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--flit-blue-text)' }}>Datos · {adquirenteLabel}</h3>
      <p className="text-sm mb-5" style={{ color: 'var(--flit-text-muted)' }}>Ingresa el numero de documento o lee la cédula para traer los datos automáticamente</p>

      <TipologiaContextBanner codigo={tipologiaCodigo} paso={3} className="mb-5" />

      {/* Barra de busqueda */}
      <div className="rounded-[12px] overflow-hidden mb-5" style={{ border: '1px solid var(--flit-border-soft)' }}>
        <div className="px-4 py-3 flex items-center gap-3" style={{ background: 'var(--flit-bg-app)', borderBottom: '1px solid var(--flit-border-soft)' }}>
          <svg className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" /></svg>
          <span className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Identificación · {adquirenteLabel}</span>
        </div>
        <div className="p-4">
          <div className="flex gap-2 mb-3">
            <input value={comprador.documento} onChange={(e) => setComprador({ ...comprador, documento: e.target.value })}
              placeholder={`Número de documento del ${adqLower}...`}
              className="flit-focus flex-1 px-4 py-3 rounded-[10px] text-sm border bg-white outline-none transition-shadow font-mono text-lg"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') onConsultarComprador(); }} />
            <button onClick={onConsultarComprador} disabled={compradorLoading}
              className="flit-focus px-6 py-3 rounded-[999px] text-sm font-bold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-50 flex-shrink-0"
              style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}
            >
              {compradorLoading ? 'Buscando...' : 'Consultar RUNT'}
            </button>
          </div>
          {/* Leer cedula */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px" style={{ background: 'var(--flit-border-soft)' }} />
            <span className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>o</span>
            <div className="flex-1 h-px" style={{ background: 'var(--flit-border-soft)' }} />
          </div>
          <button onClick={onLeerCedula} disabled={cedulaOverlayOpen}
            className="flit-focus mt-3 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-[12px] border-2 border-dashed transition-all cursor-pointer disabled:opacity-50"
            style={{ borderColor: 'var(--flit-border-input)' }}>
            <svg className="w-5 h-5" style={{ color: 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" /></svg>
            <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue)' }}>Capturar documento</span>
          </button>
        </div>

        {/* Resultado RUNT */}
        {compradorRunt?.persona && (() => {
          const multas = compradorRunt.multas;
          const tieneMultas = multas && (
            (Array.isArray(multas) && multas.length > 0) ||
            (typeof multas === 'object' && !Array.isArray(multas) && multas.tieneMultas === 'SI')
          );
          return (
            <div className="px-4 pb-4 space-y-3">
              <div className="p-3 rounded-[12px]" style={{ background: 'rgba(112,207,58,0.10)', border: '1px solid rgba(112,207,58,0.30)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <svg className="w-4 h-4" style={{ color: 'var(--flit-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                  <span className="text-xs font-bold" style={{ color: 'var(--flit-success)' }}>Persona encontrada en RUNT</span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
                  <div><span style={{ color: 'var(--flit-text-muted)' }}>Nombres: </span><span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{compradorRunt.persona.nombres}</span></div>
                  <div><span style={{ color: 'var(--flit-text-muted)' }}>Apellidos: </span><span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{compradorRunt.persona.apellidos}</span></div>
                  <div><span style={{ color: 'var(--flit-text-muted)' }}>Documento: </span><span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{compradorRunt.persona.documento}</span></div>
                  <div><span style={{ color: 'var(--flit-text-muted)' }}>Estado: </span><span className="font-bold" style={{ color: compradorRunt.persona.estadoPersona === 'ACTIVA' ? 'var(--flit-success)' : 'var(--flit-warning)' }}>{compradorRunt.persona.estadoPersona || '—'}</span></div>
                  {compradorRunt.persona.tieneLicencias && <div><span style={{ color: 'var(--flit-text-muted)' }}>Licencias: </span><span className="font-semibold" style={{ color: 'var(--flit-success)' }}>Si</span></div>}
                  {compradorRunt.persona.estadoConductor && <div><span style={{ color: 'var(--flit-text-muted)' }}>Conductor: </span><span className="font-semibold">{compradorRunt.persona.estadoConductor}</span></div>}
                </div>
              </div>

              {/* Multas SIMIT */}
              {tieneMultas && (
                <div className="p-4 rounded-[12px]" style={{ background: 'rgba(228,61,48,0.10)', border: '2px solid rgba(228,61,48,0.30)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-5 h-5" style={{ color: 'var(--flit-danger)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                    <span className="text-sm font-bold" style={{ color: 'var(--flit-danger)' }}>ALERTA: Comparendos/Multas pendientes</span>
                  </div>
                  <p className="text-xs mb-3" style={{ color: 'var(--flit-danger)' }}>El comprador tiene multas de transito registradas. No podra completar el tramite hasta que valide el pago de los comparendos.</p>
                  {Array.isArray(multas) && multas.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1 border-t" style={{ color: 'var(--flit-danger)', borderColor: 'rgba(228,61,48,0.30)' }}>
                      <span className="font-mono font-bold">{m.numero || m.comparendo || `#${i + 1}`}</span>
                      <span className="flex-1">{m.infraccion || m.descripcion || m.estado || 'Multa registrada'}</span>
                      {m.valor && <span className="font-bold">${Number(m.valor).toLocaleString('es-CO')}</span>}
                    </div>
                  ))}
                  {!Array.isArray(multas) && typeof multas === 'object' && (
                    <div className="text-xs" style={{ color: 'var(--flit-danger)' }}>
                      {multas.totalMultas && <div className="font-bold">Total multas: {multas.totalMultas}</div>}
                      {multas.valorTotal && <div className="font-bold">Valor total: ${Number(multas.valorTotal).toLocaleString('es-CO')}</div>}
                    </div>
                  )}
                </div>
              )}

              {!tieneMultas && (
                <div className="p-3 rounded-[12px] flex items-center gap-3" style={{ background: 'rgba(112,207,58,0.10)', border: '1px solid rgba(112,207,58,0.30)' }}>
                  <svg className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--flit-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <div>
                    <span className="text-xs font-bold" style={{ color: 'var(--flit-success)' }}>Sin multas ni comparendos pendientes</span>
                    {multas && !Array.isArray(multas) && multas.nroPazYSalvo && <p className="text-[10px] mt-0.5" style={{ color: 'var(--flit-success)' }}>Paz y Salvo No. {multas.nroPazYSalvo}</p>}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Formulario datos adicionales */}
      <div className="rounded-[12px] overflow-hidden mb-5" style={{ border: '1px solid var(--flit-border-soft)' }}>
        <div className="px-4 py-3" style={{ background: 'var(--flit-bg-app)', borderBottom: '1px solid var(--flit-border-soft)' }}>
          <span className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Datos de contacto</span>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Nombre completo *</label>
            <input value={comprador.nombre} onChange={(e) => setComprador({ ...comprador, nombre: e.target.value })}
              className="flit-focus w-full px-4 py-3 rounded-[10px] text-sm border bg-white outline-none transition-shadow" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Documento</label>
            <input value={comprador.documento} readOnly className="w-full px-4 py-3 rounded-[10px] text-sm border font-mono" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Email *</label>
            <input type="email" value={comprador.email} onChange={(e) => setComprador({ ...comprador, email: e.target.value })}
              placeholder="correo@ejemplo.com"
              className="flit-focus w-full px-4 py-3 rounded-[10px] text-sm border bg-white outline-none transition-shadow" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Teléfono</label>
            <input value={comprador.telefono} onChange={(e) => setComprador({ ...comprador, telefono: e.target.value })}
              placeholder="3001234567"
              className="flit-focus w-full px-4 py-3 rounded-[10px] text-sm border bg-white outline-none transition-shadow" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
          </div>
          <div className="relative">
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Ciudad</label>
            <input value={comprador.ciudad}
              onChange={(e) => { setComprador({ ...comprador, ciudad: e.target.value }); setCiudadFilter(e.target.value); setShowCiudades(true); }}
              onFocus={() => { if (comprador.ciudad.length >= 2) setShowCiudades(true); }}
              onBlur={() => setTimeout(() => setShowCiudades(false), 200)}
              placeholder="Escribe para buscar..."
              className="flit-focus w-full px-4 py-3 rounded-[10px] text-sm border bg-white outline-none transition-shadow" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
            {showCiudades && filteredCiudades.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-[12px] z-50 max-h-48 overflow-auto" style={{ border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
                {filteredCiudades.map((c) => (
                  <button key={c} type="button"
                    onMouseDown={(e) => { e.preventDefault(); setComprador({ ...comprador, ciudad: c }); setShowCiudades(false); }}
                    className="w-full text-left px-4 py-2.5 text-sm transition-colors border-b last:border-0 hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-primary)' }}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="md:col-span-2 lg:col-span-3">
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Dirección</label>
            <input value={comprador.direccion} onChange={(e) => setComprador({ ...comprador, direccion: e.target.value })}
              className="flit-focus w-full px-4 py-3 rounded-[10px] text-sm border bg-white outline-none transition-shadow" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
          </div>
        </div>
      </div>

      {/* TRAM-TIPO-01: parte vendedora (titular saliente) — solo en compraventa directa. */}
      {vendedorRequerido && (
        <div className="rounded-[12px] overflow-hidden mb-5" style={{ border: '1px solid var(--flit-border-soft)' }}>
          <div className="px-4 py-3 flex items-center gap-3" style={{ background: 'var(--flit-bg-app)', borderBottom: '1px solid var(--flit-border-soft)' }}>
            <svg className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--flit-warning)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <span className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Vendedor · titular saliente (obligatorio)</span>
          </div>
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Tipo doc</label>
              <select value={vendedor.tipoDoc} onChange={(e) => setVendedor({ ...vendedor, tipoDoc: e.target.value })}
                className="flit-focus w-full px-3 py-3 rounded-[10px] text-sm border bg-white outline-none" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
                <option value="CC">CC</option>
                <option value="CE">CE</option>
                <option value="NIT">NIT</option>
                <option value="PAS">PAS</option>
              </select>
            </div>
            <div className="md:col-span-1 lg:col-span-2">
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Documento del vendedor *</label>
              <div className="flex gap-2">
                <input value={vendedor.documento} onChange={(e) => setVendedor({ ...vendedor, documento: e.target.value })}
                  placeholder="Número de documento del vendedor..."
                  className="flit-focus flex-1 px-4 py-3 rounded-[10px] text-sm border bg-white outline-none font-mono" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
                  onKeyDown={(e) => { if (e.key === 'Enter') onConsultarVendedor(); }} />
                <button onClick={onConsultarVendedor} disabled={vendedorLoading}
                  className="flit-focus px-4 py-3 rounded-[999px] text-sm font-bold text-white disabled:opacity-50 flex-shrink-0"
                  style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
                  {vendedorLoading ? 'Buscando...' : 'RUNT'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--flit-text-muted)' }}>Nombre del vendedor *</label>
              <input value={vendedor.nombre} onChange={(e) => setVendedor({ ...vendedor, nombre: e.target.value })}
                placeholder="Nombre completo"
                className="flit-focus w-full px-4 py-3 rounded-[10px] text-sm border bg-white outline-none" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
            </div>
          </div>
          {vendedorRunt?.persona && (
            <div className="px-4 pb-4">
              <div className="p-3 rounded-[12px] flex items-center gap-2" style={{ background: 'rgba(112,207,58,0.10)', border: '1px solid rgba(112,207,58,0.30)' }}>
                <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--flit-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                <span className="text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>
                  Vendedor en RUNT: {[vendedorRunt.persona.nombres, vendedorRunt.persona.apellidos].filter(Boolean).join(' ')} — {vendedorRunt.persona.estadoPersona || '—'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between">
        <button onClick={onAtras} className="flit-focus px-5 py-2.5 rounded-[999px] text-sm font-medium border bg-white" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Atras</button>
        <button onClick={onGuardar} className="flit-focus px-6 py-2.5 rounded-[999px] text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99]"
          style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}
        >
          Guardar y continuar
        </button>
      </div>
    </div>
  );
}
