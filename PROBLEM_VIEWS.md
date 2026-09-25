# Problem views

Views that show rendering problems, to revisit after changes. Open a link with the dev server
running (`mise run dev`); the Copy link button gives the link for the current view.

## Open

- **Dark teeth along floor edges near Spot's front right foot.**
  [View](http://localhost:8000/#az=150.00&el=12.00&d=4.500&t=0.520,0.000,-0.600&fov=2.0&spot=1&veil=0&bounds=0)
  - There's a staircase of small dark triangles along the orange/green and blue/green boundaries on
    the floor, about two map texels apart.
  - Not yet diagnosed. It's probably another lamp's light edge read from its map.
- **Ghostly fringe along the veil.**
  [View](http://localhost:8000/#az=348.46&el=-3.00&d=8.676&t=0.000,1.600,0.000&fov=40.0&spot=0&veil=1&bounds=0)
  - The veil stopping short of the floor is correct: it ends where blue's rays graze it.
  - The fringe along its edge is an artifact: stretched veil triangles near triple lines, and copies
    drawn from lamps whose rays graze the veil.
- **Needle lines in the Boundaries view.**
  [View](http://localhost:8000/#az=245.96&el=-3.00&d=5.804&t=0.000,1.600,0.000&fov=40.0&spot=0&veil=0&bounds=1)
  - There are long thin streaks on the shadow walls under the veils.
- **Low-resolution Boundaries view.**
  [View](http://localhost:8000/#az=79.31&el=2.24&d=5.184&t=0.000,1.600,0.000&fov=40.0&spot=0&veil=0&bounds=1)
  - The boundary surfaces look like a stretched, swimming low-resolution texture, because they're built
    from the maps.

## Fixed

- **Dark wedge on Spot's back, where the ear's shadow stripes meet.**
  [View](http://localhost:8000/#az=24.51&el=83.96&d=11.952&t=0.110,1.500,-0.010&fov=5.0&spot=1&veil=0&bounds=0)
  - Green's light was cut off there by orange light that orange's map wrongly showed as present.
  - Orange's light really ends a few centimetres above the surface, where it meets a thin layer of blue
    light that the sweep stepped over.
  - Fixed by refining the maps ray by ray after the sweep (b0e07ee).
  - A thin dark sliver along the orange/green edge at the junction is real: the reference finds those
    points dark too.

- **Purple spikes and staircase shadows under the belly.**
  [View](http://localhost:8000/#az=150.00&el=12.00&d=4.500&t=0.100,0.250,0.000&fov=14.0&spot=1&veil=0&bounds=0)
  - Fixed by exact surface lighting (0a2033e).
- **Jagged shards where green's light grazes the leg.**
  [View](http://localhost:8000/#az=150.00&el=12.00&d=4.500&t=0.220,0.620,-0.430&fov=3.0&spot=1&veil=0&bounds=0)
  - Fixed by refining Spot and testing light at its smooth surface (0a2033e).
