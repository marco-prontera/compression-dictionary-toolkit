import type { EdgeManifest } from '../shared/types.js';
export type { EdgeManifest } from '../shared/types.js';
export function createEdgeHandler<Env = unknown>(options: {
    manifest: EdgeManifest;
    loadObject: (key: string, env: Env, context?: unknown) => Promise<Uint8Array | ArrayBuffer | null>;
}): (request: Request, env: Env, context?: unknown) => Promise<Response>;
export function loadCloudflareObject(
    key: string,
    env: {
        BUCKET?: {
            get(
                key: string
            ): Promise<{ httpMetadata?: { contentEncoding?: string }; arrayBuffer(): Promise<ArrayBuffer> } | null>;
        };
        BLOB_ORIGIN?: string;
    }
): Promise<ArrayBuffer | null>;
