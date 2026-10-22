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

/** Spec §13.3 — weekly digest rendered with React Email (HTML + text). */

export interface DigestEmailItem {
  name: string;
  url: string;
  detail: string;
}

export interface DigestEmailSection {
  title: string;
  items: DigestEmailItem[];
}

export interface DigestEmailProps {
  weekLabel: string;
  sections: DigestEmailSection[];
  watchlist: DigestEmailItem[];
  dashboardUrl: string;
  preferencesUrl: string;
  unsubscribeUrl: string;
}

export function DigestEmail({
  weekLabel,
  sections,
  watchlist,
  dashboardUrl,
  preferencesUrl,
  unsubscribeUrl,
}: DigestEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Trendr weekly digest · {weekLabel}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>Trendr</Text>
          <Heading style={heading}>The fastest-growing projects this week</Heading>
          <Text style={muted}>{weekLabel} · growth velocity, not raw size.</Text>
          <Hr style={hr} />

          {sections.map((section) => (
            <Section key={section.title} style={sectionStyle}>
              <Heading as="h2" style={sectionHeading}>
                {section.title}
              </Heading>
              {section.items.map((item) => (
                <Text key={`${section.title}-${item.url}`} style={row}>
                  <Link href={item.url} style={itemLink}>
                    {item.name}
                  </Link>
                  <br />
                  <span style={itemDetail}>{item.detail}</span>
                </Text>
              ))}
            </Section>
          ))}

          {watchlist.length > 0 ? (
            <Section style={sectionStyle}>
              <Heading as="h2" style={sectionHeading}>
                Your watchlist this week
              </Heading>
              {watchlist.map((item) => (
                <Text key={`watchlist-${item.url}`} style={row}>
                  <Link href={item.url} style={itemLink}>
                    {item.name}
                  </Link>
                  <br />
                  <span style={itemDetail}>{item.detail}</span>
                </Text>
              ))}
            </Section>
          ) : null}

          <Button href={dashboardUrl} style={button}>
            Open Trendr
          </Button>
          <Text style={footer}>
            <Link href={preferencesUrl} style={footerLink}>
              Manage digest preferences
            </Link>
            {' · '}
            <Link href={unsubscribeUrl} style={footerLink}>
              Unsubscribe
            </Link>
          </Text>
          <Text style={fineprint}>
            You received this email because you subscribed to the Trendr weekly digest. One click on
            the unsubscribe link is enough.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderDigestEmail(props: DigestEmailProps): Promise<{
  html: string;
  text: string;
}> {
  const html = await render(<DigestEmail {...props} />);
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
  fontSize: 23,
  lineHeight: '30px',
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

const sectionStyle: React.CSSProperties = {
  marginBottom: 20,
};

const sectionHeading: React.CSSProperties = {
  color: '#fafafa',
  fontSize: 16,
  lineHeight: '22px',
  margin: '0 0 8px',
};

const row: React.CSSProperties = {
  borderTop: '1px solid #27272a',
  margin: 0,
  padding: '8px 0',
  fontSize: 14,
  lineHeight: '21px',
};

const itemLink: React.CSSProperties = {
  color: '#f4f4f5',
  fontWeight: 600,
  textDecoration: 'none',
};

const itemDetail: React.CSSProperties = {
  color: '#a1a1aa',
  fontSize: 12,
};

const button: React.CSSProperties = {
  backgroundColor: '#34d399',
  borderRadius: 8,
  color: '#022c22',
  display: 'inline-block',
  fontSize: 14,
  fontWeight: 600,
  marginTop: 8,
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
