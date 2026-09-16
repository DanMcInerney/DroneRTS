"""Sparse original street furniture authored in Blender at ten metres per unit.

Call from build-graphics.py before exporting cincinnati::

    streets = runpy.run_path(str(ROOT / 'scripts/graphics-streets.py'))
    streets['build_streets'](bpy, city, {
        'empty': empty, 'material': material, 'SurfaceBatch': SurfaceBatch,
        'finish': finish, 'join_by_material': join_by_material, 'xyz': xyz,
    })

The returned cincinnati-street-details root is separate from building/roof
meshes. It is cosmetic scenery, never collision geometry or actor metadata.
Street View reference: 226 East Third Street (May 2025) and 313 Vine Street.
Cantilever hardware, black poles and yellow hydrants are observed types; exact
siting, green sign legends and dimensions are artist approximations. No Google
imagery, map tiles or third-party fonts are copied into the assets.
"""
import math


def _segments(city, name=None):
    for road in city['roads']:
        if name is not None and road['name'] != name:
            continue
        for a, b in zip(road['points'], road['points'][1:]):
            dx, dz = b['x'] - a['x'], b['z'] - a['z']
            length = math.hypot(dx, dz)
            if length > 1e-6:
                yield road, a, b, dx / length, dz / length, length


def _projection(x, z, a, dx, dz, length):
    distance = max(0, min(length, (x - a['x']) * dx + (z - a['z']) * dz))
    return a['x'] + dx * distance, a['z'] + dz * distance


def _building_clear(city, x, z, margin=.085):
    for building in city['buildings']:
        if building.get('baseY', 0) > .9:
            continue
        angle = math.radians(building.get('rotation', 0))
        c, s = math.cos(angle), math.sin(angle)
        dx, dz = x - building['x'], z - building['z']
        if (abs(c * dx - s * dz) < building['width'] / 2 + margin and
                abs(s * dx + c * dz) < building['depth'] / 2 + margin):
            return False
    return True


def street_site(city, name, target, side=1):
    """Project an artist-selected vicinity onto a mapped curb, outside traffic.

    Local u crosses the road; v follows it. The two Third Street signs face
    west, and road rotation comes from its nearest actual source segment.
    Small deterministic shifts avoid simplified building corners and junctions.
    """
    candidates = []
    for road, a, _, dx, dz, length in _segments(city, name):
        x, z = _projection(*target, a, dx, dz, length)
        candidates.append((math.hypot(x - target[0], z - target[1]), road, a, dx, dz, length))
    if not candidates:
        raise ValueError('Street detail source road missing: ' + name)
    for _, road, a, dx, dz, length in sorted(candidates, key=lambda item: item[0]):
        x, z = _projection(*target, a, dx, dz, length)
        # Stable eastward/southward local orientation, independent of OSM order.
        if dx < 0:
            dx, dz = -dx, -dz
        nx, nz = -dz, dx
        curb = (road['width'] / 2 + .17) * side
        for shift in (0, .5, -.5, 1, -1, 1.5, -1.5):
            cx, cz = x + dx * shift, z + dz * shift
            px, pz = cx + nx * curb, cz + nz * curb
            if math.hypot(cx - target[0], cz - target[1]) > 2.5:
                continue
            if not _building_clear(city, px, pz):
                continue
            on_road = False
            for other, start, _, ux, uz, distance in _segments(city):
                qx, qz = _projection(px, pz, start, ux, uz, distance)
                if math.hypot(px - qx, pz - qz) < other['width'] / 2 + .055:
                    on_road = True
                    break
            if not on_road:
                return {'road': name, 'x': cx, 'z': cz, 'dx': dx, 'dz': dz,
                        'nx': nx, 'nz': nz, 'curb': curb}
    raise ValueError('No clear curb for street detail: ' + name + ' ' + str(target))


def street_layout(city):
    """Client asset layout only; exact prop positions never enter actor files."""
    return {
        'signs': [
            (street_site(city, 'East 3rd Street', (34.5, 24.2)), 'I-71 NORTH', 'Columbus'),
            (street_site(city, 'West 3rd Street', (-23.5, 35.3)), 'I-75 SOUTH', 'Kentucky'),
            (street_site(city, 'East 2nd Street', (17, 35.9)), 'RIVERFRONT', 'The Banks'),
        ],
        'lights': [
            street_site(city, 'Vine Street', (-7, 11.1)),
            street_site(city, 'East 3rd Street', (5.6, 29.7)),
            street_site(city, 'East 3rd Street', (21.7, 26.6)),
            street_site(city, 'East 2nd Street', (29.5, 33.4)),
        ],
        'hydrants': [
            street_site(city, 'Vine Street', (-4.4, 24.6), -1),
            street_site(city, 'East 3rd Street', (8, 29.2)),
        ],
    }


def build_streets(bpy, city, helpers):
    """Build and return one static root, batched into five material meshes."""
    from mathutils import Matrix

    material = helpers['material']
    root = helpers['empty']('cincinnati-street-details')
    batch = helpers['SurfaceBatch']()
    green = material('Street sign enamel', '#086c4e', .6)
    white = material('Street sign lettering', '#f0f1dc', .65)
    aluminum = material('Street galvanized steel', '#99a3a3', .46, .48)
    black = material('Street black enamel', '#252b2c', .66, .18)
    yellow = material('Street hydrant yellow', '#e6b631', .65)
    layout = street_layout(city)

    def transform(site, p):
        u, y, v = p
        return (site['x'] + site['nx'] * u + site['dx'] * v,
                y, site['z'] + site['nz'] * u + site['dz'] * v)

    def cube(site, p, size, surface):
        # Across/up/along is left-handed. Flip local depth for SurfaceBatch's
        # right-handed box winding, while retaining the requested physical pose.
        batch.cube(p[0], p[1], -p[2], *size, surface,
                   lambda point: transform(site, (point[0], point[1], -point[2])))

    def tube(site, u, bottom, top, radius, surface, top_radius=None):
        # Ten-sided circular posts retain shape at camera resolution cheaply.
        points = []
        for y, r in [(bottom, radius), (top, top_radius if top_radius is not None else radius)]:
            points.append([transform(site, (u + math.cos(i * math.tau / 10) * r,
                                           y, math.sin(i * math.tau / 10) * r))
                           for i in range(10)])
        for i in range(10):
            j = (i + 1) % 10
            batch.quad([points[0][j], points[1][j], points[1][i], points[0][i]], surface)
        batch.quad(list(reversed(points[0])), surface, [(0, 0)] * 10)
        batch.quad(points[1], surface, [(0, 0)] * 10)

    def lettering(site, label, u, y, max_width, height):
        curve = bpy.data.curves.new('Original guide sign lettering', 'FONT')
        curve.body = label
        curve.align_x = 'CENTER'
        curve.align_y = 'CENTER'
        curve.size = height
        curve.resolution_u = 4
        curve.extrude = 0
        curve.fill_mode = 'BOTH'
        ob = bpy.data.objects.new('Guide sign ' + label, curve)
        bpy.context.collection.objects.link(ob)
        ob.location = helpers['xyz'](transform(site, (u, y, -.010)))
        # Blender font X is sign-across, Y is vertical, Z faces approaching cars.
        basis = Matrix(((site['nx'], 0, -site['dx']),
                        (-site['nz'], 0, site['dz']),
                        (0, 1, 0)))
        ob.rotation_euler = basis.to_euler()
        bpy.context.view_layer.update()
        width = max(vertex[0] for vertex in ob.bound_box) - min(vertex[0] for vertex in ob.bound_box)
        ob.scale.x = min(1, max_width / max(width, 1e-6))
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.convert(target='MESH')
        helpers['finish'](bpy.context.object, 'Guide sign ' + label, white, root)

    for site, upper, lower in layout['signs']:
        u = site['curb'] - .65
        width, height, center = .86, .25, .68
        tube(site, site['curb'], 0, .84, .016, aluminum, .012)
        cube(site, (site['curb'], .014, 0), (.075, .028, .075), aluminum)
        cube(site, (site['curb'] - .54, .82, .028), (1.11, .024, .032), aluminum)
        # The gray back, two support rails and hangers make the sign physical.
        cube(site, (u, center, .002), (width, height, .010), aluminum)
        cube(site, (u, center, -.004), (width, height, .006), green)
        for rail_y in [center - .07, center + .07]:
            cube(site, (u, rail_y, .018), (width + .012, .014, .023), aluminum)
        for across in [-.26, .26]:
            cube(site, (u + across, .75, .026), (.015, .16, .020), aluminum)
        for across in [-width / 2 + .012, width / 2 - .012]:
            cube(site, (u + across, center, -.0075), (.006, height - .021, .001), white)
        for y in [center - height / 2 + .012, center + height / 2 - .012]:
            cube(site, (u, y, -.0075), (width - .021, .006, .001), white)
        lettering(site, upper, u + .055, center + .045, .64, .059)
        lettering(site, lower, u + .055, center - .037, .60, .061)
        # One simple downward lane arrow, without raster icons or tiny labels.
        arrow_u = u - .32
        cube(site, (arrow_u, center + .007, -.008), (.015, .080, .001), white)
        batch.quad([transform(site, p) for p in [
            (arrow_u - .040, center - .024, -.009),
            (arrow_u, center - .065, -.009),
            (arrow_u + .040, center - .024, -.009)]], white, [(0, 0)] * 3)

    for site in layout['lights']:
        u = site['curb']
        tube(site, u, 0, .075, .024, black, .020)
        tube(site, u, .06, .84, .012, black, .007)
        cube(site, (u - .11, .825, 0), (.23, .014, .014), black)
        cube(site, (u - .255, .815, 0), (.11, .025, .044), black)
        cube(site, (u - .257, .8015, 0), (.079, .002, .032), white)

    for site in layout['hydrants']:
        u = site['curb']
        tube(site, u, 0, .018, .029, yellow)
        tube(site, u, .013, .088, .021, yellow)
        tube(site, u, .085, .110, .025, yellow, .008)
        cube(site, (u, .059, 0), (.072, .024, .024), yellow)
        for side in [-1, 1]:
            cube(site, (u + side * .039, .059, 0), (.008, .025, .026), black)
        cube(site, (u, .112, 0), (.014, .007, .014), yellow)

    batch.build(root)
    helpers['join_by_material'](root)
    root['source'] = 'Original Blender geometry; street furniture observed in Google Street View, May 2025, East Third/Vine; siting, dimensions and legends approximated'
    root['guideSigns'] = len(layout['signs'])
    root['streetlights'] = len(layout['lights'])
    root['hydrants'] = len(layout['hydrants'])
    return root
