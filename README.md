# DRAGON ACES

Fighter-pilot dogfights on dragonback, in the browser. Up to 10 riders share one sky over a compact
mountain island, a 1.65 km arena built around a giant castle: spit fireballs, roast foes up close with flame breath, lock on and launch homing seekers, and
barrel-roll out of the way. Rooms are topped up with AI dragons, so there is always a fight. You can also
practise offline against bots.

Built with three.js. The dragons are generated in code when the game loads, with no model files. The sky,
terrain textures and lighting come from Poly Haven HDRIs and scans (CC0).

## Make your own

This repository is meant to be forked. Change the breeds, the map, the castle, the rules, whatever you like, and
publish your own version. The code is MIT licensed (see `LICENSE`). The art, sound and fonts keep the licences listed
under [Credits](#credits): almost everything is CC0, the fonts are SIL OFL, and the music by Matthew Pablo is CC BY 3.0,
so keep his credit (it is already in the in-game Credits panel) if you keep the music.

Quick start (Node 20 or newer):

```bash
npm install
npm run build
npm run serve        # http://127.0.0.1:8080/
```

## Playing

| Input | Action |
| --- | --- |
| Mouse | Aim. Your dragon banks and pulls toward the aim (War Thunder-style mouse aim) |
| Left click / J | Fireballs (they fly along the nose reticle, nudged toward the aim and a locked target) |
| Right click / K | Flame breath: short range, high damage, burns heat fast |
| F / middle click | Seeker fireball. Keep a dragon near your aim for about 1 s to lock on first |
| W / S | Beat wings harder / glide and air-brake |
| Shift / Space | Boost (drains wing stamina) |
| R | Breed ability (see below) |
| Q / E | Barrel roll: a quick sideways dodge that also shakes off seekers at close range |
| A / D | Roll |
| C (hold) | Free look |
| Tab | Scoreboard |
| Esc | Pause menu |

Gamepads with the standard mapping work: sticks aim and roll, triggers fire, A boosts, bumpers dodge, Y fires a seeker, X uses the breed ability.
Phones get on-screen controls (the gauges move to the top-left so the thumbs own the bottom of the screen).

On the title screen, **1-4** pick a dragon (the showcase dragon roars, breathes flame and swaps breed), **Enter**
starts a Quick Battle, and **How to play**, **Settings** and **Credits** open from the bottom of the left column.
In battle a strip of control hints fades away after about 18 seconds (switch it off in Settings).

- **Feel** (`client/js/feel.js`, all client-side): the chase camera trails turns (tight along the view, loose
  sideways and up), banks with the dragon, shortens its boom against terrain and sky rocks, and its FOV is an
  underdamped spring, so boost and barrel rolls punch. Flying low or between canyon walls adds FOV, motion blur
  and a fine tremor; stalling adds a buffet. Hits shake the view by damage and distance and kick it away from
  the attacker; seekers and kills freeze the simulation for a few frames (hit-stop). Your kills run a short slow
  motion on particles, wrecks and the camera (the flight itself never slows). Dying orbits the falling wreck in
  slow motion, then cuts to your killer with letterbox bars and depth of field. Respawning swoops in from
  above. Throttle spools up and down, the barrel roll kicks off hard and stops clean, and gamepad sticks are
  rate based with a response curve and **vibrate** (hits, boost, kills, low flying, stall) where the browser
  exposes `vibrationActuator`.
- **Energy**: diving gains speed and climbing spends it. Below about 110 km/h a dragon stalls and its nose drops.
- **Heat**: every fireball and every second of breath adds heat. At 100 you overheat and can't fire until it cools to 40.
- **Clouds**: dragons inside a cloud vanish from radar and can't be locked. You get a whiteout too.
- **The Citadel**: the middle of the map is a colossal Gothic fortress on a rocky massif: a keep under an 800 m twisting
  spire ringed by four slender satellite spires (up to 520 m), six great towers and spires (250-550 m) with spiral ramps
  and galleries, a curtain wall with sally ports, a lower outer bailey on a terrace under the cliff with a barbican
  and a road up to the gate, four viaducts and two sky bridges, flying buttresses, hanging chains and banners, bats
  wheeling round the spires and mist pooling in the courtyard. It is solid (dragons crash into it,
  fireballs burst on it) and full of ways through: a 56 m wide, 70 m long gate tunnel, a free-standing triumphal arch
  right behind it, arches 40-72 m wide in the walls and bridges. Pursued bots dive through the gate and the great arches
  and weave round the towers instead of ramming them.
- **Ember shrines**: a glowing orb floats over each sky island, and two more hang in the Citadel (the courtyard, in line
  with the gate, and above the high sky bridge). Fly through one to heal 40 HP; it then
  recharges for 25 s. They show as gold crosses on the radar, and wounded bots go for them too.
- **Breeds** differ in numbers and each has a signature ability on **R** (gamepad X). It is ready 5 s after
  you spawn. Every kill takes 4 s off the cooldown, every assist 2 s. The room decides who an ability hits, so
  it cannot be spoofed.

  | Breed | Notes | Ability | Cooldown | What it does |
  | --- | --- | --- | --- | --- |
  | Ember Drake | balanced | **Inferno Wake** | 24 s | Instant. For 4.5 s you shed napalm puffs behind you (22 m radius, 4 s each, 24 dmg/s). Anyone in them also burns for 2.5 s (11 dmg/s). Your own trail never hurts you. Use it when someone is on your tail. |
  | Frost Wyrm | more hide, slower, wider turns | **Frost Nova** | 22 s | 0.45 s charge while a ring closes in on you (Rime Armor, 30% less damage, from the start), then a 210 m shockwave: foes still inside take 18 and are chilled for 4 s (turn rate x0.55, speed x0.85). Fly out of the ring to escape; killing the caster during the charge cancels it. |
  | Storm Wyvern | fastest, quick bolts, thin hide | **Chain Lightning** | 16 s | Locks the foe nearest your nose (480 m, wide cone, line of sight needed). After a 0.3 s charge the bolt strikes and leaps to up to two more foes within 280 m: 22, 15, 10 damage. The locked dragon gets a warning and **a barrel roll at the last moment dodges the bolt**; a miss gives back 40% of the cooldown. With nothing in front it is refused and costs nothing. |
  | Venom Serpent | weaker spit, brutal breath | **Acid Cloud** | 17 s | A glob arcs 120 m ahead (0.6 s flight, a marker shows where it lands) and a 76 m cloud lingers for 8 s: 19 dmg/s, then poison (9 dmg/s for 4 s), and Corrode makes the victim take 20% more damage for 4 s. |

  Abilities, napalm and acid clouds never hurt allies. Bots use them too: Ember when chased, Frost when
  foes crowd it, Storm and Venom when a target is lined up.
- **Matches** end after 8 minutes or at the kill limit, then a 14-second results screen. A kill scores 100,
  an assist 50, First Blood +50, Revenge +25. Crashing within 10 s of being hit gives the kill to whoever hit you last.
  - **Free-for-all**: first to 15 kills.
  - **Team Deathmatch**: Gold flight against Crimson flight, first to 20 team kills (or the most when time runs
    out). Friendly fire is off for every damage source, allies cannot be locked on, and shots pass through them.
    Lens rims, markers, radar blips and the kill feed use the team colours, and the team score sits at the top of the
    screen. Humans are split evenly and bots even the flights up (at least three dragons a side). Each flight
    spawns on its own side of the arena. At the start of every match the best scorers are split between the
    flights. Public skies alternate Free-for-all and Team Deathmatch, one match each; for a private sky or
    offline practice pick the mode on the menu before you create it.
- **Streaks and comebacks**:
  - 3 kills in a life: **Blazing**, fireballs fire 30% faster and build 40% less heat for 15 s.
  - 5 kills: **Surge**, heals 40% of your hide, readies your ability and renews Blazing.
  - 7 kills: **Dragonlord**, +20% damage for 20 s (plus Blazing).
  - From 4 kills on you carry a **bounty** (75 points at 4, +25 per kill, up to 250) shown as a star on your
    lens and radar blip. In free-for-all a runaway leader (6+ kills and 3 clear) is worth 40. Whoever ends
    the run collects it.
  - After 3 deaths in a row without a kill you respawn with a **Second Wind**: 5 s of protection, 10 s of
    Blazing and your ability ready.
  - Medals: First Blood, Revenge (down whoever last downed you), Shutdown (end a streak of 3+), Close Call (kill
    under 20% hide), Sniper (fireball or seeker kill from 650 m+), Bounty Hunter. They show in the kill feed and,
    with end-of-match awards (Top Ace, Heavy Hitter, Wingman, Streak Master, Spellfire), on the results screen.

## Presentation

- **Title screen**: a two-minute filmed flight of the chosen dragon through the map (fjord, Citadel, dive off the
  massif, moat canyon, stone gate, sea), cut like air-to-air footage (`client/js/ui-showcase.js`, route and shot list
  in `showcase-flight.js`, checked against terrain and the castle by `tests/showcase.test.mjs`). The flight is the breed
  picker: choosing a breed jumps the film to one of a few chosen close-up spots (`HERO_SPOTS`: sun behind the camera,
  open sky or far land behind the dragon, under the clouds, the dragon facing away from the menu) and it roars and
  breathes its element there; the old breed's effects are cleared first. On a portrait phone the lens is longer so
  the dragon spans about two thirds of the width in the top 60% of the screen. Test hooks:
  `window.__dragonAces.showcaseTime = t` jumps the film, `showcaseHold = true` freezes it.
- **HUD** (`client/js/hud.js`, `ui-panels.js`) is kept quiet so the other dragons stay visible: no panels, thin
  rules, warm off-white type with one accent per state, and nothing in the middle of the screen (warnings sit under
  the clock, messages and kill or streak notices low in the centre for about 1.5 s). The hull is a thin line with
  its number; the wing and heat lines only appear while they are being used up; seeker and breed ability are rings
  that fill as they recharge (on touch they ride on the SEEK and POWER buttons). After four quiet seconds (no
  combat, warning or dragon within 650 m) the clock, speed and height fade back (`#hud.calm`). Also: a trailing
  damage bar on the hull,
  a sparse radar with field-of-view wedge, altitude chevrons and missile pings, a lead marker for the target you
  are on, animated hit markers and damage numbers, kill and streak banners (Double Kill up to Dragonlord),
  a low-health heartbeat, lock and missile warnings (with off-screen arrows), a scoreboard and a results screen
  with podium, awards and your own stats. Gauges only write the DOM when a value changes.
- **Fonts**: Fraunces for display (a soft 1970s-80s film-title serif) and Archivo for the interface and HUD (a
  grotesque with a width axis), both SIL OFL, self-hosted in `client/fonts/`. CSS reads them only through
  `var(--display)` and `var(--ui)`. Display type is roman; italic only for proper names (callsign, ability names).
- **Wordmark**: "Dragon" over "Aces" in Fraunces, outlined to SVG paths and spaced by hand (the g's descender hangs
  into the space above "ce"), one warm ink colour. `tools/build_wordmark.py` regenerates it; it lives once in
  `index.html` as the `#wordmark` symbol (title screen and loading card).
- **Menus**: the title screen is the flying showcase dragon with a film-title layout: the wordmark and actions in the
  left column (callsign, Quick Battle, Practice, More ways to fly), the breed caption (name, then prev / dots / next,
  ability, stats; 1-4 / arrow keys) in the bottom band. No breed cards. "More ways to fly" opens a sheet (a bottom
  sheet on a phone) with Private sky, Join a friend (code field) and the battle type for private skies and practice;
  an invite link (`?room=CODE`) opens it with the code filled in.
- **Target lenses** (`client/js/render/lens.js`, rims in `hud.js`): instead of boxes, a far dragon gets a small
  magnifying glass that follows it and shows it live and sharp (wings beating, breed colours, fire). The lens is a
  true telescope: the main camera's own position and orientation with an off-axis projection zoomed around the
  dragon, so haze, light and roll match the world. Only the dragons inside the lens (their far mesh, which is plenty at lens size) and
  the fire and trail effects are drawn, into a 128 / 192 / 256 px half-float target (quality 0 / 1 / 2, MSAA at 1+);
  the background is the main frame's HDR buffer heavily blurred and darkened about 15% (a long lens's shallow depth
  of field), with the main frame's own tiny copy of the dragon (by depth) and hot sparks next to it (by brightness)
  painted out. Then a little refraction and colour fringe at the edge, an inner vignette, the same AgX tone map and
  grade as the main view, a hint of glass and a thin warm rim. Size inside the glass is a range cue: spread wings
  span 3/4 of the lens at 300 m and less with distance, down to about 40% from 1600 m on; when the dragon's own size
  on screen grows to that (about 350 m down to 240 m at 1080p) the lens fades and shrinks away. The dragon you're on
  hands over early inside 650 m, so the real dragon and the lead pip under your reticle are never behind glass.
  **Calm by rule:** one warm ink for rims and health, red only for threats to you and for the lock, colour only as a
  small identity tick at 12 o'clock (breed colour, team colour in Team Deathmatch). The rim carries health as an arc
  under it (red below 35%), a small notch showing which way the dragon flies, and the lock arc closing on the rim; once
  locked the rim turns warm red and a little thicker (no ticks, no text). Up close there is no ring: a short health
  arc under the dragon and an identity tick over it. **One name on screen**: the lock target while there is one, else
  the dragon on your nose within 900 m, drawn once, on whichever of its lens or its own marks is more visible. At most
  3 lenses (2 on touch screens, small viewports and quality 0), ranked lock target, dragons locked on to you or lining
  up a shot (`threats.js`), nearest the nose, nearest; lenses never overlap (dragons bunched up on screen share one);
  the rest get a small caret, allies a smaller one in their team colour. A dragon out of sight behind terrain, sky
  rocks, the Citadel or thick cloud gets only a dim caret (no lens, no name, no lead pip), and you cannot lock on
  through them either. Out-of-view arrows only for the nearest two, threats (red) and seekers. Lenses beyond the
  per-frame budget are re-rendered round-robin. **Settings → Magnifier lenses** or `?lens=0` turns them off (small
  markers; your target keeps its health and lock arcs).
- **Threat cues**: bots never lock on, so a hostile within 600 m whose nose points within 8 degrees of you counts as a
  threat (`client/js/threats.js`, with a little hysteresis): it gets lens priority and a red edge arrow, and "ON YOUR
  SIX" shows in the lock-warning slot while it is behind you. An incoming seeker puts a red bearing wedge on a ring
  around the reticle with its time to impact. Damage arcs are small (15% of the screen around the centre), thin, one
  per attacker per 0.5 s, merged when close, and not shown for burns and acid.

## Sound and music

`client/js/audio.js` plays recorded sounds (`client/assets/audio/*.mp3`, about 5 MB in total) through WebAudio,
with a synthesised wind bed and a streamed music bed. Every sample has a procedural fallback, so a failed download
only costs quality.

- **One space.** Every positional sound (remote shots, wingbeats, roars, explosions, impacts, splashes, other
  dragons' abilities) goes through the same model: a reference distance and roll-off per category
  (`CATS`: weapons 60 m, impacts 70, abilities 110, roars 150, explosions 160, wingbeats 45), the same air absorption
  (a low-pass that closes from 18 kHz to about 1 kHz with distance) and the same reverb send into one short, dark
  open-air convolver (more wet the further away). The panner only does direction. Your own dragon's sounds are
  centred and outrank everything of their kind when voices are limited.
- **Loudness.** `tools/build_audio.py` normalises every sample offline, per category, to the targets in
  `tools/audio_spec.json` (active LUFS: explosions -20, roars -19, abilities -20, weapons -21, impacts -22, stingers
  -21, alerts -25, wings -27, interface -29; the music to -16 LUFS integrated) with a look-ahead limiter at
  -1.5 dBFS, and writes what the encoded files measure to `client/assets/audio/loudness.json`. The engine adds one
  trim per category (`CATS.trim`), so the whole mix is a table, not per-sample luck. Repeats vary by at most 6 %
  pitch and 1 dB, never more.
- **Buses.** Category buses feed `sfx`; the interface sounds have their own bus; the wind, air passes and menu sea
  are `ambience`; the streamed tracks are `music`. They sum into a glue compressor, a limiter and a soft clip, so
  nothing leaves above about -0.2 dBFS, then the master volume, the death filter and the pause filter.
- **Ducking.** Big explosions near you, roars, ability hits and kill stingers dip the music and the ambience with
  smooth ramps (fast attack, 1 s release); your own death drops them hard (music -10 dB, air -18 dB) and closes the
  highs for a moment. Overlapping ducks only ever go deeper, never stack into silence.
- **Voice limiting.** Every sound type has a cap (6 fireballs, 3 seekers, 5 wingbeats, 6 impacts, 4 explosions,
  3 roars ...), a retrigger gap and a priority. A new voice over the cap steals the quietest of its type (loudness
  at the listener, fading with how much of the sound has played) or is dropped if it is the quietest; a global cap of
  40 does the same across types, weighted by priority. Twenty dragons firing is a handful of loud voices, not a wall.
- **Wind and air** are not recordings: five filtered-noise layers (a low rumble, a body, a whoosh, gusts, a cloud
  hush) follow airspeed, boost, dives, tight turns and height above the ground, every parameter through a smooth
  ramp. Gusts come and go on their own. Every layer is low-passed at 1.4 to 1.7 kHz or lower, so there is no hiss. Inside a cloud the wind is cut sharply
  (-24 dB within a fraction of a second) and returns slowly; the pause menu closes the air completely. A dragon rushing
  past close by gives a pass-by whoosh that falls in pitch and sweeps across the stereo field.

Music streams as `<audio>` elements: the menu theme, a battle bed that loops from its build-up and a short results
sting, crossfaded as the match phase changes. The pause menu muffles everything and stops the air. Settings has
master, music, effects (weapons, impacts, voices, abilities and the interface sounds) and ambience and wind sliders
(stored in `localStorage` as `da.vol`, `da.music`, `da.sfx`, `da.amb`); all four use a squared taper.

`node tools/audio_render.mjs --out /tmp/r --tag after` renders scripted scenes (cruise, a boost dive with a cloud, a
ten-dragon dogfight, a big explosion and your own death, and a catalogue of every event near and far) through the real
`audio.js` into an `OfflineAudioContext` in headless Chromium; `python3 tools/audio_analyze.py /tmp/r after` prints
LUFS, peaks, crest factor and the spectral balance. `tests/audio.test.mjs` measures every shipped file against the
loudness spec and tests the space model and the voice limiter.

## How it works

```
shared/       pure JS, runs in the browser, the terrain worker and the room server
  world.js      the map as a deterministic height function: castle plateau, moat, mountain ring with passes, fjords,
                waterfalls, rock arches, sea stacks, ruins, floating islands, spawn points (see "The map")
  castle.js     the Citadel: layout spec, rocky massif, colliders (behind world.solidAt), bot steering helpers
  flight.js     arcade flight model + "mouse aim" autopilot (players and bots use the same code)
  room.js       authoritative room: health, kills, scores, teams, streaks, respawns, match flow, bots, bot fireballs
  abilities.js  the four breed abilities, napalm/acid zones, burn and poison ticks
  bots.js       AI: target choice, lead pursuit, merges and break turns, terrain, sky-rock, landmark and Citadel avoidance, arch runs
  combat.js     hit tests (ellipsoid in the dragon's body frame, swept for fast projectiles)
  protocol.js   binary state/snapshot encoding; events are small JSON messages
  hub.js        matchmaking: quick battle, private 4-letter rooms
client/js/    three.js client (bundled by esbuild into game.js + terrain-worker.js + castle-worker.js)
  ui-*.js       title screen widgets, showcase camera, scoreboard/results; hud.js and audio.js are the HUD and sound
  render/       sky + height fog, chunked LOD terrain, forests, rocks and ruins, ocean, clouds, sky islands, the Citadel (castle*.js), dragon, combat effects (fx, vfx-*), trails, shrines
  game.js       local flight, weapons, interpolation of remote dragons, HUD feedback
cloudflare/   server.js (room server, used by tools/serve.mjs) and build.mjs (static client build)
tools/        prepare_assets.py (Poly Haven downloads), build_castle_textures.py, gen_vfx.py (flipbooks),
              serve.mjs, castle_shots.mjs, build_audio.py + audio_spec.json + loudness.py + audio_synth.py (sound build),
              audio_render.mjs + audio_harness.html + audio_analyze.py (offline mix renders and loudness numbers)
```

**Netcode.** Each client flies its own dragon and streams its state at 20 Hz in a 27-byte binary
message. The room sends a binary snapshot of every dragon at 20 Hz, 26 bytes per dragon. Remote dragons
are drawn about 120 ms in the past, with Hermite interpolation along their velocity. The room is
authoritative for everything that matters: health, damage, kills, scores and respawns. Shooters claim
their own hits ("favour the shooter"), and the room checks each claim before applying it:

- the victim is an enemy (no friendly fire in Team Deathmatch);
- the shot was really fired and hasn't already hit;
- it is within its lifetime;
- the hit point lies on the shot's path;
- the victim was near that point, with slack for latency;
- for seekers, the target hadn't just barrel-rolled out of the way.

Fire rates are enforced on the server (including the Blazing bonus), and moves are checked for teleports. Bots
are simulated by the room at 30 Hz, and the room resolves their fireballs itself.

Abilities are not claims: a client only sends `{t:'abil'}`. The room checks the cooldown and that the dragon is
alive, then works out the targets from the positions it knows and broadcasts the result (`abil`, `zone`, `st`
events). Napalm and acid zones are simulated by the room and tick four times a second. The one thing the room
cannot enforce is a chilled human's own flight, which the client applies when told (`st chill`).

**Rendering.**
- **Sky:** the HDRI is decoded back to linear HDR so the sky and the world share one tone map (AgX, applied in the lens pass). A sun halo
  is added on top of the photographed sky.
- **Fog / aerial perspective:** three.js fog is replaced with exponential height fog. Its colour is not a constant:
  at load the HDRI is averaged into a 24x8 table of haze colours by view direction (`buildFogTable`), so mountains,
  islands, clouds and the sea dissolve into exactly the sky behind them, with a warm forward-scattering glow toward the sun.
- **Clouds:** real volumetric cumulus (`render/clouds.js`, `render/cloudfield.js`). A tiling 2D weather map holds the
  thickness of two cumulus layers (towering cumulus from about 1 km up to the 1.7 km ceiling, low banks around 500 m); a full-screen pass raymarches
  it at 0.25 / 0.36 / 0.5 of the render size (quality 0 / 1 / 2) with 3D Perlin-Worley and Worley noise baked on the GPU
  at start-up (128^3 and 48^3, no asset files). Lighting is Beer-Lambert extinction, a powder term, a dual-lobe
  Henyey-Greenstein phase function and a four-octave multiple-scattering approximation, with a short light march toward
  the sun. Empty space is skipped with a mip of the weather map, the march is jittered per frame and accumulated with
  temporal reprojection (the camera and wind motion are reprojected, history is rejected on depth or opacity change), and
  the result is composited with a depth- and alpha-aware upsample. The composite writes the cloud's entry depth to `gl_FragDepth`, so
  terrain, islands and dragons occlude and sit inside clouds correctly and particles draw over them.
  `Clouds.density(p)` is the CPU twin of the weather map's macro profile (same formula), cheap (two bilinear
  samples), and still drives radar hiding and the whiteout. The field drifts with the wall clock, so every player
  sees and hides in the same clouds.
- **Light shafts:** a half-resolution radial blur toward the sun of cloud transparency, composited with the clouds
  (hidden when the sun is behind terrain).
- **Cloud shadows:** every lit material (terrain, islands, dragons) and the sea attenuate the sun by the weather map's
  thickness along the sun ray, so cloud shadows slide over the land and water.
- **Terrain:** a worker meshes 600 m chunks (12 x 12 over 7.2 km) at four levels of detail and bakes mountain shadow heights
  and AO into a 1024² texture. That texture shadows the terrain, the sea and dragons flying through
  shadowed valleys. A second 1024² mask (forest density, distance to the canyon centre line, conifer share,
  rockiness) comes from the same worker. The splat shader mixes grass (graded lush to sun-dried, with close-up
  detail layers and wind gusts rolling over it), rock, sand, snow (with sparkle), forest litter under the canopy
  and gravel and streams along canyon floors. Steep faces use a warped full triplanar lookup of two cliff
  textures with sedimentary banding, so walls read as layered rock instead of one repeating tile.
  The splat shader is the single most expensive thing in a frame (dozens of texture-array taps per pixel), so it
  only pays for what shows: anisotropic filtering 2x / 4x / 8x by tier, one tap where the anti-tiling mask is fully
  on one scale, triplanar projections under 3% dropped, and the ground layers' normal maps faded out between 0.9
  and 1.3 km (mipmapping has flattened them by then; cliffs keep theirs). That made it 20-55% cheaper with no
  visible change.
- **Forests:** `flora-model.js` (run in the worker) decides where trees grow from height, slope, canyon
  proximity and noise fields: dense forest in valleys and on moderate slopes, meadows and glades, stunted trees
  toward the tree line, palms on beaches, none on cliffs, snow or ruin platforms. About 90 000 trees (fir, pine,
  oak, birch, palm) plus shrubs are placed per 800 m block (9 x 9) with a rank each. `vegetation.js` instances them at
  three detail levels that cross-dissolve per instance (alpha-to-coverage with MSAA, a Bayer dither at q0) and
  thin by rank with distance:
  - **Full meshes** (370-900 triangles, wind, leaf and needle cut-outs, back-lit foliage) within about 95 m at
    quality 1 (140 m at 2).
  - **Octahedral impostors** (`impostors.js`) from there to about 3 km. The first time quality 1 or 2 is chosen,
    each fir, pine, oak and birch is rendered from a 6 x 6 grid of directions over the upper hemisphere into two
    GPU atlases (albedo + coverage, and view-space normal + baked occlusion; about 2400 x 1000 px each, a few
    tens of ms to bake, no asset files). A tree is then one camera-facing quad: the shader finds the three nearest
    baked views from the direction to the camera (rotated by the tree's own yaw), re-projects the quad into each,
    blends them and lights the result through the normal PBR path, so sun, image-based light, back-light,
    mountain shadow, cloud shadow and height fog match the real trees. Per-instance scale, width, yaw and tint
    keep forests from looking cloned. All four species share one atlas, so a 400 m quadrant (near) or an 800 m
    block (far) is a single draw call, and about 100 000 trees cost roughly 100 000 triangles.
  - **Quality 0** has no MSAA and no atlas: it keeps the 84-190 triangle meshes and the 21-28 triangle far
    cones and blobs, drops the full meshes, leaf cut-outs and shrubs, and keeps half the trees (out to 1.5 km).
  Beyond the impostors the terrain shader's canopy tint (clumped crowns, dark gaps, a darker forest floor) carries the
  forest. Foliage gets back-lighting, baked occlusion and the mountain shadows.
- **Rocks and landmarks:** boulders and slabs are scattered on slopes, canyon floors and beaches (merged per
  200 m cell near the camera). `shared/world.js` picks ten sites deterministically (temples, forts, watchtowers and
  the skeleton of a colossal dragon) on platforms it levels into the terrain, about 20 sea stacks along the coasts
  and in the fjords, and nine rock spires in the moat; towers, pillars, gates, the skull, the stacks and the rock
  arches are solid in `solidAt()` / `hitLandmark()`.
- **The Citadel** (`shared/castle.js`, `client/js/render/castle*.js`, `client/js/castle-worker.js`):
  - **Layout.** `castle.js` is the single source of truth: towers as stacks of stages (shaft, corbelled gallery,
    roof; tapering, twisting, 4 to 16 sided), wall runs, arch walls ("bays", used for the gate, the triumphal arch,
    the sally ports, the viaducts and the sky bridges), flying buttresses, chains, banners, braziers and shrines.
    Colliders and meshes are both generated from it, so they agree. The massif is `castle.terrain()`, wrapped round
    `world.height()`: a rock pillar standing on the map's 170 m plateau (smooth maximum of the two), flat at 640 m for
    the courtyard, a 55 m drop to the outer bailey's terrace with a road cut down to the barbican, then a sheer cliff
    (about 63 degrees, ridged crags) that meets the plateau at about 670 m. The moat and the mountain ring beyond are the map's.
  - **Colliders** behind `world.solidAt()`: tapered cylinders (tower stages, with galleries and set-backs), oriented
    boxes with pointed or segmental arch holes (walls, bays), beams (flying buttresses) and an exact spiral test for
    the ramps. A bounding cylinder rejects almost every call at once and a 48 m grid finds the few candidates; a call
    costs about 0.4 microseconds in the worst case on a laptop. Bots probe their path every 28 m out to 3.3 s ahead
    (spires are thinner than the old probe spacing at speed), pick the nearest clear heading, and commit to it for a
    moment so they do not dither; a pursued bot near the gate may commit to a run through the big arches instead.
  - **Geometry** (`castle-geo*.js`, run in the worker): everything is lofted from rings with explicit metric UVs, so
    the photoscanned stone courses stay level on tapered, twisted and conical shapes and the texel density is the same
    on a 5 m buttress and a 600 m spire. Detail level 0 adds pilasters, string courses, hip ribs and crockets, dormers,
    bartizans, arch mouldings, machicolation corbels, timber hoardings and ramp brackets; level 1 drops the small
    stuff; level 2 is the silhouette. Merlons, lancet windows, gargoyles, banners, chain links and brazier bowls are
    instanced. Level 0 is about 140 k triangles (level 1 87 k, the silhouette 19 k) plus about 180 k in the instances, in
    about 34 draw calls.
  - **Lighting.** The sun never moves, so `castle-bake.js` voxelises the colliders and the massif (10 m cells, blurred)
    and, at load time (about 1 s in the worker), computes a 112 x 92 x 112 light volume: sun transmittance, rain
    exposure and ambient openness per cell, stored in an RGBA8 3D texture (4.6 MB). The stone shader samples it per
    pixel, 5.5 m off the surface along its normal, so there are no per-vertex bands on big triangles (cells inside
    stone are filled from their open neighbours so the filtering never leaks a wall's own darkness). The shader adds the
    real-time shadow map near the camera, the terrain's mountain-shadow texture, the cloud shadows and the height fog
    like every other material; the terrain worker also folds the towers into its sun shadow march, so a 800 m spire
    throws a long shadow across the land.
  - **Materials** (`castle-material.js`): one PBR shader on `MeshStandardMaterial`, six Poly Haven photoscans (ashlar,
    rubble, slate, wood, iron, dark stone) from two texture arrays, each with a height map (the scan's displacement, or
    for the ashlar, whose scan ships a flat one, mortar joints from the albedo plus relief integrated from the normals).
    Close up the height drives parallax (one tap at quality 1, two at 2; fading out by 95 m), mortar cavity darkening
    and lightened, chipped block edges, with colour varying block by block; a coarse blurred second scale and a world
    space macro layer add broad light and dark patches, warm and cool tints. All noise is one 256 x 256 tiling
    texture (four octaves in four channels), and the relief, second scale and weathering fall away with distance.
    Weathering is procedural: dirt in occluded creases, vertical rain streaks below ledges (strength from the rain
    exposure), moss on damp upward faces low on the building, lime bloom, a wet dark band at the foot of the walls, rust
    on iron, verdigris and violet patches on the slate. Windows (a row of them on every wide face) glow warm, cool or
    ember and flicker; banners sway in the vertex shader; braziers burn with the effects system's flames and light, and
    their smoke drifts up the spires for ten seconds. `castle-life.js` adds about 150 bats (one instanced draw call,
    animated entirely in the vertex shader) and two drifting mist discs in the courtyard.
  - **Distance.** Beyond about 2.3 km (quality 1) the whole castle is one draw call; closer, each of about 25 structures
    picks level 0, 1 or 2 by distance and is frustum culled. Quality 0 never uses level 0, skips brazier fire and
    shortens every range; quality 2 stretches them.
- **Sky islands:** groves, boulders, wild flowers, a brook running to the waterfall lip, glowing crystal
  clusters (with halos), hanging roots, drifting debris and a waterfall that dissolves into mist.
- **Ocean:** a camera-centred clip-map (grids that double in size out to the horizon) displaced by ten Gerstner
  waves, with the wavelengths that a pixel can no longer resolve faded out by their screen footprint so the horizon
  never shimmers. The fragment shader recomputes the wave normals, adds normal-map ripples, and shades with Fresnel
  reflection of the HDRI and of the cloud layers, a GGX sun glitter that widens with distance, sub-surface turquoise
  in the crests, foam where the surface folds and at the shore, turquoise shallows, mountain shadows and cloud shadows.
- **Dragons:** one rigged mesh (41 bones, generated and driven in code) with four breed looks. The skin is a
  physical material over scale, plate and mottling detail generated on the GPU at load, with colour masks (stripe
  bands, blotches, mottling) that each breed tints, so the same hide reads as ember, frost, storm or venom. Eyes
  are wet glass balls with a veined iris and slit pupil. Wing membranes have generated veins, mottling, a rolled
  edge, and glow when backlit. Each breed
  also has its own silhouette (see below) and shader tricks: magma in the scale grooves (ember), glittering
  ice crystals (frost), crawling lightning and iridescence (storm), a wet gloss and toxic glow (venom).
- **The lens (`client/js/render/post.js`):** no EffectComposer. The scene renders once into a half-float target
  (MSAA at quality 1 and up, plus a depth texture), then a Karis-averaged dual-filter bloom pyramid, optional
  depth-only AO, and **one** final pass writes the canvas: depth of field (title screen and kill cam), camera
  motion blur reprojected from depth (so the ground streaks while your dragon stays crisp) plus a boost zoom
  blur, chromatic aberration only on boost and big hits, bloom with a procedural lens-dirt mask, the sun glare
  and ghosts (occlusion tested on the CPU), an AgX tone map with a film grade (teal shadows, warm highlights,
  S-curve, vibrance), vignette, cloud whiteout, damage tint, letterbox bars in the death cam, film grain and a
  dither that kills sky banding. Exposure dips a little when the sun is in view. The VFX heat-haze and shockwave
  offsets (`vfx-distort.js`) are drawn into a half-res buffer and the final pass bends every scene tap by it, so it
  works with the blur and bloom; it costs nothing while no haze is alive and is off at quality 0.
- **Quality tiers** (`?q=0|1|2`, the settings menu, or the automatic drop). The post costs below are estimates at
  1080p. Measured on an Apple M5 at q1, 2160x1350 (a 1440x900 Retina window), with each frame forced to finish: the
  heaviest title-film and battle views take 13-16 ms, of which the terrain is 3-6, clouds 1-3, forest impostors
  0.5-2, the Citadel 1-2.5 even right next to it, your own dragon about 0.5, and post about 3. Do not trust
  `perf.gpuMs` on Apple GPUs: they clock down when there is slack, so the timer reads 10-25 ms at a steady 60 fps.
  To compare costs, render the same frozen frame back to back with a 1-pixel `readPixels` after each (that waits
  for the GPU) and toggle a part's `visible` on and off in alternation; plain fps and timer queries were too noisy.

  | Tier | Passes | Anti-aliasing | Pixel ratio | Rough extra cost over a bare scene render |
  | --- | --- | --- | --- | --- |
  | 0 fast | scene, 4-level bloom from 1/4 res, final, FXAA | FXAA, no MSAA | 1 | ~1 ms discrete, ~2 ms integrated |
  | 1 high | scene, 5-level bloom from 1/2 res, final with 8-tap motion blur (DOF 16 taps on the title) | MSAA x4 | up to 1.5 | ~1.5 ms discrete, ~3 ms integrated |
  | 2 ultra | adds AO (0.6 res, 12 taps, bilateral blur), 6-level bloom, 12-tap motion blur, 28-tap DOF, grain | MSAA x4 + supersampling | up to 2 | ~3 ms discrete, supersampling dominates |

- **Dynamic resolution:** on browsers with `EXT_disjoint_timer_query_webgl2` (Chrome, Edge) the renderer reads GPU
  time and, when it can't hold ~60 fps, trims the render scale in 1/8 steps (down to 0.625) before the page
  drops a quality tier; it creeps back up with headroom. A high GPU time only counts while frames are really late
  (over 18 ms), since Apple GPUs report inflated times at 60 fps. Other browsers only react to clearly slow frames.
  `?gov=0` freezes it (automated browsers do this by themselves).
- **Combat effects** (`render/fx.js`, `vfx-*.js`): every effect is a GPU-instanced sprite pool, one draw call each,
  CPU-simulated with swap-remove so only live particles are uploaded. Flames, smoke, flame jets and shapes come from
  animated flipbook atlases (`client/assets/vfx_*.png`, generated by `tools/gen_vfx.py` from domain-warped 3D noise).
  Fire is partly occluding, so stacked flames converge to flame colour rather than whiting out under bloom. Palette
  ramps are per breed: Ember fire and black smoke, Frost cold mist, ice shards and snow glitter, Storm violet
  plasma with crackling lightning arcs, Venom acid with dripping globs and toxic gas. Fireballs have a white-hot
  stretched core and a flame tail; seekers add a core ribbon and two counter-rotating corkscrews. Explosions layer a
  flash, lumpy fireball, sparks, debris, delayed smoke, a pale vapour shock ring with screen refraction and (on a death or
  crash) a lingering smoke column; ground hits add flat dust rings, sea hits throw a splash column. Particles fade
  where they dip into the sea or terrain using the height map (soft particles without a depth buffer). Wounded
  dragons leak smoke then fire, breath sets targets alight, wrecks trail fire. Four point lights are shared by the
  brightest effects and never change count, so shaders never recompile mid-fight.
  Breed abilities get their own looks (`fx.abilityCast` / `abilityZone` / `status`): Inferno Wake's flame tail and
  burning napalm patches; Frost Nova's wall of frost mist closing in, then a rolling ring of frost vapour with ice shards and snow; Chain
  Lightning's crackling charge and lock line, then bright branching arcs (wider with range so they read from afar);
  Venom's lobbed glob with a thin olive vapour ring where it will land, then a roiling toxic cloud. Rings are
  alpha-blended dust and vapour (never glowing lines), and the elemental breeds' plasma is toned a little toward grey. Chilled dragons
  frost over, corroded ones drip acid, Rime Armor shows orbiting ice crystals. Blasts within about 150 m of the
  camera are dimmed and sprites that would cover the view fade by screen coverage, so nothing blinds the pilot.
  Quality 0 / 1 / 2 scales particle density to 45% / 80% / 120%, caps the pools at 50% / 80% / 100%, and turns the
  haze pass off at level 0.

## The map

The battle area is a 1.65 km disc (`WORLD.radius`), with the air thinning above 1.7 km (`WORLD.ceiling`): the
Citadel, the moat and the inner face of the mountain ring. Its edge runs along the ring, so the crests, the fjords
and the coast beyond frame the arena. The terrain extends to 3.6 km each way (`WORLD.terrainHalf`), so past the
radius there is scenery only: the outer ring, satellite islands and open sea out to the horizon. Rooms hold up to
10 dragons and bots top them up to 6 (`MAX_PLAYERS`, `BOT_TARGET` in `room.js`). Why 1.65 km: 6 dragons get about
1.4 km2 each, the density 8 had on the 2.2 km map, so the nearest foe is typically about 300 m away (the first
4.2 km map left about 1 km), inside a few seconds of flight at 60-190 m/s with guns effective inside ~500 m.
`tools/encounter-bench.mjs` measures it with a scripted room of bots, optionally with a stand-in for a player
(`tests/encounter.test.mjs` pins the improvement over the old maps, and how long a player keeps foes in view).

Dragons are drawn 1.4x life size (`DRAGON_SCALE` in `constants.js`, with the hitbox scaled to match and the chase
camera's boom lengthened by the same factor, so your own dragon looks as it did) so a foe at fighting range reads as a
dragon, not a dot. Bots meeting a foe nose to nose ease off and offset their line to pass to one side, then turn in
behind; closing on a tail they match speed instead of overshooting; they boost only to catch a foe that is getting
away, and break turns without boosting unless badly hurt. Fights stay in view longer: with a stand-in player in a
6-dragon room, 18% of its looks at a foe (inside 300 m) last under 2 s, against 26% before these changes (8 dragons,
2.2 km, life-size dragons), and a look lasts 7.9 s on average instead of 6.4 s. Over the mountain ring, which the
edge now cuts through, bots keep 120-160 m more air under them (8 bots crashed 0.4 times a minute without that, 0.08
with it).

```
r < 600 m       castle plateau: flat rock at 170 m (world.castleSite), ragged skirt to ~860 m
930-1150 m      the moat: a ring canyon with a stream and rock spires, floor ~60 m
1150-1900 m     the ring: jagged mountains to ~1 km cut by six radial passes; three passes end in sea
                inlets whose head walls carry a waterfall, three run dry to beaches under a stone gate
1650 m          edge of the battle area (stone gates at ~1330 m and the waterfalls at ~1430 m are inside)
1900-2300 m     coast, sea stacks and a sea arch; satellite islands to ~3 km (scenery)
in the air      twelve sky islands (r 38-160 m, 240-1250 m up), 1-1.6 km out, all inside the battle area, two
                carrying a rock ring
```

Castle interface (`world.castleSite`): `{ x: 0, z: 0, radius: 600, height: 170, skirt: 260, clear: 920 }`. The ground
is exactly `height` inside `radius` (`world.plateauAt(x, z)` is 1 there and falls to 0 over the skirt); nothing
else (forest, rocks, ruins, sky islands, stacks, shrines) is placed within `clear` metres of the centre. New solids
hook into `solidAt()` in `shared/world.js`; bots probe `world.hitLandmark()` too.

Rock arches (`world.arches`: centre, axis `yaw`, hole radius `R`, tube radius `t`) are tori that dragons can fly
through (`hitArch`); bots keep a sphere around each one clear. Waterfalls (`world.waterfalls`) are rendered by
`render/falls.js`, following the cliff profile. `node tools/map-preview.mjs out.png` draws a shaded-relief map with
everything marked, without a GPU.

Spawns (`world.spawnPoint`, `SPAWN` in `constants.js`) pick the candidate on a ring 0.64-0.8 radii out (1.06-1.32 km,
outside the Citadel's 1.04 km no-spawn zone and inside the edge warning) whose nearest dragon is closest to 550-950 m
(never under 420 m), high enough to fly clear of the land between it and the castle.
Bots plan their way round the mountains (`planTerrain` in `bots.js`: they probe several distances along their heading
and turn from walls instead of climbing them).

## Developing

```bash
npm install
npm test                         # shared simulation tests (headless)
npm run build                    # client into dist/
npm run serve                    # http://127.0.0.1:8080/ (offline practice works without a server)
```

`npm run serve` also runs the online room server on `/ws`, so **Quick Battle** and private skies work locally.
To let friends on your network join, run `node tools/serve.mjs dist 8080 0.0.0.0` and share your machine's address.
To check the online path end to end, with the server running:

```bash
DRAGON_URL=ws://127.0.0.1:8080/ws node --test tests/online.test.mjs
```

To put it on the internet, any host that serves `dist/` and forwards WebSockets on `/ws` to the same Node process works
(a small VPS, Fly.io, Render, Railway...). `cloudflare/server.js` is plain enough to run in a Cloudflare Durable Object too.

Add `?q=0|1|2` to the page URL to force the graphics level. The game also drops a level by itself if
frames are slow.

`node tools/castle_shots.mjs <url> <prefix> '[{"name":"far","pos":[x,y,z],"look":[x,y,z]}]'` (headless, software GL, so
keep `W=640 H=360` small) waits for the Citadel, parks the title camera and saves a screenshot per camera, printing
`renderer.info` for the frame and the castle's own draw calls and triangles (main pass and shadow pass). The courtyard
floor is at y 640 and the keep's finial at about 1440.

### Rebuilding the assets

```bash
python3 tools/build_audio.py     # -> client/assets/audio/*.mp3 + loudness.json (downloads the source packs, needs ffmpeg + numpy)
```

The outputs are committed, so you only need these to change them.

```bash
python tools/prepare_assets.py   # -> client/assets/sky.jpg, env.hdr, terrain textures (clouds and waves are procedural)
python3 tools/build_world_textures.py      # -> world_cliffb / world_forest / world_ruin textures (Poly Haven)
python3 tools/build_castle_textures.py     # -> castle_<material>_albedo.jpg / _nr.jpg / _h.jpg, six Poly Haven photoscans (CC0)
python3 tools/build_world_assets.py trees rocks ruins crystals   # -> world_*.glb (numpy only;
                                           #    add --preview out.png for a software-rendered contact sheet)
python3 tools/gen_vfx.py         # -> client/assets/vfx_fire/smoke/jet/shapes.png (numpy + Pillow only)
```

**The dragon model.** There are no model or texture files: `DragonView` (`render/dragon.js`) drives a dragon that is
generated in JavaScript at load time (about 0.2 s), with 41 bones, four breed looks and a near and a far LOD.

- `render/dragon-code-util.js` is the toolkit: a vertex pool, lofted tubes with arbitrary cross-sections (UVs are the
  mirrored arc length from the belly line and the distance along the path, counted in scale cells, so there is no
  seam), bezier horns, normals, tangents from the UV layout, grid-cavity and sphere AO, and skinning helpers.
- `dragon-code-geo.js` builds the skeleton and **one continuous skin from the tail tip to the snout**: a loft along
  the spine whose cross-sections are super-ellipses (angular on the skull) displaced by a muscle atlas (pectorals,
  shoulder mass, ribs, haunch, neck muscles, brow ridges, eye sockets with lids, cheek plates, nostrils, lip ridge,
  vertebral humps, belly bands). The jaw, teeth, tongue and eyes are separate meshes tucked into it.
  `dragon-code-limbs.js` has the legs (thigh mass, knee, shin, foot, toes with claws), the wing arms (humerus, forearm,
  knuckled fingers, thumb claw) and the membranes: Coons patches and polar panels between the finger curves with a
  scalloped, sagging trailing edge and a rolled hem. `dragon-code-extras.js` has the per-breed horns, antlers,
  spikes, crystals, sail, hood, ear fins and tail ornaments.
- Skinning weights are computed, not painted: smooth blends along the spine and limb chains (the blend width follows
  the local radius), capsule-distance falloff for the membranes, rigid for horns and teeth.
- Detail is generated, not shipped. Three tileable height fields (overlapping scales whose rows run toward the tail,
  full-width belly plates, voronoi bony plates for the skull) are baked once on the GPU, the first time a body material
  is drawn (about 35 ms, half-float render targets with mipmaps: height, dh/du, dh/dv, per-scale id). The body shader
  reads them with one tap, so the detail is mip-filtered and fades by itself with distance instead of shimmering, and
  it is turned into a bump normal in the generated tangent frame. The scale size follows the loft (large on the back,
  fine on the neck and face, plates on the belly and skull), a low-frequency warp keeps the lattice from reading as a
  grid, and the far LOD has no voronoi plates. The height also drives the cavity darkening, the per-scale tint and
  the ember magma; horn and tooth growth rings are procedural. A 128 px tileable noise gives the stripe, blotch and
  mottle masks that the breeds tint (stripes stay off the face). The membranes get a canvas-drawn vein
  map: branching, tapering veins grown through the same panel curves as the mesh, blurred into a height, normal, AO
  and mottle set, with a backlit translucent glow in the shader.
- About 35k triangles for the body, 5.5k for the wings and 7 to 8k for a breed's extras near; the far LOD is about
  4k in total (body 1.8k, wings 0.6k, eyes 0.7k, extras about 1k). `node --test tests/dragon-code.test.mjs` checks the rig, the skin weights
  and the budgets.

## Credits

- Sky and environment: [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky)
  by Greg Zaal and Jarod Guest, CC0.
- Terrain textures: Poly Haven `aerial_grass_rock`, `aerial_rocks_02`, `aerial_beach_01`, `snow_field_aerial`
  and `cliff_side`, CC0. World textures (also CC0, Poly Haven): `marble_cliff_03` (second cliff layer),
  `forest_leaves_04` (forest litter) and `large_sandstone_blocks` (ruins). Trees, rocks, ruins, the dragon
  skeleton and the crystals are generated procedurally by `tools/build_world_assets.py` (no third-party models).
- The Citadel's materials are Poly Haven photoscans, all CC0 (`tools/build_castle_textures.py` downloads and packs them):
  [`medieval_blocks_03`](https://polyhaven.com/a/medieval_blocks_03) (ashlar),
  [`castle_wall_varriation`](https://polyhaven.com/a/castle_wall_varriation) (rubble),
  [`grey_roof_01`](https://polyhaven.com/a/grey_roof_01) (slate) and
  [`medieval_wood`](https://polyhaven.com/a/medieval_wood) and
  [`metal_plate_02`](https://polyhaven.com/a/metal_plate_02) by Rob Tuytel, and
  [`stone_brick_wall_001`](https://polyhaven.com/a/stone_brick_wall_001) by Dimitrios Savva and Rico Cilliers.
  The fortress itself (every tower, arch, gargoyle and banner) is generated by code in this repository.
- Water normals: three.js examples (MIT).
- Clouds follow the approach of Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015)
  and Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (2020); the noise volumes are
  generated at run time. Ocean displacement is the classic Gerstner sum (Tessendorf, "Simulating Ocean Water").
- Fire, smoke, flame-jet and shape flipbooks (`vfx_*.png`): generated by `tools/gen_vfx.py`, original work, CC0.
- Fonts: [Fraunces](https://github.com/undercasetype/Fraunces) by Undercase Type (`client/fonts/OFL-Fraunces.txt`)
  and [Archivo](https://github.com/Omnibus-Type/Archivo) by Omnibus-Type (`client/fonts/OFL-Archivo.txt`), both SIL
  Open Font License.

### Audio

All audio allows commercial use. `tools/build_audio.py` slices, pitch-shifts, layers, loudness-normalises and encodes
the sources; the numbers below are the sizes of what ships in `client/assets/audio/`. The wind is synthesised in the
engine and needs no recording (the two wind loops of earlier versions, "wind1" by Luke.RUSTLTD and "wind whoosh
loop" by SketchMan3, both CC0, are no longer used). No new third-party recordings were added: the ability layers
(`nova_*`, `chain_*`, `acid_*`, `inferno`, `chill`) reuse the packs below with synthesis, and the alerts and chimes
are original work.

| Use | Source (author, licence) |
| --- | --- |
| Music: menu theme `music_menu.mp3` (2.0 MB), "The Fall of Arcana" | Matthew Pablo, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), [OpenGameArt](https://opengameart.org/content/the-fall-of-arcana-epic-game-theme-music), <https://matthewpablo.com> |
| Music: battle bed `music_battle.mp3` (1.7 MB) and results sting `music_results.mp3` (0.3 MB), "Dream Raid" parts I and III | Matthew Pablo, CC BY 3.0, [OpenGameArt](https://opengameart.org/content/dream-raid-cinematic-action-soundtrack) |
| Dragon roars `roar_1-5` (pitched down, with a sub layer) | "Big scary troll sounds" by Darsycho, CC0, [OpenGameArt](https://opengameart.org/content/big-scary-troll-sounds) |
| Deep bellow `roar_deep` | "CC0 Deep Monster Roar" by trazzz123, CC0, [OpenGameArt](https://opengameart.org/content/cc0-deep-monster-roar) |
| Pain grunts `hurt_1-3` | "80 CC0 creature SFX" by rubberduck, CC0, [OpenGameArt](https://opengameart.org/content/80-cc0-creature-sfx) |
| Wingbeats `flap_1-3` | "Large Wings Flap" by AntumDeluge, CC0, [OpenGameArt](https://opengameart.org/content/large-wings-flap) |
| Wingbeat `flap_4` | "Dragon Flap" by VishwaJai, CC0, [OpenGameArt](https://opengameart.org/content/dragon-flap-0) |
| Fireball launch `fireball_1-3`, flame ignite `breath_start`, seeker | "Fireball" by Julien Matthey (Freesound 105016), CC0, [OpenGameArt](https://opengameart.org/content/fireball-1), layered with "Swishes Sound Pack" by artisticdude, CC0 |
| Flame breath loop `breath_loop` | Kenney "Sci-fi Sounds" `thrusterFire` (CC0) with the crackle of "Fireplace Sound loop" by PagDev, CC0 |
| Explosions `explode_*`, `impact_*` | Kenney "Sci-fi Sounds" and "Impact Sounds" (CC0), "25 CC0 bang / firework SFX" by rubberduck (CC0), "Synthesized explosion" by qubodup (CC0) |
| Water splashes `splash_1-3` | "40 CC0 water / splash / slime SFX" by rubberduck, CC0 |
| Barrel roll `dodge` | "Swishes Sound Pack" by artisticdude, CC0 |
| Ability sounds `nova_*`, `chain_*`, `acid_*`, `inferno`, `chill` | Layers of Kenney "Impact Sounds" (glass) and "Sci-fi Sounds" (low-frequency explosion), "40 CC0 water / splash / slime SFX" by rubberduck and the fireball, swish and monster-roar sources above, with synthesis (`tools/audio_synth.py`, original, CC0) |
| Lock-on and warning tones `lock_*`, `warn_*`, `heartbeat`, `overheat`, shrine chime `heal` | Synthesised in `tools/audio_synth.py`, original work, CC0 |
| Interface, hit and kill sounds `ui_*`, `hit`, `kill`, streak bells `streak_1-3` | Kenney "Interface Sounds" and "Impact Sounds", CC0, <https://kenney.nl> |

CC BY 3.0 attribution (the two Matthew Pablo tracks) is also shown in the in-game Credits panel.
