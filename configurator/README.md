# Wrapsthetic Configurator

A self-contained, static web app for Wrapsthetic customers. A customer measures their prosthetic
socket and pylon, or their wheelchair wheels, uploads artwork, sees it on a 3D model of the
prosthetic or on a spinning wheel, and sends Wrapsthetic everything needed to produce the wrap or
the wheel discs.

It is designed to sit behind a link on the Wrapsthetic website. It has its own branding, links
back to the main site, and carries a `noindex` tag so search engines send people to the main site
rather than straight into the form. There is no build step. The only dependency is a vendored copy
of three.js (`vendor/three.min.js`, MIT, r128) used for the 3D preview; everything else is plain
HTML, CSS and JavaScript.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The configurator (five-step form), followed by "how it works" and the measuring guide |
| `configurator.css` | Styling (light and dark themes, large touch targets, print layout for the order sheet) |
| `configurator.js` | Wizard logic, measurements, unit conversion, template geometry, previews, order pack, submission |
| `vendor/three.min.js` | three.js r128 (MIT) for the interactive 3D preview. Falls back to a flat silhouette without WebGL |

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
| `websiteUrl` | Where the logo, "Back to Wrapsthetic" and footer links go. Set to https://wrapsthetic.com |
| `contactEmail` | Address customers are asked to email the order pack to if the server is unreachable. Placeholder, confirm before launch |
| `submitUrl` | Endpoint that receives orders (see below). Defaults to `/api/wrap-orders` |
| `seamAllowanceCm` | Extra width added to every wrap template for the overlap seam |
| `discBleedCm` | Extra radius added to wheel disc templates for trimming |
| `previewMaxPx` | Long-side size the preview image is downscaled to. The original file is sent untouched |

## How the customer flow works

1. **About you**: name, email (both required), phone, address, notes.
2. **What to wrap**: a prosthetic wrap or wheelchair wheel discs.
   - Prosthetic: type (below/above knee, below/above elbow, other), side, whether to wrap the
     socket and/or pylon, socket surface.
   - Wheel discs: wheel size, one disc or a pair, and whether a pair is mirrored (so the design
     reads the same way from outside on both wheels) or identical.
3. **Measurements** (centimetres or inches; everything is stored in cm).
   - Prosthetic: socket length from brim to bottom, then the app generates measuring points every
     2.5, 5 or 10 cm (1, 2 or 4 inches) and asks for the full circumference at each. Pylon length
     and circumference if the pylon is being wrapped. Free text for valves, buttons and straps to
     leave clear. Values that jump more than 35% between neighbouring points are flagged.
   - Wheel discs: disc diameter (inside edge of the rim to inside edge, through the centre) and the
     hub clearance diameter.
4. **Artwork**: image upload (PNG, JPEG, WebP, SVG), finish, fill mode (fill, fit, tile), size,
   offset, rotation and background colour. The artwork can be dragged directly on the flat template.
   - Prosthetic: an interactive 3D model built from the measurements (surface of revolution through
     the circumferences), with the artwork mapped on exactly as the flat template lays it out. Drag
     to turn, a Turn slider for keyboard users, and an optional slow spin. Without WebGL the page
     shows a shaded front-view silhouette instead.
   - Wheel discs: the disc on a wheel with tyre and push rim. Drag to spin.
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
  "version": 2,
  "createdAt": "2026-10-15T12:00:00.000Z",
  "company": "Wrapsthetic",
  "product": "prosthetic",
  "customer": { "name": "", "email": "", "phone": "", "postcode": "", "address": "", "notes": "" },
  "prosthetic": { "type": "transtibial", "side": "left", "wrapSocket": true, "wrapPylon": true,
                  "socketMaterial": "carbon", "description": "" },
  "wheelchair": null,
  "measurements": {
    "entered_in": "cm",
    "product": "prosthetic",
    "socket": { "length_cm": 32, "interval_cm": 5,
                "stations": [ { "position_cm": 0, "circumference_cm": 34 }, { "position_cm": 5, "circumference_cm": 33 } ] },
    "pylon": { "length_cm": 15, "circumference_cm": 10 },
    "discs": null,
    "cutouts": "Valve on the inside 6 cm from the bottom",
    "notes": ""
  },
  "template": { "seamAllowance_cm": 1, "discBleed_cm": 0.5, "socket": { "height_cm": 32, "maxWidth_cm": 35 },
                "pylon": { "height_cm": 15, "width_cm": 11 }, "discs": null, "note": "..." },
  "artwork": { "fileName": "art.png", "mimeType": "image/png", "bytes": 914730,
               "width_px": 1200, "height_px": 800, "finish": "gloss",
               "placement": { "fit": "cover", "scale": 130, "offsetX": 0, "offsetY": 0, "rotation": 0, "background": "#ffffff" },
               "notes": "" }
}
```

`stations` run from the brim (position 0) to the bottom (position = socket length). `socket` or
`pylon` is `null` when that part is not being wrapped.

For wheel discs, `product` is `"discs"`, `prosthetic` is `null`, and the order carries:

```json
  "wheelchair": { "wheelSize": "24in", "quantity": 2, "mirrored": true, "description": "" },
  "measurements": { "entered_in": "cm", "product": "discs", "socket": null, "pylon": null,
                    "discs": { "diameter_cm": 52, "hub_cm": 6, "quantity": 2, "mirrored": true, "wheelSize": "24in" },
                    "cutouts": "", "notes": "" },
  "template": { "discs": { "diameter_cm": 52, "cut_diameter_cm": 53, "hub_cm": 6, "quantity": 2, "mirrored": true } }
```

### `template.svg`

One SVG unit equals 1 mm and the document declares its size in mm, so it opens at true scale in
Illustrator, Inkscape or a cutter's software. For a wheel disc order it holds one circle per disc
(the second mirrored when requested) with the bleed as the outer cut line, the finished edge dashed,
the hub hole, registration ticks at 12, 3, 6 and 9 o'clock and a 10 cm scale bar. For a prosthetic
wrap, for each part being wrapped it contains:

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

Serve the repository root with any static server and open `/configurator/`. Both flows were
verified in headless Chromium: station generation, validation, unit switching, artwork upload,
dragging the artwork on the template, turning the 3D model, spinning the wheel, order pack download
(valid zip with the right template), submission fallback and restore after reload.
