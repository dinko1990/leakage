# Leak Drop Tracker

A small installable web app for iPhone that watches a selected area of a puddle for ripple motion and timestamps likely drops. It also records Pump 1, Pump 2, inlet-water states, notes, and intervals between drops.

## Important limitation

The camera needs a **secure web address (HTTPS)**. Opening `index.html` directly from the Files app is not a reliable deployment method. The easiest free options are GitHub Pages, Netlify Drop, Cloudflare Pages, or another HTTPS static host.

## Fastest deployment with Netlify Drop

1. Unzip this package on a computer.
2. Open Netlify Drop in a browser and drag the entire `leak-drop-tracker` folder onto the page.
3. Open the generated `https://...netlify.app` address on the iPhone in Safari.
4. Tap Share → **Add to Home Screen**.
5. Open the new Leak Tracker icon and approve camera access. If the camera is blank in the installed icon on a particular iOS version, open the same HTTPS address directly in Safari; the session tools still work there.

## GitHub Pages deployment

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. Open repository Settings → Pages.
4. Under Build and deployment, choose “Deploy from a branch,” then select `main` and `/root`.
5. Open the resulting HTTPS address on the iPhone in Safari and add it to the Home Screen.

## Recommended physical setup

- Keep yourself and the phone outside the sewage pit.
- Clamp the iPhone rigidly; even tiny movements produce false ripple detections.
- Aim at a small, reflective patch of still water.
- Use steady side-lighting, not a flickering lamp.
- Select only the puddle surface; exclude hoses, pump housings, moving shadows, and the water-entry edge.
- Calibrate for five seconds while nothing changes.
- Test states separately: all off, Pump 1 only, Pump 2 only, inlet only, and useful combinations.

## Reading the evidence

A correlation is strongest when the drop interval changes quickly and repeatedly after the same state change. Repeat each state more than once. A delayed response can indicate stored pressure, drainage from a pipe, or water already trapped around the pit, rather than a leak directly at the currently active machine.

This tool helps structure observations; it does not prove the physical leak location. Sewage pits are hazardous confined spaces. Do not enter one without qualified confined-space professionals and proper gas testing, ventilation, isolation, and protective equipment.
