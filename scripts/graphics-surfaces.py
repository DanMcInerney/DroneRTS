"""Original aerial-inspired roof artwork, authored and packed by Blender.

Mechanical grilles and membrane details are flush surface artwork: no apparent
raised HVAC obstacle is introduced without an authoritative collision volume.
"""
import numpy as np


def roof_pieces(points, blockers):
    """Subtract earlier coplanar roofs, preserving the union of source boxes.

    Each subtraction partitions a convex face along a convex roof boundary.
    Only duplicate visible triangles disappear; collision boxes are untouched.
    """
    def halfplane(polygon, a, b, inside):
        # Authored roof outlines wind clockwise in game X/Z.
        def side(p):
            return (b[0]-a[0])*(p[2]-a[2])-(b[2]-a[2])*(p[0]-a[0])
        result = []
        for index, p in enumerate(polygon):
            q = polygon[(index+1) % len(polygon)]
            sp, sq = side(p), side(q)
            pin, qin = (sp <= 0) == inside, (sq <= 0) == inside
            if pin:
                result.append(p)
            if pin != qin:
                t = sp/(sp-sq)
                result.append(tuple(x+t*(y-x) for x,y in zip(p,q)))
        return result

    def area(polygon):
        return abs(sum(p[0]*polygon[(i+1) % len(polygon)][2]
                       - polygon[(i+1) % len(polygon)][0]*p[2]
                       for i,p in enumerate(polygon)))/2

    pieces = [points]
    for blocker in blockers:
        next_pieces = []
        for piece in pieces:
            overlap = piece
            for index, a in enumerate(blocker):
                overlap = halfplane(overlap,a,blocker[(index+1) % len(blocker)],True)
                if len(overlap) < 3:
                    break
            if len(overlap) < 3 or area(overlap) <= 1e-10:
                next_pieces.append(piece)
                continue
            remainder = piece
            for index, a in enumerate(blocker):
                b = blocker[(index+1) % len(blocker)]
                outside = halfplane(remainder,a,b,False)
                if len(outside) >= 3 and area(outside) > 1e-10:
                    next_pieces.append(outside)
                remainder = halfplane(remainder,a,b,True)
                if len(remainder) < 3:
                    break
        pieces = next_pieces
    return pieces


def roof_materials(bpy, source, material, png):
    results = []
    for index, color in enumerate(['#b8b6ab', '#667073', '#8c887b']):
        n = 512
        rng = np.random.default_rng(811 + index)
        yy, xx = np.mgrid[0:n, 0:n]
        base = np.array([int(color[i:i+2], 16)/255 for i in (1, 3, 5)])
        grain = rng.normal(0, .018, (n, n, 1))
        weather = (np.sin(xx/43 + np.sin(yy/61)) * np.cos(yy/57))[:, :, None] * .017
        pixels = np.clip(base + grain + weather, 0, 1)
        # Membrane rolls, repairs, drainage channels and flat utility grilles.
        pixels[(xx % 85 < 2) | (yy % 256 < 2)] *= .82
        pixels[(xx % 85 == 3)] = np.minimum(1, base * 1.07)
        pixels[301:416, 65:180] *= .90
        pixels[300:302, 64:180] *= .8
        for x, y, w, h in [(320, 62, 128, 90), (330, 350, 76, 96)]:
            pixels[y-5:y+h+5, x-5:x+w+5] = base * .69
            pixels[y:y+h, x:x+w] = (.43, .48, .49)
            pixels[y:y+3, x:x+w] = (.72, .74, .71)
            for row in range(y+8, y+h-3, 7):
                pixels[row:row+2, x+5:x+w-5] = (.22, .28, .29)
        # Round exhaust-grille artwork inside the same flat roof envelope.
        for x, y in [(76, 83), (130, 83)]:
            radial = (xx-x)**2 + (yy-y)**2
            pixels[radial < 19**2] = (.29, .34, .34)
            pixels[(radial < 16**2) & (radial > 13**2)] = (.66, .69, .67)
            pixels[(radial < 12**2) & ((xx+yy) % 7 < 2)] = (.50, .54, .52)
        path = source / 'textures' / f'roof-{index}.png'
        png(path, pixels)
        mat = material('Roof aerial membrane ' + str(index), '#ffffff', .94)
        image = bpy.data.images.load(str(path)); image.pack()
        node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = image; node.extension = 'REPEAT'
        mat.node_tree.links.new(node.outputs['Color'], mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
        results.append(mat)
    return results
