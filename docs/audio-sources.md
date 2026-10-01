# Streak Audio Sources

This document records the approved sources for the first Streak sound pack. Audio is downloaded during development, edited/transcoded, and committed under `public/audio/streak/`. The game must never fetch sounds from a third-party URL at runtime.

## Preferred CC0 packs

| Source | Official download | License | Useful files | Streak mapping |
| --- | --- | --- | --- | --- |
| Kenney UI Audio (50 assets) | [kenney_ui-audio.zip](https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The [asset page](https://kenney.nl/assets/ui-audio) confirms CC0 and commercial use. | `Audio/click1.ogg`-`click5.ogg`, `mouseclick1.ogg`, `rollover*.ogg`, `switch*.ogg` | Card/link selection, wager +/- clicks, toggle/settings feedback, modal navigation. |
| Kenney Interface Sounds (100 assets) | [kenney_interface-sounds.zip](https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip) | `License.txt` in the archive states [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), including commercial projects. Credit Kenney/kenney.nl is welcomed but optional. The [asset page](https://kenney.nl/assets/interface-sounds) confirms CC0. | `back_00*.ogg`, `drop_00*.ogg`, `confirmation_00*.ogg`, `glass_00*.ogg`, `error_00*.ogg`, `select_00*.ogg`, `tick_00*.ogg`, `toggle_00*.ogg`, `maximize_00*.ogg`, `minimize_00*.ogg` | Card deal/flick, chip drop/cascade, successful link chime, cash-out confirmation, loss/error cue, UI selection and volume toggle. |

The Interface Sounds pack is the recommended starting point because its filenames already group the required cues. The CC0 OGG files are retained locally as source material, while the current runtime uses original Web Audio synthesis for cohesive classic-casino motifs. Keep the original `License.txt` with the source archive or in the attribution record.

## Realistic card and chip recordings

For a more physical casino character, use [Freesound](https://freesound.org/) only with the asset's license explicitly verified as **CC0**. Freesound's [official license FAQ](https://freesound.org/help/faq/#licenses) explains that CC0 permits commercial reuse and modification; CC BY requires attribution, while CC BY-NC is not suitable for a commercial casino game. Search result pages are not enough evidence: record the individual sound page URL, author, license, and download date in `public/audio/streak/ATTRIBUTION.md`.

Suggested searches:

- [card dealing / card flick](https://freesound.org/search/?q=card+deal&f=license:%22creative+commons+0%22)
- [poker chip click / chips](https://freesound.org/search/?q=poker+chips&f=license:%22creative+commons+0%22)
- [bell / success chime](https://freesound.org/search/?q=bell+chime&f=license:%22creative+commons+0%22)
- [card thud / impact](https://freesound.org/search/?q=card+thud&f=license:%22creative+commons+0%22)

If no suitable CC0 recording is available, record the sound in-house or build it from Kenney CC0 layers. This avoids introducing attribution or non-commercial restrictions.

## Recommended first mapping

These are source candidates, not runtime filenames; rename the edited exports to the stable names used by the frontend:

| Runtime file | Candidate source | Event |
| --- | --- | --- |
| `ui-select.ogg` | `select_001.ogg` or `click_001.ogg` | Card/link selection |
| `wager-chip.ogg` | `tick_001.ogg` or `drop_001.ogg` | Wager increment/decrement |
| `card-deal.ogg` | `back_001.ogg` layered with a quiet `drop_002.ogg` | Host confirms an opened round |
| `card-continue.ogg` | `back_002.ogg` | Host enters the next randomness phase |
| `hit-chime.ogg` | `glass_001.ogg` or `confirmation_001.ogg` | Live state confirms a successful link |
| `loss-tone.ogg` | `error_001.ogg` layered with a short `drop_003.ogg` | Live state confirms a loss |
| `cashout-chime.ogg` | `maximize_001.ogg` layered with `glass_002.ogg` | Terminal payout is authoritative |
| `action-error.ogg` | `error_002.ogg` | Host rejects an action |

Sound playback must remain presentation-only: never play a success, loss, or payout cue until the corresponding live host snapshot is decoded and rendered. Keep attribution and source checksums alongside the final files so the pack can be audited or replaced later. The synthesized runtime cues do not use random values or external audio requests.
