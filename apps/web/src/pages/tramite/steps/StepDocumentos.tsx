// TRAM-ARCH-01b · Paso 2 — Carga de documentos + resumen OCR.
//
// Presentacional: el shell (TramiteDigital) posee el estado (archivos, OCR,
// subida) y pasa callbacks. Misma UX que el bloque inline previo.

import { DOC_TYPES } from '../../../constants/tramite';
import FlitUploadBox from '../../../components/flit/FlitUploadBox';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../../components/flit/flitPageKit';
import {
  FLIT_STEP_TITLE, FLIT_STEP_TITLE_STYLE, FLIT_STEP_SUB, FLIT_STEP_SUB_STYLE, FLIT_OK, FLIT_ERR,
} from '../wizard/flitStepKit';
import type { ArchivoData, OcrResult } from '../wizard/types';

export interface StepDocumentosProps {
  archivos: ArchivoData[];
  uploading: Record<string, boolean>;
  ocrResults: Record<string, OcrResult>;
  onSubirDoc: (tipo: string, file: File) => void;
  onAtras: () => void;
  onContinuar: () => void;
}

export default function StepDocumentos({
  archivos, uploading, ocrResults, onSubirDoc, onAtras, onContinuar,
}: StepDocumentosProps) {
  return (
    <div className="bg-[var(--color-surface-elevated)] rounded-[9px] border border-[color:var(--color-border)] p-6">
      <h3 className={FLIT_STEP_TITLE} style={FLIT_STEP_TITLE_STYLE}>Carga de documentos</h3>
      <p className={FLIT_STEP_SUB} style={FLIT_STEP_SUB_STYLE}>Sube los documentos requeridos para la matrícula inicial</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {DOC_TYPES.map((dt) => {
          const uploaded = archivos.filter((a) => a.tipo === dt.key);
          const isUploading = uploading[dt.key] || false;
          const ocrResult = ocrResults[dt.key];
          const rejected = ocrResult?._rechazado;
          const verified = uploaded.length > 0 && ocrResult && !rejected;
          const boxState = isUploading ? 'uploading' : rejected ? 'rejected' : verified ? 'verified' : 'idle';
          return (
            <FlitUploadBox
              key={dt.key}
              label={dt.label}
              required={dt.required}
              state={boxState}
              count={uploaded.length}
              onFile={(f) => onSubirDoc(dt.key, f)}
            />
          );
        })}
      </div>
      {/* Resumen OCR de documentos analizados */}
      {Object.keys(ocrResults).length > 0 && (
        <div className="space-y-3 mb-5">
          {Object.entries(ocrResults).map(([tipo, data]) => {
            const isValid = (data.es_factura_valida || data.es_valido) && !data._rechazado;
            return (
              <div key={tipo} className="rounded-[9px] border p-4" style={isValid ? FLIT_OK : FLIT_ERR}>
                <div className="flex items-center gap-2 mb-2">
                  <svg className={`w-4 h-4 ${isValid ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={isValid ? 'M4.5 12.75l6 6 9-13.5' : 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z'} />
                  </svg>
                  <span className={`text-xs font-bold uppercase ${isValid ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>
                    {tipo} — {isValid ? 'Documento verificado' : data._rechazado ? 'RECHAZADO' : 'Documento no valido'}
                  </span>
                  <span className="text-xs text-[color:var(--color-text-tertiary)] ml-auto">{data.tipo_documento}</span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                  {tipo === 'factura' && (<>
                    {data.numero_factura && <div><span className="text-[color:var(--color-text-tertiary)]">Factura: </span><span className="font-medium">{data.numero_factura}</span></div>}
                    {data.fecha && <div><span className="text-[color:var(--color-text-tertiary)]">Fecha: </span><span className="font-medium">{data.fecha}</span></div>}
                    {data.emisor_nombre && <div><span className="text-[color:var(--color-text-tertiary)]">Emisor: </span><span className="font-medium">{data.emisor_nombre}</span></div>}
                    {data.emisor_nit && <div><span className="text-[color:var(--color-text-tertiary)]">NIT: </span><span className="font-medium">{data.emisor_nit}</span></div>}
                    {data.comprador_nombre && <div><span className="text-[color:var(--color-text-tertiary)]">Comprador: </span><span className="font-medium">{data.comprador_nombre}</span></div>}
                    {data.comprador_documento && <div><span className="text-[color:var(--color-text-tertiary)]">Doc: </span><span className="font-medium">{data.comprador_documento}</span></div>}
                    {data.vehiculo_marca && <div><span className="text-[color:var(--color-text-tertiary)]">Vehiculo: </span><span className="font-medium">{data.vehiculo_marca} {data.vehiculo_linea} {data.vehiculo_modelo}</span></div>}
                    {data.vehiculo_vin && <div><span className="text-[color:var(--color-text-tertiary)]">VIN: </span><span className="font-medium font-mono">{data.vehiculo_vin}</span></div>}
                    {data.vehiculo_color && <div><span className="text-[color:var(--color-text-tertiary)]">Color: </span><span className="font-medium">{data.vehiculo_color}</span></div>}
                    {(data.total ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">Total: </span><span className="font-bold text-[color:var(--color-text-primary)]">${Number(data.total).toLocaleString('es-CO')}</span></div>}
                    {(data.iva ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">IVA: </span><span className="font-medium">${Number(data.iva).toLocaleString('es-CO')}</span></div>}
                    {data.forma_pago && <div><span className="text-[color:var(--color-text-tertiary)]">Pago: </span><span className="font-medium">{data.forma_pago}</span></div>}
                  </>)}
                  {tipo === 'aduana' && (<>
                    {data.numero_documento && <div><span className="text-[color:var(--color-text-tertiary)]">No. Doc: </span><span className="font-medium">{data.numero_documento}</span></div>}
                    {data.fecha && <div><span className="text-[color:var(--color-text-tertiary)]">Fecha: </span><span className="font-medium">{data.fecha}</span></div>}
                    {data.aduana && <div><span className="text-[color:var(--color-text-tertiary)]">Aduana: </span><span className="font-medium">{data.aduana}</span></div>}
                    {data.importador_nombre && <div><span className="text-[color:var(--color-text-tertiary)]">Importador: </span><span className="font-medium">{data.importador_nombre}</span></div>}
                    {data.importador_nit && <div><span className="text-[color:var(--color-text-tertiary)]">NIT: </span><span className="font-medium">{data.importador_nit}</span></div>}
                    {data.pais_origen && <div><span className="text-[color:var(--color-text-tertiary)]">Origen: </span><span className="font-medium">{data.pais_origen}</span></div>}
                    {data.puerto_entrada && <div><span className="text-[color:var(--color-text-tertiary)]">Puerto: </span><span className="font-medium">{data.puerto_entrada}</span></div>}
                    {data.subpartida_arancelaria && <div><span className="text-[color:var(--color-text-tertiary)]">Subpartida: </span><span className="font-medium font-mono">{data.subpartida_arancelaria}</span></div>}
                    {data.vehiculo_marca && <div><span className="text-[color:var(--color-text-tertiary)]">Vehiculo: </span><span className="font-medium">{data.vehiculo_marca} {data.vehiculo_linea} {data.vehiculo_modelo}</span></div>}
                    {data.vehiculo_vin && <div><span className="text-[color:var(--color-text-tertiary)]">VIN: </span><span className="font-medium font-mono">{data.vehiculo_vin}</span></div>}
                    {data.vehiculo_motor && <div><span className="text-[color:var(--color-text-tertiary)]">Motor: </span><span className="font-medium font-mono">{data.vehiculo_motor}</span></div>}
                    {data.vehiculo_color && <div><span className="text-[color:var(--color-text-tertiary)]">Color: </span><span className="font-medium">{data.vehiculo_color}</span></div>}
                    {(data.valor_fob_usd ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">FOB: </span><span className="font-medium">USD ${Number(data.valor_fob_usd).toLocaleString()}</span></div>}
                    {(data.valor_cif_usd ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">CIF: </span><span className="font-medium">USD ${Number(data.valor_cif_usd).toLocaleString()}</span></div>}
                    {(data.valor_cif_cop ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">CIF COP: </span><span className="font-bold">${Number(data.valor_cif_cop).toLocaleString('es-CO')}</span></div>}
                    {(data.arancel_valor ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">Arancel: </span><span className="font-medium">${Number(data.arancel_valor).toLocaleString('es-CO')} ({data.arancel_porcentaje}%)</span></div>}
                    {(data.iva_valor ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">IVA: </span><span className="font-medium">${Number(data.iva_valor).toLocaleString('es-CO')} ({data.iva_porcentaje}%)</span></div>}
                    {(data.total_tributos ?? 0) > 0 && <div><span className="text-[color:var(--color-text-tertiary)]">Total tributos: </span><span className="font-bold text-[color:var(--color-text-primary)]">${Number(data.total_tributos).toLocaleString('es-CO')}</span></div>}
                    {data.regimen && <div><span className="text-[color:var(--color-text-tertiary)]">Regimen: </span><span className="font-medium">{data.regimen}</span></div>}
                  </>)}
                  {tipo === 'impronta' && (<>
                    {data.numero_certificado && <div><span className="text-[color:var(--color-text-tertiary)]">Certificado: </span><span className="font-medium font-mono">{data.numero_certificado}</span></div>}
                    {data.fecha && <div><span className="text-[color:var(--color-text-tertiary)]">Fecha: </span><span className="font-medium">{data.fecha}</span></div>}
                    {data.entidad_emisora && <div><span className="text-[color:var(--color-text-tertiary)]">Entidad: </span><span className="font-medium">{data.entidad_emisora}</span></div>}
                    {data.vehiculo_marca && <div><span className="text-[color:var(--color-text-tertiary)]">Vehiculo: </span><span className="font-medium">{data.vehiculo_marca} {data.vehiculo_linea} {data.vehiculo_modelo}</span></div>}
                    {data.vehiculo_vin && <div><span className="text-[color:var(--color-text-tertiary)]">VIN (impronta): </span><span className="font-medium font-mono">{data.vehiculo_vin}</span>
                      {data.estado_vin && data.estado_vin !== 'no_verificado' && <span className={`ml-1 text-xs font-bold ${data.estado_vin === 'coincide' ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>{data.estado_vin.toUpperCase()}</span>}
                      {data.vehiculo_vin_datos && data.vehiculo_vin !== data.vehiculo_vin_datos && <div className="text-xs text-[color:var(--kit-rojo-texto)] font-mono ml-4">Datos: {data.vehiculo_vin_datos}</div>}
                    </div>}
                    {data.vehiculo_motor && <div><span className="text-[color:var(--color-text-tertiary)]">Motor (impronta): </span><span className="font-medium font-mono">{data.vehiculo_motor}</span>
                      {data.estado_motor && data.estado_motor !== 'no_verificado' && <span className={`ml-1 text-xs font-bold ${data.estado_motor === 'coincide' ? 'text-[color:var(--kit-verde-texto)]' : data.estado_motor === 'no_aplica' ? 'text-[color:var(--color-text-tertiary)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>{data.estado_motor.toUpperCase()}</span>}
                      {data.vehiculo_motor_datos && data.vehiculo_motor !== data.vehiculo_motor_datos && <div className="text-xs text-[color:var(--kit-rojo-texto)] font-mono ml-4">Datos: {data.vehiculo_motor_datos}</div>}
                    </div>}
                    {data.vehiculo_chasis && <div><span className="text-[color:var(--color-text-tertiary)]">Chasis (impronta): </span><span className="font-medium font-mono">{data.vehiculo_chasis}</span>
                      {data.estado_chasis && data.estado_chasis !== 'no_verificado' && <span className={`ml-1 text-xs font-bold ${data.estado_chasis === 'coincide' ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>{data.estado_chasis.toUpperCase()}</span>}
                      {data.vehiculo_chasis_datos && data.vehiculo_chasis !== data.vehiculo_chasis_datos && <div className="text-xs text-[color:var(--kit-rojo-texto)] font-mono ml-4">Datos: {data.vehiculo_chasis_datos}</div>}
                    </div>}
                    {data.vehiculo_serie && data.vehiculo_serie !== data.vehiculo_vin && <div><span className="text-[color:var(--color-text-tertiary)]">Serie: </span><span className="font-medium font-mono">{data.vehiculo_serie}</span></div>}
                    {data.inspector_nombre && <div><span className="text-[color:var(--color-text-tertiary)]">Inspector: </span><span className="font-medium">{data.inspector_nombre}</span></div>}
                    {data.tiene_qr && <div><span className="text-[color:var(--color-text-tertiary)]">QR: </span><span className="font-medium text-[color:var(--kit-verde-texto)]">Presente</span></div>}
                    {data.tiene_hash && <div><span className="text-[color:var(--color-text-tertiary)]">Hash: </span><span className="font-medium font-mono text-xs">{data.hash_valor?.slice(0, 24)}...</span></div>}
                    {data.resolucion_referencia && <div><span className="text-[color:var(--color-text-tertiary)]">Resolucion: </span><span className="font-medium text-xs">{data.resolucion_referencia}</span></div>}
                    {data.alertas && data.alertas.length > 0 && <div className="col-span-full mt-1">{data.alertas.map((a: string, i: number) => <span key={i} className="inline-block px-2 py-0.5 mr-1 mb-1 rounded text-xs font-bold  text-[color:var(--kit-rojo-texto)]">{a}</span>)}</div>}
                  </>)}
                  {tipo === 'soat' && (<>
                    {data.numero_poliza && <div><span className="text-[color:var(--color-text-tertiary)]">Poliza: </span><span className="font-medium">{data.numero_poliza}</span></div>}
                    {data.aseguradora && <div><span className="text-[color:var(--color-text-tertiary)]">Aseguradora: </span><span className="font-medium">{data.aseguradora}</span></div>}
                    {data.fecha_vencimiento && <div><span className="text-[color:var(--color-text-tertiary)]">Vence: </span><span className="font-medium">{data.fecha_vencimiento}</span></div>}
                  </>)}
                </div>
                {data._motivo && <p className="text-xs text-[color:var(--kit-rojo-texto)] mt-2 font-semibold">{data._motivo}</p>}
                {data._paginas_extraidas && <p className="text-xs text-[color:var(--color-action)] mt-2 font-semibold">PDF multi-documento: se extrajeron {data.paginas_documento?.length} de {data._paginas_originales} paginas</p>}
                {data.observaciones && !data._rechazado && <p className="text-xs text-[color:var(--color-text-tertiary)] mt-2 italic">{data.observaciones}</p>}
              </div>
            );
          })}
        </div>
      )}

      {archivos.length > 0 && (
        <div className="border border-[color:var(--color-border)] rounded-[9px] p-3 mb-5">
          <p className="text-xs font-semibold text-[color:var(--color-text-tertiary)] mb-2">{archivos.length} documento(s) cargados</p>
          <div className="space-y-1">
            {archivos.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
                <svg className="w-3.5 h-3.5 text-[color:var(--kit-verde-texto)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                <span className="font-medium text-[color:var(--color-text-secondary)]">{a.tipo}</span> — <span className="truncate">{a.originalName}</span>
                <span className="text-[color:var(--color-text-tertiary)]">{((a.size || 0) / 1024).toFixed(0)} KB</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex justify-between">
        <button type="button" onClick={onAtras} className={`${flitBtnSecondary}`} style={flitBtnSecondaryStyle}>Atrás</button>
        <button onClick={onContinuar} className={`${flitBtnPrimary} text-white`} style={flitBtnPrimaryStyle}>
          Continuar
        </button>
      </div>
    </div>
  );
}
