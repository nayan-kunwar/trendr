# TLS certificates

Place the Cloudflare Origin Certificate here before starting the production
stack:

```text
infra/nginx/certs/origin.pem
infra/nginx/certs/origin-key.pem
```

Create the certificate in the Cloudflare dashboard under **SSL/TLS → Origin
Server → Create Certificate** for the production hostname (or wildcard), then
copy the PEM and private key with these exact names. Keep the private key at
mode `600` and owned by the deploy user.

The files are ignored by git; only this README and `.gitkeep` are committed.
`docker-compose.prod.yml` mounts this directory read-only at
`/etc/nginx/certs`, and nginx refuses to start if either file is missing.

For local validation without a Cloudflare certificate, generate a throwaway
self-signed pair:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=localhost' \
  -keyout infra/nginx/certs/origin-key.pem \
  -out infra/nginx/certs/origin.pem
```

Do not use self-signed certificates in production: Cloudflare's **Full
(strict)** mode rejects them.
