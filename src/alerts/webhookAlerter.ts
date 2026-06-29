import type { LoggerLike } from "../bot";

export interface WebhookAlerterConfig {
  readonly webhookUrl?: string;
  readonly logger: LoggerLike;
  readonly fetchImpl?: typeof fetch;
  readonly minIntervalMs?: number;
}

export class WebhookAlerter {
  private readonly webhookUrl: string | undefined;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly lastSent = new Map<string, number>();

  public constructor(config: WebhookAlerterConfig) {
    this.webhookUrl = config.webhookUrl;
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.minIntervalMs = config.minIntervalMs ?? 60_000;
  }

  public async notify(event: string, payload: Record<string, unknown>): Promise<void> {
    if (this.webhookUrl === undefined || this.webhookUrl.trim() === "") {
      return;
    }
    const now = Date.now();
    const last = this.lastSent.get(event) ?? 0;
    if (now - last < this.minIntervalMs) {
      return;
    }
    this.lastSent.set(event, now);
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, ...payload, ts: new Date().toISOString() }),
      });
      if (!response.ok) {
        this.logger.warn("webhook_alert_failed", { event, status: response.status });
      }
    } catch (error) {
      this.logger.warn("webhook_alert_error", { event, error: String(error) });
    }
  }
}
