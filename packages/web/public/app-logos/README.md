# MCP template logos

These files identify the external providers in the recommended MCP template picker and installed App surfaces. `sources.json` records each official source page, download URL, archive member where applicable, retrieval date and SHA-256. Do not replace them with a redrawn logo or a third-party icon pack.

All assets retain the provider artwork and colors. Notion is the official homepage's inline sticker SVG; its CSS-dependent ink fill is resolved to black so the SVG renders standalone. No geometry was redrawn. Linear uses its current official site icon, replacing the former manually assembled purple tile. Atlassian's official company mark represents the combined Jira and Confluence template; Work IQ uses the specific Microsoft Learn Work IQ image. Canva uses the icon variant supplied for small integration surfaces. Google products each use their own original Google-hosted product image.

Files are served by the web deployment at `https://app.raft.build/app-logos/`. The catalog requires absolute HTTPS URLs. New files therefore need the web deployment before their production URLs load; the existing initials fallback remains until then. Preview validation serves the exact checked-in assets locally and must not be reported as production availability.

Keep bundled JSON and the unreleased catalog expansion SQL consistent. Existing administrator rows win during migration; do not overwrite their custom logos or retirement state. The already released Notion/Linear migration and their stable SVG paths stay unchanged.
