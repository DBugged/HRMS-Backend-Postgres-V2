import { fileStorageDriver } from './file-storage.config';

describe('fileStorageDriver', () => {
  const original = process.env.FILE_STORAGE_DRIVER;

  afterEach(() => {
    if (original === undefined) delete process.env.FILE_STORAGE_DRIVER;
    else process.env.FILE_STORAGE_DRIVER = original;
  });

  it('defaults to local when unset', () => {
    delete process.env.FILE_STORAGE_DRIVER;
    expect(fileStorageDriver()).toBe('local');
  });

  it('defaults to local for any value other than exactly "s3"', () => {
    process.env.FILE_STORAGE_DRIVER = 'S3'; // wrong case, not accepted
    expect(fileStorageDriver()).toBe('local');
    process.env.FILE_STORAGE_DRIVER = 'r2';
    expect(fileStorageDriver()).toBe('local');
  });

  it('switches to s3 only when explicitly set', () => {
    process.env.FILE_STORAGE_DRIVER = 's3';
    expect(fileStorageDriver()).toBe('s3');
  });
});
