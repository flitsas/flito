// FLITO — selector de documentos adicionales del SOAT (HU #13363).
//
// Spec: docs/ux/flito-soat-documentos-adicionales.md §3.1–§3.3, §6, §7. **Controlado**: no sabe nada
// del alta ni del envío (§5). La HU #13365 lo monta en el detalle con su propio botón de enviar y
// `presentes` = los documentos ya guardados.
//
// Los inválidos no viajan, no bloquean el envío y no suman a la frase de faltantes del alta (AC3):
// se pintan aparte, con su motivo, y se pueden descartar de la vista. Copy del alta: **usted**.
import { useRef } from 'react';
import { Paperclip, TriangleAlert, Upload, X } from 'lucide-react';
import FlitUploadBox from '../../flit/FlitUploadBox';
import StatusChip from '../../flit/StatusChip';
import { flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';
import { Seccion } from '../soat-cliente/bloques';
import {
  ACCEPT_ADICIONALES, LARGO_ETIQUETA_ADICIONAL, MAX_TOTAL_ADICIONALES, aPresentes, motivoEnPantalla,
  tamanoLegible, tipoLegible, validarAdicionales, validos, type ElegidoAdicional, type PresenteAdicional,
} from './documentosAdicionales';
import { MotivoDescarteDocumentoAdicional } from '@operaciones/shared-types';

const BOTON_ICONO =
  'flit-focus grid h-8 w-8 shrink-0 place-items-center rounded transition-colors hover:bg-[var(--flit-bg-hover)]';

export const TITULO_BLOQUE_ADICIONALES = '4 · Documentos adicionales (opcional)';

/** Plural «para adjuntar» del chip (§3.2): cuenta solo los válidos. */
const archivos = (n: number) => (n === 1 ? '1 archivo' : `${n} archivos`);

export default function DocumentosAdicionalesSelector({ value, onChange, presentes = [], ajenos = [], idBase = 'adic' }: {
  value: ElegidoAdicional[];
  onChange: (lista: ElegidoAdicional[]) => void;
  /** Ya guardados (HU #13365): cuentan para cupos y repetidos. */
  presentes?: PresenteAdicional[];
  /** Solo para «repetido» (la factura de venta del alta). */
  ajenos?: PresenteAdicional[];
  idBase?: string;
}) {
  const ok = validos(value);
  const malos = value.filter((e) => e.motivo);
  const total = ok.reduce((s, e) => s + e.archivo.size, 0);
  const contenedorRef = useRef<HTMLDivElement>(null);

  const elegir = (nuevos: File[]) => {
    // Los ya válidos de la lista consumen cupo antes que los recién elegidos. Elegir más SUMA.
    const evaluados = validarAdicionales(nuevos, [...presentes, ...aPresentes(ok)], ajenos);
    onChange([...value, ...evaluados]);
  };

  const quitar = (clave: string, grupo: ElegidoAdicional[]) => {
    const i = grupo.findIndex((e) => e.clave === clave);
    const destino = grupo[i + 1] ?? grupo[i - 1];
    onChange(value.filter((e) => e.clave !== clave));
    // Foco tras quitar (§3.2): la fila vecina del mismo grupo, o la caja si la lista queda vacía.
    // Se aplica en el siguiente cuadro, cuando React ya pintó la lista nueva.
    requestAnimationFrame(() => {
      const raiz = contenedorRef.current;
      if (!raiz) return;
      const siguiente = destino && raiz.querySelector<HTMLElement>(`[data-quitar="${destino.clave}"]`);
      if (siguiente) siguiente.focus();
      else raiz.querySelector<HTMLElement>('input[type="file"]')?.focus();
    });
  };

  const etiquetar = (clave: string, etiqueta: string) =>
    onChange(value.map((e) => (e.clave === clave ? { ...e, etiqueta } : e)));

  return (
    <div ref={contenedorRef} className="space-y-3">
      {value.length === 0 ? (
        <>
          <FlitUploadBox
            label="Elegir archivos" hint="PDF, JPG, PNG, WEBP o HEIC · hasta 15 MB cada uno"
            state="idle" accept={ACCEPT_ADICIONALES} multiple onFiles={elegir} onFile={(f) => elegir([f])}
          />
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Si tiene otros documentos que ayuden con la solicitud, adjúntelos aquí. Hasta 20 archivos y 250 MB en
            total. No son obligatorios.
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className={`${flitBtnSecondary} w-full cursor-pointer justify-center focus-within:shadow-[0_0_0_3px_var(--flit-border-focus)] sm:w-auto`}
            style={flitBtnSecondaryStyle}>
            <Upload size={16} aria-hidden="true" className="shrink-0" />
            Elegir más archivos
            <input
              type="file" multiple accept={ACCEPT_ADICIONALES} className="sr-only"
              onChange={(e) => { const l = Array.from(e.target.files ?? []); if (l.length) elegir(l); e.target.value = ''; }}
            />
          </label>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            {archivos(ok.length)} · {tamanoLegible(total)} de {MAX_TOTAL_ADICIONALES / (1024 * 1024)} MB
          </p>
        </div>
      )}

      {ok.length > 0 && (
        <>
          <ul className="divide-y rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
            {ok.map((e, i) => {
              const idNombre = `${idBase}-nombre-${e.clave}`;
              const idEtiqueta = `${idBase}-etiqueta-${e.clave}`;
              return (
                <li key={e.clave} className="space-y-2 p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p id={idNombre} title={e.archivo.name} className="truncate text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                        {e.archivo.name}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                        {tipoLegible(e.archivo.type, e.archivo.name)} · {tamanoLegible(e.archivo.size)}
                      </p>
                    </div>
                    <button type="button" data-quitar={e.clave} aria-label={`Quitar ${e.archivo.name}`} title={`Quitar ${e.archivo.name}`}
                      className={BOTON_ICONO} style={{ color: 'var(--flit-text-secondary)' }}
                      onClick={() => quitar(e.clave, ok)}>
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                  <div>
                    <label htmlFor={idEtiqueta} className="mb-1 block text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>
                      Etiqueta (opcional)
                    </label>
                    <input
                      id={idEtiqueta} type="text" className={flitInp} aria-describedby={idNombre}
                      value={e.etiqueta} maxLength={LARGO_ETIQUETA_ADICIONAL} autoComplete="off"
                      placeholder={i === 0 ? 'Ej.: Poder autenticado' : undefined}
                      onChange={(ev) => etiquetar(e.clave, ev.target.value)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Si no les pone etiqueta, se guardan con el nombre del archivo.
          </p>
        </>
      )}

      {malos.length > 0 && (
        <div role="status" className="space-y-2">
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            No se van a adjuntar ({malos.length})
          </p>
          <ul className="divide-y rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
            {malos.map((e) => (
              <li key={e.clave} className="flex items-start gap-2 p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: 'var(--flit-danger-text)' }} />
                <div className="min-w-0 flex-1">
                  <p title={e.archivo.name} className="truncate text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                    {e.archivo.name}
                    {e.motivo === MotivoDescarteDocumentoAdicional.SUPERA_TAMANO && ` · ${tamanoLegible(e.archivo.size)}`}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--flit-danger-text)' }}>{motivoEnPantalla(e.motivo ?? '')}</p>
                </div>
                <button type="button" data-quitar={e.clave} aria-label={`Descartar ${e.archivo.name}`} title={`Descartar ${e.archivo.name}`}
                  className={BOTON_ICONO} style={{ color: 'var(--flit-text-secondary)' }}
                  onClick={() => quitar(e.clave, malos)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Puede enviar la solicitud igual: estos archivos no viajan.
          </p>
        </div>
      )}
    </div>
  );
}

/** El bloque 4 del alta, con el patrón de la factura (§2): la página solo lo monta. */
export function BloqueDocumentosAdicionales({ value, onChange, factura }: {
  value: ElegidoAdicional[]; onChange: (lista: ElegidoAdicional[]) => void; factura: File | null;
}) {
  const n = validos(value).length;
  return (
    <Seccion
      titulo={TITULO_BLOQUE_ADICIONALES}
      icono={<Paperclip size={18} aria-hidden="true" className="shrink-0" />}
      chip={n > 0 ? <StatusChip tone="neutral">{`${n} para adjuntar`}</StatusChip> : undefined}
    >
      <DocumentosAdicionalesSelector
        value={value} onChange={onChange} idBase="sol-adic"
        ajenos={factura ? [{ nombre: factura.name, tamanoBytes: factura.size }] : []}
      />
    </Seccion>
  );
}
