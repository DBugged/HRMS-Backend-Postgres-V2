import { Logger } from '@nestjs/common';
import { sendLetterQuietly } from './auto-letter';

const logger = { warn: jest.fn() } as unknown as Logger;
const actor = { id: 'hr1' } as never;

describe('sendLetterQuietly', () => {
  it('sends the letter and reports it', async () => {
    const send = jest.fn().mockResolvedValue({ message: 'ok' });
    expect(await sendLetterQuietly({ send } as never, logger, 'e1', 'confirmationLetter', actor, 'org')).toBe(true);
    expect(send).toHaveBeenCalledWith('e1', 'confirmationLetter', actor, 'org');
  });

  it('never throws: a missing template is logged and reported as not sent', async () => {
    const send = jest.fn().mockRejectedValue(new Error('No active letter template found'));
    expect(await sendLetterQuietly({ send } as never, logger, 'e1', 'resignationAcceptance', actor, 'org')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});
