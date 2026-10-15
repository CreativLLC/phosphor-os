# Security

Phosphor-OS lets an agent run commands and edit files on your PC. Treat access to the app like a shell on that PC.

## How it is exposed

- The server listens on `127.0.0.1` only (`server/config.ts`). It is not reachable from your network.
- The phone connects through **`tailscale serve`**, which publishes the app on HTTPS to the devices of your own
  tailnet only.
- **Never use `tailscale funnel`.** Funnel makes the app reachable from the public internet. Never bind the server to
  `0.0.0.0`, and never forward the port on your router.
- Check what is served: `tailscale serve status`. Turn it off: `tailscale serve reset`.

## Password and secrets

- The login password is `PHOSPHOR_PASSWORD` in `.env` in the project folder. The server makes one on first start.
  Change it in SETTINGS > SECURITY (it logs out every other device) or by editing `.env`.
- `.env` and `data/` hold your password, login key, chat list and calendar address. Both are in `.gitignore`. Do not
  commit, paste or screenshot them. Keep `.env` readable only by you: `chmod 600 .env`.
- The server removes the password from the environment before it starts agents, so agents and the commands they run
  do not inherit it.
- A calendar secret address (`PHOSPHOR_CALENDAR_ICS`) is a password for your calendar. If it leaks, reset it in Google
  Calendar and paste the new one.
- A local model (optional) listens on `127.0.0.1` with a random key, kept in `.env` and `~/.config/phosphor-os`.

## Reporting a problem

Please report security problems privately (the repository's Security tab, "Report a vulnerability", if it is on;
otherwise contact the owner) and not in a public issue. Include what you did and what you saw. Do not include your `.env`.
