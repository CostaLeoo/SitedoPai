import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Converte erros em respostas sem detalhes internos. Violações de unicidade e
 * de chave estrangeira viram 409/400; o resto vira 500 com registro no log.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      res.status(err.getStatus()).json(typeof body === 'string' ? { message: body } : body);
      return;
    }
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      res.status(409).json({ code: 'CONFLICT', message: 'Já existe um registro com esses dados.' });
      return;
    }
    if (code === '23503') {
      res.status(400).json({ code: 'INVALID_REFERENCE', message: 'Um dos registros indicados não existe.' });
      return;
    }
    if (code === '23514' || code === '22P02') {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Revise os dados enviados.' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Operação não permitida.' });
      return;
    }
    this.log.error((err as Error)?.message ?? String(err));
    res.status(500).json({ code: 'INTERNAL', message: 'Não foi possível concluir. Tente novamente.' });
  }
}
