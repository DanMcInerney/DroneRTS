"""Rebuild original Blender assets: blender --background --python scripts/build-graphics.py.

Coordinates are authored in game XYZ then mapped to Blender X,-Z,Y. The glTF
exporter returns them to game XYZ. City surfaces retain the authoritative boxes;
window/roof detailing is a flush skin, not a new obstacle or navigable opening.
"""
import bpy
import math
import json
import hashlib
import random
import struct
import zlib
import runpy
import numpy as np
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'client/assets'
SOURCE = ROOT / 'assets/blender'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(parents=True, exist_ok=True)
(SOURCE / 'textures').mkdir(exist_ok=True)
bpy.context.preferences.filepaths.save_version = 0
random.seed(24)


def xyz(p):
    return (p[0], -p[2], p[1])


def linear(v):
    return v / 12.92 if v < .04045 else ((v + .055) / 1.055) ** 2.4


def material(name, color, rough=.7, metal=0):
    mat = bpy.data.materials.new(name)
    rgb = [linear(int(color[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    return mat


def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def empty(name):
    ob = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(ob)
    return ob


def finish(ob, name, mat, parent=None):
    ob.name = name
    ob.data.materials.append(mat)
    ob.parent = parent
    return ob


def box(name, pos, size, mat, parent=None, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz(pos))
    ob = bpy.context.object
    ob.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = ob.modifiers.new('Molded edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        bpy.ops.object.modifier_apply(modifier=mod.name)
        normal = ob.modifiers.new('Weighted surface normals', 'WEIGHTED_NORMAL')
        bpy.ops.object.modifier_apply(modifier=normal.name)
    return finish(ob, name, mat, parent)


def cylinder(name, pos, radius, depth, mat, parent=None, forward=False, vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=xyz(pos))
    ob = bpy.context.object
    if forward:
        ob.rotation_euler.x = math.pi / 2
    for face in ob.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    return finish(ob, name, mat, parent)


def torus(name, pos, radius, thickness, mat, parent=None):
    bpy.ops.mesh.primitive_torus_add(major_segments=40, minor_segments=8, location=xyz(pos), major_radius=radius, minor_radius=thickness)
    ob = bpy.context.object
    for face in ob.data.polygons:
        face.use_smooth = True
    return finish(ob, name, mat, parent)


def join_by_material(parent):
    # Retain named equipment roots, but reduce each part to one draw per material.
    groups = {}
    for ob in list(parent.children):
        if ob.type == 'MESH':
            groups.setdefault(ob.data.materials[0].name, []).append(ob)
    for name, objects in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for ob in objects:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        objects[0].name = parent.name + '_' + name


def export(name):
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / (name + '.blend')))
    # Blender 5.2 Meshopt applies a fixed 12-bit exponential POSITION filter.
    # At city-scale coordinates it rounds sub-meter trim and gives coplanar
    # vertices different heights. Preserve the city's original float geometry;
    # the small origin-centered aircraft kit can retain compressed positions.
    bpy.ops.export_scene.gltf(filepath=str(OUT / (name + '.glb')), export_format='GLB',
        export_animations=False, export_cameras=False, export_lights=False, export_extras=True,
        export_meshopt_compression_enable=name != 'cincinnati')


reset()
shell = material('Porcelain polymer', '#d6dad8', .36)
team = material('Team paint', '#ffffff', .52)
light = material('Team light', '#ffffff', .3)
light_bsdf = light.node_tree.nodes.get('Principled BSDF')
light_bsdf.inputs['Emission Color'].default_value = (1, 1, 1, 1)
light_bsdf.inputs['Emission Strength'].default_value = 2
dark = material('Graphite polymer', '#272e33', .57)
rubber = material('Grip rubber', '#151c20', .9)
metal = material('Brushed aluminum', '#8b989c', .3, .72)
glass = material('Camera glass', '#203c47', .12, .55)
ochre = material('Ochre crate', '#bd8c27', .87)
ink = material('Cargo ink', '#171b1d', .92)

airframe = empty('airframe')
box('Lower chassis', (0, -.012, 0), (.22, .10, .29), team, airframe, .035)
box('Molded shell', (0, .025, -.005), (.23, .11, .30), team, airframe, .042)
box('Broad team panel', (0, .072, .015), (.15, .019, .205), team, airframe, .009)
for x in [-.17, .17]:
    for z in [-.15, .15]:
        arm = box('Swept arm', (x / 2, .015, z / 2), (.21, .033, .042), team, airframe, .015)
        arm.rotation_euler.z = -math.atan2(z, x)
        torus('Propeller guard', (x, .051, z), .085, .005, team, airframe)
        torus('Lower guard lip', (x, .013, z), .085, .003, team, airframe)
        torus('Navigation light upper', (x, .046, z), .084, .008, light, airframe)
        torus('Navigation light lower', (x, .008, z), .084, .006, light, airframe)
        cylinder('Brushless motor', (x, .043, z), .021, .044, metal, airframe)
        cylinder('Motor cap', (x, .068, z), .013, .008, dark, airframe)
        for angle in [0, math.pi / 2]:
            blade = box('Propeller blade', (x, .060, z), (.149, .0035, .014), rubber, airframe, .0017)
            blade.rotation_euler.z = angle + (x * z * 37)
        for angle in [0, math.pi / 2, math.pi, math.pi * 1.5]:
            spoke = box('Guard brace', (x + math.cos(angle) * .065, .043, z + math.sin(angle) * .065), (.042, .003, .004), team, airframe, .001)
            spoke.rotation_euler.z = -angle
            box('Guard upright', (x + math.cos(angle) * .085, .032, z + math.sin(angle) * .085), (.005, .038, .005), team, airframe, .0015)
        cylinder('Landing strut', (x * .86, -.024, z * .9), .008, .080, metal, airframe, vertices=16)
        box('Landing foot', (x * .86, -.066, z * .9), (.022, .034, .038), rubber, airframe, .006)
box('Gimbal yoke', (0, .003, -.147), (.112, .064, .035), dark, airframe, .012)
cylinder('Camera barrel', (0, .004, -.173), .038, .040, metal, airframe, True)
cylinder('Lens bezel', (0, .004, -.195), .031, .008, rubber, airframe, True)
cylinder('Lens', (0, .004, -.200), .024, .002, glass, airframe, True)
for x in [-.027, .027]:
    box('Vent slot', (x, .071, .11), (.035, .002, .007), dark, airframe, .0008)
for z in [-.07, -.055, -.04]:
    box('Rear shell vent', (0, -.041, z), (.07, .002, .006), dark, airframe)

armor = empty('armor-plates')
for x in [-.121, .121]:
    box('Replaceable side armor', (x, -.004, .012), (.013, .085, .18), metal, armor, .005)
box('Rear armor bumper', (0, .013, .15), (.19, .035, .014), metal, armor, .006)

gun = empty('gun')
box('Gun housing', (0, .059, -.015), (.081, .053, .10), dark, gun, .009)
cylinder('Gun barrel', (0, .058, -.13), .018, .18, metal, gun, True)
cylinder('Gun muzzle', (0, .058, -.223), .012, .007, rubber, gun, True)
optics = empty('optics')
cylinder('Optics housing', (0, .003, -.218), .045, .075, dark, optics, True)
cylinder('Optics lens', (0, .003, -.257), .035, .002, glass, optics, True)
grip = empty('cargo-grip')
for x in [-.10, .10]:
    box('Cargo clamp', (x, -.104, 0), (.016, .087, .14), metal, grip, .005)
    box('Clamp pad', (x * .93, -.143, 0), (.022, .012, .12), rubber, grip, .003)
rack = empty('cargo-module')
for z in [-.06, .06]:
    box('Cargo rail', (0, -.101, z), (.45, .018, .022), metal, rack, .005)

crate = empty('crate')
box('Crate body', (0, .057, 0), (.208, .114, .208), ochre, crate, .005)
box('Sealed lid', (0, .115, 0), (.22, .010, .22), ochre, crate, .004)
for x in [-.102, .102]:
    for z in [-.102, .102]:
        box('Corner protector', (x, .058, z), (.016, .112, .016), dark, crate, .003)
for x in [-.045, .045]:
    box('Latch', (x, .093, .105), (.018, .022, .003), metal, crate, .001)
for angle in [-math.pi / 4, math.pi / 4]:
    mark = box('Top cargo X', (0, .1202, 0), (.155, .0004, .034), ink, crate)
    mark.rotation_euler.z = angle
for side in [-1, 1]:
    for angle in [-math.pi / 4, math.pi / 4]:
        mark = box('Side cargo X', (0, .061, side * .1042), (.14, .022, .0004), ink, crate)
        mark.rotation_euler.y = angle * .52
        mark = box('End cargo X', (side * .1042, .061, 0), (.0004, .022, .14), ink, crate)
        mark.rotation_euler.x = angle * .52
pallet = empty('pallet')
for x in [-.11, 0, .11]:
    box('Pallet runner', (x, .009, 0), (.036, .018, .29), dark, pallet, .002)
for z in [-.117, -.0585, 0, .0585, .117]:
    box('Pallet slat', (0, .021, z), (.29, .008, .05), dark, pallet, .001)
cabinet = empty('service-cabinet')
box('Tool cabinet', (0, .07, 0), (.48, .14, .24), dark, cabinet, .012)
box('Team lid', (0, .138, 0), (.45, .008, .215), team, cabinet, .003)
for x in [-.19, .19]:
    box('Cabinet latch', (x, .09, .1205), (.025, .035, .002), metal, cabinet, .001)
box('Lid stripe', (0, .1425, 0), (.055, .001, .18), shell, cabinet)
for root in [airframe, armor, gun, optics, grip, rack, crate, pallet, cabinet]:
    join_by_material(root)
export('drone-kit')


class SurfaceBatch:
    """Game-space mesh authoring, batched per PBR material for six-camera rendering."""
    def __init__(self):
        self.batches = {}

    def quad(self, points, mat, uv=None):
        vertices, faces, uvs = self.batches.setdefault(mat, ([], [], []))
        start = len(vertices)
        vertices.extend(xyz(p) for p in points)
        faces.append(tuple(range(start, start + len(points))))
        uvs.extend(uv or [(0,0),(1,0),(1,1),(0,1)])

    def cube(self, x, y, z, w, h, d, mat, transform=lambda p: p, include_top=True):
        p = [(x + a*w/2, y + b*h/2, z + c*d/2) for a,b,c in
             [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
        for ids in [(3,2,1,0),(4,5,6,7),(0,1,5,4),(2,3,7,6),(0,4,7,3),(1,2,6,5)]:
            if not include_top and ids == (2,3,7,6):
                continue
            self.quad([transform(p[i]) for i in ids], mat)

    def build(self, root):
        for mat, (verts, faces, uvs) in self.batches.items():
            mesh = bpy.data.meshes.new(mat.name)
            mesh.from_pydata(verts, [], faces)
            mesh.update()
            layer = mesh.uv_layers.new(name='Facade UV')
            layer.data.foreach_set('uv', np.array(uvs, dtype=np.float32).ravel())
            ob = bpy.data.objects.new(mat.name, mesh)
            bpy.context.collection.objects.link(ob)
            finish(ob, mat.name, mat, root)


def png(path, values):
    """Write original tile artwork losslessly; no third-party photo textures."""
    data = np.clip(values*255,0,255).astype(np.uint8)
    height,width,_ = data.shape
    def chunk(kind, value):
        return struct.pack('>I',len(value))+kind+value+struct.pack('>I',zlib.crc32(kind+value))
    raw = b''.join(b'\x00'+row.tobytes() for row in data)
    temporary = path.with_suffix('.png.tmp')
    temporary.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b''))
    temporary.replace(path)


def facade_material(name, wall, curtain=False, historic=False, pattern=None):
    """Bake bevel/reveal artwork and metal/roughness into a mipmapped PBR tile.

    Four bays by four floors in each 512 px tile preserve architectural density
    without hundreds of thousands of tiny triangles in every acquired frame.
    """
    n = 512
    rng = np.random.default_rng(43)
    color = np.array([int(wall[i:i+2],16)/255 for i in (1,3,5)])
    yy,xx = np.mgrid[0:n,0:n]
    u,v = xx%128, yy%128
    noise = rng.uniform(-.014,.014,(n,n,1))
    rgb = np.clip(np.ones((n,n,3))*color+noise,0,1)
    orm = np.ones((n,n,3)); orm[:,:,1]=.87; orm[:,:,2]=0
    l,r = (7,121) if curtain else (27,101)
    bottom,top = (12,111) if curtain else (22,103)
    if pattern == 'carew':
        l,r,bottom,top = 34,94,24,101
        # Buff brick piers frame recessed vertical stacks of dark bronze sash.
        rgb[(u > 26) & (u < 102)] *= .83
        mortar = (v % 9 == 0) | ((u + (v//9 % 2)*12) % 24 == 0)
        rgb[mortar] *= .96
    elif pattern == 'limestone':
        l,r,bottom,top = 29,99,23,102
        rgb[(v % 32 == 0) | ((u + (v//32 % 2)*32) % 64 == 0)] *= .92
    elif pattern == 'fifth-third':
        l,r,bottom,top = 36,92,2,125
        rgb[(u < 13) | (u > 115)] *= .69
    elif pattern == 'silver-glass':
        l,r,bottom,top = 15,119,5,123
    reveal = (u>=l-3)&(u<=r+3)&(v>=bottom-3)&(v<=top+3)
    window = (u>=l)&(u<=r)&(v>=bottom)&(v<=top)
    rgb[reveal]=(.19,.23,.24)
    # Independent panes, reflected skyline silhouettes and partial blinds. The
    # artwork is original, not satellite pixels wrapped around a building.
    panes = rng.uniform(-.055, .045, (4,4))
    shade = ((v-bottom)/(top-bottom)*.09 + panes[yy//128,xx//128])[:,:,None]
    reflection = np.ones((n,n,3))*np.array([.17,.30,.43] if pattern == 'silver-glass' else [.22,.27,.29] if pattern in ['carew','limestone','fifth-third'] else [.25,.35,.41])+shade
    silhouette = (v < 34 + 12*np.sin(xx/21) + 7*np.cos(xx/9)) & window
    reflection[silhouette] *= .72
    rgb[window]=reflection[window]
    blinds = window & (v > 82) & ((xx//128 + yy//128*3)%5 == 1) & (pattern != 'silver-glass')
    rgb[blinds]=(.55,.55,.49)
    orm[window,1]=.28; orm[window,2]=.42
    frame=(window & ((u==l)|(u==r)|(v==bottom)|(v==top)))
    rgb[frame]=(.59,.63,.63); orm[frame,1]=.4; orm[frame,2]=.4
    divider=window & (abs(u-64)<=1)
    rgb[divider]=(.37,.42,.44)
    if historic:
        sill=(v>=bottom-7)&(v<=bottom-4)&(u>=l-5)&(u<=r+5)
        rgb[sill]=color*.91
        highlight=(v==bottom-4)&(u>=l-5)&(u<=r+5)
        rgb[highlight]=np.minimum(1,color*1.10)
    if curtain:
        frame=(u<3)|(u>125)|(v<3)|(v>125)
        rgb[frame]=(.54,.60,.62); orm[frame,1]=.42; orm[frame,2]=.5
    if pattern == 'silver-glass':
        rib = (u < 13)
        rgb[rib]=(.73,.76,.77); rgb[u < 3]=(.38,.44,.48)
        orm[rib,1]=.4; orm[rib,2]=.55
    if pattern == 'fifth-third':
        rgb[(v < 5) & window]=(.27,.25,.24)
    mat = material('Facade '+name, '#ffffff')
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    for suffix,pixels in [('color',rgb),('orm',orm)]:
        path = SOURCE/'textures'/f'{name}-{suffix}.png'
        png(path,pixels)
        image = bpy.data.images.load(str(path)); image.pack()
        if suffix=='orm': image.colorspace_settings.name='Non-Color'
        node=mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image=image; node.extension='REPEAT'
        if suffix=='color': mat.node_tree.links.new(node.outputs['Color'],bsdf.inputs['Base Color'])
        else:
            split=mat.node_tree.nodes.new('ShaderNodeSeparateColor')
            mat.node_tree.links.new(node.outputs['Color'],split.inputs[0])
            mat.node_tree.links.new(split.outputs['Green'],bsdf.inputs['Roughness'])
            mat.node_tree.links.new(split.outputs['Blue'],bsdf.inputs['Metallic'])
    return mat


reset()
city = json.loads((ROOT / 'shared/city-data.json').read_text())
root = empty('cincinnati-buildings')
batch = SurfaceBatch()
masonry = [material('Masonry ' + str(i), c, .87) for i,c in enumerate(['#ae9e86','#bead90','#a18d7a','#b9b5a6','#b59a7d','#9da6a7','#ad9e93'])]
carew = material('Carew buff brick', '#c3a079', .85)
limestone = material('Limestone trim', '#c8bca5', .82)
roof_authoring = runpy.run_path(str(ROOT/'scripts/graphics-surfaces.py'))
roof_tiles = roof_authoring['roof_materials'](bpy, SOURCE, material, png)
coping = material('Roof coping', '#c8bca5', .82)
recess = material('Recess shadow', '#29373b', .8)
frames = material('Aluminum mullions', '#829397', .36, .5)
glasswall = material('Curtain wall spandrel', '#455d69', .32, .35)
facades = [facade_material('masonry-'+str(i),c) for i,c in enumerate(['#ae9e86','#bead90','#a18d7a','#b9b5a6','#b59a7d','#9da6a7','#ad9e93'])]
carew_facade=facade_material('carew','#c3a079',historic=True,pattern='carew')
glass_facade=facade_material('glass','#455d69',curtain=True)
landmark_authoring = runpy.run_path(str(ROOT/'scripts/graphics-landmarks.py'))
landmark_facades = {
    'limestone': facade_material('fourth-vine','#d6ceba',historic=True,pattern='limestone'),
    'fifth-third': facade_material('fifth-third','#bfb9a9',pattern='fifth-third'),
    'silver-glass': facade_material('great-american','#778c9e',curtain=True,pattern='silver-glass'),
}
roof_regions = []
for index, b in enumerate(city['buildings']):
    w,h,d = b['width'], b['height'], b['depth']
    base = b.get('baseY', 0)
    angle = math.radians(b.get('rotation', 0))
    c,s = math.cos(angle), math.sin(angle)
    def transform(p):
        x,y,z = p
        return (b['x'] + c*x + s*z, base+y, b['z'] - s*x + c*z)
    historic = any(key in b['id'] for key in ['carew','netherland','fourth-vine'])
    curtain = 'great-american-tower' in b['id'] or b['id'] in ['scripps-center','pnc-center','600-vine'] or not historic and index % 5 == 0
    wall = carew if historic else glasswall if curtain else masonry[index % len(masonry)]
    facade = carew_facade if historic else glass_facade if curtain else facades[index % len(facades)]
    landmark = landmark_authoring['landmark_style'](b['id'])
    if landmark in landmark_facades:
        facade = landmark_facades[landmark]
    if landmark == 'limestone':
        wall = masonry[3]
    elif landmark == 'fifth-third':
        wall = masonry[3]
    batch.cube(0,h/2,0,w,h,d,wall,transform,include_top=False)
    # Satellite references show pale membranes, dark tar and warm gravel, not a
    # uniform gray roof. Keep modeled service roofs perfectly clear and flat.
    roof_surface = roof_tiles[index % len(roof_tiles)]
    # One tessellated surface owns every roof pixel. Coplanar utility patches,
    # seam strips and the body-box cap used to compete in the depth buffer as
    # the camera moved. Vents/seams now live exclusively in the mipmapped tile;
    # the coping border meets, but never overlaps, the textured interior.
    rim = min(.045, w/4, d/4)
    roof_blockers = [points for y,points in roof_regions if abs(y-base-h) < 1e-6]
    def roof_panel(x,z,pw,pd,mat,textured=False):
        points = [(x-pw/2,h,z-pd/2),(x-pw/2,h,z+pd/2),
                  (x+pw/2,h,z+pd/2),(x+pw/2,h,z-pd/2)]
        for piece in roof_authoring['roof_pieces']([transform(p) for p in points],roof_blockers):
            uv = [((c*(px-b['x'])-s*(pz-b['z'])+w/2)/4,
                   (s*(px-b['x'])+c*(pz-b['z'])+d/2)/4) for px,_,pz in piece] if textured else [(0,0)]*len(piece)
            batch.quad(piece,mat,uv)
    roof_panel(0,0,w-2*rim,d-2*rim,roof_surface,True)
    for zz in [-d/2+rim/2,d/2-rim/2]:
        roof_panel(0,zz,w,rim,coping)
    for xx in [-w/2+rim/2,w/2-rim/2]:
        roof_panel(xx,0,rim,d-2*rim,coping)
    roof_regions.append((base+h,[transform(p) for p in [(-w/2,h,-d/2),(-w/2,h,d/2),(w/2,h,d/2),(w/2,h,-d/2)]]))
    floors = max(1, round(h / .36))
    floor_height = h / floors
    for face in range(4):
        across = w if face % 2 == 0 else d
        columns = max(2, round(across / (.20 if landmark == 'fifth-third' else .29 if landmark else .26 if curtain else .36)))
        bay = across / columns
        # Each face's local coordinates are right-handed, winding outward.
        def panel(u,y,pw,ph,mat,offset=.0012):
            def on_face(a,b):
                return [(a,b,d/2+offset),(w/2+offset,b,-a),(-a,b,-d/2-offset),(-w/2-offset,b,a)][face]
            batch.quad([transform(on_face(a,yy)) for a,yy in [(u-pw/2,y-ph/2),(u+pw/2,y-ph/2),(u+pw/2,y+ph/2),(u-pw/2,y+ph/2)]],mat)
        def on_face(a,y):
            return [(a,y,d/2+.001),(w/2+.001,y,-a),(-a,y,-d/2-.001),(-w/2-.001,y,a)][face]
        batch.quad([transform(on_face(a,y)) for a,y in [(-across/2,0),(across/2,0),(across/2,h),(-across/2,h)]],
                   facade, [(0,0),(columns/4,0),(columns/4,floors/4),(0,floors/4)])
        if landmark:
            landmark_authoring['detail_face'](b, landmark, face, across, columns, batch, transform, panel,
                {'stone': limestone, 'brick': carew, 'recess': recess, 'metal': frames, 'glass': glasswall})
            continue
        # Base stone band, storefront rhythm and top cornice emphasize real floors.
        if not curtain:
            panel(0,h-.045,across,.05,limestone,.002)
            panel(0,h-.10,across,.024,recess,.0022)
            # Modeled tiered cornices, pilasters, belt courses and storefronts
            # retain the sourced body silhouette rather than generic cubes.
            for row in range(3, floors, 3 if historic else 5):
                panel(0,row*floor_height,across,.014,limestone,.0025)
            if historic:
                for col in range(0,columns+1,3):
                    u=max(-across/2+.018,min(across/2-.018,-across/2+col*bay))
                    panel(u,h/2,.031,h-.12,limestone,.003)
            if base == 0:
                panel(0,.15,across,.30,recess,.0018)
                for col in range(max(1, round(across/.65))):
                    u=-across/2+(col+.5)*across/max(1,round(across/.65))
                    panel(u,.135,min(.45,across*.25),.23,glasswall,.0023)
                    panel(u,.285,min(.50,across*.27),.028,limestone,.003)
        else:
            for col in range(0,columns+1,4):
                panel(max(-across/2+.009,min(across/2-.009,-across/2+col*bay)),h/2,.018,h,frames,.002)
            for row in range(2,floors,3):
                panel(0,row*floor_height,across,.013,frames,.0025)
        # Tiara reference is a flush crown lattice over solid glass: the source
        # crown remains an opaque collision box, never an apparent fly-through.
        if b['id'] == 'great-american-tower-crown':
            for col in range(9):
                u = max(-across/2+.0135,min(across/2-.0135,-across/2 + across*col/8))
                panel(u,h/2,.027,h,limestone,.002)
            for row in range(1,7):
                panel(0,h*row/7,across,.027,limestone,.002)
            # Diagonal pale braces make the solid crown's lattice readable from
            # the street. They do not suggest an unmodeled fly-through opening.
            for col in range(8):
                lo=-across/2+across*col/8
                hi=lo+across/8
                def face_point(u,y):
                    return [(u,y,d/2+.003),(w/2+.003,y,-u),(-u,y,-d/2-.003),(-w/2-.003,y,u)][face]
                for ya,yb in [(0,h),(h,0)]:
                    batch.quad([transform(face_point(u,y)) for u,y in [(lo,ya),(lo+.020,ya),(hi,yb),(hi-.020,yb)]], limestone)
batch.build(root)
root['source'] = 'shared/city-data.json; OpenStreetMap contributors (ODbL); original facade artwork'
street_authoring = runpy.run_path(str(ROOT/'scripts/graphics-streets.py'))
street_authoring['build_streets'](bpy, city, {
    'empty': empty, 'material': material, 'SurfaceBatch': SurfaceBatch,
    'finish': finish, 'join_by_material': join_by_material, 'xyz': xyz,
})
export('cincinnati')
manifest = {
    'schema': 1,
    'generator': 'scripts/build-graphics.py',
    'blender': bpy.app.version_string,
    'sourceCitySha256': hashlib.sha256((ROOT/'shared/city-data.json').read_bytes()).hexdigest(),
    'buildings': [[b.get(k,0) for k in ['id','x','baseY','z','width','height','depth','rotation']] for b in city['buildings']],
    'assets': {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.glob('*.glb'))},
}
(OUT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest['assets']))
