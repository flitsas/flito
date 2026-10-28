// HU #14134 — panel de la carga masiva: vacío → subiendo → en curso → terminado, con su error y
// «Reintentar» en cada paso. Al desmontarse (salir de la vista o pasar a Individual) el polling se
// cancela; el procesamiento sigue en el servidor y no hay pantalla para retomarlo (AC6).
import { useEffect } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import AvisoProcesando from '../../../flit/AvisoProcesando';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../../flit/flitPageKit';
import { Seccion } from '../bloques';
import { COPY_COMUN, COPY_MASIVO } from './copyMasivo';
import PasoPlantilla from './PasoPlantilla';
import ResumenLote from './ResumenLote';
import TablaFilasLote, { FilasEsqueleto } from './TablaFilasLote';
import type { TipoMasivo } from './tiposMasivo';
import { useLoteMasivo } from './useLoteMasivo';
import ZonaCargaExcel from './ZonaCargaExcel';

export default function PanelMasivoRenovacion({ tipo, companiaId, faltaCompania, onEnCurso }: {
  tipo: TipoMasivo;
  companiaId: number | undefined;
  faltaCompania: boolean;
  /** El contenedor necesita saberlo para confirmar antes de pasar a Individual. */
  onEnCurso: (enCurso: boolean) => void;
}) {
  const l = useLoteMasivo(tipo, companiaId);
  const copy = COPY_MASIVO[tipo];
  const { avance } = l;
  useEffect(() => { onEnCurso(l.enCurso); }, [l.enCurso, onEnCurso]);
  useEffect(() => () => onEnCurso(false), [onEnCurso]);

  const icono = <FileSpreadsheet size={18} aria-hidden="true" className="shrink-0" />;

  if (!l.loteId) {
    return (
      <Seccion titulo={copy.tituloSeccion} icono={icono}>
        <PasoPlantilla tipo={tipo} descargando={l.descargando === 'plantilla'} onDescargar={() => void l.descargarPlantilla()}>
          <ZonaCargaExcel
            tipo={tipo} archivo={l.archivo} errorArchivo={l.errorArchivo} subiendo={l.subiendo}
            errorSubida={l.errorSubida} faltaCompania={faltaCompania}
            onElegir={l.elegirArchivo} onCargar={() => void l.subir()}
          />
        </PasoPlantilla>
      </Seccion>
    );
  }

  const procesadas = avance ? Math.max(0, avance.total - avance.pendientes - avance.procesando) : 0;
  return (
    <>
      {l.terminado && avance?.resumen && (
        <Seccion titulo="Resultado de la carga" icono={icono}>
          <ResumenLote
            resumen={avance.resumen} filas={l.filas} puedeDescargar={avance.descargaRechazadas} vencida={l.rechazadasVencidas}
            descargando={l.descargando === 'rechazadas'} onDescargar={() => void l.descargarRechazadas()} onOtro={l.reiniciar}
          />
        </Seccion>
      )}
      <Seccion titulo={l.terminado ? (tipo === 'inicial' ? 'Detalle por VIN' : 'Filas de la carga') : copy.tituloSeccion} icono={l.terminado ? undefined : icono}>
        <div className="space-y-3">
          {l.errorAvance === 'red' && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
              <p className="min-w-0">{COPY_COMUN.falloAvance}</p>
              <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={l.reintentarAvance}>
                Reintentar
              </button>
            </div>
          )}
          {l.errorAvance === 'no_encontrado' && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
              <p className="min-w-0">{copy.noEncontrada}</p>
              <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={l.reiniciar}>
                Cargar otro archivo
              </button>
            </div>
          )}
          {l.enCurso && !l.errorAvance && (avance ? (
            <AvisoProcesando
              texto={`Procesando: ${procesadas} de ${avance.total} filas. Puede salir de esta página; el proceso continúa.`}
              anuncio="Procesando la carga en masa. Puede salir de esta página; el proceso continúa."
            />
          ) : <AvisoProcesando texto="Preparando el avance…" />)}
          {l.filas.length > 0 ? <TablaFilasLote tipo={tipo} filas={l.filas} /> : !l.errorAvance && <FilasEsqueleto />}
        </div>
      </Seccion>
    </>
  );
}
