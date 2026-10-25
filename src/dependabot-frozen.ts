/**
 * THE PACKAGES WHOSE VERSIONS ARE FROZEN BY POLICY: the ONE list, so Dependabot never proposes a move of one (A11-253, under A11-251).
 *
 * `dependabot-config` writes every name here into each repository's npm `ignore`, with its reason as the comment above it. A repository
 * does not list them itself and cannot opt out: a name is added here, once, and the next `dependabot-config --write` carries it everywhere.
 *
 * TWO KINDS, each with the evidence that decides it:
 *   - the fleet's pins manifest: every `layers.*.package` of control's `deploy-pins.json` (A11-205). The fleet runs the exact release the
 *     manifest pins, and a move is a pull request in control that changes the version and the `integrity` together. control's own
 *     `dependabot-config.test.ts` fails when a layer is added to the manifest and not to this list, so the two cannot drift.
 *   - the packages that pick the NVDA version CI evidence runs on (a11ign/a11ign ADR 0033 makes the guidepup version cache-key evidence;
 *     0.34.0 upgraded NVDA to 2026.2). A move needs `evidence:check`, a recapture and a fleet-wide change. The manifest does not write these
 *     as a package name, so no test can compare them: the reason stated here is the check.
 *
 * Playwright is NOT frozen: A11-230 says an unlisted Playwright version "still runs".
 */

export type FrozenPackage = { name: string; reason: string };

const FLEET_PINS = "in the fleet's pins manifest (control deploy-pins.json `layers`, A11-205)";
const NVDA_PICK = "picks the NVDA version CI evidence runs on (a11ign/a11ign ADR 0033): a move needs a recapture and a fleet-wide change";

export const FROZEN: readonly FrozenPackage[] = [
  { name: "@a11ign/screenreader-worker", reason: `${FLEET_PINS}: the fleet runs the release it pins` },
  { name: "@a11ign/screenreader-fleet", reason: `${FLEET_PINS}: the fleet runs the release it pins` },
  { name: "@guidepup/guidepup", reason: `its version ${NVDA_PICK}` },
  { name: "@guidepup/setup", reason: `its version ${NVDA_PICK}` },
];
