import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/admin/test/route';
import { GET } from '@/app/api/admin/active-downloads/route';
import { loggerLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    post: vi.fn(),
    getServerSession: vi.fn(),
    findClients: vi.fn(),
    findClient: vi.fn(),
    findSetting: vi.fn(),
    findHeaders: vi.fn(),
    findRequests: vi.fn(),
    decrypt: vi.fn(),
}));

vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        downloadClient: { findMany: mocks.findClients, findFirst: mocks.findClient },
        systemSetting: { findUnique: mocks.findSetting },
        customHeader: { findMany: mocks.findHeaders },
        request: { findMany: mocks.findRequests },
    },
}));
vi.mock('@/lib/encryption', () => ({ decryptSecret: mocks.decrypt }));
vi.mock('@/lib/download-clients', () => ({ qbitAuthHeaders: vi.fn() }));
vi.mock('@/lib/mailer', () => ({ Mailer: {} }));
vi.mock('@/lib/annas-test', () => ({ testAnnasArchiveKey: vi.fn() }));
vi.mock('@/lib/metron/client', () => ({ authFromSettings: vi.fn(), metronGet: vi.fn() }));

const client = {
    id: 'transmission-1', type: 'transmission', name: 'Transmission', protocol: 'Torrent',
    url: 'http://transmission:9091', user: 'admin', pass: 'enc:secret', apiKey: null, category: 'comics,manga',
};

beforeEach(() => {
    mocks.post.mockReset();
    mocks.getServerSession.mockResolvedValue({ user: { role: 'ADMIN' } });
    mocks.findClients.mockResolvedValue([client]);
    mocks.findClient.mockResolvedValue(client);
    mocks.findSetting.mockImplementation(async ({ where }: { where: { key: string } }) =>
        where.key === 'setup_complete' ? { value: 'true' } : null);
    mocks.findHeaders.mockResolvedValue([]);
    mocks.findRequests.mockResolvedValue([]);
    mocks.decrypt.mockImplementation(async (value: string | null) => value?.replace(/^enc:/, '') ?? null);
});

function testRequest(config: Record<string, unknown> = {}) {
    return new Request('http://localhost/api/admin/test', {
        method: 'POST',
        body: JSON.stringify({ type: 'clients', config: { clientType: 'transmission', url: client.url, user: client.user, pass: 'secret', ...config } }),
    });
}

describe('Transmission connection test', () => {
    it('uses the shared handshake and accepts Transmission with label support', async () => {
        mocks.post
            .mockResolvedValueOnce({ status: 409, headers: { 'x-transmission-session-id': 'session' } })
            .mockResolvedValueOnce({ status: 200, data: { result: 'success', arguments: { version: '4.0.6', 'rpc-version': 17 } } });
        const result = await (await POST(testRequest())).json();
        expect(result).toEqual({ success: true, message: 'Transmission Connected! (v4.0.6)' });
        expect(mocks.post.mock.calls[1]).toMatchObject([
            'http://transmission:9091/transmission/rpc',
            { method: 'session-get' },
            { timeout: 5000, headers: { 'X-Transmission-Session-Id': 'session' } },
        ]);
    });

    it('decrypts the saved password when the editor sends its masked value', async () => {
        mocks.post.mockResolvedValue({ status: 200, data: { result: 'success', arguments: { version: '3.00', 'rpc-version': 16 } } });
        expect((await (await POST(testRequest({ pass: '********' }))).json()).success).toBe(true);
        expect(mocks.decrypt).toHaveBeenCalledWith('enc:secret');
        expect(mocks.post.mock.calls[0][2].headers.Authorization).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
    });

    it('rejects older Transmission versions without category labels', async () => {
        mocks.post.mockResolvedValue({ status: 200, data: { result: 'success', arguments: { version: '2.94', 'rpc-version': 15 } } });
        const result = await (await POST(testRequest())).json();
        expect(result.success).toBe(false);
        expect(result.message).toContain('Transmission 3.0 or newer');
    });

    it('reports an RPC failure rather than a successful connection', async () => {
        mocks.post.mockResolvedValue({ status: 200, data: { result: 'permission denied' } });
        const result = await (await POST(testRequest())).json();
        expect(result.success).toBe(false);
        expect(result.message).toContain('permission denied');
    });

    it('allows connection testing during first-run setup', async () => {
        mocks.findSetting.mockResolvedValue(null);
        mocks.getServerSession.mockResolvedValue(null);
        mocks.post.mockResolvedValue({ status: 200, data: { result: 'success', arguments: { version: '4.0.6', 'rpc-version': 17 } } });
        expect((await (await POST(testRequest())).json()).success).toBe(true);
    });

    it('requires admin access after setup', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { role: 'USER' } });
        expect((await POST(testRequest())).status).toBe(401);
        expect(mocks.post).not.toHaveBeenCalled();
    });
});

describe('Transmission dashboard downloads', () => {
    const torrent = {
        hashString: 'hash', name: 'Comic', labels: ['comics'], percentDone: 1,
        status: 6, totalSize: 1024, error: 0,
    };
    beforeEach(() => {
        mocks.post.mockResolvedValue({ status: 200, data: { result: 'success', arguments: { torrents: [torrent] } } });
    });

    it('uses the same normalized, category-filtered downloads as the background monitor', async () => {
        const result = await (await GET()).json();
        expect(result).toEqual({
            success: true,
            activeDownloads: [{ id: 'hash', name: 'Comic', progress: '100.0', status: 'Seeding', size: '0.00 MB', clientName: 'Transmission' }],
        });
        expect(mocks.decrypt).toHaveBeenCalledWith('enc:secret');
        expect(mocks.post.mock.calls[0][1].method).toBe('torrent-get');
    });

    it('hides ignored torrents unless a downloading/stalled request links to them', async () => {
        mocks.findSetting.mockResolvedValue({ value: '["hash"]' });
        expect((await (await GET()).json()).activeDownloads).toEqual([]);
        mocks.findRequests.mockResolvedValue([{ downloadLink: 'hash' }]);
        expect((await (await GET()).json()).activeDownloads).toHaveLength(1);
    });

    it('logs a failed poll', async () => {
        mocks.post.mockRejectedValue(new Error('Connection refused'));
        expect((await (await GET()).json()).activeDownloads).toEqual([]);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Connection refused'), 'warn');
    });

    it('keeps the admin access gate', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        expect((await GET()).status).toBe(403);
        expect(mocks.post).not.toHaveBeenCalled();
    });
});
