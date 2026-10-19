import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTransmissionDownloads, transmissionRpc } from '@/lib/transmission';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({ default: { post: mocks.post } }));

const client = { url: 'http://transmission:9091', name: 'Transmission', user: 'admin', pass: 'secret', category: 'comics,manga' };
const success = (args = {}) => ({ status: 200, headers: {}, data: { result: 'success', arguments: args } });

beforeEach(() => {
    mocks.post.mockReset();
    mocks.post.mockResolvedValue(success());
});

describe('Transmission RPC', () => {
    it.each([
        ['http://transmission:9091', 'http://transmission:9091/transmission/rpc'],
        ['http://transmission:9091/', 'http://transmission:9091/transmission/rpc'],
        ['http://transmission:9091/transmission/', 'http://transmission:9091/transmission/rpc'],
        ['http://transmission:9091/transmission/rpc/', 'http://transmission:9091/transmission/rpc'],
        ['https://proxy.example/prefix/custom/rpc?token=abc', 'https://proxy.example/prefix/custom/rpc?token=abc'],
    ])('uses the correct RPC endpoint for %s', async (url, endpoint) => {
        await transmissionRpc({ ...client, url }, 'session-get');
        expect(mocks.post).toHaveBeenCalledWith(endpoint, { method: 'session-get', arguments: {} }, expect.any(Object));
    });

    it('replays the same request after the HTTP 409 session challenge', async () => {
        mocks.post
            .mockResolvedValueOnce({ status: 409, headers: { 'x-transmission-session-id': 'new-session' } })
            .mockResolvedValueOnce(success({ version: '4.0.6' }));

        const result = await transmissionRpc(client, 'session-get', {}, { 'X-Custom': 'value' }, 5000);
        expect(result).toEqual({ version: '4.0.6' });
        expect(mocks.post).toHaveBeenCalledTimes(2);
        const first = mocks.post.mock.calls[0];
        const second = mocks.post.mock.calls[1];
        expect(first[1]).toEqual(second[1]);
        expect(first[2].headers).not.toHaveProperty('X-Transmission-Session-Id');
        expect(second[2]).toMatchObject({
            timeout: 5000,
            headers: {
                'X-Transmission-Session-Id': 'new-session',
                'X-Custom': 'value',
                'Content-Type': 'application/json',
                Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}`,
            },
        });
        const accepts = first[2].validateStatus;
        expect(accepts(409)).toBe(true);
        expect(accepts(200)).toBe(true);
        expect(accepts(401)).toBe(false);
        expect(accepts(500)).toBe(false);
    });

    it('does not invent credentials when RPC authentication is disabled', async () => {
        await transmissionRpc({ url: client.url }, 'session-get');
        expect(mocks.post.mock.calls[0][2].headers).not.toHaveProperty('Authorization');
    });

    it('fails explicitly if the session header is missing', async () => {
        mocks.post.mockResolvedValue({ status: 409, headers: {} });
        await expect(transmissionRpc(client, 'session-get')).rejects.toThrow('session handshake failed');
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });

    it('bounds repeated session challenges instead of looping forever', async () => {
        mocks.post.mockResolvedValue({ status: 409, headers: { 'x-transmission-session-id': 'session' } });
        await expect(transmissionRpc(client, 'session-get')).rejects.toThrow('session handshake failed');
        expect(mocks.post).toHaveBeenCalledTimes(2);
    });

    it('surfaces HTTP-200 RPC errors', async () => {
        mocks.post.mockResolvedValue({ status: 200, data: { result: 'invalid or corrupt torrent file' } });
        await expect(transmissionRpc(client, 'torrent-add')).rejects.toThrow('invalid or corrupt torrent file');
    });

    it('rejects a non-RPC response rather than reporting success', async () => {
        mocks.post.mockResolvedValue({ status: 200, data: '<html>Login</html>' });
        await expect(transmissionRpc(client, 'session-get')).rejects.toThrow('Invalid RPC response');
    });

    it('propagates HTTP/authentication failures without retrying', async () => {
        mocks.post.mockRejectedValue(new Error('Request failed with status code 401'));
        await expect(transmissionRpc(client, 'session-get')).rejects.toThrow('401');
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });
});

describe('Transmission active downloads', () => {
    const torrent = {
        hashString: 'abc123', name: 'Batman #1', labels: ['Comics'], percentDone: 0.42,
        status: 4, totalSize: 2 * 1024 * 1024, error: 0, errorString: '',
    };

    it('filters by any configured label and returns the shared download shape with stable hashes', async () => {
        mocks.post.mockResolvedValue(success({ torrents: [
            torrent,
            { ...torrent, hashString: 'manga-hash', labels: ['unrelated', 'MANGA'], percentDone: 1, status: 6 },
            { ...torrent, labels: ['movies'] },
            { ...torrent, labels: [] },
        ] }));
        const downloads = await getTransmissionDownloads(client, { 'X-Custom': 'value' });
        expect(downloads).toEqual([
            { id: 'abc123', name: 'Batman #1', progress: '42.0', status: 'Downloading', clientName: 'Transmission', size: '2.00 MB' },
            { id: 'manga-hash', name: 'Batman #1', progress: '100.0', status: 'Seeding', clientName: 'Transmission', size: '2.00 MB' },
        ]);
        expect(mocks.post.mock.calls[0][1]).toMatchObject({
            method: 'torrent-get',
            arguments: { fields: expect.arrayContaining(['hashString', 'labels', 'error', 'errorString']) },
        });
    });

    it('defaults to the comics label', async () => {
        mocks.post.mockResolvedValue(success({ torrents: [torrent] }));
        expect(await getTransmissionDownloads({ ...client, category: null }, {})).toHaveLength(1);
    });

    it.each([1, 2])('does not turn recoverable tracker error %i into a destructive failure', async error => {
        mocks.post.mockResolvedValue(success({ torrents: [{ ...torrent, error, errorString: 'Tracker unavailable' }] }));
        expect((await getTransmissionDownloads(client, {}))[0].status).toBe('Downloading');
    });

    it('reports local errors so the existing failed-download handling can act', async () => {
        mocks.post.mockResolvedValue(success({ torrents: [{ ...torrent, error: 3, errorString: 'No data found' }] }));
        expect((await getTransmissionDownloads(client, {}))[0].status).toBe('Error: No data found');
    });

    it('rejects a missing torrent list', async () => {
        await expect(getTransmissionDownloads(client, {})).rejects.toThrow('invalid torrent list');
    });
});
