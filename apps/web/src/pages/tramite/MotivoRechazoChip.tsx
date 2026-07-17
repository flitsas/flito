import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';
import { motivoRechazoLabel } from './rechazoOt';

interface Props {
  codigo: string | null | undefined;
  tone?: ChipTone;
}

export default function MotivoRechazoChip({ codigo, tone = 'warning' }: Props) {
  const label = motivoRechazoLabel(codigo);
  if (!label) return null;
  return <StatusChip tone={tone}>{label}</StatusChip>;
}
