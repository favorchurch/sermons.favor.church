# Sermon Bank — Neon Redesign Prototype (Round 2)

Interactive UI prototype for Sermon Bank (`sermons.favor.church`), combining the new layout and typography (`Plus Jakarta Sans` + `Inter`) with the original Sermon Bank sage/paper/moss green palette and architectural book art. No production code, auth, API, schema, or worker files were modified.

## Round 2 updates (per Rico's feedback)

- **Interchangeable A ↔ C layouts (B dropped)**: **Variant A (Side rail)** is the default, with a visible **Side rail / Top bar** toggle in the rail footer, top bar, and Workspace settings that persists per user in `localStorage` (`sermon-bank.layout`). Direct links via `?variant=A` and `?variant=C` also work.
- **Original Sermon Bank green branding**: Uses exact colours from `public/assets/app.css` on `origin/main` (`#f8f9f5` ground, `#ffffff` surface, `#f1f5ed` subtle panel, `#26392c` ink, `#5a6b5e` muted, `#476b51` accent, `#335a3e` accent strong, `#e9f1e7` accent soft, `#dce5db` rule, `#7a8d7c` control edge, and the original book-cover palettes).
- **Book art retained tastefully**: Original shelf-and-ribbon mark, compact architectural bookshelf illustration in the Library header and Sign-in band, deterministic mini book covers on Sermon Detail, and calm open-book art in empty states (SVG art only, zero emoji).
- **New typography preserved**: `Plus Jakarta Sans` display headings + `Inter` UI/body with `tabular-nums` and a strict `13px` text floor (`11px` only for mobile tab labels and compact badges).

## How to preview locally

```bash
python3 -m http.server 4179 --bind 127.0.0.1 --directory docs/prototypes/neon-redesign
```

Open:

- **Default (Variant A — Side rail)**: `http://127.0.0.1:4179/#/library`
- **Variant C — Top bar**: `http://127.0.0.1:4179/?variant=C#/library`
- **Screens**: `#/signin`, `#/library`, `#/calendar?y=2026&m=11&d=2026-11-08`, `#/sermon/sermon-grace`, `#/sermon/sermon-grace?tab=notes&q=grace`, `#/search?q=John%203%3A16&scope=everything`, `#/onboarding`, `?state=loading|empty|error#/library`

## Evidence

- Updated After screenshots (desktop `1280×860` and mobile `390×844`) plus Variant C shots: `/Users/rico/Git/rico-mode/state/evidence/sermons-neon-redesign/`
- Side-by-side **Before vs. After** comparisons for all 6 main screens (Sign-in, Library, Preaching Calendar, Sermon Detail, Search, Workspace Switcher — desktop and mobile): `/Users/rico/Git/rico-mode/state/evidence/sermons-neon-redesign/side-by-side/`
