import { S3Client } from '@aws-sdk/client-s3';

// One shared client for the process — the SDK pools connections
// internally, no reason to construct a new one per request. Picks up
// credentials the standard AWS SDK way (env vars / instance role /
// shared credentials file); nothing custom here on purpose, since a
// custom credential path is exactly the kind of thing that quietly
// works in dev and breaks in prod.
let client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({ region: requireEnv('AWS_REGION') });
  }
  return client;
}

export function getS3Bucket(): string {
  return requireEnv('AWS_S3_BUCKET');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set when FILE_STORAGE_DRIVER=s3 (see .env.example).`,
    );
  }
  return value;
}
