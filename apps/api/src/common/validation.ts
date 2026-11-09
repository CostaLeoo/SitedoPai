import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Revise os campos indicados.',
      fields: r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const uuid = z.string().uuid();
