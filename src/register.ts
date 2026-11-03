export interface RegisterConnectorOptions {
    apiUrl: string;
    connectorId: string;
    secret: string;
    fetcher?: typeof fetch;
}

export class ConnectorRegistrationError extends Error {
    constructor(readonly status: number) {
        super(`Connector registration failed with HTTP ${status}`);
        this.name = 'ConnectorRegistrationError';
    }
}

/** Sends the authenticated liveness signal used by existing Erik connectors. */
export async function registerConnector(input: RegisterConnectorOptions): Promise<void> {
    const response = await (input.fetcher ?? fetch)(`${input.apiUrl.replace(/\/+$/, '')}/api/connector/register`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
            Authorization: `Bearer ${input.secret}`,
            'X-Erik-Connector': input.connectorId,
            Accept: 'application/json',
        },
    });
    if (!response.ok) throw new ConnectorRegistrationError(response.status);
}
