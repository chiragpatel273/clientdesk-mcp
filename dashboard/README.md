# ClientDesk dashboard

The staff dashboard for ClientDesk: overview, audit log, review queue, inbox and the accuracy report. A React + Vite
single-page app that reads the server's JSON API (`/api/*`). The ClientDesk server serves the built files at
`/dashboard`, on the same origin as the API, so sign-in, roles and access rules stay in the server.

All data shown is the fictional Northbridge Advisory demo firm.

## Run it

```bash
# 1. Start the ClientDesk server on :3000 (repo root)
npm run dev

# 2. In another terminal
cd dashboard
npm install
npm run dev        # http://localhost:5173/dashboard/
```

The Vite dev server proxies `/api`, `/auth` and `/files` to `http://localhost:3000` (set `CLIENTDESK_API` to point
elsewhere), so cookies and headers behave as they do in production.

## Build

```bash
npm run build      # type-checks, then writes dashboard/dist
npm run typecheck
npm run lint
```

The server serves `dashboard/dist` at `/dashboard`. The app uses browser routing under `/dashboard`, so the server
must answer unknown paths under `/dashboard/*` with `dist/index.html` (an SPA fallback). Otherwise reloading
`/dashboard/audit` returns a 404.

## Sign-in

`GET /api/me` reports the auth mode.

- **dev**: the header bar shows a user switcher (from `GET /api/staff`). The chosen email is sent as
  `x-clientdesk-user` on every request and remembered in `localStorage`. The default is `maya@northbridge.example`.
- **oauth**: the server's session cookie is used. When `/api/me` answers 401 the app shows a sign-in screen that goes
  to `/auth/login?returnTo=/dashboard/`. Sign out posts to `/auth/logout`.

Every POST sends `x-clientdesk-csrf: 1`. Requests use `credentials: 'same-origin'`.

## Layout

- `src/api.ts`: API types (the contract) and the typed fetch client
- `src/pages/`: one file per page
- `src/components/ui/`: shadcn-style primitives (written by hand: cva, tailwind-merge, lucide-react)
- `src/index.css`: Tailwind v4 and the design tokens (light and dark)
