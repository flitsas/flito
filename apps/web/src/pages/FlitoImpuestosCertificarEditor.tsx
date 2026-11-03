// Editor de «Certificar sin trámite»: la factura a la izquierda (ficha, estado de la lectura y vista
// previa) y los datos a la derecha, en un solo formulario con tres bloques. Presentación pura: la
// lectura, el guardado y las consultas viven en FlitoImpuestosCertificar.
import { ScanText, TriangleAlert, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import AvisoProcesando from '../components/flit/AvisoProcesando';
import FlitUploadBox from '../components/flit/FlitUploadBox';
import StatusChip from '../components/flit/StatusChip';
import VisorPdf from '../components/flit/VisorPdf';
import { FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary } from '../components/flit/flitPageKit';

export interface Borrador {
  organismoCodigo: string; placa: string; documentoPropietario: string;
  nombrePropietario: string; vin: string; marca: string; linea: string; anio: string;
  color: string; cilindrada: string;
}
export interface Catalogo {
  organismos: { codigo: string; nombre: string }[];
}
export type CampoLeido = 'vin' | 'marca' | 'linea' | 'anio' | 'color' | 'cilindrada';
const CAMPOS_LEIDOS: CampoLeido[] = ['vin', 'marca', 'linea', 'anio', 'color', 'cilindrada'];

const CONTROL = 'flit-focus h-10 w-full rounded-lg border bg-flit-card px-3 text-sm';
const OBLIGATORIOS: (keyof Borrador)[] = [
  'organismoCodigo', 'placa', 'documentoPropietario', 'nombrePropietario',
  'vin', 'marca', 'linea', 'anio', 'color', 'cilindrada',
];

/** true desde `lg` (1024 px). La vista previa no se monta por debajo: no descarga ni rasteriza el PDF. */
function useEscritorio(): boolean {
  const q = '(min-width: 1024px)';
  const [v, setV] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setV(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return v;
}

/** Los primeros bytes de un PDF son «%PDF-»: lo demás no se manda al visor (que mostraría un error en inglés). */
async function esPdf(b: Blob): Promise<boolean> {
  try { return (await b.slice(0, 5).text()) === '%PDF-'; } catch { return false; }
}

const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();

export function faltantes(b: Borrador): number {
  return OBLIGATORIOS.filter((k) => !b[k].trim()).length;
}

interface Props {
  vista: 'alta' | 'detalle';
  borrador: Borrador;
  onBorrador: (b: Borrador) => void;
  catalogo: Catalogo | null;
  pdf: File | null;
  onPdf: (f: File) => void;
  leyendo: boolean;
  /** Valores que trajo la lectura; el chip «Leído» se apaga si el gestor cambia el campo. */
  leidos: Partial<Record<CampoLeido, string>>;
  /** Cuántos de los 6 datos vinieron, o null si aún no se leyó. */
  leidosN: number | null;
  fallaLectura: string | null;
  onReintentar: () => void;
  certificado: boolean;
  ocupado: boolean;
  dirty: boolean;
  onSubmit: () => void;
  onConsultar?: () => void;
  /** Registro guardado: baja la factura del servidor para la vista previa (solo se llama en escritorio). */
  cargarFactura?: () => Promise<Blob>;
  /** Cambia cuando la factura guardada cambia (otro registro o tras reemplazarla): fuerza la recarga. */
  claveFactura?: string;
  /** Estado, descargas y comparación con el RUNT (solo en el registro guardado). */
  debajo?: ReactNode;
}

export default function CertificarEditor(p: Props) {
  const { vista, borrador: b, certificado, leyendo } = p;
  const alta = vista === 'alta';
  const faltan = faltantes(b);
  const escritorio = useEscritorio();
  const [ampliarSolicitada, setAmpliar] = useState(false);
  // Solo existe en escritorio y con vista previa: en móvil el estado se ignora.
  const ampliada = ampliarSolicitada && escritorio;
  const colsForm = ampliada ? 'lg:grid-cols-1 xl:grid-cols-2' : '';
  const [url, setUrl] = useState<string | null>(null);
  const [pdfInvalido, setPdfInvalido] = useState(false);
  useEffect(() => {
    setUrl(null); setPdfInvalido(false);
    if (!p.pdf) return undefined;
    let vivo = true;
    let u: string | null = null;
    void esPdf(p.pdf).then((ok) => {
      if (!vivo) return;
      if (!ok) { setPdfInvalido(true); return; }
      u = URL.createObjectURL(p.pdf as File);
      setUrl(u);
    });
    return () => { vivo = false; if (u) URL.revokeObjectURL(u); };
  }, [p.pdf]);

  // Factura ya guardada: se pide al servidor solo en escritorio y mientras no haya un File nuevo.
  const [remota, setRemota] = useState<{ url: string | null; cargando: boolean; error: boolean; invalido: boolean }>({ url: null, cargando: false, error: false, invalido: false });
  const [reintento, setReintento] = useState(0);
  const { cargarFactura, claveFactura } = p;
  const quiereRemota = !alta && escritorio && !p.pdf && !!cargarFactura;
  useEffect(() => {
    if (!quiereRemota || !cargarFactura) { setRemota({ url: null, cargando: false, error: false, invalido: false }); return undefined; }
    let vivo = true;
    let u: string | null = null;
    setRemota({ url: null, cargando: true, error: false, invalido: false });
    cargarFactura().then(async (blob) => {
      const ok = await esPdf(blob);
      if (!vivo) return;
      if (!ok) { setRemota({ url: null, cargando: false, error: false, invalido: true }); return; }
      u = URL.createObjectURL(blob);
      setRemota({ url: u, cargando: false, error: false, invalido: false });
    }).catch(() => { if (vivo) setRemota({ url: null, cargando: false, error: true, invalido: false }); });
    return () => { vivo = false; if (u) URL.revokeObjectURL(u); };
    // cargarFactura cambia de identidad en cada render del padre: la clave es la que manda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiereRemota, claveFactura, reintento]);
  const urlVista = p.pdf ? url : remota.url;
  const sinVista = escritorio && (p.pdf ? pdfInvalido : remota.invalido);

  // Diferencias entre lo que dice la factura recién leída y lo que hay en el formulario (solo alta).
  const difiere = (k: CampoLeido) => alta && !!p.leidos[k] && norm(p.leidos[k] as string) !== norm(b[k]);
  const hayDiferencias = CAMPOS_LEIDOS.some(difiere);

  const set = (k: keyof Borrador) => (v: string) => p.onBorrador({ ...b, [k]: v });
  const leido = (k: CampoLeido) => !!b[k] && !!p.leidos[k] && norm(p.leidos[k] as string) === norm(b[k]);
  const ayuda = (k: CampoLeido) => (difiere(k) ? { valor: p.leidos[k] as string, onUsar: () => set(k)(p.leidos[k] as string) } : undefined);
  const hayCambios = alta || p.dirty;
  const guardarPrimaria = hayCambios;
  const consultarPrimaria = !alta && !p.dirty && !certificado;
  const bloqueado = leyendo || p.ocupado;

  const subir = (
    <FlitUploadBox
      label={alta ? 'Factura de venta (PDF)' : 'Reemplazar factura (PDF, opcional)'}
      required={alta}
      hint={p.pdf ? p.pdf.name : 'Elige el PDF de la factura'}
      accept="application/pdf,.pdf"
      alcanzable
      state={leyendo ? 'uploading' : p.pdf ? 'verified' : 'idle'}
      count={p.pdf ? 1 : 0}
      onFile={p.onPdf}
    />
  );

  if (alta && !p.pdf) {
    return (
      <FlitCard>
        <div className="flex flex-col gap-4">
          <div className="max-w-xl">{subir}</div>
          <div className="flex justify-end">
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled>Guardar</button>
          </div>
        </div>
      </FlitCard>
    );
  }

  const chipLectura = leyendo ? <AvisoProcesando texto="Leyendo la factura…" />
    : p.leidosN === null ? null
    : p.leidosN === 6 ? <StatusChip tone="success">Leída</StatusChip>
    : <StatusChip tone="warning">{`Leída a medias · ${p.leidosN} de 6 datos`}</StatusChip>;

  return (
    <div className={`grid grid-cols-1 gap-4 lg:items-start ${ampliada ? 'lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]' : 'lg:grid-cols-[320px_minmax(0,1fr)]'}`}>
      <aside className="lg:sticky lg:top-4" aria-label="Factura de venta">
        <FlitCard>
          <div className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Factura de venta</h4>
            {p.pdf && (
              <p className="text-xs break-all" style={{ color: 'var(--flit-text-secondary)' }}>
                PDF · {p.pdf.name} · {Math.max(1, Math.round(p.pdf.size / 1024))} KB
              </p>
            )}
            {chipLectura && <div>{chipLectura}</div>}
            {p.fallaLectura && (
              <p role="status" className="rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)', border: '1px solid var(--flit-border-soft)' }}>
                {p.fallaLectura}
              </p>
            )}
            {sinVista && (
              <p role="status" className="rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)', border: '1px solid var(--flit-border-soft)' }}>
                No pudimos mostrar la vista previa de esta factura.
              </p>
            )}
            {alta && hayDiferencias && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-xl border px-3 py-2 text-sm"
                style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)', borderColor: 'var(--flit-warning)' }}
              >
                <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0">Algunos datos del formulario no coinciden con esta factura.</span>
              </p>
            )}
            {urlVista && escritorio && !sinVista && (
              <div className={`relative overflow-hidden rounded-lg border border-flit-soft ${ampliada ? 'h-[max(24rem,calc(100vh-24rem))]' : 'h-80'}`}>
                <VisorPdf url={urlVista} nombre={p.pdf?.name ?? 'la factura'} />
                <button
                  type="button"
                  aria-label={ampliada ? 'Reducir factura' : 'Ampliar factura'}
                  title={ampliada ? 'Reducir factura' : 'Ampliar factura'}
                  aria-pressed={ampliada}
                  onClick={() => setAmpliar((v) => !v)}
                  className="flit-focus absolute bottom-3 right-6 inline-grid h-10 w-10 place-items-center rounded-full border border-flit-soft bg-flit-card/80 backdrop-blur-sm transition-colors hover:bg-flit-card"
                  style={{ color: 'var(--flit-text-primary)' }}
                >
                  {ampliada ? <ZoomOut size={18} aria-hidden="true" /> : <ZoomIn size={18} aria-hidden="true" />}
                </button>
              </div>
            )}
            {quiereRemota && remota.cargando && <AvisoProcesando texto="Cargando la factura…" />}
            {quiereRemota && remota.error && (
              <p role="status" className="rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)', border: '1px solid var(--flit-border-soft)' }}>
                No pudimos cargar la factura.{' '}
                <button type="button" className="flit-focus underline" onClick={() => setReintento((n) => n + 1)}>Reintentar</button>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {p.fallaLectura && alta && (
                <button type="button" className={flitBtnSecondary} disabled={bloqueado || !p.pdf} onClick={p.onReintentar}>Reintentar lectura</button>
              )}
            </div>
            {!certificado && <div>{subir}</div>}
          </div>
        </FlitCard>
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <FlitCard>
          <form
            className={`flex flex-col gap-6 ${leyendo ? 'pointer-events-none opacity-60' : ''}`}
            aria-busy={leyendo}
            onSubmit={(ev) => { ev.preventDefault(); p.onSubmit(); }}
          >
            <Bloque titulo="Organismo de tránsito" cols={colsForm}>
              <Sel id="cert-organismo" etiqueta="Organismo" valor={b.organismoCodigo} disabled={certificado} onChange={set('organismoCodigo')}
                opciones={(p.catalogo?.organismos ?? []).map((o) => ({ v: o.codigo, t: o.nombre }))} />
            </Bloque>
            <Bloque titulo="Propietario" cols={colsForm}>
              <Campo id="cert-documento" etiqueta="Documento del propietario" valor={b.documentoPropietario} disabled={certificado} onChange={set('documentoPropietario')} />
              <Campo id="cert-nombre" etiqueta="Nombre del propietario" valor={b.nombrePropietario} disabled={certificado} onChange={set('nombrePropietario')} />
            </Bloque>
            <Bloque titulo="Vehículo" nota="El RUNT se consulta por VIN." cols={ampliada ? colsForm : 'lg:grid-cols-3'}>
              <Campo id="cert-placa" etiqueta="Placa" valor={b.placa} disabled={certificado} onChange={set('placa')} />
              <Campo id="cert-vin" etiqueta="VIN" valor={b.vin} disabled={certificado} onChange={set('vin')} leido={leido('vin')} ayuda={ayuda('vin')} />
              <Campo id="cert-marca" etiqueta="Marca" valor={b.marca} disabled={certificado} onChange={set('marca')} leido={leido('marca')} ayuda={ayuda('marca')} />
              <Campo id="cert-linea" etiqueta="Línea" valor={b.linea} disabled={certificado} onChange={set('linea')} leido={leido('linea')} ayuda={ayuda('linea')} />
              <Campo id="cert-anio" etiqueta="Año" valor={b.anio} disabled={certificado} onChange={set('anio')} leido={leido('anio')} ayuda={ayuda('anio')} />
              <Campo id="cert-color" etiqueta="Color" valor={b.color} disabled={certificado} onChange={set('color')} leido={leido('color')} ayuda={ayuda('color')} />
              <Campo id="cert-cilindraje" etiqueta="Cilindraje" valor={b.cilindrada} disabled={certificado} onChange={set('cilindrada')} leido={leido('cilindrada')} ayuda={ayuda('cilindrada')} />
            </Bloque>

            {!certificado && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-flit-soft pt-4">
                <p aria-live="polite" className="text-sm" style={{ color: faltan ? 'var(--flit-warning-ink)' : 'var(--flit-text-primary)' }}>
                  {faltan ? `Faltan ${faltan} ${faltan === 1 ? 'dato' : 'datos'} para guardar.` : 'Listo para guardar.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {!alta && p.onConsultar && (
                    <button type="button" className={consultarPrimaria ? flitBtnPrimary : flitBtnSecondary}
                      style={consultarPrimaria ? flitBtnPrimaryStyle : undefined} disabled={bloqueado || faltan > 0} onClick={p.onConsultar}>
                      Consultar RUNT
                    </button>
                  )}
                  <button type="submit" className={guardarPrimaria ? flitBtnPrimary : flitBtnSecondary}
                    style={guardarPrimaria ? flitBtnPrimaryStyle : undefined} disabled={bloqueado || faltan > 0 || !hayCambios}>
                    {alta ? 'Guardar' : 'Guardar cambios'}
                  </button>
                </div>
              </div>
            )}
          </form>
        </FlitCard>
        {p.debajo}
      </div>
    </div>
  );
}

function Bloque({ titulo, nota, cols = '', children }: { titulo: string; nota?: string; cols?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h4 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{titulo}</h4>
        {nota && <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{nota}</p>}
      </div>
      <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${cols}`}>{children}</div>
    </section>
  );
}

function Etiqueta({ id, texto, leido }: { id: string; texto: string; leido?: boolean }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <label htmlFor={id} className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{texto}</label>
      {leido && <StatusChip tone="success">Leído</StatusChip>}
    </div>
  );
}

const borde = (vacio: boolean) => ({ borderColor: vacio ? 'var(--flit-warning)' : 'var(--flit-border-soft)' });

function Campo({ id, etiqueta, valor, disabled, onChange, leido, ayuda }: {
  id: string; etiqueta: string; valor: string; disabled?: boolean; onChange: (v: string) => void; leido?: boolean;
  ayuda?: { valor: string; onUsar: () => void };
}) {
  const idAyuda = `${id}-ayuda`;
  return (
    <div>
      <Etiqueta id={id} texto={etiqueta} leido={leido} />
      <input id={id} className={CONTROL} required value={valor} disabled={disabled}
        aria-describedby={ayuda ? idAyuda : undefined}
        // Diferencia pendiente con la factura: borde PUNTEADO en advertencia (el «obligatorio vacío» es continuo).
        style={ayuda && !disabled ? { borderColor: 'var(--flit-warning)', borderStyle: 'dashed' } : borde(!valor.trim())}
        onChange={(ev) => onChange(ev.target.value)} />
      {ayuda && !disabled && (
        <div
          id={idAyuda}
          role="status"
          className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border px-3 py-2 text-sm"
          style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)', borderColor: 'var(--flit-warning)' }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ScanText size={16} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 break-all">La factura dice: <strong className="font-semibold">{ayuda.valor}</strong></span>
          </span>
          <button
            type="button"
            // La franja es de color FIJO (`--flit-chip-warning-bg` no cambia en oscuro), así que el botón usa solo
            // tokens que tampoco cambian: fondo de la franja, tinta y borde `--flit-warning-ink`. El hover NO
            // toca el fondo (nada translúcido): engrosa el borde con un anillo interior.
            className="flit-focus inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-sm font-medium transition-shadow hover:shadow-[inset_0_0_0_1px_var(--flit-warning-ink)] active:shadow-[inset_0_0_0_2px_var(--flit-warning-ink)]"
            style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)', borderColor: 'var(--flit-warning-ink)' }}
            onClick={ayuda.onUsar}
          >
            Usar este dato
          </button>
        </div>
      )}
    </div>
  );
}

function Sel({ id, etiqueta, valor, disabled, onChange, opciones }: { id: string; etiqueta: string; valor: string; disabled?: boolean; onChange: (v: string) => void; opciones: { v: string; t: string }[] }) {
  return (
    <div>
      <Etiqueta id={id} texto={etiqueta} />
      <select id={id} className={CONTROL} style={borde(!valor)} required disabled={disabled} value={valor} onChange={(ev) => onChange(ev.target.value)}>
        <option value="">Selecciona</option>
        {opciones.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
      </select>
    </div>
  );
}
