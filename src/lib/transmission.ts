import axios from 'axios';

interface TransmissionClient {
    url: string;
    user?: string | null;
    pass?: string | null;
}

interface RpcResponse<T> {
    result: string;
    arguments?: T;
}

function rpcUrl(url: string): string {
    const endpoint = new URL(url);
    const pathname = endpoint.pathname.replace(/\/+$/, '');
    if (!pathname) endpoint.pathname = '/transmission/rpc';
    else if (pathname === '/transmission') endpoint.pathname = '/transmission/rpc';
    else endpoint.pathname = pathname;
    return endpoint.toString();
}

export async function transmissionRpc<T = Record<string, never>>(
    client: TransmissionClient,
    method: string,
    args: Record<string, unknown> = {},
    baseHeaders: Record<string, string> = {},
    timeout = 15000,
): Promise<T | undefined> {
    const headers: Record<string, string> = { ...baseHeaders, 'Content-Type': 'application/json' };
    if (client.user || client.pass) {
        headers.Authorization = `Basic ${Buffer.from(`${client.user || ''}:${client.pass || ''}`).toString('base64')}`;
    }

    // A 409 is Transmission's CSRF challenge, not a failed RPC. Retry only once.
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await axios.post<RpcResponse<T>>(rpcUrl(client.url), { method, arguments: args }, {
            headers: { ...headers },
            timeout,
            validateStatus: status => status === 409 || (status >= 200 && status < 300),
        });
        if (response.status === 409) {
            const sessionId = response.headers['x-transmission-session-id'];
            if (attempt > 0 || typeof sessionId !== 'string' || !sessionId) {
                throw new Error('Transmission session handshake failed. Check that your proxy forwards X-Transmission-Session-Id.');
            }
            headers['X-Transmission-Session-Id'] = sessionId;
            continue;
        }
        if (response.data?.result !== 'success') {
            throw new Error(`Transmission ${method} failed: ${response.data?.result || 'Invalid RPC response'}`);
        }
        return response.data.arguments;
    }
    throw new Error('Transmission session handshake failed.');
}

interface TransmissionTorrent {
    hashString: string;
    name: string;
    percentDone: number;
    status: number;
    totalSize: number;
    labels: string[];
    error: number;
    errorString: string;
}

export async function getTransmissionDownloads(
    client: TransmissionClient & { name: string; category?: string | null },
    headers: Record<string, string>,
) {
    const result = await transmissionRpc<{ torrents: TransmissionTorrent[] }>(client, 'torrent-get', {
        fields: ['hashString', 'name', 'percentDone', 'status', 'totalSize', 'labels', 'error', 'errorString'],
    }, headers);
    if (!Array.isArray(result?.torrents)) throw new Error('Transmission returned an invalid torrent list.');

    const categories = (client.category || 'comics').split(',').map(category => category.trim().toLowerCase()).filter(Boolean);
    const statuses: Record<number, string> = {
        0: 'Paused', 1: 'Queued for verification', 2: 'Checking',
        3: 'Queued', 4: 'Downloading', 5: 'Queued for seeding', 6: 'Seeding',
    };
    return result.torrents
        .filter(torrent => torrent.labels?.some(label => categories.includes(label.toLowerCase())))
        .map(torrent => ({
            id: torrent.hashString,
            name: torrent.name,
            progress: (torrent.percentDone * 100).toFixed(1),
            // Tracker warnings/errors (1/2) are recoverable; only local errors (3) fail the job.
            status: torrent.error === 3 ? `Error: ${torrent.errorString || 'Local data error'}` : (statuses[torrent.status] || 'Unknown'),
            clientName: client.name,
            size: (torrent.totalSize / 1024 / 1024).toFixed(2) + ' MB',
        }));
}
