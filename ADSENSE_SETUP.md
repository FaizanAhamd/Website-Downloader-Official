# Google AdSense — Setup & Verification Guide

This project includes the plumbing for Google AdSense, but **ads are disabled by default**
and **must not be enabled before the site is verified with Google**.

## Current configuration

- Publisher ID configured: `pub-3385240797900631`
- Env flag: `ADSENSE_ENABLED=false` (default)
- Env var: `ADSENSE_PUBLISHER_ID=pub-3385240797900631`

## Important safety rules

1. **Verify the publisher ID.** Confirm `pub-3385240797900631` is the actual publisher ID on
   your Google AdSense account before production. The ID in `.env.example` / config is a
   starting value and is flagged for verification — do not assume it is live.
2. **Do not fabricate a site-verification code.** Google provides a specific verification
   code (e.g. a `google-site-verification` meta tag or a DNS record) after you submit the
   site. This repo does not include any verification code — you must obtain it from Google.
3. **Do not invent an AdSense account status.** Enable ads only after the site is approved
   and you have real ad units.
4. **Ads are kept off the downloader controls.** The ad unit partial (`views/partials/ad-unit.hbs`)
   is only used on content pages (About, Guides, Features, Contact, Privacy, Terms). It is
   never placed next to the downloader input, buttons, progress, cancel controls, errors or
   the ZIP download control.

## How ads are gated

- The AdSense loader script is injected in `<head>` only when `config.adsense.scriptEnabled`
  is true (i.e. `ADSENSE_ENABLED=true` **and** a publisher ID is set).
- The `<ins>` ad units render only when `ADSENSE_ENABLED=true` and a publisher ID is set.
- `ads.txt` returns a placeholder comment until ads are enabled with a verified publisher ID.

## Steps to enable (after Google verification)

1. Complete AdSense site submission and verify ownership with Google (use the code/record
   Google gives you — do not invent one).
2. Wait for Google to approve the site and create ad units.
3. Create ad units in AdSense and note their slot IDs.
4. Update the ad slots in each page that includes `{{> ad-unit adSlot="…"}}` (the numbers
   are placeholders), or configure them as you prefer.
5. Set `ADSENSE_ENABLED=true` in production environment variables.
6. Confirm `ADSENSE_PUBLISHER_ID` matches the verified ID.
7. Deploy and re-run the ad unit's verification in AdSense.

## Privacy / policy disclosures

The Privacy Policy page already includes advertising disclosures (Google Ads Settings link,
partner-sites policy, cookie policy, personalised-advertising opt-out). Review the draft
privacy/terms pages with a legal professional before production.

## File locations

- `config.js` — `adsense` configuration object.
- `.env.example` — `ADSENSE_ENABLED`, `ADSENSE_PUBLISHER_ID`.
- `views/partials/ad-unit.hbs` — reusable responsive ad unit.
- `views/layout.hbs` — conditional head script injection.
- `public/ads.txt` — static ads.txt placeholder.

## Readiness status

| Item | Status |
|---|---|
| Original content (home, about, contact, features, how-it-works, FAQ, 4 guides) | **Ready** — original, useful, detailed; no lorem ipsum. |
| Pages accessible without login | **Ready** — all public, no auth. |
| Navigation / footer | **Ready** — full internal linking, no dead links (route-tested). |
| Privacy / Terms disclosures | **Ready (review as draft)** — advertising, cookie, personalised-advertising, opt-out disclosures present. Legal review recommended before production. |
| Contact info | **Ready** — `faizanraki42@gmail.com`, Faizan Ahmad, GitHub link. |
| Ads gating | **Ready** — disabled by default (`ADSENSE_ENABLED=false`); loader + ad units render only when enabled AND a publisher ID is set. |
| Publisher ID `pub-3385240797900631` | **Unverified** — must be confirmed inside your AdSense account. Never enabled until confirmed. |
| Ad-unit slot IDs (`1234567890`…) | **Placeholders** — never rendered while ads are disabled; replace with real ad-unit slots before enabling. |
| `ads.txt` | **Placeholder** — contains only an explanatory comment until the publisher ID is verified; then add the real seller line. |
| Google site verification | **Not started** — no code/record invented. You must add the verification method Google provides. |
| Consent management (e.g. EEA cookie consent) | **Not implemented** — add a consent banner/tool before serving ads to affected regions. |
| AdSense approval status | **Not claimed** — not applied/approved. |

### Readiness summary
- **Policy + content ready for review.** The site is eligible to be submitted once the
  domain is live and complete.
- **Code is intentionally non-advertising until verified** — no fake publisher ID or
  placeholder ad is ever served.
