import { http } from './http';
import type { PreaurWebhookConfig, PreaurWebhookEventTag } from './config_schema';
import { constructMessager } from './logger';

const WebhookMessager = constructMessager('Webhook');

export interface WebhookContext {
    pkgname?: string;
    version?: string;
    pkgver?: string;
    pkgrel?: string;
    epoch?: string;
    maintainer?: string;
    reason?: string;
    error?: string;
    buildTime?: number;
    timestamp?: string;
}

const DEFAULT_TEMPLATES: Record<PreaurWebhookEventTag, string> = {
    SESSION_START: '🚀 PreAUR session started',
    SESSION_END: '✅ PreAUR session completed: {{reason}}',
    SESSION_FAILED: '❌ PreAUR session failed: {{error}}',

    APPROVAL_NEW_PACKAGE: '📦 New package detected: {{pkgname}}',
    APPROVAL_NEW_MAINTAINER: '👤 New maintainer detected: {{maintainer}}',
    APPROVAL_UNAPPROVED: '⚠️ Unapproved entries found, build blocked',
    APPROVAL_PASSED: '✅ Approval check passed',

    PACKAGE_UPDATED: '🔄 Package {{pkgname}} updated to {{version}}',
    PACKAGE_NO_UPDATE: '⏭️ Package {{pkgname}} skipped: {{reason}}',
    PACKAGE_CHECK_FAILED: '⚠️ Update check failed: {{pkgname}} - {{error}}',

    BUILD_START: '🔨 Building {{pkgname}} {{version}}',
    BUILD_SUCCESSFUL: '✅ Build successful: {{pkgname}} {{version}} ({{buildTime}}s)',
    BUILD_FAILED: '❌ Build failed: {{pkgname}} {{version}} - {{error}}',

    PUSH_START: '📤 Pushing {{pkgname}} to AUR',
    PUSH_SUCCESSFUL: '✅ Pushed {{pkgname}} to AUR',
    PUSH_FAILED: '❌ Push failed: {{pkgname}} - {{error}}',
};

export class WebhookNotifier {
    constructor(private readonly webhooks: PreaurWebhookConfig[]) {}

    async notify(tag: PreaurWebhookEventTag, context: WebhookContext = {}): Promise<void> {
        const timestamp = new Date().toISOString();
        const contextWithTimestamp = { ...context, timestamp };

        const promises = this.webhooks
            .filter(webhook => webhook.tags.includes(tag))
            .map(webhook => this.sendWebhook(webhook, tag, contextWithTimestamp));

        await Promise.allSettled(promises);
    }

    private async sendWebhook(
        webhook: PreaurWebhookConfig,
        tag: PreaurWebhookEventTag,
        context: WebhookContext
    ): Promise<void> {
        try {
            const template = webhook.templates?.[tag] ?? DEFAULT_TEMPLATES[tag];
            const message = this.renderTemplate(template, context);
            const url = this.renderTemplate(webhook.url, context);

            const method = webhook.method ?? 'POST';
            const payload = webhook.payload ?? { message };

            // Add _rendered to context for payload rendering
            const contextWithRendered = { ...context, _rendered: message };

            const renderedPayload = typeof payload === 'string'
                ? this.renderTemplate(payload, contextWithRendered)
                : this.renderTemplateObject(payload, contextWithRendered);

            if (method.toUpperCase() === 'GET') {
                await http.get(url, {
                    params: typeof renderedPayload === 'object' ? renderedPayload : undefined,
                    timeout: 10000,
                });
            } else {
                await http.post(url, renderedPayload, {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(webhook.headers ?? {}),
                    },
                    timeout: 10000,
                });
            }

            console.log(WebhookMessager(`Sent ${tag} to ${webhook.id}`));
        } catch (error: any) {
            console.warn(WebhookMessager(`Failed to send ${tag} to ${webhook.id}: ${error.message}`));
        }
    }

    private renderTemplate(template: string, context: WebhookContext): string {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return String(context[key as keyof WebhookContext] ?? match);
        });
    }

    private renderTemplateObject(obj: any, context: WebhookContext): any {
        if (typeof obj === 'string') {
            return this.renderTemplate(obj, context);
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this.renderTemplateObject(item, context));
        }
        if (obj && typeof obj === 'object') {
            return Object.fromEntries(
                Object.entries(obj).map(([key, value]) => [
                    key,
                    this.renderTemplateObject(value, context),
                ])
            );
        }
        return obj;
    }
}

export function createWebhookNotifier(config?: PreaurWebhookConfig[]): WebhookNotifier | undefined {
    if (!config || config.length === 0) {
        return undefined;
    }
    return new WebhookNotifier(config);
}
