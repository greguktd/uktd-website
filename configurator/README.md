# Wrapsthetic Configurator

A self-contained, static web app for Wrapsthetic customers. An amputee measures their prosthetic,
uploads artwork, previews it on the wrap and sends Wrapsthetic everything needed to produce a
custom wrap for the socket and pylon.

It is designed to sit behind a link on the Wrapsthetic website. It has its own branding, links
back to the main site, and carries a `noindex` tag so search engines send people to the main site
rather than straight into the form. There is no build step and no dependencies.

**Spelling note.** Public coverage of the company (Motability Foundation) spells the name
*Wrapsthetic* (wrap + aesthetic), so that spelling is used here. It is a single `brandName` value
in `configurator.js` if it needs to change.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The configurator (five-step form), followed by "how it works" and the measuring guide |
| `configurator.css` | Styling (light and dark themes, large touch targets, print layout for the order sheet) |
| `configurator.js` | Wizard logic, measurements, unit conversion, template geometry, previews, order pack, submission |

## Linking from the Wrapsthetic website

Host this folder anywhere static files can be served and link to its `index.html`, for example
`https://configurator.wrapsthetic.com/` or `https://wrapsthetic.com/configurator/`. Nothing in
the folder depends on the UKTD site. On this repository it is reachable at `/configurator/`
once deployed, which only happens on a push to `main` through the existing Azure Static Web Apps
workflow. Opening a pull request against `main` also creates a preview deployment, so avoid that
until the configurator is meant to be live.

## Before launch: configuration

Edit the `CONFIG` block at the top of `configurator.js`:

| Key | What it does |
| --- | --- |
| `brandName` | Company name shown in the header, footer, page title, buttons and order files |
| `websiteUrl` | Where the logo, "Back to Wrapsthetic" and footer links go. Placeholder, confirm before launch |
| `contactEmail` | Address customers are asked to email the order pack to if the server is unreachable. Placeholder, confirm before launch |
| `submitUrl` | Endpoint that receives orders (see below). Defaults to `/api/wrap-orders` |
| `seamAllowanceCm` | Extra width added to every template for the overlap seam |
| `previewMaxPx` | Long-side size the preview image is downscaled to. The original file is sent untouched |

## How the customer flow works

1. **About you**: name, email (both required), phone, address, notes.
2. **Your prosthetic**: type (below/above knee, below/above elbow, other), side, whether to wrap the
   socket and/or pylon, socket surface.
3. **Measurements**: socket length from brim to bottom, then the app generates measuring points
   every 2.5, 5 or 10 cm (1, 2 or 4 inches) and asks for the full circumference at each. Pylon
   length and circumference if the pylon is being wrapped. Free text for valves, buttons and
   straps to leave clear. Customers can work in centimetres or inches; everything is stored in cm.
   Values that jump more than 35% between neighbouring points are flagged for a second look.
4. **Artwork**: image upload (PNG, JPEG, WebP, SVG), finish, fill mode (fill, fit, tile), size,
   offset, rotation and background colour, with a live preview on the flat template and a rough
   front view on the limb.
5. **Review and send**: summary with edit links, download the order pack, print, and submit.

Progress is saved to `localStorage` on the device until the order is sent. Artwork files are
not persisted, so a returning customer is asked to choose the file again.

## What Wrapsthetic receives

### Submission

`POST` to `submitUrl` as `multipart/form-data` with these parts:

| Part | Content |
| --- | --- |
| `order` | JSON string (schema below) |
| `template` | `template.svg`, the flat wrap outline at true scale with the artwork placed as the customer chose |
| `artwork` | The customer's original image file, unmodified (omitted if none was uploaded) |
| `pack` | `order-pack.zip` containing all of the above plus `order-sheet.html` |

A `2xx` response marks the order as sent. If the response JSON contains `reference` or `id` it
is shown to the customer. Any failure falls back to a message asking them to download the pack
and email it to `contactEmail`, and nothing they entered is lost.

There is no backend in this repository yet. Options, in order of effort:

- **Azure Static Web Apps managed function**: add an `api/` folder with a function on the
  `wrap-orders` route that stores the parts in Blob Storage and emails Wrapsthetic. Set
  `api_location: "api"` in `.github/workflows/azure-static-web-apps-*.yml`.
- **Form service**: point `submitUrl` at any service that accepts multipart uploads.
- **No backend**: leave the endpoint unreachable. Customers always get the fallback and can email
  the pack. Workable for a soft launch.

### `order.json`

```json
{
  "schema": "wrapsthetic.wrap-order",
  "version": 1,
  "createdAt": "2026-10-15T12:00:00.000Z",
  "company": "Wrapsthetic",
  "customer": { "name": "", "email": "", "phone": "", "postcode": "", "address": "", "notes": "" },
  "prosthetic": { "type": "transtibial", "side": "left", "wrapSocket": true, "wrapPylon": true,
                  "socketMaterial": "carbon", "description": "" },
  "measurements": {
    "entered_in": "cm",
    "socket": { "length_cm": 32, "interval_cm": 5,
                "stations": [ { "position_cm": 0, "circumference_cm": 34 }, { "position_cm": 5, "circumference_cm": 33 } ] },
    "pylon": { "length_cm": 15, "circumference_cm": 10 },
    "cutouts": "Valve on the inside 6 cm from the bottom",
    "notes": ""
  },
  "template": { "seamAllowance_cm": 1, "socket": { "height_cm": 32, "maxWidth_cm": 35 },
                "pylon": { "height_cm": 15, "width_cm": 11 }, "note": "..." },
  "artwork": { "fileName": "art.png", "mimeType": "image/png", "bytes": 914730,
               "width_px": 1200, "height_px": 800, "finish": "gloss",
               "placement": { "fit": "cover", "scale": 130, "offsetX": 0, "offsetY": 0, "rotation": 0, "background": "#ffffff" },
               "notes": "" }
}
```

`stations` run from the brim (position 0) to the bottom (position = socket length). `socket` or
`pylon` is `null` when that part is not being wrapped.

### `template.svg`

One SVG unit equals 1 mm and the document declares its size in mm, so it opens at true scale in
Illustrator, Inkscape or a cutter's software. For each part being wrapped it contains:

- the outline, with width at each measuring point equal to the circumference plus the seam
  allowance, and a dotted seam line;
- each measuring point labelled with its distance from the brim and the circumference;
- the artwork, clipped to the outline, placed exactly as the customer previewed it (the embedded
  copy is the downscaled preview; use `artwork-original.*` from the pack for print);
- a 10 cm scale bar.

The outline is a straight development (each circumference laid flat at its height), which is
accurate for the near-cylindrical shapes of most sockets. Final fitting and any relief cuts remain
with Wrapsthetic.

## Testing

Serve the repository root with any static server and open `/configurator/`. The flow was
verified in headless Chromium: station generation, validation, unit switching, artwork preview,
order pack download (valid zip), submission fallback and restore after reload.
