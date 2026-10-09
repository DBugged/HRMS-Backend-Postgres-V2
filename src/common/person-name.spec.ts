import { isValidPersonName } from './person-name';

describe('isValidPersonName', () => {
  it.each(['Asha Rao', "D'Souza", 'Mary-Ann K. Singh', 'Ñandú Pérez'])(
    'accepts %s',
    (n) => expect(isValidPersonName(n)).toBe(true),
  );
  it.each(['<script>alert(1)</script>', '12345', '', '9Asha', 'A@B'])(
    'rejects %s',
    (n) => expect(isValidPersonName(n)).toBe(false),
  );
});
