// Aviso de retiros en las colas SOAT e Impuestos (Épica #14707; UX `docs/ux/epica-14707-tramite-muerto.md` §5).
//
// Quien SOLICITÓ un SOAT o un impuesto que ya iba al gestor se entera de que se retiró porque FLIT anuló o
// revocó su trámite. Cada cola muestra solo los retiros de su concepto. Va justo debajo del encabezado de la
// página: es un estado que sigue siendo cierto hasta que se marca visto, así que es un aviso de página y no un
// toast ni una campana (patrón nuevo, no pedido). Cuatro estados: cargando y vacío no pintan nada (la cola se
// ve como siempre); error = una línea discreta con «Reintentar» (`role="status"`, no tapa la cola); lleno =
// `InlineAlert warn` con la lista (5 visibles y «Ver los N») y «Entendido», que marca vistos TODOS los del
// aviso, también los plegados. Al acertar, el foco va al título de la página; al fallar, toast y el aviso sigue.
import { useEffect, useId, useState } from 'react';
import type { AvisoUsuarioDto } from '@operaciones/shared-types';
import { avisosApi } from '../../lib/api';
import InlineAlert from './InlineAlert';
import Placa from './Placa';
import { claseBoton } from './GradientButton';
import { toastError } from './ToastFlito';

const VISIBLES = 5;
const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
const revocado = (a: AvisoUsuarioDto) => a.motivo === 'revocado';

type Fase = { fase: 'cargando' } | { fase: 'error' } | { fase: 'listo'; avisos: AvisoUsuarioDto[] };

function copy(concepto: 'soat' | 'impuesto', usted: boolean, avisos: AvisoUsuarioDto[]) {
  const n = avisos.length;
  const nombre = concepto === 'soat' ? 'SOAT' : n === 1 ? 'impuesto' : 'impuestos';
  const quien = usted ? 'que usted solicitó' : 'que solicitaste';
  const titulo = n === 1 ? `Se retiró 1 ${nombre} ${quien}` : `Se retiraron ${n} ${nombre} ${quien}`;
  const donde = usted ? 'esta lista' : 'la cola';
  const cierre = usted ? 'No tiene que hacer nada más.' : 'No tienes que hacer nada más.';
  const texto = n === 1
    ? `Su trámite se ${revocado(avisos[0]) ? 'revocó' : 'anuló'} en FLIT: ya no se tramita y salió de ${donde}. ${cierre}`
    : `Sus trámites se anularon o se revocaron en FLIT: ya no se tramitan y salieron de ${donde}. ${cierre}`;
  return { titulo, texto };
}

/** El foco va al título de la página para no perderse en el vacío que deja el aviso. */
function focoAlTitulo() {
  const h1 = document.querySelector<HTMLElement>('main h1, h1');
  if (!h1) return;
  if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
  h1.focus();
}

export default function AvisosUsuario({ concepto, usted = false, recarga = 0 }: {
  concepto: 'soat' | 'impuesto';
  /** Canal Cliente: copy en usted. */
  usted?: boolean;
  /** Cambia cuando la cola se refresca: se vuelve a pedir sin ocultar lo ya pintado. */
  recarga?: number;
}) {
  const [estado, setEstado] = useState<Fase>({ fase: 'cargando' });
  const [intento, setIntento] = useState(0);
  const [verTodos, setVerTodos] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const idLista = useId();

  useEffect(() => {
    let vivo = true;
    avisosApi.listar()
      .then((r) => { if (vivo) setEstado({ fase: 'listo', avisos: r.avisos.filter((a) => a.concepto === concepto) }); })
      // Al refrescar con un aviso ya pintado, un fallo no lo oculta.
      .catch(() => { if (vivo) setEstado((e) => (e.fase === 'listo' && e.avisos.length > 0 ? e : { fase: 'error' })); });
    return () => { vivo = false; };
  }, [concepto, recarga, intento]);

  const plural = concepto === 'soat' ? 'SOAT' : 'impuesto';
  if (estado.fase === 'cargando') return null;
  if (estado.fase === 'error') {
    return (
      <p role="status" className="m-0 text-sm text-[color:var(--color-text-secondary)]" data-testid={`avisos-${concepto}-error`}>
        {usted ? `No pudimos revisar si se retiró algún ${plural} que usted solicitó.` : `No pudimos revisar si se retiró algún ${plural} que solicitaste.`}{' '}
        <button type="button" className="enlace-btn" onClick={() => { setEstado({ fase: 'cargando' }); setIntento((n) => n + 1); }}>Reintentar</button>
      </p>
    );
  }
  const avisos = estado.avisos;
  if (avisos.length === 0) return null;

  const { titulo, texto } = copy(concepto, usted, avisos);
  const visibles = verTodos ? avisos : avisos.slice(0, VISIBLES);
  const entendido = async () => {
    setGuardando(true);
    try {
      await avisosApi.marcarVisto(avisos.map((a) => a.id));
      setEstado({ fase: 'listo', avisos: [] });
      setTimeout(focoAlTitulo, 0);
    } catch {
      toastError(usted ? 'No pudimos ocultar el aviso. Intente de nuevo.' : 'No se pudo ocultar el aviso. Intenta de nuevo.', () => { void entendido(); });
    } finally { setGuardando(false); }
  };

  return (
    <div data-testid={`avisos-${concepto}`}>
      <InlineAlert tono="warn" titulo={titulo}>
        <p className="m-0 mt-1">{texto}</p>
        <ul id={idLista} className="m-0 mt-3 list-none space-y-2 p-0">
          {visibles.map((a) => (
            <li key={a.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]">
              <span>{a.placa ? <Placa placa={a.placa} /> : '—'}</span>
              <span className="text-sm tabular-nums">{a.idFlit ?? '—'}</span>
              <span className="col-span-2 text-sm sm:col-span-1">{revocado(a) ? 'Trámite revocado en FLIT' : 'Trámite anulado en FLIT'}</span>
              <span className="col-span-2 text-sm tabular-nums text-[color:var(--color-text-secondary)] sm:col-span-1 sm:text-right">{fecha(a.creadoEn)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {avisos.length > VISIBLES && (
            <button type="button" className={claseBoton('ghost', 'sm')} aria-expanded={verTodos} aria-controls={idLista}
              onClick={() => setVerTodos((v) => !v)}>{verTodos ? 'Ver menos' : `Ver los ${avisos.length}`}</button>
          )}
          <button type="button" className={claseBoton('secondary', 'sm', 'max-sm:w-full')} disabled={guardando} aria-busy={guardando || undefined}
            aria-label={usted ? undefined : `Entendido, ocultar el aviso de ${concepto === 'soat' ? 'SOAT' : 'impuestos'} retirados`}
            onClick={() => { void entendido(); }}>Entendido</button>
        </div>
      </InlineAlert>
    </div>
  );
}

/** Copy del 409 `TRAMITE_NO_VIGENTE` en una cola (14707 §6): impersonal, sin reintento; la cola se refresca. */
export function copyColaNoVigente(concepto: 'soat' | 'impuesto', n: number): string {
  if (n <= 1) return `Este ${concepto === 'soat' ? 'SOAT' : 'impuesto'} ya no está en la cola: su trámite se anuló o se revocó en FLIT. La lista ya se actualizó.`;
  return 'Algunos de los seleccionados ya no están en la cola: su trámite se anuló o se revocó en FLIT. La lista ya se actualizó.';
}
