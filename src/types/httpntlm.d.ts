declare module "httpntlm" {
    interface NtlmOptions {
        url: string;
        username: string;
        password: string;
        domain?: string;
        workstation?: string;
        headers?: Record<string, string>;
        rejectUnauthorized?: boolean;
        [key: string]: unknown;
    }
    interface NtlmResponse {
        statusCode: number;
        headers: Record<string, unknown>;
        body: string;
    }
    type Cb = (err: Error | null, res: NtlmResponse) => void;
    const httpntlm: {
        get(opts: NtlmOptions, cb: Cb): void;
        post(opts: NtlmOptions, cb: Cb): void;
    };
    export default httpntlm;
}
