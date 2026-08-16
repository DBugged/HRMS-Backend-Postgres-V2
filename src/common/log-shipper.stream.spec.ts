import { createLogShipperStream } from './log-shipper.stream';

describe('createLogShipperStream', () => {
  it('flushes a batch via POST once batchSize is reached', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(undefined);
    const stream = createLogShipperStream({
      url: 'https://logs.example.com/ingest',
      batchSize: 2,
      fetchImpl,
    });

    stream.write('{"msg":"one"}\n');
    stream.write('{"msg":"two"}\n');

    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://logs.example.com/ingest',
      expect.objectContaining({
        method: 'POST',
        body: '{"msg":"one"}\n{"msg":"two"}',
      }),
    );
  });

  it('flushes a partial batch on stream end', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(undefined);
    const stream = createLogShipperStream({
      url: 'https://logs.example.com/ingest',
      batchSize: 10,
      fetchImpl,
    });

    stream.write('{"msg":"only one"}\n');
    stream.end();

    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://logs.example.com/ingest',
      expect.objectContaining({ body: '{"msg":"only one"}' }),
    );
  });

  it('never throws or blocks writes when the POST rejects', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));
    const stream = createLogShipperStream({
      url: 'https://logs.example.com/ingest',
      batchSize: 1,
      fetchImpl,
    });

    expect(() => stream.write('{"msg":"boom"}\n')).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
