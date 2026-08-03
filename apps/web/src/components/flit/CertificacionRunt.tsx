/**
 * Certificación de un impuesto contra el RUNT — celda de la cola y detalle del resultado (HU #11168).
 *
 * Dos piezas que se usan juntas pero se prueban por separado: la CELDA, que decide qué se ve en cada
 * fila, y el MODAL, que explica por qué un intento no certificó.
 *
 * Lo que el modal existe para separar: una discrepancia de datos y un RUNT caído se parecen mucho
 * desde la interfaz —en ambos casos «no se pudo»— pero el gestor tiene que hacer cosas distintas.
 * Ante una discrepancia hay que ir a corregir un dato; ante un traspaso sincronizando, esperar a
 * mañana; ante un error de servicio, reintentar en un rato. Un único «no se pudo certificar» le
 * obligaría a adivinar cuál de las tres era. Por eso cada desenlace trae su propio tono, su propio
 * título y, en el caso de la discrepancia, la tabla campo a campo.
 */

import {
  CAMPO_CERTIFICACION_LABEL, ResultadoCampo, ResultadoCertificacion,
  type ComparacionCampo,
} from '@operaciones/shared-types';
import FlitModal from './FlitModal';
import StatusChip, { type ChipTone } from './StatusChip';
import {
  FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from './flitPageKit';

/** Lo que la cola sabe de una certificación vigente. El detalle completo vive en el PDF. */
export interface CertificacionCola {
  id: string;
  certificadoEn: string;
  certificadoPorNombre: string;
}

/** Desenlace de un intento, ya normalizado desde la respuesta del backend. */
export interface ResultadoIntento {
  code: ResultadoCertificacion;
  mensaje: string;
  /** Solo en `con_diferencias`. */
  campos?: ComparacionCampo[];
}

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Celda de la columna Certificación.
 *
 * Tres estados excluyentes, en este orden: ya certificado (chip que descarga), certificable (botón),
 * o nada. El orden importa — un registro certificado NO vuelve a mostrar el botón aunque siga siendo
 * elegible: recertificar es una acción deliberada que se pide desde el detalle, no algo que ocurra
 * por pulsar donde antes había otra cosa.
 */
export function CeldaCertificacion({
  certificacion, puedeDescargar, puedeCertificar, cargando, onCertificar, onDescargar,
}: {
  certificacion: CertificacionCola | null;
  /**
   * Depende SOLO del rol, no del estado del impuesto.
   *
   * Un impuesto ya pagado no se puede certificar —el dinero salió— pero su certificado sigue siendo
   * la evidencia de la verificación que se hizo antes de pagar, y es justo entonces cuando hace
   * falta enseñárselo al cliente. Atar la descarga al estado lo dejaría sin evidencia descargable.
   */
  puedeDescargar: boolean;
  /** El rol puede operar Y el estado del impuesto lo admite. Un auditor nunca. */
  puedeCertificar: boolean;
  cargando: boolean;
  onCertificar: () => void;
  onDescargar: () => void;
}) {
  if (certificacion) {
    const titulo = `Certificado el ${fechaHora(certificacion.certificadoEn)} por ${certificacion.certificadoPorNombre}`;
    // A un usuario de solo lectura se le muestra el estado, no el enlace: el backend le devolvería
    // 403 al descargar (la ruta es de operaciones y gestor), y ofrecer un botón que falla es peor
    // que no ofrecerlo.
    if (!puedeDescargar) {
      return (
        <td className="px-3 py-2">
          <span title={titulo}><StatusChip tone="success">Certificado</StatusChip></span>
        </td>
      );
    }
    return (
      <td className="px-3 py-2">
        <button type="button" onClick={onDescargar} title={`${titulo}. Descargar el certificado en PDF.`}
          aria-label="Descargar certificado en PDF" className="cursor-pointer">
          <StatusChip tone="success">Certificado</StatusChip>
        </button>
      </td>
    );
  }

  if (!puedeCertificar) return <td className="px-3 py-2 text-sm">—</td>;

  return (
    <td className="px-3 py-2">
      <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
        disabled={cargando} onClick={onCertificar}
        // La consulta al RUNT puede tardar decenas de segundos (90 s de timeout en backend). Sin
        // este aviso la pantalla parece colgada y el gestor vuelve a pulsar.
        title={cargando ? 'Consultando el RUNT. Puede tardar hasta un minuto.' : 'Verificar los datos contra el RUNT'}>
        {cargando ? 'Consultando RUNT…' : 'Certificar'}
      </button>
    </td>
  );
}

const TONO_RESULTADO: Record<ResultadoCertificacion, ChipTone> = {
  certificado: 'success',
  con_diferencias: 'danger',
  no_elegible: 'warning',
  traspaso_en_sincronizacion: 'warning',
  error_servicio: 'danger',
};

const TITULO_RESULTADO: Record<ResultadoCertificacion, string> = {
  certificado: 'Certificado',
  con_diferencias: 'Los datos no coinciden con el RUNT',
  no_elegible: 'Este registro no se puede certificar',
  traspaso_en_sincronizacion: 'El traspaso aún está sincronizando',
  error_servicio: 'No se pudo consultar el RUNT',
};

/**
 * Qué hacer, que no es lo mismo que qué pasó.
 *
 * El título da el diagnóstico; el chip da la salida. Es la información que de verdad separa los tres
 * desenlaces que comparten el 409: ante una discrepancia se corrige un dato, ante un traspaso
 * sincronizando se espera a mañana, y ante un RUNT caído se reintenta en un rato. Repetir el título
 * en el chip habría gastado el sitio más visible del modal en decir dos veces lo mismo.
 */
const ACCION_RESULTADO: Record<ResultadoCertificacion, string> = {
  certificado: 'Listo',
  con_diferencias: 'Corrige el dato y reintenta',
  no_elegible: 'No aplica a este registro',
  traspaso_en_sincronizacion: 'Reintenta en 24-72 horas hábiles',
  error_servicio: 'Reintenta en unos minutos',
};

const TONO_CAMPO: Record<ResultadoCampo, ChipTone> = {
  coincide: 'success',
  difiere: 'danger',
  no_verificable: 'draft',
  sin_dato_flito: 'draft',
};

const LABEL_CAMPO: Record<ResultadoCampo, string> = {
  coincide: 'Coincide',
  difiere: 'Difiere',
  no_verificable: 'No reportado por el RUNT',
  sin_dato_flito: 'Sin dato en FLITO',
};

/** Desenlace de UN registro dentro de un lote, tal como lo devuelve el backend (HU #11166). */
export interface ResultadoLoteItem {
  id: string;
  resultado: ResultadoCertificacion;
  mensaje?: string;
  diferenciasBloqueantes?: ComparacionCampo[];
}

export interface ResultadoLote {
  total: number;
  certificados: number;
  resultados: ResultadoLoteItem[];
}

/**
 * Resultado de una certificación masiva, un registro por fila (HU #11169).
 *
 * El backend responde 200 aunque nueve de diez fallen: el desenlace vive POR REGISTRO. Así que el
 * modal no puede limitarse a «salió bien» o «salió mal» — tiene que decir, de cada uno, qué pasó y
 * qué hacer. Por eso reutiliza el mismo vocabulario que el modal individual: el gestor que ya
 * aprendió qué significa «Corrige el dato y reintenta» no debería aprenderlo otra vez aquí.
 */
export function ModalResultadoLote({ resultado, placaDe, onClose }: {
  resultado: ResultadoLote;
  /** La placa es lo que el gestor reconoce; el id de un impuesto no le dice nada. */
  placaDe: (id: string) => string | null;
  onClose: () => void;
}) {
  const fallidos = resultado.total - resultado.certificados;

  return (
    <FlitModal wide title="Resultado de la certificación masiva" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <StatusChip tone="success">Certificados {resultado.certificados}</StatusChip>
          {fallidos > 0 && <StatusChip tone="warning">Sin certificar {fallidos}</StatusChip>}
        </div>

        <FlitTable>
          <thead>
            <FlitTr>
              <FlitTh>Placa</FlitTh><FlitTh>Resultado</FlitTh><FlitTh>Qué hacer</FlitTh><FlitTh>Detalle</FlitTh>
            </FlitTr>
          </thead>
          <tbody>
            {resultado.resultados.map((r) => (
              <FlitTr key={r.id}>
                <td className="px-3 py-2 text-sm font-medium">{placaDe(r.id) ?? '—'}</td>
                <td className="px-3 py-2 text-sm">{TITULO_RESULTADO[r.resultado] ?? r.resultado}</td>
                <td className="px-3 py-2">
                  <StatusChip tone={TONO_RESULTADO[r.resultado]}>{ACCION_RESULTADO[r.resultado]}</StatusChip>
                </td>
                <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                  {r.mensaje ?? detalleDiferencias(r.diferenciasBloqueantes) ?? '—'}
                </td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>

        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Los que no se certificaron conservan su estado: un intento fallido no cambia el registro ni deja certificación.
        </p>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onClose}>Listo</button>
      </div>
    </FlitModal>
  );
}

/**
 * Resume las diferencias en una línea.
 *
 * El desenlace `con_diferencias` no trae `mensaje` —el detalle viaja campo a campo— y dejar la celda
 * vacía obligaría a certificar de uno en uno solo para saber cuál era el dato malo. Con el nombre
 * del campo basta para ir a corregirlo.
 */
function detalleDiferencias(campos: ComparacionCampo[] | undefined): string | null {
  if (!campos?.length) return null;
  const nombres = campos.map((c) => CAMPO_CERTIFICACION_LABEL[c.campo] ?? c.campo);
  return `No coincide: ${nombres.join(', ')}`;
}

/** Explica por qué un intento no certificó. Solo se abre cuando algo salió distinto de bien. */
export function ModalResultadoCertificacion({ resultado, placa, onClose }: {
  resultado: ResultadoIntento;
  placa: string | null;
  onClose: () => void;
}) {
  const conDiferencias = resultado.code === ResultadoCertificacion.CON_DIFERENCIAS;

  return (
    <FlitModal wide={conDiferencias} onClose={onClose}
      title={`${TITULO_RESULTADO[resultado.code]}${placa ? ` · ${placa}` : ''}`}>
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <StatusChip tone={TONO_RESULTADO[resultado.code]}>{ACCION_RESULTADO[resultado.code]}</StatusChip>
        </div>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{resultado.mensaje}</p>

        {conDiferencias && resultado.campos && resultado.campos.length > 0 && (
          <div>
            <FlitTable>
              <thead>
                <FlitTr>
                  <FlitTh>Campo</FlitTh><FlitTh>En FLITO</FlitTh><FlitTh>En el RUNT</FlitTh><FlitTh>Resultado</FlitTh>
                </FlitTr>
              </thead>
              <tbody>
                {resultado.campos.map((c) => (
                  <FlitTr key={c.campo}>
                    <td className="px-3 py-2 text-sm font-medium">
                      {CAMPO_CERTIFICACION_LABEL[c.campo] ?? c.campo}
                    </td>
                    <td className="px-3 py-2 text-sm">{c.valorFlito ?? '—'}</td>
                    <td className="px-3 py-2 text-sm">{c.valorRunt ?? '—'}</td>
                    <td className="px-3 py-2">
                      <StatusChip tone={TONO_CAMPO[c.resultado]}>{LABEL_CAMPO[c.resultado]}</StatusChip>
                      {/* Marca de por qué ESTE campo frenó la certificación: marca y línea pueden
                          diferir sin bloquear, y sin esta pista la tabla no lo explica. */}
                      {c.bloqueante && c.resultado === ResultadoCampo.DIFIERE && (
                        <div className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Impide certificar</div>
                      )}
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
            <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              El registro conserva su estado: este intento no lo cambió ni dejó certificación. El botón Certificar sigue disponible.
            </p>
          </div>
        )}
      </div>
    </FlitModal>
  );
}
