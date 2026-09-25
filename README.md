# Fauxtons

Photons are the carrier particle of the electromagnetic force, and they are what we see when we shine a flashlight on an object.  If we shine a red light onto the wall we see a red spot, and if we add a green light on the same spot, the red photons and green photons bouncing off the wall combine into what our eyes perceive as yellow.  Photons will happily coexist with each other and their Photon Fields can overlap.

Fauxtons are similar to light but they have a curious property: they don't mix.  If you shine a red light onto the wall you see the same red spot, but if you shine a green light on the same spot, we only see the light that is brighter.  Stranger still, a stronger field occludes a weaker one: where the red field is stronger, the green light is extinguished and cannot continue forward, so it never reaches the darker regions beyond.  You could position two equal flashlights facing each other and the light that they emit would stop each other at a flat midplane between the two, each casting a dark shadow behind the other.  How strange!

## This repo

This repo is an investigation of how best to model fauxtonic behavior on a computer so that we can learn more about their curious properties.  We want to position fauxton light sources in a 3D space and see how the light fields interact.  Interactive visualization is very important to obtain an intuition into Fauxtonics.

## The model

A scene holds lamps and opaque occluders, one of which is the ground. Lamp `i` has a position `o_i`,
a unit axis `a_i`, a power `P_i` and a cone half-angle `α_i`. Write `c_i = cos²α_i`.

**Field.** At a point `x`, let `Δ = x − o_i`, `r = |Δ|` and `cos θ = (a_i · Δ) / r`. The cone profile is

`p_i(x) = (cos²θ − c_i) / (1 − c_i)`

which is 1 on the axis and 0 at the cone's nominal edge. The field is

`F_i(x) = P_i p_i(x)² / r²`

where `a_i · Δ > 0`, `r ≤ R` and `p_i(x) ≥ p_min`, and zero everywhere else. `R` is a range beyond
which no lamp reaches. `p_min` is a cone cutoff: directions whose profile is below it emit no light,
so every cone has a hard edge just inside its nominal one. Without the cutoff, a lamp's field fades
smoothly to zero at its edge, and the isolux veil between it and any other lamp hugs that edge
asymptotically. Along one emission direction the profile is constant, so the cutoff removes whole
rays rather than carving new edges inside the beam. It also keeps the speed of every ray's light,
defined below, above zero.

**Light and extinction.** A lamp emits light along every direction inside its cutoff. The light
travels in a straight line from the lamp and ends at the first of:

- its range `R`;
- the first occluder its ray hits;
- the first point that another lamp's light reaches where that lamp's field is strictly stronger.
  This is extinction.

Light that has been extinguished stays extinguished for the rest of its ray, even if the lamp that
extinguished it weakens or is itself extinguished further on. A lamp's field exists throughout its
cone, but only light that is present can extinguish other light. Nothing bends, scatters or spreads
sideways, and there is no indirect transport. A lamp's light reaches a point `x` when `x` lies on one
of its rays before the point where that ray's light was extinguished.

**Isolux veils.** The surface where two fields are equal, `F_i = F_j`, is their isolux veil. Where the
light of both lamps reaches their isolux veil, each is extinguished just beyond it, because past the
veil the other lamp's field is the stronger one. That is the part of the isolux veil that is visible.
Where the veil passes through space that one or both lamps' light never reaches, nothing happens on
it.

**Dark regions.** A point is dark when every lamp whose cone covers it had its light extinguished or
occluded before arriving. This is common and correct. Beams extinguish each other in mid-air, so a
beam casts a shadow for every lamp whose rays pass through it, including on ground the beam itself
never reaches. The strongest field at a point may belong to a lamp whose light never arrives there;
a weaker lamp whose light did arrive then lights it.

Two cases that follow from these rules:

- Two equal lamps facing each other on a common axis stop each other on the flat midplane between
  them. Neither lamp's light gets past it, so the space behind each lamp, which only the other lamp's
  beam could have lit, is dark.
- Two lamps that emit equally in every direction, with `P_A = 9 P_B`. Their isolux veil is the sphere
  of points three times as far from A as from B, and it encloses B. A's light that meets the sphere is
  extinguished on it and cannot get behind it. So B's light fills the ball and the shadow behind it as
  seen from A, a region bounded by A's rays that graze the sphere, and A's light fills everything
  else. B lights that shadow although A's field is stronger there, because A's light never arrives.

## Field-distance

A lamp's field-distance at a point is `d_i(x) = 1 / √F_i(x)`. Along one emission direction `ω` the
profile is a constant `p_i(ω)`, so at distance `t` along the ray

`d_i = t / (√P_i p_i(ω))`

Field-distance grows in proportion to distance along every ray. The constant `v_i(ω) = √P_i p_i(ω)` is
the speed of the light along that ray.

It helps to read field-distance as time, with every lamp sending out a ping. At time `d`, every lamp's
ping sits on its own isolux shell of brightness `1 / d²`, so all pings dim together at the same rate
and differ only in how far out that shell is. Along each ray a ping moves outward at a constant speed:
fast along a bright lamp's axis, slow near a cone edge. Brighter at a point means arrived earlier.
Extinction then reads: the first ping to reach a point keeps it, and a ping arriving later freezes
there. Two pings meet face to face only on their isolux veil, where they arrive at the same time.
Elsewhere, a later ping freezes where it enters space an earlier ping has already filled, usually well
behind that earlier ping's leading edge.

**The ordering.** Light of lamp `i` can be extinguished at `x` only by a lamp `j` with
`F_j(x) > F_i(x)`, that is `d_j(x) < d_i(x)`. Whether `j`'s light reaches `x` depends only on what
happened on `j`'s ray before `x`, and every point there has `d_j < d_j(x)`. So every decision at
field-distance `d` depends only on decisions at field-distances smaller than `d`. The dependency is
well founded, which has three consequences:

- the solution is unique;
- deciding every point in increasing field-distance decides each one once, with nothing to revisit;
- it gives a direct recursive definition: `j`'s light reaches `x` if at no point of `j`'s ray before
  `x` is another lamp both brighter and reached by its own light. Each test in that recursion is at a
  smaller field-distance, so it terminates. Slow as it is, it is exact, which makes it a check for any
  faster method.

A discrete approximation keeps the first two properties only if every decision it makes at
field-distance `d` depends on nothing decided at a larger field-distance.

## What is visible

- At most one lamp's light is present at a point, except on an isolux veil, where neither field is
  stronger. If two lamps' light were present at a point and one were brighter, the dimmer would have
  been extinguished there.
- A surface is lit by the lamp whose light reaches it, and is dark where none does.
- In the air, a lamp's light is visible where it is present, in that lamp's colour and with that
  lamp's field strength.
- An isolux veil is visible where the light of both of its lamps reaches it.

## Parameters

| Symbol | Meaning | Typical value |
|---|---|---|
| `P_i` | lamp power | 18 to 30 |
| `α_i` | cone half-angle | 36° to 44° |
| `R` | range | 18 |
| `p_min` | cone cutoff on the profile | 0.01 |

Distances are in scene units. These values suit lamps a few units above the ground and a few units
apart.

## Lighting Spot from inside

The scene is a Spot 24 units tall with its lamps inside, lighting its walls from within: a sculpture of
translucent cells, one lamp to each, whose patches of wall should all be lit evenly, with no dark spots,
no hot spots and no jumps in brightness where patches meet.

- **Layouts.** A layout is where each lamp is, where it points and how bright it is, with a dimmer
  that turns it down to half its full power at most. The page shows the saved layout in `layouts/` for
  the number of lamps chosen, or places that many afresh.
- **Placing lamps.** Lamps go in clusters, a few back to back at one place, facing out. Lamps that share
  a place never cut into each other's light, and where their patches meet, their fields and their
  angles of incidence agree, so the brightness carries on across the seam. Places are picked one at a
  time, each where a lamp could light well the most of the wall not yet lit well, until another would
  add less than a twentieth of the wall: seams between clusters jump, so a few large clusters light
  Spot more evenly than many small ones (`src/clusters.js`). Lamps are shared out between places by the
  solid angle of wall each serves, and aimed to split it evenly; new layouts get colours that differ
  wherever patches meet (`src/colors.js`).
- **Optimising.** Each round solves the cells, measures how every vertex of Spot is lit, and moves
  every lamp a damped Gauss-Newton step towards lighting its patch at the mean brightness, in log terms.
  A lamp slides along its own axis, turns and dims; a cluster moves by the push of all its lamps. Dark
  vertices pull on the nearest cone, and where one lamp's light cuts off another's, both are pushed apart.
  Moves that leave more of Spot dark are undone (`src/optimizer.js`).
- **Measures.** The readout gives the share of the wall left dark, the ratio of the 95th to the 5th
  percentile of brightness over the lit wall, and the share of seams where the brightness jumps by more
  than a fifth.

Optimise runs rounds until it is pressed again, then shows the best layout found; Save writes it to
`layouts/` through the development server.
