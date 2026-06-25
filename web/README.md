# YT Agent — Web

Next.js 14 frontend for the YT Agent pipeline. Pairs with the FastAPI
backend in `../backend/`.

## Launch (development)

From the project root:

```powershell
python launch.py
```

This starts:
- **Backend** — FastAPI on http://localhost:8000 (auto-reloads on Python edits)
- **Frontend** — Next.js dev on http://localhost:3000 (auto-reloads on TSX edits)
- Browser opens to `http://localhost:3000` after ~4s

The first launch runs `npm install` in `web/` (~1-2 min).

## Launch (production)

```powershell
python launch.py --prod
```

Builds a production Next.js bundle then runs `next start`.

## Stack

- Next.js 14 (App Router) + React 18 + TypeScript
- Tailwind CSS — handcrafted dark theme, no shadcn CLI
- `lucide-react` icons
- All API calls go to `/api/*` which Next rewrites to the FastAPI backend
  during dev (`next.config.js`)

## Layout

```
web/
├── app/
│   ├── layout.tsx        ← shell with sidebar
│   ├── globals.css       ← Tailwind + reusable utility classes
│   ├── page.tsx          ← Dashboard (run + live progress + last result)
│   ├── settings/page.tsx ← all knobs (Content/Voice/Video/Upload/Keywords)
│   ├── history/page.tsx  ← runs + embedded video + storyboard view
│   └── keys/page.tsx     ← .env management
├── components/
│   └── Sidebar.tsx       ← collapsible left rail
├── lib/
│   └── api.ts            ← typed fetch wrappers for the FastAPI backend
├── next.config.js
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

## Notes

- The old Streamlit GUI (`gui.py`) is still present but no longer the
  recommended entry point. Use `python launch.py` for the modern UI.
- The Python pipeline itself is untouched — `main.py` and everything
  under `modules/` work exactly as before.
