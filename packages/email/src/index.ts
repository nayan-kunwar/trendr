import { createTransport, type Transporter } from 'nodemailer';
import { Resend } from 'resend';

/**
 * Spec §13.3 — provider-neutral email boundary. The API needs the same
 * transport for magic links that the worker needs for alerts and digests, so
 * the interface and its implementations live in this small shared package.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  /** Provider idempotency hint when the provider supports one. */
  idempotencyKey?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string }>;
}

export interface EmailSenderOptions {
  provider: 'smtp' | 'resend' | 'log';
  from: string;
  smtpUrl?: string;
  resendApiKey?: string;
}

/** Dev/production SMTP sender (Mailpit locally, any SMTP relay in production). */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    private readonly from: string,
    smtpUrl: string,
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const info = (await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    })) as { messageId?: string };
    return { id: info.messageId ?? `smtp-${Date.now()}` };
  }
}

/** Production Resend sender (spec §13.3). */
export class ResendEmailSender implements EmailSender {
  private readonly client: Resend;

  constructor(
    private readonly from: string,
    apiKey: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const result = await this.client.emails.send({
      from: this.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.headers === undefined ? {} : { headers: message.headers }),
    });
    if (result.error !== null) {
      throw new Error(`Resend rejected the message: ${result.error.message}`);
    }
    return { id: result.data.id };
  }
}

/** Test/dev fallback that keeps the send path observable without a provider. */
export class LogEmailSender implements EmailSender {
  send(message: EmailMessage): Promise<{ id: string }> {
    const id = `log-${Date.now()}`;
    console.info(`[email:log] ${message.to} — ${message.subject} (${id})`);
    return Promise.resolve({ id });
  }
}

export function createEmailSender(options: EmailSenderOptions): EmailSender {
  switch (options.provider) {
    case 'resend': {
      if (options.resendApiKey === undefined || options.resendApiKey.length === 0) {
        throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
      }
      return new ResendEmailSender(options.from, options.resendApiKey);
    }
    case 'log':
      return new LogEmailSender();
    case 'smtp':
    default:
      return new SmtpEmailSender(options.from, options.smtpUrl ?? 'smtp://mailpit:1025');
  }
}
