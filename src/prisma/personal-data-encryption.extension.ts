import { Prisma } from '@prisma/client';
import {
  decryptPersonalData,
  encryptPersonalData,
} from '../common/personal-data-crypto';

// Transparent field-level encryption of sensitive keys inside User.personalData: every write through the
// injected client encrypts, every result (single row, array, or a nested `user` create/update result)
// is decrypted, so services keep working with plaintext. Legacy plaintext rows pass through on read.
type Obj = Record<string, unknown>;

function encryptData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(encryptData);
  if (!data || typeof data !== 'object') return data;
  const d = data as Obj;
  if (!('personalData' in d)) return d;
  const pd = d.personalData;
  // Prisma wraps some JSON writes as { set: ... }.
  const wrapped =
    pd && typeof pd === 'object' && 'set' in (pd as Obj)
      ? { set: encryptPersonalData((pd as Obj).set) }
      : encryptPersonalData(pd);
  return { ...d, personalData: wrapped };
}

function decryptResult(res: unknown): unknown {
  if (Array.isArray(res)) return res.map(decryptResult);
  if (!res || typeof res !== 'object') return res;
  const r = res as Obj;
  if (!('personalData' in r)) return r;
  return { ...r, personalData: decryptPersonalData(r.personalData) };
}

export function personalDataEncryptionExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'personal-data-encryption',
      query: {
        user: {
          async $allOperations({ operation, args, query }) {
            const a: Obj = args ?? {};
            const next: Obj = { ...a };
            if ('data' in a) next.data = encryptData(a.data);
            if (operation === 'upsert') {
              next.create = encryptData(a.create);
              next.update = encryptData(a.update);
            }
            const result: unknown = await query(next);
            return decryptResult(result);
          },
        },
      },
    }),
  );
}
