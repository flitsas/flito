// Expediente documental de la compañía en el detalle de su bolsa (HU #13892, Feature #13888).
// Título visible «Documentos» (literal del AC1; decidido por David el 2026-10-24).
// Spec: docs/ux/flito-bolsas-expediente-documental.md (Pantalla 1). Contrato: ADR-0028 §5.
//
// Lista de 5 filas dentro de una `FlitCard`, sin primaria propia (la del detalle manda). 4 estados de
// la sección: el resto del detalle no espera a esta ni se rompe si falla. Sin `bolsas.documentos.ver`
// (o con E1 en 403) la sección no existe. Con `activa=false` se consulta y descarga, pero los
// controles de carga y fecha no están en el DOM.
//
// «Validando…» (ADR §8): mientras algún documento esté validando se relee E1 cada 5 s en silencio,
// con tope de 2 min o 3 fallos seguidos; al tope, aviso neutro con «Actualizar». El cambio de estado
// se anuncia por una región `aria-live` única, sin toast.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import {
  TIPOS_DOCUMENTO_BOLSA_PRINCIPALES,
  type DocumentoBolsaDto, type EstadoDocumentoBolsa, type ExpedienteCompaniaDto, type TipoDocumentoBolsa,
} from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorBolsa } from '../../lib/bolsas';
import {
  ESTADO_DOCUMENTO, FUNCION_CARGAR_DOCUMENTOS_BOLSA, FUNCION_VER_DOCUMENTOS_BOLSA, nombreDocumento,
  SONDEO_FALLOS_MAX, SONDEO_INTERVALO_MS, SONDEO_TOPE_MS,
} from '../../lib/bolsasDocumentos';
import StatusChip from '../flit/StatusChip';
import { FlitCard, flitBtnSecondarySm } from '../flit/flitPageKit';
import FilaDocumento from './FilaDocumento';

interface Props {
  companiaId: number;
  /** Estado de la bolsa ya conocido por el detalle: así no se descubre lo inactivo por un 409. */
  activa: boolean;
  /** Carrera (409 en la carga o en la fecha): relee el detalle; la sección relee E1 por su cuenta. */
  onBolsaCambio?: () => void;
}

export default function ExpedienteDocumental(props: Props) {
  const { hasFuncion } = useAuth();
  if (!hasFuncion(FUNCION_VER_DOCUMENTOS_BOLSA)) return null;
  return <Seccion {...props} tieneCargar={hasFuncion(FUNCION_CARGAR_DOCUMENTOS_BOLSA)}
    puedeReactivar={hasFuncion('bolsas.bolsa.inactivar')} />;
}

type Carga =
  | { fase: 'cargando' }
  | { fase: 'error'; noExiste: boolean }
  | { fase: 'sin-permiso' }
  | { fase: 'lista'; expediente: ExpedienteCompaniaDto };

const AVISO_NEUTRO = { borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' };
const PRINCIPALES = TIPOS_DOCUMENTO_BOLSA_PRINCIPALES as readonly string[];

function Seccion({ companiaId, activa, onBolsaCambio, tieneCargar, puedeReactivar }: Props & {
  tieneCargar: boolean; puedeReactivar: boolean;
}) {
  const idTitulo = useId();
  const [carga, setCarga] = useState<Carga>({ fase: 'cargando' });
  const [historial, setHistorial] = useState<TipoDocumentoBolsa | null>(null);
  const [editando, setEditando] = useState<TipoDocumentoBolsa | null>(null);
  const [lento, setLento] = useState(false);
  const [anuncio, setAnuncio] = useState('');
  const montado = useRef(true);
  const previos = useRef<Map<TipoDocumentoBolsa, EstadoDocumentoBolsa>>(new Map());
  const inicioSondeo = useRef<number | null>(null);

  useEffect(() => { montado.current = true; return () => { montado.current = false; }; }, []);

  /** Pone el expediente y anuncia las filas que salieron de «Validando…». */
  const aplicar = useCallback((exp: ExpedienteCompaniaDto) => {
    const cambios: string[] = [];
    for (const d of exp.documentos) {
      if (previos.current.get(d.tipo) === 'validando' && d.estado !== 'validando') {
        cambios.push(`${nombreDocumento(d.tipo)}: ${ESTADO_DOCUMENTO[d.estado].texto}.`);
      }
    }
    previos.current = new Map(exp.documentos.map((d) => [d.tipo, d.estado]));
    if (cambios.length) setAnuncio(cambios.join(' '));
    setCarga({ fase: 'lista', expediente: exp });
  }, []);

  /** Lee E1. `silencioso`: sin esqueleto ni error de sección (sondeo, «Actualizar», carreras). */
  const leer = useCallback(async (silencioso: boolean): Promise<boolean> => {
    if (!silencioso) setCarga({ fase: 'cargando' });
    try {
      const exp = await bolsasDocumentosApi.expediente(companiaId);
      // Cuerpo sin la forma del contrato (proxy, versión vieja del API): error, no una sección rota.
      if (!Array.isArray(exp?.documentos)) throw new Error('expediente sin documentos');
      if (montado.current) aplicar(exp);
      return true;
    } catch (e) {
      if (!montado.current || silencioso) return false;
      const { status } = errorBolsa(e);
      setCarga(status === 403 ? { fase: 'sin-permiso' } : { fase: 'error', noExiste: status === 404 });
      return false;
    }
  }, [companiaId, aplicar]);

  useEffect(() => { void leer(false); }, [leer]);

  const hayValidando = carga.fase === 'lista' && carga.expediente.documentos.some((d) => d.estado === 'validando');

  // Sondeo de «Validando…». Se detiene al quedar ninguno validando, al desmontar o al tope.
  useEffect(() => {
    if (!hayValidando) { inicioSondeo.current = null; setLento(false); return; }
    if (lento) return;
    if (inicioSondeo.current === null) inicioSondeo.current = Date.now();
    let fallos = 0;
    const reloj = window.setInterval(() => {
      if (Date.now() - (inicioSondeo.current ?? 0) >= SONDEO_TOPE_MS) {
        window.clearInterval(reloj);
        setLento(true);
        return;
      }
      void leer(true).then((ok) => {
        fallos = ok ? 0 : fallos + 1;
        if (fallos >= SONDEO_FALLOS_MAX && montado.current) { window.clearInterval(reloj); setLento(true); }
      });
    }, SONDEO_INTERVALO_MS);
    return () => window.clearInterval(reloj);
  }, [hayValidando, lento, leer]);

  /** La fila toma el DTO de E3/E4 sin releer. Una carga nueva con OCR rearma el sondeo. */
  const aplicarDocumento = useCallback((dto: DocumentoBolsaDto, origen: 'carga' | 'fecha') => {
    setCarga((c) => {
      if (c.fase !== 'lista') return c;
      const documentos = c.expediente.documentos.map((d) => (d.tipo === dto.tipo ? { ...d, estado: dto.estado, vigente: dto } : d));
      const completo = documentos.filter((d) => PRINCIPALES.includes(d.tipo)).every((d) => d.estado === 'valido');
      previos.current.set(dto.tipo, dto.estado);
      return { fase: 'lista', expediente: { ...c.expediente, documentos, completo } };
    });
    if (origen === 'carga' && dto.estado === 'validando') { inicioSondeo.current = Date.now(); setLento(false); }
  }, []);

  if (carga.fase === 'sin-permiso') return null;

  const puedeCargar = tieneCargar && activa;
  const titulo = (
    <h3 id={idTitulo} className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Documentos</h3>
  );
  const subtitulo = (
    <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
      Documentos de vinculación de la compañía. Vencen 30 días después de expedidos.
    </p>
  );

  return (
    <FlitCard>
      {/* `relative`: ancla el anuncio `sr-only` (absolute) a la sección; si no, su offsetParent es el overlay
          `.flit-modal` y agranda el scroll del overlay por debajo del diálogo (HU #13892, DEV). */}
      <section aria-labelledby={idTitulo} data-testid="expediente-documental" className="relative">
        {carga.fase === 'cargando' && (
          <>
            {titulo}
            {subtitulo}
            <EsqueletoExpediente />
          </>
        )}

        {carga.fase === 'error' && (
          <>
            {titulo}
            <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--flit-danger-text)' }}>
              {carga.noExiste
                ? 'No encontramos la compañía de esta bolsa. Cierra el detalle y vuelve a abrirlo.'
                : 'No pudimos cargar los documentos de la compañía. Intenta de nuevo.'}
            </p>
            {!carga.noExiste && (
              <button type="button" className={`${flitBtnSecondarySm} mt-3`} onClick={() => { void leer(false); }}>
                <RotateCw size={14} aria-hidden="true" className="shrink-0" />
                Reintentar
              </button>
            )}
          </>
        )}

        {carga.fase === 'lista' && (() => {
          const { expediente } = carga;
          const validos = expediente.documentos.filter((d) => PRINCIPALES.includes(d.tipo) && d.estado === 'valido').length;
          const vacio = expediente.documentos.every((d) => d.estado === 'pendiente');
          return (
            <>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                {titulo}
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  <StatusChip tone={expediente.completo ? 'success' : 'warning'}>
                    {expediente.completo ? 'Docs completos' : 'Docs pendientes'}
                  </StatusChip>
                  <span>{expediente.completo ? 'Los 4 principales están válidos' : `${validos} de 4 principales válidos`}</span>
                </div>
              </div>
              {subtitulo}
              {vacio && (
                <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                  {puedeCargar
                    ? 'Todavía no hay documentos. Carga los cuatro principales para dejar el expediente completo.'
                    : (!activa && tieneCargar
                      ? 'Todavía no hay documentos. Reactiva la bolsa para cargarlos.'
                      : 'Todavía no hay documentos. Alguien con permiso de carga tiene que subirlos.')}
                </p>
              )}
              {!activa && (
                <div role="status" data-testid="aviso-expediente-inactiva" className="mt-3 rounded-lg border px-3 py-2 text-sm" style={AVISO_NEUTRO}>
                  La bolsa está inactiva: puedes consultar y descargar los documentos, pero no cargarlos ni cambiar fechas.{' '}
                  {puedeReactivar
                    ? 'Reactiva la bolsa para actualizarlos.'
                    : 'Para actualizarlos, alguien con permiso tiene que reactivar la bolsa primero.'}
                </div>
              )}
              {lento && hayValidando && (
                <div role="status" data-testid="aviso-ocr-lento"
                  className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm" style={AVISO_NEUTRO}>
                  <p className="min-w-0 flex-1 basis-56">
                    La lectura de la fecha está tardando más de lo normal. Puedes seguir trabajando y actualizar en un rato.
                  </p>
                  <button type="button" className={flitBtnSecondarySm} onClick={() => { void leer(true); }}>
                    <RotateCw size={14} aria-hidden="true" className="shrink-0" />
                    Actualizar
                  </button>
                </div>
              )}
              <ul className="mt-3 divide-y border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                {expediente.documentos.map((d) => (
                  <FilaDocumento key={d.tipo} companiaId={companiaId} doc={d} puedeCargar={puedeCargar}
                    historialAbierto={historial === d.tipo}
                    onHistorial={(abrir) => setHistorial(abrir ? d.tipo : null)}
                    editando={editando === d.tipo && puedeCargar}
                    onEditar={(abrir) => setEditando((t) => (abrir ? d.tipo : (t === d.tipo ? null : t)))}
                    onDocumento={aplicarDocumento}
                    onCarrera={() => { onBolsaCambio?.(); void leer(true); }} />
                ))}
              </ul>
            </>
          );
        })()}

        <p aria-live="polite" className="sr-only">{anuncio}</p>
      </section>
    </FlitCard>
  );
}

function EsqueletoExpediente() {
  const barra = (w: string, h = 'h-3') => <div className={`${h} rounded`} style={{ width: w, background: 'var(--flit-bg-app)' }} />;
  return (
    <div role="status" aria-label="Cargando el expediente" className="mt-3 divide-y border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="space-y-2 py-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="flex flex-wrap items-center gap-2">{barra('35%')}{barra('5rem', 'h-5')}</div>
          {barra('60%')}
        </div>
      ))}
    </div>
  );
}
