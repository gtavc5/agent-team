export interface PiQuotaContext {
  modelRegistry: {
    getProvider(id: string): unknown;
    getAll(): { provider: string }[];
    isUsingOAuth(model: { provider: string }): boolean;
    getProviderAuthStatus(id: string): { configured: boolean; source?: string };
    getProviderAuth(
      id: string,
    ): Promise<
      { source?: string; auth: { apiKey?: string; headers?: Record<string, unknown> } } | undefined
    >;
  };
  events: { emit(name: string, data: unknown): void };
}
