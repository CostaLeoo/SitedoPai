import type { PtStatus, TeamFunction } from '@/lib/types';

export const PT_STATUS: Record<PtStatus, string> = {
  DRAFT: 'Rascunho', IN_ANALYSIS: 'Em análise', AWAITING_CORRECTION: 'Aguardando correção', AWAITING_APPROVAL: 'Aguardando aprovação',
  RELEASED: 'Liberada', IN_EXECUTION: 'Em execução', SUSPENDED: 'Suspensa', CLOSED: 'Encerrada', REJECTED: 'Rejeitada',
  CANCELLED: 'Cancelada', EXPIRED: 'Expirada',
};

export const FUNCTION_LABEL: Record<TeamFunction, string> = {
  RESPONSIBLE: 'Responsável pela execução', EXECUTOR: 'Executante', ENTRY_SUPERVISOR: 'Supervisor de entrada',
  ATTENDANT: 'Vigia', RESCUE: 'Equipe de resgate',
};

export const MEANING_LABEL: Record<string, string> = {
  RELEASE: 'Liberação', RESUME: 'Retomada', ACKNOWLEDGE: 'Ciência dos riscos', SUSPEND: 'Suspensão', CLOSE: 'Encerramento',
};

export const fmt = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
