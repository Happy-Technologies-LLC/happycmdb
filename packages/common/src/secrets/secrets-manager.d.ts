import { ConfigSchema } from '../config/config.schema';
export interface SecretsProvider {
    getSecret(key: string): Promise<string | null>;
    getSecrets(keys: string[]): Promise<Record<string, string>>;
    setSecret?(key: string, value: string): Promise<void>;
    deleteSecret?(key: string): Promise<void>;
}
export declare class SecretsManager {
    private provider;
    private cache;
    private cacheTtl;
    constructor(config: ConfigSchema['secrets'], provider?: SecretsProvider);
    getSecret(key: string): Promise<string | null>;
    getSecrets(keys: string[]): Promise<Record<string, string>>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;
    clearCache(): void;
    invalidateCache(key: string): void;
    private getFromCache;
    private setInCache;
}
export declare function getSecretsManager(_config: ConfigSchema['secrets'], provider?: SecretsProvider): SecretsManager;
export declare function initializeSecretsManager(_config: ConfigSchema['secrets'], provider?: SecretsProvider): SecretsManager;
//# sourceMappingURL=secrets-manager.d.ts.map