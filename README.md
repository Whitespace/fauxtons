# Fauxtons

Photons are the carrier particle of the electromagnetic force, and they are what we see when we shine a flashlight on an object.  If we shine a red light onto the wall we see a red spot, and if we add a green light on the same spot, the red photons and green photons bouncing off the wall combine into what our eyes perceive as yellow.  Photons will happily coexist with each other and their Photon Fields can overlap.

Fauxtons are similar to light but they have a curious property: they don't mix.  If you shine a red light onto the wall you see the same red spot, but if you shine a green light on the same spot, we only see the light that is brighter.  Stranger still, a stronger field occludes a weaker one: where the red field is stronger, the green light is extinguished and cannot continue forward, so it never reaches the darker regions beyond.  You could position two equal flashlights facing each other and the light that they emit would stop each other at a flat midplane between the two, each casting a dark shadow behind the other.  How strange!

## This repo

This repo is an investigation of how best to model fauxtonic behavior on a computer so that we can learn more about their curious properties.  We want to position fauxton light sources in a 3D space and see how the light fields interact.  Interactive visualization is very important to obtain an intuition into Fauxtonics.

## The model

A scene holds lamps and opaque occluders, one of which is the ground. Lamp `i` has a position `o_i`,
a unit axis `a_i` and a power `P_i`. The lamps are LEDs of one type, so they share one beam: its
brightness falls to half at an angle `α` off the axis, and would fade to nothing at an angle `β`. Write
`c = cos β`.

**Field.** At a point `x`, let `Δ = x − o_i`, `r = |Δ|` and `cos θ = (a_i · Δ) / r`. The beam profile is

`p_i(x) = ((cos θ − c) / (1 − c))^m`

which is 1 on the axis and 0 at `β`, with the exponent `m` that makes `p² = ½` at `α`. The field is

`F_i(x) = P_i p_i(x)² / r²`

where `cos θ > c`, `r ≤ R` and `p_i(x) ≥ p_min`, and zero everywhere else. `R` is a range beyond
which no lamp reaches. `p_min` is a cutoff: directions whose profile is below it emit no light, so
every beam has a hard edge short of `β`. Without the cutoff, a lamp's field fades smoothly to zero at
its edge, and the isolux veil between it and any other lamp hugs that edge asymptotically. Along one
emission direction the profile is constant, so the cutoff removes whole rays rather than carving new
edges inside the beam. It also keeps the speed of every ray's light, defined below, above zero.

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

## Solving from sight

The page solves the cells one of two ways, over the same maps of each lamp's rays (`src/solver.js`).

- **The sweep** decides every point in increasing field-distance, as above. Then each ray is followed
  exactly against the other lamps' light twice, to catch thin layers of light the sweep stepped over.
- **Solve from sight** starts with every lamp's light reaching as far as nothing solid is in its way.
  Each ray is then followed exactly against the other lamps' light as the last pass left it, and cut
  where it runs into stronger light, pass after pass. After the first pass, each lamp's light reaches
  where it is the brightest lamp in sight all the way from the lamp; later passes let light into the
  shadows of light that was itself cut short.

The brightest lamp in sight is not the model on its own, as both cases above show: it would light the
dark space behind each of two facing lamps, and give the shadow behind B's ball to A. On the saved
64-lamp layout it gets about 3% of Spot's walls wrong, lighting them where no light gets or giving them
to a lamp whose light was stopped on the way (`fauxton.checkSight()`). The passes settle on the
model's solution all the same, because each cut depends only on light at smaller field-distances; they
revisit points rather than deciding each once. A few hundred of the millions of rays never settle,
whichever way the solve starts: most reach Spot's wall in one pass and stop a few millimetres short of it
in the next. The solve ends once only those are left. It gives the same cells as the sweep, and takes
half as long in Spot and an eighth as long in the orb.

## What is visible

- At most one lamp's light is present at a point, except on an isolux veil, where neither field is
  stronger. If two lamps' light were present at a point and one were brighter, the dimmer would have
  been extinguished there.
- A surface is lit by the lamp whose light reaches it, and is dark where none does.
- In the air, a lamp's light is visible where it is present, in that lamp's colour and with that
  lamp's field strength.
- An isolux veil is visible where the light of both of its lamps reaches it.

## Parameters

| Symbol | Meaning | Value |
|---|---|---|
| `P_i` | lamp power | 50 to 100 |
| `α` | angle off the axis where the beam is half as bright | 40° |
| `β` | angle where the beam would fade to nothing | 100° |
| `R` | range | 18 |
| `p_min` | cutoff on the profile | 0.15 |

Distances are in scene units of 10 mm. The beam is a cautious model of the 5050 and 2020 LEDs the
sculptures are built with, narrower rather than wider than theirs. Each lamp's light is solved over a
map of its directions, which can't reach 90°, so `p_min` cuts the beam off at 80°, where it is down to
about 2% of its brightness on the axis. The map places each direction by its angle off the lamp's axis
along each of the map's two axes, so its texels are spread about evenly over the beam.

## Lighting Spot from inside

The scene is a Spot 24 units tall with its lamps inside, lighting its walls from within: a sculpture of
translucent cells, one lamp to each, whose patches of wall should all be lit evenly, with no dark spots,
no hot spots and no jumps in brightness where patches meet.

- **Layouts.** A layout is where each lamp is, where it points and how bright it is, with a dimmer
  that turns it down to half its full power at most. The page shows the saved layout in `layouts/` for
  the number of lamps chosen, or places that many afresh.
- **Placing lamps.** Lamps go in clusters, a few back to back at one place, facing out. Lamps that share
  a place never cut into each other's light, and where their patches meet, their fields and their
  angles of incidence agree, so the brightness carries on across the border. Places are picked one at a
  time, each where a lamp could light well the most of the wall not yet lit well: three, and then one
  more for about every 18 lamps. Brightness steps where patches of different clusters meet, and small
  clusters light their walls unevenly, so a few large clusters do best: three for 64 lamps, seven for
  128 (`src/clusters.js`).
  Lamps are shared out between places by the solid angle of wall each serves, and aimed to split it
  evenly; new layouts get colours that differ wherever patches meet (`src/colors.js`).
- **Optimising.** Each round solves the cells, measures how every vertex of Spot is lit, and moves
  every lamp a damped Gauss-Newton step towards lighting its patch at the mean brightness, in log terms.
  A lamp slides along its own axis, turns and dims; a cluster moves by the push of all its lamps. Dark
  vertices pull on the nearest cone, and where one lamp's light cuts off another's, both are pushed apart.
  Moves that leave more of Spot dark are undone (`src/optimizer.js`).
- **Measures.** The readout gives the share of the wall left dark, and how evenly each patch is lit:
  its brightest point over its darkest, in the median patch and the worst. The dimmers can even out
  whole patches against each other, but not a patch in itself. A dark spot belongs to the patch around
  it, the nearest lit one, and a patch with a black spot, somewhere that gets less than a hundredth of
  its brightest light, is counted apart. Each patch is measured at its vertices and where its borders
  cross the mesh's edges, so that every patch is measured right up to its corners. The measures are of
  the light arriving from the lamps in a straight line, never of light the shell spreads.

Optimise runs rounds until it is pressed again, then shows the best layout found; Save writes it to
`layouts/` through the development server.

## Spread in the shell

The shell is milky resin, which spreads light sideways as it passes through. Spread shows that, for
looking at only (`src/diffusion.js`): no amount of it is relied on to light what no lamp can see, so the
measures ignore it. Light scatters sideways through the resin as it crosses the shell and leaks out of
both faces as it goes: diffusion with loss in a thin sheet, the screened Poisson equation `M − ℓ² ΔM = E`
on the surface, for the light `E` arriving and `M` leaving. `ℓ`, in millimetres, is how far it spreads:
most light comes out within `2ℓ` of where it went in. Light stays in its cell, as the walls between
cells stop it and send it back, and a dark spot is in the cell of the patch around it.

## Opaque sheets

Opaque draws the veils and the boundaries of the lit volumes as solid walls rather than glowing sheets,
without the light in the air. The walls are found for every pixel: the view is followed from cell to
cell until the light it is in ends. A veil is drawn where the two fields are equal and both lights get
there, Spot's surface where the view meets its triangles, and the edge of a shadow along the rays of the
lamp that makes it. With Veil, the view goes on past any other wall to the first veil; with
Boundaries, it stops at the first wall. A wall is in the colour of the cell the view is in, so looking
at a cell from outside shows the inside of its far walls.

Opaque v2 draws the walls from the boundary meshes instead, for about what the glowing boundaries cost:
each lamp's mesh is solid, flat shaded in the lamp's colour, and drawn only from inside its lit volume,
so a cell seen from outside again shows the inside of its far walls. With Veil and not Boundaries, only
the parts of the meshes on veils are drawn. The walls have the meshes' flaws.

## Backface culling

The light in the air is each lamp's light added up along the view, with nothing in front hiding
anything behind. Backface culling shows at each pixel only the cell owning the patch of surface in view
there, the one lighting it, whichever way its lamp points: everything behind is hidden, and nothing
shows where no patch is in view. It applies to whatever is drawn: the light in the air, the veils and
the boundaries.

## The 2D grid

`2d.html` spreads the light of lamps on a grid of 256 × 256 cells, a tick at a time, to compare ways of
doing it, with the beam and field above. Click a cell to place a lamp, then click where it should face:
the further from the lamp, the brighter it is, as its field on its axis is 1 there. Tick runs one tick,
Run ticks until nothing changes, and Reset goes back to no light (`src/grid2d/`). Copy URL copies a link
with the lamps and settings, and opening it gives them back, with no light yet.

- **Flood fill:** each tick, the lamps take turns, the most powerful first. In its turn a lamp's light
  spreads into each cell next to it that the lamp can see in a straight line and that is unlit or lit by
  a lamp weaker there, as the lamps before it left the grid. A cell on the line lit by a lamp at least as
  strong there blocks the sight. A cell keeps its light until a stronger lamp takes it.
- **JFA:** the same, but a lamp's light spreads into the cells a step away from it along the rows,
  columns and diagonals rather than next to it, so with a step of 1 it is the flood fill. The step halves
  each tick unless told not to.
- **Fill and kill:** the flood fill's rule, carried by creatures only to where something may change. A fill
  creature tries to light its cell for its lamp; when it does, fill creatures hatch on the cell's
  neighbours, and kill creatures on neighbours further on whose lamps the cell now cuts off. A kill creature
  puts out its cell if its lamp can no longer see it, spreads to the cells that lamp lights around it, and
  leaves fill creatures for the lamps around to light the cell again. Kill creatures move while any are
  alive; then fill creatures move, the most powerful lamp's first. A tick moves one generation.

Once a pass settles, **Additional pass** runs the chosen algorithm again from no light, judging the line
of sight against the grid as the last pass left it, and then says how many cells it changed, if any.
**Show changed** makes those cells blink, or while a pass runs, the cells its last tick changed. Under
the grid, the page lists for each lamp and each other lamp that took cells from it in the pass the
brightest of those cells, as the first lamp's field there.

The status counts the work done as comparisons, the same way for every algorithm: one each time a pass
looks at a cell of the grid, to decide the cell in a lamp's turn or a creature's move, to look at one of
the eight cells around it, or to follow a line of sight through it.

## The orb

The orb scene is a sculpture that has been built, to compare the model with: a sphere 250 mm across,
split into the 60 pentagons of a pentagonal hexecontahedron, with an LED 50 mm under the middle of each,
facing out. Its lamps lie along the directions of a snub dodecahedron's vertices, so by symmetry each
pair of neighbours meets on the plane between them, and the cells come out as the pentagons.
