// Íconos del módulo PESV compartidos por PesvDiagnostico y PesvDiagnosticoAuditoria (y vecinas).
// UI Kit 2026: sirven glifos del kit (`<Icono>`, currentColor). Mismos exports y firmas que antes.
import { Icono } from '../flit/kit/Icono';

type Props = { className?: string };

export const ArrowRightIcon = ({ className = 'w-3.5 h-3.5' }: Props) => <Icono nombre="derecha" className={className} />;
export const LockIcon = ({ className = 'w-4 h-4' }: Props) => <Icono nombre="candado" className={className} />;
export const ClipboardCheckIcon = ({ className = 'w-7 h-7' }: Props) => <Icono nombre="portapapeles" className={className} />;
export const SearchIcon = ({ className = 'w-4 h-4' }: Props) => <Icono nombre="buscar" className={className} />;
export const DownloadIcon = ({ className = 'w-4 h-4' }: Props) => <Icono nombre="nube-bajar" className={className} />;
export const PrinterIcon = ({ className = 'w-4 h-4' }: Props) => <Icono nombre="reporte-detallado" className={className} />;
export const ExternalLinkIcon = ({ className = 'w-4 h-4' }: Props) => <Icono nombre="externo" className={className} />;
export const CloseXIcon = ({ className = 'w-5 h-5' }: Props) => <Icono nombre="cerrar" className={className} />;
