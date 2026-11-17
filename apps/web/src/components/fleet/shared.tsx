// Helpers UI compartidos entre paneles del detalle de flota: puente al UI Kit 2026 (Épica #14560).
// Los paneles nuevos usan DataTable/GradientButton/FlitField directamente; esto queda por compatibilidad.
import { Icono } from '../flit/kit/Icono';
import {
  flitInp, FlitField, FlitTh, FlitTable, FlitTr,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

export const inputCls = flitInp;
export const Field = FlitField;
export const Th = FlitTh;
export const TableCard = FlitTable;
export const Tr = FlitTr;

export function CloseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return <Icono nombre="cerrar" className={className} />;
}

export const btnPrimary = flitBtnPrimary;
export const btnPrimaryStyle = flitBtnPrimaryStyle;
export const btnSecondary = flitBtnSecondary;
export const btnSecondaryStyle = flitBtnSecondaryStyle;
