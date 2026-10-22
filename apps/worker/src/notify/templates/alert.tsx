import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import { render, toPlainText } from '@react-email/render';

import type { AlertType } from '@trendr/core';

/** Spec §13.3 — alert email rendered with React Email (HTML + plain text). */

export interface AlertEmailEvent {
  type: AlertType;
  itemName: string;
  itemUrl: string;
  summary: string;
  detail: string;
}

export interface AlertEmailProps {
  events: AlertEmailEvent[];
  dashboardUrl: string;
  preferencesUrl: string;
  unsubscribeUrl: string;
}

const RULE_LABEL: Record<AlertType, string> = {
  velocity_spike: 'Velocity spike',
  rank_entered: 'Rank entry',
  threshold_crossed: 'Threshold crossed',
  new_alias: 'New alias',
};

export function AlertEmail({
  events,
  dashboardUrl,
  preferencesUrl,
  unsubscribeUrl,
}: AlertEmailProps) {
  const single = events.length === 1;
  return (
    <Html>
      <Head />
      <Preview>
        {single
          ? `${events[0]?.itemName ?? 'An item'} · ${events[0]?.summary ?? 'new alert'}`
          : `${events.length} new Trendr alerts`}
      </Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>Trendr</Text>
          <Heading style={heading}>
            {single ? 'A tracked item is moving' : `${events.length} alerts for you`}
          </Heading>
          <Text style={muted}>
            {single
              ? 'One of your alert rules fired after the latest scoring run.'
              : 'Your alert rules fired after the latest scoring run.'}
          </Text>
          <Hr style={hr} />
          {events.map((event, index) => (
            <Section key={`${event.itemUrl}-${index}`} style={eventCard}>
              <Text style={rule}>{RULE_LABEL[event.type]}</Text>
              <Link href={event.itemUrl} style={itemLink}>
                {event.itemName}
              </Link>
              <Text style={summary}>{event.summary}</Text>
              <Text style={detail}>{event.detail}</Text>
            </Section>
          ))}
          <Button
            href={single ? (events[0]?.itemUrl ?? dashboardUrl) : dashboardUrl}
            style={button}
          >
            {single ? 'View item' : 'Open dashboard'}
          </Button>
          <Text style={footer}>
            <Link href={preferencesUrl} style={footerLink}>
              Manage alert preferences
            </Link>
            {' · '}
            <Link href={unsubscribeUrl} style={footerLink}>
              Unsubscribe from alerts
            </Link>
          </Text>
          <Text style={fineprint}>
            You received this email because you created an alert rule on Trendr. Alert emails are
            rate-limited by each rule&apos;s cooldown.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderAlertEmail(props: AlertEmailProps): Promise<{
  html: string;
  text: string;
}> {
  const html = await render(<AlertEmail {...props} />);
  return { html, text: toPlainText(html) };
}

const body: React.CSSProperties = {
  backgroundColor: '#09090b',
  color: '#f4f4f5',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  margin: 0,
  padding: '24px 12px',
};

const container: React.CSSProperties = {
  backgroundColor: '#18181b',
  border: '1px solid #27272a',
  borderRadius: 12,
  margin: '0 auto',
  maxWidth: 560,
  padding: '28px',
};

const brand: React.CSSProperties = {
  color: '#34d399',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: '0.08em',
  margin: '0 0 10px',
  textTransform: 'uppercase',
};

const heading: React.CSSProperties = {
  color: '#fafafa',
  fontSize: 22,
  lineHeight: '28px',
  margin: '0 0 8px',
};

const muted: React.CSSProperties = {
  color: '#a1a1aa',
  fontSize: 14,
  lineHeight: '22px',
  margin: 0,
};

const hr: React.CSSProperties = {
  borderColor: '#27272a',
  margin: '20px 0',
};

const eventCard: React.CSSProperties = {
  backgroundColor: '#111113',
  border: '1px solid #27272a',
  borderRadius: 10,
  marginBottom: 12,
  padding: '14px 16px',
};

const rule: React.CSSProperties = {
  color: '#34d399',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  margin: '0 0 4px',
  textTransform: 'uppercase',
};

const itemLink: React.CSSProperties = {
  color: '#fafafa',
  fontSize: 16,
  fontWeight: 600,
  textDecoration: 'none',
};

const summary: React.CSSProperties = {
  color: '#e4e4e7',
  fontSize: 14,
  lineHeight: '21px',
  margin: '6px 0 0',
};

const detail: React.CSSProperties = {
  color: '#a1a1aa',
  fontSize: 12,
  lineHeight: '18px',
  margin: '4px 0 0',
};

const button: React.CSSProperties = {
  backgroundColor: '#34d399',
  borderRadius: 8,
  color: '#022c22',
  display: 'inline-block',
  fontSize: 14,
  fontWeight: 600,
  marginTop: 12,
  padding: '10px 18px',
  textDecoration: 'none',
};

const footer: React.CSSProperties = {
  color: '#71717a',
  fontSize: 12,
  lineHeight: '18px',
  marginTop: 22,
};

const footerLink: React.CSSProperties = {
  color: '#a1a1aa',
  textDecoration: 'underline',
};

const fineprint: React.CSSProperties = {
  color: '#52525b',
  fontSize: 11,
  lineHeight: '16px',
  marginTop: 10,
};
