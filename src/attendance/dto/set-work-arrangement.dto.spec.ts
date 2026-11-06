import { BadRequestException } from '@nestjs/common';
import { createValidationPipe } from '../../common/validation-pipe';
import { SetWorkArrangementDto } from './set-work-arrangement.dto';

// Runs through the pipe the running app uses (main.ts), which words the errors and shows one per field. The e2e specs
// build their own plain ValidationPipe, so they cannot check this.
describe('SetWorkArrangementDto reason', () => {
  const pipe = createValidationPipe();
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(
      { workArrangement: 'WFH', ...body },
      { type: 'body', metatype: SetWorkArrangementDto },
    ) as Promise<SetWorkArrangementDto>;
  const messageFor = async (body: Record<string, unknown>) => {
    try {
      await validate(body);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      return (err as BadRequestException).getResponse() as {
        message: string[];
      };
    }
    throw new Error('Expected the body to be refused.');
  };

  it('is optional: a body without it is accepted unchanged', async () => {
    const dto = await validate({ date: '2026-11-04', endDate: '2026-11-06' });
    expect(dto.reason).toBeUndefined();
    expect(dto.endDate).toBe('2026-11-06');
  });

  it('is an accepted field, and is trimmed', async () => {
    const dto = await validate({ reason: '  Home repair visit  ' });
    expect(dto.reason).toBe('Home repair visit');
  });

  it.each([[''], ['    '], ['\n\t ']])(
    'blank text %j counts as no reason',
    async (reason) => {
      expect((await validate({ reason })).reason).toBeNull();
    },
  );

  it('accepts null', async () => {
    expect((await validate({ reason: null })).reason).toBeNull();
  });

  it('counts the length after trimming', async () => {
    const fits = 'x'.repeat(500);
    expect((await validate({ reason: `  ${fits}  ` })).reason).toBe(fits);
  });

  it('refuses more than 500 characters with one clear message', async () => {
    const res = await messageFor({ reason: 'x'.repeat(501) });
    expect(res.message).toEqual(['Reason must be at most 500 characters.']);
  });

  it('tells a value that is not text exactly that', async () => {
    const res = await messageFor({ reason: 42 });
    expect(res.message).toEqual(['Reason must be text.']);
  });

  it('still refuses fields it does not know', async () => {
    const res = await messageFor({ note: 'x' });
    expect(res.message).toEqual(['"note" is not an accepted field.']);
  });
});
